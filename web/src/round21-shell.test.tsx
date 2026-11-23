import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from './api';
import type { SessionSummary, Snapshot } from './types';

vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const { default: App } = await import('./App');

// The studio shell: the whole studio is mounted over a fake API, as the page calls it.
const at = (clock: string) => `2026-11-17T${clock}Z`;
const summary = (sessionId: string, title: string, clock = '03:00:00'): SessionSummary => ({ sessionId, title, genre: 'sf-shooter', createdAt: at(clock) });
const snapOf = (s: SessionSummary, extra: Partial<Snapshot> = {}): Snapshot => ({
  session: { ...s, concept: null }, messages: [], ips: [], assets: [], jobs: [], games: [], ...extra });
const A = summary('ses_aaaaaaaaaa', '달빛 온실의 정원사', '03:10:00');
const B = summary('ses_bbbbbbbbbb', '네온 골목의 배달부', '03:05:00');
const SCOUT: Agent = { agentId: 'ag_1', name: '모델 스카우트', instructions: '새 모델을 찾아 알려 줘', scheduleLabel: '매일 오전 9시', cron: 'cron(0 9 * * ? *)',
  enabled: true, builtin: true, lastRun: null };

let sessions: SessionSummary[]; // the account's sessions, newest first
let snaps: Map<string, Snapshot>;
let calls: { method: string; url: string; body?: Record<string, unknown> }[];
let down: boolean; // no API call gets an answer (the connection is cut)
let dead: (url: string, method: string) => boolean; // ... or only these calls get none
let status: Record<string, number>; // an answer other than 200, by path ("/api/sessions")
let made: number;
let root: Root | null;
let container: HTMLDivElement;

