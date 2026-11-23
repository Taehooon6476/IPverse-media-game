import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fmtTime, type Asset, type Ip, type Job, type Snapshot } from './types';

// Fewer buttons on the IP pane: an IP card keeps one primary action and a ⋯ menu, a 3D card one 내려받기 menu,
// a video card its 수정하기 and a ⋯ menu. Every action stays reachable with the same handler.
const at = '2026-11-04T10:00:00Z';
const ip = (ipId: string, kind: Ip['kind'], name: string, extra: Partial<Ip> = {}): Ip => ({ ipId, kind, name,
  description: `${name} 설명`, version: 1, imageAssetId: `${ipId}_img`, cutoutAssetId: `${ipId}_cut`, createdAt: at, ...extra });
const asset = (assetId: string, kind: Asset['kind'], extra: Partial<Asset> = {}): Asset => ({ assetId, kind, key: `k/${assetId}`,
  url: `https://cdn/${assetId}`, contentType: '', meta: {}, createdAt: at, ...extra });
const job = (jobId: string, kind: Job['kind'], status: Job['status'], input: Record<string, unknown> = {}): Job => ({ jobId, kind,
  provider: 'mediagen_image', status, input, outputs: [], deps: [], progress: '', createdAt: at, updatedAt: at });
const pictures = (ips: Ip[]) => ips.flatMap((x) => [asset(`${x.ipId}_img`, 'image', { ipId: x.ipId }), asset(`${x.ipId}_cut`, 'cutout', { ipId: x.ipId })]);
const snapOf = (ips: Ip[], jobs: Job[] = [], extra: Asset[] = []) => ({ session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: at },
  messages: [], games: [], ips, assets: [...pictures(ips), ...extra], jobs }) as Snapshot;

const luna = ip('luna', 'character', '루나');
const momo = ip('momo', 'character', '모모', { glbAssetId: 'momo_glb' }); // has a 3D model
const momoGlb = asset('momo_glb', 'glb', { ipId: 'momo' });
const blaster = ip('blaster', 'weapon', '펄스 블래스터');
const core = ip('core', 'prop', '코어');

type OnAction = (tool: string, args: Record<string, unknown>, background?: boolean) => Promise<void>;
let container: HTMLDivElement;
let root: Root;
let onAction: Mock<OnAction>;
let onEdit: Mock;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  onAction = vi.fn<OnAction>(async () => undefined);
  onEdit = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async (snap: Snapshot, tab = 'characters') => {
  history.replaceState(null, '', `#ip=${tab}`);
  const { IpPane } = await import('./components/IpPane');
  await act(async () => root.render(<IpPane snap={snap} onAction={onAction} onEdit={onEdit} onRetry={vi.fn()} />));
};
const card = (name: string) => [...container.querySelectorAll('article.card')].find((c) => c.querySelector('h3')?.textContent === name)!;
/** The buttons an IP card shows below its description (menu items are portalled out of the card). */
const actions = (name: string) => [...card(name).querySelectorAll('.card-actions button')].map((b) => b.getAttribute('aria-label'));
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
/** Opens the menu behind the trigger with this accessible name → its items as {label, hint, disabled}. */
async function open(trigger: string) {
  const t = button(trigger);
  expect(t.getAttribute('aria-haspopup')).toBe('menu');
  await act(async () => t.click());
  expect(t.getAttribute('aria-expanded')).toBe('true');
  const menu = document.getElementById(t.getAttribute('aria-controls')!)!;
  expect(menu.getAttribute('aria-label')).toBe(trigger);
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => ({
    label: el.querySelector('span')!.textContent, hint: el.querySelector('small')?.textContent,
    disabled: el.getAttribute('aria-disabled') === 'true', el }));
}
const pick = async (trigger: string, label: string) => {
  const item = (await open(trigger)).find((x) => x.label === label)!;
  await act(async () => item.el.click());
};
const brief = (items: { label: string | null; hint?: string; disabled: boolean }[]) =>
  items.map(({ label, hint, disabled }) => (disabled ? `${label} (${hint})` : label));

