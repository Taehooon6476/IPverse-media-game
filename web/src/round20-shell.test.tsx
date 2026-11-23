import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Game, Ip, Snapshot } from './types';

// Opening a session is a step in the history: the browser's Back closes what was open over it (the live console,
// 장르 스킬, an edit drawer) instead of leaving its flags set. The whole studio is mounted over a fake API, as the
// page polls it.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const { default: App } = await import('./App');

const A = 'ses_aaaaaaaaaa';
const B = 'ses_bbbbbbbbbb';
const at = (clock: string) => `2026-11-16T${clock}Z`;
const sessionOf = (sessionId: string, title: string) => ({ sessionId, title, genre: 'rpg-quest' as const, concept: null, createdAt: at('03:00:00.000') });
// a prop with a model: its card's primary button is 수정하기
const lantern: Ip = { ipId: 'ip_lantern', kind: 'prop', name: '반딧불 등불', description: '', version: 1, imageAssetId: 'ast_img', cutoutAssetId: 'ast_cut',
  glbAssetId: 'ast_glb', createdAt: at('03:01:00.000') };
const asset = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, ipId: 'ip_lantern', key: `sessions/${A}/${assetId}`, url: `/u/${assetId}`,
  contentType: 'application/octet-stream', meta: {}, createdAt: at('03:01:30.000') });
const game: Game = { gameId: 'gm_1', title: '달빛 숲의 별조각', genre: 'rpg-quest', specKey: 'games/gm_1/spec.json',
  previewUrl: '/games/gm_1/index.html', createdAt: at('03:20:00.000') };

let snaps: Record<string, Snapshot>;
/** What GET /api/sessions/{id} answers in place of the session, when set: [status, body]. */
let gone: [number, unknown] | null;
let calls: { method: string; url: string; body?: { text?: string } }[]; // every POST the page made
let made: number;
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
  sessionStorage.setItem('ipverse.tokens', JSON.stringify({ access: 'tok', exp: Date.now() + 3_600_000, user: 'luna' }));
  snaps = {
    [A]: { session: sessionOf(A, '별빛 숲의 리라'), messages: [], ips: [lantern],
      assets: [asset('ast_img', 'image'), asset('ast_cut', 'cutout'), asset('ast_glb', 'glb')], jobs: [], games: [game] },
    [B]: { session: sessionOf(B, '네온 골목의 배달부'), messages: [], ips: [], assets: [], jobs: [], games: [] },
  };
  gone = null;
  calls = [];
  made = 0;
  root = null;
  const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/demo-login') return reply({ AccessToken: 'demo', RefreshToken: 'r', ExpiresIn: 3600 });
    if (method === 'POST') calls.push({ method, url, body });
    if (url === '/api/sessions' && method === 'POST') {
      const s = sessionOf(`ses_new${++made}`, '새 세션');
      snaps[s.sessionId] = { session: s, messages: [], ips: [], assets: [], jobs: [], games: [] };
      return reply({ session: s }, 201);
    }
    const one = url.match(/^\/api\/sessions\/([^/]+)(\/chat)?$/);
    if (one && snaps[one[1]]) {
      if (one[2]) return reply({ messageId: 'm' }, 202);
      return gone ? reply(gone[1], gone[0]) : reply(snaps[one[1]]);
    }
    if (url === '/api/sessions') return reply({ sessions: Object.values(snaps).map(({ session: s }) => ({ sessionId: s.sessionId, title: s.title, genre: s.genre, createdAt: s.createdAt })) });
    if (url === '/api/connections') return reply({ platform: [], servers: [] });
    if (url === '/api/agents') return reply({ agents: [] });
    if (url === '/api/agents/inbox') return reply({ notes: [] });
    return reply({ error: 'not_found' }, 404);
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

