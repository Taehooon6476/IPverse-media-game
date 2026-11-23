import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, runTool, runToolAsync } from './api';
import { SkillsDrawer } from './components/SkillsDrawer';
import { SKILLS } from './skills';
import type { Ip, Job, Message, Snapshot } from './types';

vi.mock('./api', () => ({ getSession: vi.fn(), runTool: vi.fn(), runToolAsync: vi.fn() }));

const at = '2026-11-05T00:00:00Z';
const job = (jobId: string, kind: Job['kind'], provider: Job['provider']): Job => ({ jobId, kind, provider, status: 'failed',
  input: { ipId: 'ip_coin' }, outputs: [], deps: [], progress: '', error: 'GPU busy', createdAt: at, updatedAt: at });
const coin: Ip = { ipId: 'ip_coin', kind: 'prop', name: '황금 코인', description: 'gold coin', version: 1, createdAt: at };
const session = (sessionId: string, ips: Ip[], jobs: Job[]) => ({ session: { sessionId, title: 't', genre: 'sf-shooter', createdAt: '' },
  messages: [], games: [], assets: [], ips, jobs }) as Snapshot;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

/** Opens the platformer skill, presses its 만들기 and confirms, until the batch ends. make_skill_asset settles as
 * soon as its image and 3D jobs are registered. → what the drawer reported. */
async function makePlatformerAssets(snap: Snapshot) {
  let started = 0;
  vi.mocked(runToolAsync).mockImplementation(async () => ({ messageId: `msg_${++started}` }));
  vi.mocked(getSession).mockImplementation(async () => ({ ...snap,
    messages: Array.from({ length: started }, (_, i) => ({ messageId: `msg_${i + 1}`, status: 'done' }) as Message) }));
  const onNotice = vi.fn(), onError = vi.fn();
  await act(async () => root.render(<SkillsDrawer snap={snap} onClose={vi.fn()} onSend={vi.fn()} onNotice={onNotice}
    onError={onError} onChat={vi.fn()} />));
  const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!; // the confirm is on <body>
  await act(async () => button('점프 플랫포머').click());
  expect(container.querySelector('.skill-badge--failed')?.textContent).toBe('실패'); // the coin
  await act(async () => button('만들기 ·').click());
  await act(async () => {
    button('만들기 시작').click();
    await vi.runAllTimersAsync();
  });
  expect(onError).not.toHaveBeenCalled();
  return { notices: onNotice.mock.calls.map(([text]) => text as string),
    made: vi.mocked(runToolAsync).mock.calls.map(([, tool, args]) => `${tool}:${args.name}`).sort() };
}

describe('skills asset batch', () => {
  it('skips an asset whose image failed, makes the rest and says their images are still being drawn', async () => {
    // the coin IP was made earlier but its only image job failed; the other three are not made yet
    vi.mocked(runTool).mockRejectedValue(new Error('이미지 작업이 실패해 이미지가 없습니다')); // render_3d: 400 image_failed
    const { notices, made } = await makePlatformerAssets(session('s_image', [{ ...coin, imageJobId: 'job_img' }],
      [job('job_img', 'image', 'mediagen_image')]));
    expect(runTool).not.toHaveBeenCalled(); // no render_3d for an IP without a picture
    expect(made).toEqual(['make_skill_asset:골인 깃발', 'make_skill_asset:버섯 발판', 'make_skill_asset:스프링 점프대']);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('황금 코인'); // named and skipped, with where to retry its image
    expect(notices[0]).toContain('작업 현황');
    expect(notices[1]).toContain('그리고 있어요'); // the jobs are registered, the pictures are not drawn yet
    expect(notices[1]).not.toContain('만들었어요');
  });

  it('restarts the 3D of an asset whose picture exists and says only that', async () => {
    vi.mocked(runTool).mockResolvedValue({ result: {} });
    const ready = SKILLS.find((s) => s.id === 'platformer')!.assets.slice(1)
      .map((a, i): Ip => ({ ...coin, ipId: `ip_${i}`, name: a.name, imageAssetId: `img_${i}`, glbAssetId: `glb_${i}` }));
    const { notices, made } = await makePlatformerAssets(session('s_mesh', [{ ...coin, imageAssetId: 'img_coin' }, ...ready],
      [job('job_mesh', 'mesh3d', 'img3d')]));
    expect(vi.mocked(runTool).mock.calls).toEqual([['s_mesh', 'render_3d', { ipId: 'ip_coin' }]]);
    expect(made).toEqual([]);
    expect(notices).toEqual([expect.stringContaining('3D를 다시 시작했어요')]);
  });
});