describe('IP card: one primary action, the rest behind ⋯', () => {
  it('shows 3D로 만들기 until the IP has a 3D model, then 수정하기, and keeps 배경 제거 and the version badge', async () => {
    await render(snapOf([luna, momo], [], [momoGlb]));
    expect(actions('루나')).toEqual(['루나 3D로 만들기', '루나 작업 더보기']);
    expect(button('루나 3D로 만들기').className).toContain('btn-primary');
    expect(brief(await open('루나 작업 더보기'))).toEqual(['수정하기', '다시 뽑기', '액션 샷']);
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });

    expect(actions('모모')).toEqual(['모모 자연어로 수정하기', '모모 작업 더보기']);
    expect(brief(await open('모모 작업 더보기'))).toEqual(['다시 뽑기', '3D로 만들기', '액션 샷']);
    expect([button('루나 배경 제거한 그림 보기'), button('루나 버전 기록 (지금 v1)')].every(Boolean)).toBe(true);
  });

  it('runs the same tools as the old buttons, with busy and done next to the trigger', async () => {
    let accept!: () => void;
    onAction.mockImplementationOnce(() => new Promise<void>((r) => { accept = r; }));
    await render(snapOf([luna, momo, blaster], [], [momoGlb]));
    await pick('루나 작업 더보기', '다시 뽑기');
    expect(onAction).toHaveBeenLastCalledWith('reroll_ip_image', { ipId: 'luna' }, true);
    const status = card('루나').querySelector('.menu-status')!;
    expect(status.textContent).toBe('요청 중…');
    await act(async () => accept());
    expect(status.textContent).toBe('뽑는 중');

    await pick('루나 작업 더보기', '수정하기');
    expect(onEdit).toHaveBeenLastCalledWith({ kind: 'ip', ip: luna, imageUrl: 'https://cdn/luna_img' });
    await pick('루나 작업 더보기', '액션 샷');
    expect(onAction).toHaveBeenLastCalledWith('make_action_shot', { ipId: 'luna',
      action: 'running forward holding the weapon, dynamic action pose, cinematic', weapon_ip_id: 'blaster' }, true);
    await act(async () => button('루나 3D로 만들기').click());
    expect(onAction).toHaveBeenLastCalledWith('render_3d', { ipId: 'luna' });

    await pick('모모 작업 더보기', '3D로 만들기');
    expect(onAction).toHaveBeenLastCalledWith('render_3d', { ipId: 'momo' });
    expect(card('모모').querySelector('.menu-status')!.textContent).toBe('시작했어요');
    await act(async () => button('모모 자연어로 수정하기').click());
    expect(onEdit).toHaveBeenLastCalledWith({ kind: 'ip', ip: momo, imageUrl: 'https://cdn/momo_img' });
  });

  it('offers 영상 샷 on props and weapons', async () => {
    await render(snapOf([core, blaster]), 'props');
    const items = await open('코어 작업 더보기');
    expect(brief(items)).toEqual(['수정하기', '다시 뽑기', '영상 샷']);
    await act(async () => items[2].el.click());
    expect(onAction).toHaveBeenLastCalledWith('make_video_shot',
      { ipId: 'core', prompt: 'slow cinematic orbit around the subject, soft rim light', aspect_ratio: '16:9' });
    expect(card('코어').querySelector('.menu-status')!.textContent).toBe('등록됨');
  });

  it('says 3D 만드는 중 while a 3D job runs, on the primary or in the menu', async () => {
    await render(snapOf([luna, momo], [job('j1', 'render3d', 'running', { ipId: 'luna' }), job('j2', 'mesh3d', 'queued', { ipId: 'momo' })], [momoGlb]));
    expect(button('루나 3D로 만들기').disabled).toBe(true);
    expect(button('루나 3D로 만들기').textContent).toBe('3D 만드는 중');
    expect(brief(await open('모모 작업 더보기'))).toEqual(['다시 뽑기', '3D로 만들기 (3D 만드는 중)', '액션 샷']);
    expect(card('모모').querySelector('.card-status')?.textContent).toBe('3D 만드는 중 · 보통 2–8분. 끝나면 3D 탭에 나타나요.');
  });

  it('offers 움직임 뼈대만 다시 넣기 on a rigged IP: its current mesh rigged again, the look unchanged', async () => {
    const rigged = { ...momo, riggedGlbAssetId: 'momo_rig' };
    await render(snapOf([rigged], [], [momoGlb, asset('momo_rig', 'rigged_glb', { ipId: 'momo' })]));
    const items = await open('모모 작업 더보기');
    expect(brief(items)).toEqual(['다시 뽑기', '3D로 만들기', '움직임 뼈대만 다시 넣기', '액션 샷']);
    await act(async () => items[2].el.click());
    expect(onAction).toHaveBeenLastCalledWith('render_3d', { ipId: 'momo', rig_only: true });

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(snapOf([rigged], [job('j1', 'rig', 'running', { ipId: 'momo' })], [momoGlb]));
    expect(brief(await open('모모 작업 더보기'))).toContain('움직임 뼈대만 다시 넣기 (3D 만드는 중)');
  });
});