const reply = (data: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => data }) as unknown as Response;
const signIn = (extra: object = { user: 'luna' }) =>
  sessionStorage.setItem('ipverse.tokens', JSON.stringify({ access: 'tok', exp: Date.now() + 3_600_000, ...extra }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} }); // the game pane's sticky header
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32)); // the body hash, without a real async hop
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', location.pathname);
  sessions = [A, B];
  snaps = new Map([[A.sessionId, snapOf(A)], [B.sessionId, snapOf(B)]]);
  calls = [];
  down = false;
  dead = () => false;
  status = {};
  made = 0;
  root = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/config.json') return reply({ region: 'us-east-1', userPoolId: 'p', clientId: 'c' });
    if (down || dead(url, method)) throw new TypeError('Failed to fetch');
    if (status[url] && method === 'GET') return reply({ error: 'internal' }, status[url]);
    if (url === '/api/sessions' && method === 'GET') return reply({ sessions });
    if (url === '/api/sessions' && method === 'POST') {
      const s = summary(`ses_new${++made}`, typeof body.title === 'string' ? body.title : '새 세션', '04:00:00');
      sessions = [s, ...sessions];
      snaps.set(s.sessionId, snapOf(s));
      return reply({ session: snapOf(s).session }, 201);
    }
    const one = url.match(/^\/api\/sessions\/([^/]+)(\/chat)?$/);
    if (one) {
      const snap = snaps.get(decodeURIComponent(one[1]));
      if (!snap) return reply({ error: 'not_found', message: '세션을 찾을 수 없습니다' }, 404);
      if (one[2]) return reply({ messageId: 'm' }, 202);
      if (method === 'PATCH') {
        const next = { ...snap, session: { ...snap.session, title: String(body.title) } };
        snaps.set(snap.session.sessionId, next);
        sessions = sessions.map((s) => (s.sessionId === snap.session.sessionId ? { ...s, title: String(body.title) } : s));
        return reply(next);
      }
      return reply(snap);
    }
    if (url === '/api/connections') return reply({ platform: [{ id: 'imagegen', name: '이미지 생성', status: 'connected' }], servers: [] });
    if (url === '/api/agents') return reply({ agents: [SCOUT] });
    if (url === '/api/agents/inbox') return reply({ notes: [] });
    return reply({ error: 'not_found' }, 404);
  }));
});
afterEach(async () => {
  await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** A page load at this address (the browser's storage stays). */
async function open(hash = '') {
  history.replaceState(null, '', hash || location.pathname);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<App />); });
  await tick();
}
async function close() {
  if (!root) return;
  await act(async () => root!.unmount());
  container.remove();
  root = null;
}
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await tick(); };
const type = (el: HTMLTextAreaElement | HTMLInputElement, text: string) => act(async () => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const composer = () => $<HTMLTextAreaElement>('#composer')!;
const toasts = () => $$('.toast').map((t) => ({ text: t.querySelector('.toast-text')!.textContent, clock: !!t.querySelector('.toast-life') }));
const asked = (url: string, method = 'GET') => calls.filter((c) => c.url === url && c.method === method).length;
const OFFLINE = '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.';

// After a short outage every block that failed to load (the session list, 에이전트, 연결 서비스, the chat) says so in
// its place and loads again by itself; no toast or spinner is left over.
describe('what a short outage left unloaded comes back by itself (new finding 5, R20-43)', { timeout: 30_000 }, () => {
  it('a reload during an outage says what did not load, without a toast and without a spinner beside it', async () => {
    down = true;
    signIn();
    await open(`#s=${A.sessionId}`);
    expect($('main .load-error p')!.textContent).toBe(`세션을 불러오지 못했어요. ${OFFLINE}`);
    expect(toasts()).toEqual([]); // each failed load is said where its content would be
    // the chat beside it does not say "loading"
    expect($('.chat-log .spinner')).toBeNull();
    expect($('.chat-log .chat-hint')!.textContent).toBe('세션을 불러오지 못했어요.');
    expect([composer().placeholder, $('#composer-help')!.textContent]).toEqual(['세션을 불러오지 못했어요.', '세션을 불러오지 못했어요.']);
    // the sidebar's three blocks: failed, not loading
    expect($('#sidebar .side-scroll > .load-error p')!.textContent).toBe(`세션 목록을 불러오지 못했어요. ${OFFLINE}`);
    expect($('#conn-acc-region .load-error p')!.textContent).toBe(`연결 상태를 불러오지 못했어요. ${OFFLINE}`);
    expect($('#work-acc-region .agent-part .sidebar-empty')!.textContent).toBe('에이전트 목록을 불러오지 못했어요. 연결되면 다시 불러와요.');
  });

  it('when the server answers again, the session, the list, the connections and the agents load without a press', async () => {
    down = true;
    signIn();
    await open(`#s=${A.sessionId}`);
    await tick(14_000); // a short outage
    expect($('main .load-error')).not.toBeNull();
    down = false;
    await tick(10_000); // the session's own poll, at the latest
    expect($$('.load-error')).toEqual([]);
    expect($('.hero-title')!.textContent).toBe(A.title);
    expect($$('.session-list .session-title').map((t) => t.textContent)).toEqual([A.title, B.title]);
    expect($$('.conn-mini-name').map((t) => t.textContent)).toEqual(['이미지 생성']);
    expect($$('.agent-list .agent-name').map((t) => t.textContent)).toEqual(['모델 스카우트']);
    expect($('.chat-log .chat-intro')).not.toBeNull();
    expect(composer().placeholder).toBe('만들고 싶은 것이나 바꾸고 싶은 내용을 적어 주세요');
    expect(toasts()).toEqual([]);
  });

  it('on the start screen, where no session is polled, the list is tried again by itself', async () => {
    down = true;
    signIn();
    await open();
    expect($$('.load-error p').map((p) => p.textContent)).toContain(`세션 목록을 불러오지 못했어요. ${OFFLINE}`);
    await tick(5_000);
    expect($('.start .load-error')).not.toBeNull(); // still down: still said, not a skeleton in between
    expect($('.start-section[aria-busy="true"]')).toBeNull();
    down = false;
    await tick(5_000);
    expect($$('.load-error')).toEqual([]);
    expect($$('.start-session-title').map((t) => t.textContent)).toEqual([A.title, B.title]);
    expect($$('.conn-mini-name').map((t) => t.textContent)).toEqual(['이미지 생성']);
    expect($$('.agent-list .agent-name').map((t) => t.textContent)).toEqual(['모델 스카우트']);
    const before = calls.length;
    await tick(30_000);
    expect(calls.slice(before).filter((c) => c.url === '/api/sessions' || c.url === '/api/connections')).toEqual([]); // loaded: nothing is asked again
  });

  it('the browser saying it is online again tries at once', async () => {
    down = true;
    signIn();
    await open();
    down = false;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await tick();
    expect($$('.start-session-title').map((t) => t.textContent)).toEqual([A.title, B.title]);
  });

  it('a list the server answered with an error waits for 다시 시도: it is not asked for in a loop', async () => {
    status['/api/sessions'] = 500;
    signIn();
    await open();
    expect($('.start .load-error p')!.textContent).toContain('세션 목록을 불러오지 못했어요.');
    await tick(60_000);
    expect(asked('/api/sessions')).toBe(1);
    delete status['/api/sessions'];
    await click($('.start .load-error button'));
    expect($$('.start-session-title').map((t) => t.textContent)).toEqual([A.title, B.title]);
  });

  it('a list answered with an error is not asked again while the connections, which got no answer, are', async () => {
    // with the list on 500 and the connections cut, the retry asks for both, not for the list without end
    status['/api/sessions'] = 500;
    dead = (url) => url === '/api/connections';
    signIn();
    await open();
    await tick(60_000);
    expect(asked('/api/sessions')).toBe(1);
    expect(asked('/api/connections')).toBeGreaterThan(1);
    dead = () => false;
    await tick(10_000);
    expect($('#conn-acc-region .load-error')).toBeNull();
  });

  it('the connections say when they did not load, with 다시 시도, and no toast', async () => {
    status['/api/connections'] = 500;
    signIn();
    await open();
    expect($('#conn-acc-region .load-error p')!.textContent).toBe('연결 상태를 불러오지 못했어요. 요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요. (오류 500)');
    expect(toasts()).toEqual([]);
    delete status['/api/connections'];
    await click($('#conn-acc-region .load-error button'));
    expect($$('.conn-mini-name').map((t) => t.textContent)).toEqual(['이미지 생성']);
  });

  it('a toast that said the server could not be reached runs out once it can be', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    down = true;
    await type(composer(), '꼬마 마법사를 그려줘');
    await click($('.composer-send'));
    expect(toasts()).toEqual([{ text: OFFLINE, clock: false }]); // what failed stays said
    await tick(10_000); // the poll fails too: the page knows the connection is cut
    expect($$('.status-pill').map((p) => p.textContent)).toEqual(['연결 끊김 · 다시 연결 중']);
    expect(toasts()).toEqual([{ text: OFFLINE, clock: false }]);
    down = false;
    await tick(10_000);
    expect($$('.status-pill').map((p) => p.textContent)).toEqual(['자동 저장됨']);
    expect(toasts()).toEqual([{ text: OFFLINE, clock: true }]); // no longer true: it closes by itself
    expect(composer().value).toBe('꼬마 마법사를 그려줘'); // the line that was not sent is still in the box
    // jsdom has no AnimationEvent, so React listens for the prefixed name there: send both, one is heard
    await act(async () => { for (const name of ['animationend', 'webkitAnimationEnd']) $('.toast-life')!.dispatchEvent(new Event(name, { bubbles: true })); });
    expect(toasts()).toEqual([]);
  });

  it('a send that failed while the session went on answering keeps its toast: nothing says the connection came back', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    dead = (url) => url.endsWith('/chat');
    await type(composer(), '꼬마 마법사를 그려줘');
    await click($('.composer-send'));
    await tick(30_000);
    expect(toasts()).toEqual([{ text: OFFLINE, clock: false }]);
  });
});