async function open(hash: string) {
  history.replaceState(null, '', hash);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<App />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const press = async (el: HTMLElement | null | undefined) => { await act(async () => { el!.click(); }); await settle(); };
const byText = (selector: string, text: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text);
/** The browser's Back (or Forward): the address is an older entry's and popstate fires. */
const back = async (hash: string) => {
  await act(async () => { history.replaceState(null, '', hash || location.pathname); window.dispatchEvent(new PopStateEvent('popstate')); });
  await settle();
};
const app = () => $('.app')!;
const dialogs = () => document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;
const typeInto = (box: HTMLTextAreaElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
});
/** A key as the page gets it with no dialog on it: nobody takes it away. */
const keyReaches = (key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return !event.defaultPrevented;
};

/** What belongs to the open session: how each is opened, and what is on the page while it is. */
const SESSION_DIALOGS: [name: string, hash: string, open: () => Promise<void>, shown: string][] = [
  ['the live console', '', () => press($('.preview-action-live')), '.game-modal'],
  ['장르 스킬', '', () => press($('.side-nav--skills')), '.drawer--skills'],
  ['an IP\'s edit drawer', '&ip=props', () => press($('.card-action-primary')), '#asset-edit-form'],
  ['이 게임 수정', '', async () => { await press($(`[aria-label="${game.title} 더보기"]`)); await press(byText('[role="menuitem"]', '이 게임 수정')); }, '#game-edit-form'],
  ['새 게임 설계', '', () => press($('.pane-action')), '.design-drawer'],
  ['게시하기', '', () => press(byText('.topbar-actions button', '게시하기')), '#publish-title'],
  ['버전 기록', '&ip=props', () => press($('.version-btn')), '#versions-title'],
];