describe('shots wait for every picture they use (review finding 10)', () => {
  it('keeps 다시 뽑기 and both shots off while a new version is drawn; 수정하기 stays on', async () => {
    const redraw = job('job_img', 'image', 'running');
    await render(snapOf([{ ...luna, imageJobId: 'job_img' }], [redraw]));
    expect(brief(await open('루나 작업 더보기'))).toEqual(['수정하기', '다시 뽑기 (새 버전 그리는 중)', '액션 샷 (새 버전 그리는 중)']);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(snapOf([{ ...core, imageJobId: 'job_img' }], [redraw]), 'props');
    expect(brief(await open('코어 작업 더보기'))).toEqual(['수정하기', '다시 뽑기 (새 버전 그리는 중)', '영상 샷 (새 버전 그리는 중)']);
  });

  it('leaves out a weapon whose picture is pending or failed, and waits for one getting a new version', async () => {
    const drawing = { ...blaster, imageAssetId: undefined, cutoutAssetId: undefined, imageJobId: 'job_w' };
    const shot = async (weapons: Ip[], jobs: Job[]) => {
      await act(async () => root.unmount());
      root = createRoot(container);
      await render(snapOf([luna, ...weapons], jobs));
      return open('루나 작업 더보기');
    };
    for (const status of ['running', 'failed'] as const) {
      const items = await shot([drawing], [job('job_w', 'image', status)]);
      await act(async () => items[2].el.click());
      expect(onAction).toHaveBeenLastCalledWith('make_action_shot',
        { ipId: 'luna', action: 'running forward, dynamic action pose, cinematic' }, true);
    }
    // the next weapon with a picture is used instead
    const items = await shot([drawing, { ...blaster, ipId: 'saber', name: '세이버' }], [job('job_w', 'image', 'running')]);
    await act(async () => items[2].el.click());
    expect(onAction).toHaveBeenLastCalledWith('make_action_shot', { ipId: 'luna',
      action: 'running forward holding the weapon, dynamic action pose, cinematic', weapon_ip_id: 'saber' }, true);

    const redrawn = await shot([{ ...blaster, imageJobId: 'job_w' }], [job('job_w', 'image', 'queued')]);
    expect(brief(redrawn)[2]).toBe('액션 샷 (펄스 블래스터 새 버전 그리는 중)');
  });
});