// At 390 px wide the crumb to the start screen is not shown: the logo is a link and the drawer has a row for it.
describe('the start screen can be reached from a session at any width (new finding 9)', { timeout: 30_000 }, () => {
  it('the logo is a link to it', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    const logo = $<HTMLAnchorElement>('a.topbar-logo')!;
    expect([logo.title, logo.textContent]).toEqual(['시작 화면으로', 'IPverse']);
    await click(logo);
    expect($('.start h2')!.textContent).toBe('아이디어 한 줄로 시작해요');
    expect(location.hash).not.toContain('s=');
    expect($('a.topbar-logo')).toBeNull(); // on the start screen itself it is the logo, not a link to where one is
    expect($('.topbar-logo')!.textContent).toBe('IPverse');
  });

  it('the ☰ drawer has a row that goes there, and closes', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    await click($('.menu-btn'));
    const home = $<HTMLButtonElement>('#sidebar .side-home')!;
    expect(home.textContent).toBe('시작 화면');
    await click(home);
    expect($('.start h2')).not.toBeNull();
    expect($('#sidebar')!.classList.contains('is-open')).toBe(false);
    expect($('#sidebar .side-home')).toBeNull(); // nowhere to go from the start screen
  });

  it('a session that did not load can be left the same way', async () => {
    status[`/api/sessions/${A.sessionId}`] = 500;
    signIn();
    await open(`#s=${A.sessionId}`);
    expect($('main .load-error')).not.toBeNull();
    await click($('a.topbar-logo'));
    expect($('.start h2')).not.toBeNull();
  });

  it('the top bar\'s title, cut at its width, says the whole name on hover (new finding 30)', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    expect($('.topbar-title')!.title).toBe(A.title);
  });
});