describe('Back under a dialog of the open session leaves a start screen that works (round20 review, web B1)', { timeout: 30_000 }, () => {
  it.each(SESSION_DIALOGS)('%s is closed with its session: the start screen takes a click and a key', async (_name, hash, show, shown) => {
    await open(`#s=${A}${hash}`);
    await show();
    expect($(shown)).not.toBeNull();
    expect(app().hasAttribute('inert')).toBe(true); // the page behind a dialog
    await back('');
    expect($('main.start')).not.toBeNull();
    expect(dialogs()).toBe(0); // nothing of session A is on top of it
    expect(app().hasAttribute('inert')).toBe(false);
    expect(keyReaches('Tab')).toBe(true); // no trap of a dialog that is gone takes the keys
    expect(keyReaches('Escape')).toBe(true);
    await press($('.start-new'));
    expect(calls.map((c) => c.url)).toEqual(['/api/sessions']);
    expect(location.hash).toBe('#s=ses_new1');
    expect($('#composer')).not.toBeNull(); // the new session is open and can be typed into
    expect(app().hasAttribute('inert')).toBe(false);
  });

  it('Back to another session closes the edit drawer: no request about session A\'s IP reaches session B', async () => {
    await open(`#s=${B}`);
    await back(`#s=${A}&ip=props`); // as after B → A in one tab
    await press($('.card-action-primary'));
    const box = () => $<HTMLTextAreaElement>('#asset-edit-form textarea');
    await typeInto(box()!, '손잡이를 은색으로 바꿔줘');
    await back(`#s=${B}`);
    expect($('.hero-title')!.textContent).toBe('네온 골목의 배달부');
    expect(box()).toBeNull(); // the drawer was session A's
    expect(app().hasAttribute('inert')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('the live console does not follow into another session', async () => {
    await open(`#s=${A}`);
    await press($('.preview-action-live'));
    expect($('.game-modal')).not.toBeNull();
    await back(`#s=${B}`);
    expect($('.game-modal')).toBeNull(); // it showed session A's game over session B
    expect(app().hasAttribute('inert')).toBe(false);
  });

  it('a session that is gone under the open console (deleted in another tab) leaves the start screen working too', async () => {
    await open(`#s=${A}`);
    await press($('.preview-action-live'));
    gone = [404, { error: 'not_found', message: '세션을 찾지 못했어요. 목록에서 다시 골라 주세요.' }];
    await settle(10_000); // the next poll
    expect($('main.start')).not.toBeNull();
    expect($('.start-notice')!.textContent).toBe('주소에 있는 세션을 찾을 수 없어요. 지워졌거나 다른 계정의 세션일 수 있어요.');
    expect(dialogs()).toBe(0);
    expect(app().hasAttribute('inert')).toBe(false);
  });

  it('a login that runs out under 장르 스킬 leaves no flag behind: after the next login the session opens and works', async () => {
    await open(`#s=${A}`);
    await press($('.side-nav--skills'));
    gone = [401, { error: 'unauthorized' }];
    await settle(10_000);
    expect($('.login')).not.toBeNull();
    gone = null;
    await press($('.login-demo button')); // any login: the address still names session A
    expect($('.hero-title')!.textContent).toBe('별빛 숲의 리라');
    expect($('.drawer--skills')).toBeNull();
    expect(app().hasAttribute('inert')).toBe(false);
  });
});

// The message box is emptied by its own line only, not by a line the page sends by itself (장르 스킬's request for a
// hero; the held game request: game-hold.test.tsx).
describe('a line the page sends by itself leaves the message box alone (round20 review, web B2)', { timeout: 30_000 }, () => {
  it('장르 스킬\'s 주인공 만들기 sends its request and keeps the draft', async () => {
    await open(`#s=${A}`);
    await typeInto($<HTMLTextAreaElement>('#composer')!, '등불을 더 밝게');
    await press($('.side-nav--skills'));
    await press($('.skill-card'));
    await press(byText('.skill-steps button', '주인공 만들기'));
    expect(calls.map((c) => c.url)).toEqual([`/api/sessions/${A}/chat`]);
    expect(calls[0].body!.text).toContain('주인공 캐릭터를 한 명 만들고');
    expect($('.drawer--skills')).toBeNull();
    expect($<HTMLTextAreaElement>('#composer')!.value).toBe('등불을 더 밝게');
  });
});

// Only the session handler's own answer (server/app.py _own_session: error "not_found") says the session is gone; a
// 404 from in front of the API (the CDN, a route missing during a deploy) is an outage.
describe('only the server\'s own "not found" closes the open session (round20 review, web)', { timeout: 30_000 }, () => {
  it('a 404 that is not the session handler\'s keeps the session open and says 연결 끊김 until a poll gets through', async () => {
    await open(`#s=${A}`);
    expect($('.hero-title')!.textContent).toBe('별빛 숲의 리라');
    gone = [404, null]; // an error page: no JSON at all
    await settle(10_000);
    expect($('main.start')).toBeNull();
    expect($('.hero-title')!.textContent).toBe('별빛 숲의 리라');
    expect(location.hash).toBe(`#s=${A}`);
    expect([...document.querySelectorAll('.status-pill')].map((p) => p.textContent)).toEqual(['연결 끊김 · 다시 연결 중']);
    gone = [404, { message: 'Not Found' }]; // a gateway's own JSON: no code of the API's
    await settle(10_000);
    expect($('main.start')).toBeNull();
    gone = null;
    await settle(10_000);
    expect([...document.querySelectorAll('.status-pill')].map((p) => p.textContent)).toEqual(['자동 저장됨']);
  });

  it('at the first load such a 404 is a session that did not load, with 다시 시도, and the address stays', async () => {
    gone = [404, null];
    await open(`#s=${A}`);
    expect($('main.start')).toBeNull();
    expect($('main .load-error p')!.textContent).toContain('세션을 불러오지 못했어요.');
    expect(location.hash).toBe(`#s=${A}`);
    gone = null;
    await press($('main .load-error button'));
    expect($('.hero-title')!.textContent).toBe('별빛 숲의 리라');
  });
});
