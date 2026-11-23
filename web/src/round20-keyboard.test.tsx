import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionButton } from './components/ActionButton';
import type { Asset, Ip, Job, Snapshot } from './types';

// A button that holds the focus is never natively disabled (the focus would drop to <body>): it says aria-disabled,
// ignores a press and keeps the focus. jsdom does not move the focus off a disabled element as Chrome does, so
// these check the attributes that decide it.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  localStorage.clear();
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
const only = () => container.querySelector<HTMLButtonElement>('button.action-btn')!;
const state = (b: HTMLButtonElement) => [b.textContent, b.disabled, b.getAttribute('aria-disabled'), document.activeElement === b];

describe('R20-52 a button that does its job in place keeps the keyboard focus', () => {
  it('is not natively disabled while its request runs: it says aria-disabled and takes no second press', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    await act(async () => root.render(<ActionButton label="다시 시도" busyLabel="요청 중…" doneLabel="요청했어요" run={run} />));
    only().focus();
    await act(async () => only().click());
    expect(state(only())).toEqual(['요청 중…', false, 'true', true]);
    await act(async () => only().click());
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect([only().disabled, only().getAttribute('aria-disabled'), document.activeElement === only()]).toEqual([false, null, true]);
  });

  it('turned off from outside under the focus, it stays focusable and says why; without the focus it is disabled as before', async () => {
    const run = vi.fn(async () => undefined);
    const show = (off: boolean) => act(async () => root.render(<ActionButton label="3D로 만들기" disabled={off} disabledLabel="3D 만드는 중" run={run} />));
    await show(false);
    only().focus();
    await show(true); // the poll saw the chain
    expect(state(only())).toEqual(['3D 만드는 중', false, 'true', true]);
    await act(async () => only().click());
    expect(run).not.toHaveBeenCalled();
    await act(async () => only().blur());
    expect(state(only())).toEqual(['3D 만드는 중', true, null, false]);
  });
});

describe('R20-52 a card keeps the focus on its 3D button through the action', () => {
  const at = '2026-11-16T03:10:00Z';
  const ip: Ip = { ipId: 'ip_lantern', kind: 'prop', name: '반딧불 등불', description: '', version: 1, imageAssetId: 'ast_img', cutoutAssetId: 'ast_cut', createdAt: at };
  const asset = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, ipId: ip.ipId, key: assetId, url: `https://cdn/${assetId}.png`, contentType: 'image/png', meta: {}, createdAt: at });
  const snapOf = (jobs: Job[]) => ({ session: { sessionId: 'ses_x', title: 't', genre: 'rpg-quest', createdAt: at }, messages: [], games: [],
    ips: [ip], assets: [asset('ast_img', 'image'), asset('ast_cut', 'cutout')], jobs }) as Snapshot;
  const mesh: Job = { jobId: 'job_mesh', kind: 'mesh3d', provider: 'img3d', status: 'running', input: { ipId: ip.ipId }, outputs: [], deps: [], progress: '',
    createdAt: at, updatedAt: at };

  it('from the press, through 시작했어요, to the chain the next poll shows', async () => {
    history.replaceState(null, '', '#ip=props');
    const { IpPane } = await import('./components/IpPane');
    const onAction = vi.fn(async () => undefined);
    const show = (jobs: Job[]) => act(async () => root.render(<IpPane snap={snapOf(jobs)} onAction={onAction} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} />));
    await show([]);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="반딧불 등불 3D로 만들기"]')!;
    button.focus();
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledWith('render_3d', { ipId: 'ip_lantern' });
    await show([mesh]);
    expect([button.isConnected, button.disabled, button.getAttribute('aria-disabled'), document.activeElement === button]).toEqual([true, false, 'true', true]);
  });
});

// 배경 · 전체 장면 needs a fill to be read on a bright scene: the fill is a rule on .kind-badge--scene (origin.css), so
// the badge has to carry that class.
describe('R20-53 the whole-scene badge is a filled badge', () => {
  it('marks 배경 · 전체 장면 with the class its fill hangs on', async () => {
    const at = '2026-11-16T03:10:00Z';
    const glade: Ip = { ipId: 'ip_glade', kind: 'prop', usage: 'background', name: '별빛 숲 공터', description: '', version: 1, imageAssetId: 'ast_glade', createdAt: at };
    const picture: Asset = { assetId: 'ast_glade', kind: 'image', ipId: 'ip_glade', key: 'k', url: 'https://cdn/glade.png', contentType: 'image/png', meta: {}, createdAt: at };
    history.replaceState(null, '', '#ip=props');
    const { IpPane } = await import('./components/IpPane');
    await act(async () => root.render(<IpPane snap={{ session: { sessionId: 'ses_x', title: 't', genre: 'rpg-quest', createdAt: at }, messages: [], games: [], ips: [glade],
      assets: [picture], jobs: [] } as Snapshot} onAction={vi.fn(async () => undefined)} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} />));
    expect([...container.querySelectorAll('.kind-badge')].map((b) => [b.textContent, b.className])).toEqual([['배경 · 전체 장면', 'kind-badge kind-badge--scene']]);
  });
});