// The server's default genre (server/store.py DEFAULT_GENRE), which nobody chose, is not shown before the session has a game.
describe('a session does not wear the server\'s default genre before it has a game (R20-49)', { timeout: 30_000 }, () => {
  const concept = { title: '달빛 온실', logline: '달빛 온실을 지키는 정원사', style: '따뜻한 3D', palette: ['#5de6cf'] };
  const game = { gameId: 'gm_1', title: '달빛 온실 방어전', genre: 'sf-shooter' as const, specKey: 'games/gm_1/spec.json', previewUrl: '/games/gm_1/index.html', createdAt: at('04:00:00') };
  const chips = () => $$('.hero-chip').map((c) => c.textContent);
  const settings = () => $('#game-settings-head')!.textContent;

  it('a new session and one with a concept alone name no genre, on the title row or in the game pane', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    expect([chips(), settings()]).toEqual([[], '게임 설정']);
    await close();
    snaps.set(A.sessionId, snapOf(A, { session: { ...A, concept } }));
    await open(`#s=${A.sessionId}`);
    expect([chips(), settings()]).toEqual([['공통 IP · 0개'], '게임 설정']);
  });

  it('with a game, and with a genre the user chose, it is said', async () => {
    snaps.set(A.sessionId, snapOf(A, { session: { ...A, concept }, games: [game] }));
    signIn();
    await open(`#s=${A.sessionId}`);
    expect(chips()).toEqual(['SF 슈터', '공통 IP · 0개']);
    expect(settings()).toBe('게임 설정SF 슈터 · v1 · 브라우저');
    await close();
    snaps.set(B.sessionId, snapOf({ ...B, genre: 'rpg-explore' }));
    await open(`#s=${B.sessionId}`);
    expect([chips(), settings()]).toEqual([['RPG 탐험'], '게임 설정RPG 탐험']);
  });
});

// Typing past 60 characters does nothing, so the count says the field is full.
describe('a name field says when it is full (new finding 30)', { timeout: 30_000 }, () => {
  const sixty = '달빛 아래 잠든 고대 도서관을 지키는 꼬마 로봇 사서와 길 잃은 별고래의 아주 긴 모험 이야기 그 첫 번째권';

  it('the title row\'s field: the count turns into a note at 60 characters', async () => {
    expect(sixty).toHaveLength(60);
    signIn();
    await open(`#s=${A.sessionId}`);
    await click($('.hero-rename'));
    await type($<HTMLInputElement>('#session-title-input')!, sixty.slice(0, 59));
    expect([$('#session-title-count')!.textContent, $('#session-title-count')!.classList.contains('is-full')]).toEqual(['59/60', false]);
    await type($<HTMLInputElement>('#session-title-input')!, sixty);
    expect([$('#session-title-count')!.textContent, $('#session-title-count')!.classList.contains('is-full')]).toEqual(['60/60 · 최대 60자예요', true]);
    expect($('#session-title-count')!.getAttribute('role')).toBe('status'); // said when it is reached
  });

  it('a list row\'s field says the same', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    await click($$('.session-rename')[1]);
    const field = $<HTMLInputElement>('.session-rename-form input')!;
    await type(field, sixty);
    expect([$('.session-rename-count')!.textContent, $('.session-rename-count')!.classList.contains('is-full')]).toEqual(['60/60 · 최대 60자예요', true]);
    await type(field, '네온 골목');
    expect([$('.session-rename-count')!.textContent, $('.session-rename-count')!.classList.contains('is-full')]).toEqual(['5/60', false]);
  });
});

// Sessions opened from the start screen's examples must not all read 새 세션 in the list.
describe('a session opened from an idea is named after it (new finding 32)', () => {
  it('takes what the idea asks for, without the asking, within the name\'s 60 characters', async () => {
    const { IDEAS, ideaTitle } = await import('./ideas');
    expect(IDEAS.map(ideaTitle)).toEqual(['우주 고양이 탐험가와 탐사용 드론', '숲을 지키는 꼬마 궁수와 나무 정령', '네온 도시의 배달 로봇과 호버 스쿠터',
      '사막 유적을 탐험하는 고고학자와 황금 나침반']);
    expect(ideaTitle('달빛 숲의 꼬마 마법사 그려줘.')).toBe('달빛 숲의 꼬마 마법사');
    expect(ideaTitle('30초 생존 게임')).toBe('30초 생존 게임'); // nothing asked for: as it is
    expect([...ideaTitle(`${'가'.repeat(80)}를 만들어줘`)]).toHaveLength(60);
  });

  it('a new session from 새 세션 시작 keeps the server\'s name: its first concept names it', async () => {
    signIn();
    await open();
    await click($('.start-new'));
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/sessions')!.body).toEqual({});
  });
});
