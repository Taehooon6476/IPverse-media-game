import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Asset, Ip, Job, Snapshot } from './types';

// Three pictures of one IP as the server stores them: v1 (the first) cut at the right, v2 passed, v3 (a re-roll)
// lost its glow to the remover and stayed a version only (mediagen_image._flag).
const image = (assetId: string, version: number, createdAt: string, check: Record<string, unknown>): Asset => ({ assetId,
  kind: 'image', key: `sessions/s/${assetId}.png`, url: `https://cdn/${assetId}.png`, contentType: 'image/png', ipId: 'ip_k',
  meta: { model: 'krea', version, check }, createdAt });
const cutout = (assetId: string, forAssetId: string): Asset => ({ assetId, kind: 'cutout', key: `sessions/s/${assetId}.png`,
  url: `https://cdn/${assetId}.png`, contentType: 'image/png', ipId: 'ip_k', meta: { forAssetId }, createdAt: '2026-11-06T18:00:00Z' });
const v1 = image('ast_v1', 1, '2026-11-06T17:51:55.206Z', { cut: ['right'], ok: false, problem: '오른쪽이 프레임에 잘림', redraws: 1, subjects: 1 });
const v2 = image('ast_v2', 2, '2026-11-06T17:57:25.832Z', { cut: [], glow: 0.33, ok: true, problem: '', redraws: 1, subjects: 1 });
const v3 = image('ast_v3', 3, '2026-11-06T17:59:29.119Z',
  { cut: [], erased: 0.11, ok: false, problem: '누끼에서 빛나는 부분이 지워짐', redraws: 1, subjects: 1 });
const assets = [v1, cutout('ast_c1', 'ast_v1'), v2, cutout('ast_c2', 'ast_v2'), v3, cutout('ast_c3', 'ast_v3')];
const drew = (jobId: string, outputs: string[], error?: string): Job => ({ jobId, kind: 'image', provider: 'mediagen_image',
  status: 'done', input: { ipId: 'ip_k' }, outputs, deps: [], progress: '', error, createdAt: '2026-11-06T17:50:48Z',
  updatedAt: '2026-11-06T17:59:29Z' });
const jobs = [
  drew('job_1', ['ast_v1', 'ast_c1'], '구도 검사 실패: 오른쪽이 프레임에 잘림(2번 그려도 같음). 첫 그림이라 그대로 두었으니 다시 뽑아 주세요.'),
  drew('job_2', ['ast_v2', 'ast_c2']),
  drew('job_3', ['ast_v3', 'ast_c3'], '구도 검사 실패: 누끼에서 빛나는 부분이 지워짐(2번 그려도 같음). 새 그림(v3)은 버전 기록에만 두고 지금 그림(v2)을 그대로 씁니다.'),
];
const katana: Ip = { ipId: 'ip_k', kind: 'weapon', name: '플라즈마 카타나', description: 'a plasma katana', weaponType: 'melee',
  version: 2, imageAssetId: 'ast_v2', cutoutAssetId: 'ast_c2', imageJobId: 'job_3', createdAt: '2026-11-06T17:50:48Z' };
const snapOf = (ip: Ip, list = assets) => ({ session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: '' }, messages: [],
  games: [], ips: [ip], assets: list, jobs }) as Snapshot;

type OnAction = (tool: string, args: Record<string, unknown>, background?: boolean) => Promise<void>;
let container: HTMLDivElement;
let root: Root;
let onAction: Mock<OnAction>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  history.replaceState(null, '', '#ip=props');
  onAction = vi.fn<OnAction>(async () => undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

const show = async (snap: Snapshot) => {
  const { IpPane } = await import('./components/IpPane');
  await act(async () => root.render(<IpPane snap={snap} onAction={onAction} onEdit={vi.fn()} onRetry={vi.fn()} />));
};
const drawer = () => document.querySelector<HTMLElement>('[role="dialog"]')!; // on <body>: it covers the whole studio
const open = async (snap: Snapshot) => {
  await show(snap);
  await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label^="플라즈마 카타나 버전 기록"]`)!.click());
  return drawer();
};
/** Each listed version, newest first: its title, the check line it carries, and whether that line is marked failed. */
const rows = () => [...drawer().querySelectorAll('.version-item')].map((li) => {
  const mark = li.querySelector('.version-check');
  return [li.querySelector('strong')!.textContent, mark?.textContent ?? null, !!mark?.classList.contains('is-failed')];
});
const restore = (label: string) => act(async () => drawer().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
const notice = () => drawer().querySelector('.notice');

describe('버전 기록: every version with its composition check (round 6 N11)', () => {
  it('marks each version with what the check found, failed ones in red with the reason', async () => {
    await open(snapOf(katana));
    expect(rows()).toEqual([
      ['v3', '구도 검사 실패: 배경 제거 이미지에서 빛나는 부분이 지워짐', true],
      ['v2 · 지금 그림', '구도 검사 통과', false],
      ['v1', '구도 검사 실패: 오른쪽이 프레임에 잘림', true],
    ]);
    // the buttons of the failed versions say so to a screen reader too (이 버전 쓰기, not 되돌리기)
    expect([...drawer().querySelectorAll('.version-item button.action-btn')].map((b) => b.getAttribute('aria-label')))
      .toEqual(['v3 버전 쓰기 (구도 검사 실패)', 'v1 버전 쓰기 (구도 검사 실패)']);
    expect(notice()).toBeNull();
  });

  it('says so when a failed version is restored, and not for one that passed', async () => {
    await open(snapOf(katana));
    await restore('v3 버전 쓰기 (구도 검사 실패)');
    expect(onAction).toHaveBeenCalledWith('restore_ip_version', { ipId: 'ip_k', imageAssetId: 'ast_v3' });
    expect(notice()?.getAttribute('role')).toBe('alert');
    expect(notice()?.textContent).toBe('구도 검사에 실패한 v3 버전을 지금 그림으로 쓰고 있어요(배경 제거 이미지에서 빛나는 부분이 지워짐). 3D도 이 모양대로 나오니 다시 뽑기를 권해요.');

    // the next poll has v3 as the IP's picture; restoring v2, which passed, takes the warning away
    await show(snapOf({ ...katana, version: 3, imageAssetId: 'ast_v3', cutoutAssetId: 'ast_c3' }));
    expect(rows()[0]).toEqual(['v3 · 지금 그림', '구도 검사 실패: 배경 제거 이미지에서 빛나는 부분이 지워짐', true]);
    await restore('v2 버전 쓰기');
    expect(onAction).toHaveBeenLastCalledWith('restore_ip_version', { ipId: 'ip_k', imageAssetId: 'ast_v2' });
    expect(notice()).toBeNull();
  });

  it('claims nothing when the restore was refused', async () => {
    await open(snapOf(katana));
    onAction.mockRejectedValueOnce(new Error('이 버전의 누끼가 없어 되돌릴 수 없습니다'));
    await restore('v1 버전 쓰기 (구도 검사 실패)');
    expect(notice()).toBeNull();
  });

  it('marks nothing on a version no check ran on (a whole-scene background, a picture older than the check)', async () => {
    const plain = { ...v1, meta: { model: 'krea', version: 1 } };
    await open(snapOf({ ...katana, version: 1, imageAssetId: 'ast_v1', cutoutAssetId: 'ast_c1' }, [plain, cutout('ast_c1', 'ast_v1')]));
    expect(rows()).toEqual([['v1 · 지금 그림', null, false]]);
  });
});
