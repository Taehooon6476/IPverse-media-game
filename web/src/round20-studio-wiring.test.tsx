import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Game, Ip, Job, Snapshot } from './types';

// What the panes and dialogs need from the studio shell (App.tsx hands them a handler or a value). The whole studio
// is mounted over a fake API, as the page polls it.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const { default: App } = await import('./App');

const SID = 'ses_w2';
const at = (clock: string) => `2026-11-16T${clock}Z`;
const session = { sessionId: SID, title: '별빛 숲의 리라', genre: 'rpg-quest' as const, concept: null, createdAt: at('03:00:00.000') };
const lantern: Ip = { ipId: 'ip_lantern', kind: 'prop', name: '반딧불 등불', description: '', version: 1, imageAssetId: 'ast_img', cutoutAssetId: 'ast_cut',
  createdAt: at('03:01:00.000') };
const asset = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, ipId: 'ip_lantern', key: `sessions/${SID}/${assetId}`, url: `/u/${assetId}`,
  contentType: 'application/octet-stream', meta: {}, createdAt: at('03:01:30.000') });
const job = (jobId: string, kind: Job['kind'], status: Job['status'], extra: Partial<Job> = {}): Job => ({ jobId, kind, provider: 'img3d', status,
  input: { ipId: 'ip_lantern' }, outputs: [], deps: [], progress: '', createdAt: at('03:12:00.000'), updatedAt: at('03:12:30.000'), ...extra });
const snap = (extra: Partial<Snapshot> = {}): Snapshot => ({ session, messages: [], ips: [lantern], assets: [asset('ast_img', 'image'), asset('ast_cut', 'cutout')],
  jobs: [], games: [], ...extra });

let served: Snapshot; // what GET /api/sessions/{id} answers now
let calls: { method: string; url: string; body?: unknown }[]; // every other request the page made
let answer: (method: string, url: string, body: unknown) => unknown; // what those answer (and what they change)
let root: Root | null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} }); // the game pane's sticky header
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32)); // the body hash, without a real async hop
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('ipverse.tokens', JSON.stringify({ access: 'tok', exp: Date.now() + 3_600_000 }));
  history.replaceState(null, '', `#s=${SID}`);
  calls = [];
  answer = () => ({});
  root = null;
  const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (url === `/api/sessions/${SID}` && method === 'GET') return reply(served);
    if (url === '/api/sessions') return reply({ sessions: [{ sessionId: SID, title: session.title, genre: session.genre, createdAt: session.createdAt }] });
    if (url === '/api/connections') return reply({ platform: [], servers: [] });
    if (url === '/api/agents') return reply({ agents: [] });
    if (url === '/api/agents/inbox') return reply({ notes: [] });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.startsWith('/api/')) calls.push({ method, url, ...(body === undefined ? {} : { body }) }); // not a game's files on the CDN
    return reply(answer(method, url, body));
  }));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

async function open(hash = '') {
  history.replaceState(null, '', `#s=${SID}${hash}`);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<App />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const press = async (el: HTMLElement) => { await act(async () => { el.click(); }); await settle(); };
const byText = <T extends HTMLElement = HTMLButtonElement>(selector: string, text: string, within: ParentNode = document) =>
  [...within.querySelectorAll<T>(selector)].find((el) => el.textContent?.trim() === text)!;
const toasts = () => [...document.querySelectorAll('.toast-text')].map((t) => t.textContent);

describe('R20-41 작업 현황 stops a job', () => {
  it('sends 중지 for the row and says so', async () => {
    served = snap({ jobs: [job('job_mesh', 'mesh3d', 'running')] });
    answer = (method, url) => {
      if (method === 'POST' && url.endsWith('/jobs/job_mesh/cancel')) served = snap({ jobs: [job('job_mesh', 'mesh3d', 'failed', { error: '사용자가 중지함' })] });
      return { canceled: 'job_mesh' };
    };
    await open('&ip=pipeline');
    await press(byText('.job[data-job="job_mesh"] button', '중지'));
    expect(calls).toEqual([{ method: 'POST', url: `/api/sessions/${SID}/jobs/job_mesh/cancel`, body: {} }]);
    expect(toasts()).toContain('작업을 중지했어요. 작업 현황 탭에서 다시 시도할 수 있어요.');
    expect(document.querySelector('.job[data-job="job_mesh"] .job-error')!.textContent).toBe('중지한 작업이에요. ‘다시 시도’를 누르면 다시 시작돼요.');
  });
});

describe('R20-23 게시하기 on a published game: its address, and 게시 내리기', () => {
  const game: Game = { gameId: 'gm_1', title: '달빛 숲의 별조각', genre: 'rpg-quest', specKey: 'games/gm_1/spec.json',
    previewUrl: '/games/gm_1/index.html', publishedUrl: '/games/gm_1/index.html', publishedAt: at('04:30:00.000'), createdAt: at('03:20:00.000') };

  it('takes the game down through the server and shows it as not published', async () => {
    served = snap({ games: [game] });
    answer = (method, url) => {
      if (method !== 'DELETE' || !url.endsWith('/publish/gm_1')) return {};
      served = snap({ games: [{ ...game, publishedUrl: undefined, publishedAt: undefined }] });
      return { unpublished: 'gm_1' };
    };
    await open();
    expect(document.querySelector('.preview-title .badge')!.textContent).toBe('게시됨');
    await press(byText('.topbar button', '게시하기'));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector<HTMLInputElement>('.publish-result input')!.value).toBe(`${location.origin}/games/gm_1/index.html`); // a whole address
    expect(calls).toEqual([]); // opening it publishes nothing
    await press(byText('button', '게시 내리기', dialog));
    await press(byText('button', '게시 내리기', document.querySelector<HTMLElement>('[role="alertdialog"]')!));
    expect(calls).toEqual([{ method: 'DELETE', url: `/api/sessions/${SID}/publish/gm_1` }]);
    expect(toasts()).toContain('게시를 내렸어요.');
    expect(dialog.querySelector('.publish-result')).toBeNull();
    expect(document.querySelector('.preview-title .badge')).toBeNull(); // the pane read the new snapshot
  });
});