describe('3D and video cards fold their links into menus', () => {
  it('puts both 3D downloads behind one 내려받기 menu', async () => {
    const glb = asset('luna_glb', 'glb', { ipId: 'luna', jobId: 'job_r' });
    const turntable = asset('luna_turn', 'turntable', { ipId: 'luna', jobId: 'job_r' });
    await render(snapOf([{ ...luna, glbAssetId: 'luna_glb' }], [], [glb, turntable]), '3d');
    const foot = container.querySelector('.card-foot')!;
    expect(foot.querySelectorAll('a')).toHaveLength(0);
    expect(button('루나 내려받기').textContent).toBe('내려받기');
    expect(button('루나 내려받기').querySelector('svg.menu-chevron')).not.toBeNull();
    const items = await open('루나 내려받기');
    expect(items.map((x) => [x.label, x.el.tagName, x.el.getAttribute('href'), x.el.getAttribute('download')])).toEqual([
      ['3D 모델 파일 (.glb)', 'A', 'https://cdn/luna_glb', ''], ['3D 회전 영상 (.mp4)', 'A', 'https://cdn/luna_turn', '']]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(snapOf([{ ...luna, glbAssetId: 'luna_glb' }], [], [glb]), '3d');
    expect((await open('루나 내려받기')).map((x) => x.label)).toEqual(['3D 모델 파일 (.glb)']);
  });

  it('shows one 3D entry per IP: the current model with when it was made, the earlier runs as versions with their downloads (round 5 R11)', async () => {
    // five relief runs on one background; the IP points at the newest
    const roof = ip('roof', 'prop', '기업 탑 옥상 정원', { usage: 'background', glbAssetId: 'roof_glb5' });
    const made = (n: number) => `2026-11-0${n}T01:30:00Z`;
    const run = (n: number) => (['glb', 'turntable', 'poster'] as const).map((kind) =>
      asset(`roof_${kind}${n}`, kind, { ipId: 'roof', jobId: `job_r${n}`, createdAt: made(n) }));
    const lunaGlb = asset('luna_glb', 'glb', { ipId: 'luna', jobId: 'job_l' });
    await render(snapOf([{ ...luna, glbAssetId: 'luna_glb' }, roof], [], [run(1), run(2), lunaGlb, run(3), run(4), run(5)].flat()), '3d');

    expect(container.querySelector('#ip-tab-3d')!.getAttribute('aria-label')).toBe('3D · 2개'); // models, not runs
    expect([...container.querySelectorAll('#ip-panel-3d > .stack > article.card')].map((c) => c.querySelector('h3')!.textContent))
      .toEqual(['기업 탑 옥상 정원', '루나']);
    const entry = card('기업 탑 옥상 정원');
    expect(entry.querySelectorAll('model-viewer, video')).toHaveLength(2); // one viewer and one turntable: the current run's
    expect(entry.querySelector('model-viewer')!.getAttribute('src')).toBe('https://cdn/roof_glb5');
    expect(entry.querySelector('.card-foot .version')!.textContent).toBe('5번째 3D · 지금 쓰는 모델'); // "v" is the picture's number
    expect(entry.querySelector('.card-foot time')!.getAttribute('dateTime')).toBe(made(5));
    expect(entry.querySelector('.card-foot time')!.textContent).toBe(fmtTime(made(5)));
    expect(card('루나').querySelector('.card-foot .version')!.textContent).toBe('지금 쓰는 모델');
    expect(card('루나').querySelector('.model-versions')).toBeNull(); // made once: nothing earlier to list

    // the earlier runs: folded under the current one, newest first, each with its time and its own downloads
    const fold = entry.querySelector<HTMLButtonElement>('.model-versions .fold-head')!;
    expect(fold.textContent).toBe('이전 3D4개');
    await act(async () => fold.click());
    expect([...entry.querySelectorAll('.model-versions li')].map((li) => [li.querySelector('strong')!.textContent,
      li.querySelector('time')!.textContent, li.querySelector('img')!.getAttribute('src')]))
      .toEqual([4, 3, 2, 1].map((n) => [`${n}번째 3D`, fmtTime(made(n)), `https://cdn/roof_poster${n}`]));
    expect((await open('기업 탑 옥상 정원 2번째 3D 내려받기')).map((x) => [x.label, x.el.getAttribute('href')])).toEqual([
      ['3D 모델 파일 (.glb)', 'https://cdn/roof_glb2'], ['3D 회전 영상 (.mp4)', 'https://cdn/roof_turntable2']]);
    expect((await open('기업 탑 옥상 정원 내려받기')).map((x) => x.el.getAttribute('href'))).toEqual(['https://cdn/roof_glb5', 'https://cdn/roof_turntable5']);
  });

  it('keeps 수정하기 (다시 연출) visible on video cards and puts 다시 뽑기 and 내려받기 behind ⋯', async () => {
    const input = { ipId: 'luna', prompt: 'luna runs', aspect_ratio: '16:9', seconds: 5, model: 'ltx' };
    const shot = asset('shot1', 'shot', { ipId: 'luna', jobId: 'job_s' });
    const trailer = asset('tr1', 'trailer', { jobId: 'job_t' });
    const shorts = asset('sh1', 'shorts', { jobId: 'job_t' });
    await render(snapOf([luna], [job('job_s', 'shot', 'done', input), job('job_t', 'trailer', 'done')], [shot, trailer, shorts]), 'video');
    const visible = [...container.querySelectorAll('.figure-actions > button, .figure-actions > .menu > button')].map((b) => b.getAttribute('aria-label'));
    expect(visible).toEqual(['샷 1 수정하기', '샷 1 · 루나 작업 더보기', '트레일러 1 수정하기', '트레일러 1 작업 더보기', '쇼츠 1 작업 더보기']);
    expect(button('트레일러 1 수정하기').textContent).toBe('다시 연출');
    expect(container.querySelectorAll('.figure-actions > a')).toHaveLength(0);

    const items = await open('샷 1 · 루나 작업 더보기');
    expect(items.map((x) => [x.label, x.el.getAttribute('href')])).toEqual([['다시 뽑기', null], ['내려받기', 'https://cdn/shot1']]);
    await act(async () => items[0].el.click());
    expect(onAction).toHaveBeenLastCalledWith('make_video_shot', { ipId: 'luna', prompt: 'luna runs', aspect_ratio: '16:9', duration: 5, model: 'ltx' });
    expect(container.querySelector('.video-card .menu-status')!.textContent).toBe('등록됨');
    await act(async () => button('샷 1 수정하기').click());
    expect(onEdit).toHaveBeenLastCalledWith({ kind: 'shot', asset: shot, name: '루나', prompt: 'luna runs', model: 'ltx', seconds: 5 });

    expect((await open('트레일러 1 작업 더보기')).map((x) => x.label)).toEqual(['내려받기']);
    expect((await open('쇼츠 1 작업 더보기')).map((x) => [x.label, x.el.getAttribute('download')])).toEqual([['내려받기', '']]);
    await act(async () => container.querySelector<HTMLButtonElement>('.section-action')!.click()); // 트레일러 연출 stays
    expect(onEdit).toHaveBeenLastCalledWith({ kind: 'trailer' });
  });
});