describe('R20-39 ✎ 게임 설계 with a game on screen leads to 이 게임 수정', () => {
  const game = (gameId: string, title: string, createdAt: string): Game => ({ gameId, title, genre: 'rpg-quest', specKey: `games/${gameId}/spec.json`,
    previewUrl: `/games/${gameId}/index.html`, createdAt });

  it('opens the edit drawer of the newest game in place of the new-game form', async () => {
    served = snap({ games: [game('gm_1', '달빛 숲의 별조각', at('04:00:00.000')), game('gm_2', '달빛 숲의 별조각: 30초 생존', at('04:18:00.000'))] });
    await open();
    await press(byText('.pane-head button', '✎ 게임 설계'));
    expect(document.querySelector('#design-title')!.textContent).toBe('새 게임 설계');
    await press(byText('.design-edit-offer button', '이 게임 수정'));
    expect(document.querySelector('#design-title')).toBeNull();
    expect(document.querySelector('#game-edit-title')!.textContent).toBe('이 게임 수정');
    expect(document.querySelector('#game-edit-intro')!.textContent).toContain('“달빛 숲의 별조각: 30초 생존”(v2)');
  });
});

describe('R20-50 버전 기록 and a big picture cover the studio: the page behind is inert', () => {
  const app = () => document.querySelector<HTMLElement>('.app')!;

  it('makes the page inert while 버전 기록 is open and hands focus back to its chip', async () => {
    served = snap();
    await open('&ip=props');
    const chip = document.querySelector<HTMLButtonElement>('button[aria-label^="반딧불 등불 버전 기록"]')!;
    chip.focus();
    await press(chip);
    const drawer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect([app().hasAttribute('inert'), app().contains(drawer), drawer.contains(document.activeElement)]).toEqual([true, false, true]);
    await press(byText('.dialog-footer button', '닫기', drawer));
    expect([app().hasAttribute('inert'), document.querySelector('[role="dialog"]'), document.activeElement]).toEqual([false, null, chip]);
  });

  it('does the same for a picture opened big', async () => {
    served = snap();
    await open('&ip=props');
    const picture = document.querySelector<HTMLButtonElement>('button[aria-label="반딧불 등불 그림 크게 보기"]')!;
    picture.focus();
    await press(picture);
    expect([app().hasAttribute('inert'), document.querySelector('[role="dialog"] h2')!.textContent]).toEqual([true, '반딧불 등불 · v1']);
    await press(document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="닫기"]')!);
    expect([app().hasAttribute('inert'), document.activeElement]).toEqual([false, picture]);
  });

  it('lets the page go when the IP of an open 버전 기록 leaves the session', async () => {
    served = snap();
    await open('&ip=props');
    await press(document.querySelector<HTMLButtonElement>('button[aria-label^="반딧불 등불 버전 기록"]')!);
    expect(app().hasAttribute('inert')).toBe(true);
    served = snap({ ips: [], assets: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); // the next poll of an idle session
    expect([document.querySelector('[role="dialog"]'), app().hasAttribute('inert')]).toEqual([null, false]);
  });
});
