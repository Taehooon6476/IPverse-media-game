import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary, Snapshot } from './types';

vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const { default: App, pageTitle } = await import('./App');

// A first-time user: what the page says after a sign-up, which session opens after a login, a remembered session of
// another account, and drafts kept per session. The whole studio is mounted over a fake API, as the page calls it.
const at = (clock: string) => `2026-11-16T${clock}Z`;
const summary = (sessionId: string, title: string, clock = '03:00:00'): SessionSummary => ({ sessionId, title, genre: 'sf-shooter', createdAt: at(clock) });
const snapOf = (s: SessionSummary, extra: Partial<Snapshot> = {}): Snapshot => ({
  session: { ...s, concept: null }, messages: [], ips: [], assets: [], jobs: [], games: [], ...extra });
const A = summary('ses_aaaaaaaaaa', '달빛 온실의 정원사', '03:10:00');
const B = summary('ses_bbbbbbbbbb', '네온 골목의 배달부', '03:05:00');

let sessions: SessionSummary[]; // the account's sessions, newest first
let snaps: Map<string, Snapshot>;
let calls: { method: string; url: string; body?: Record<string, unknown> }[];
let listStatus: number; // what GET /api/sessions answers (0: no answer at all)
let getStatus: number; // what GET /api/sessions/{id} answers for a session that exists
let expired: boolean; // every API call answers 401
let made: number;
let root: Root | null;
let container: HTMLDivElement;

const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
const signIn = (extra: object = { user: 'luna' }) =>
  sessionStorage.setItem('ipverse.tokens', JSON.stringify({ access: 'tok', exp: Date.now() + 3_600_000, ...extra }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} }); // the game pane's sticky header
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32)); // the body hash, without a real async hop
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', location.pathname);
  sessions = [A, B];
  snaps = new Map([[A.sessionId, snapOf(A)], [B.sessionId, snapOf(B)]]);
  calls = [];
  listStatus = 200;
  getStatus = 200;
  expired = false;
  made = 0;
  root = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/config.json') return reply({ region: 'us-east-1', userPoolId: 'p', clientId: 'c' });
    if (url.startsWith('https://cognito-idp.')) return reply({ AuthenticationResult: { AccessToken: 'tok2', ExpiresIn: 3600 } });
    if (url === '/api/demo-login') return reply({ AccessToken: 'demo', RefreshToken: 'r', ExpiresIn: 3600 });
    if (expired) return reply({ error: 'unauthorized' }, 401);
    if (url === '/api/sessions' && method === 'GET') {
      if (listStatus === 0) throw new TypeError('Failed to fetch');
      return listStatus === 200 ? reply({ sessions }) : reply({ error: 'internal' }, listStatus);
    }
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
      if (method === 'DELETE') {
        snaps.delete(snap.session.sessionId);
        sessions = sessions.filter((s) => s.sessionId !== snap.session.sessionId);
        return reply({ deleted: snap.session.sessionId });
      }
      if (method === 'PATCH') {
        const next = { ...snap, session: { ...snap.session, title: String(body.title) } };
        snaps.set(snap.session.sessionId, next);
        return reply(next);
      }
      return getStatus === 200 ? reply(snap) : reply({ error: 'internal' }, getStatus);
    }
    if (url === '/api/connections') return reply({ platform: [], servers: [] });
    if (url === '/api/agents') return reply({ agents: [] });
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
const opened = () => calls.filter((c) => c.method === 'GET' && /^\/api\/sessions\/ses_/.test(c.url)).map((c) => c.url.split('/').at(-1));
const toasts = () => $$('.toast-text').map((t) => t.textContent);
const sessionRow = (title: string) => $$<HTMLAnchorElement>('.session-list a.session').find((a) => a.textContent!.includes(title))!;

// the whole studio mounts in each case: a case gets 30 s instead of the default 5
describe('the first screen after a login is the start screen (R20-02, R20-17, R20-40)', { timeout: 30_000 }, () => {
  it('opens no session by itself: what the product makes, one primary button, the examples, the recent sessions', async () => {
    signIn();
    localStorage.setItem('ipverse.lastSession', B.sessionId); // what an older browser remembers
    await open();
    const start = $('main.start')!;
    expect(start.querySelector('h2')!.textContent).toBe('아이디어 한 줄로 시작해요');
    expect(start.querySelector('.start-lead')!.textContent)
      .toBe('아이디어 하나가 캐릭터·소품 그림에서 3D, 영상, 플레이 가능한 게임, 라이브 방송과 광고까지 이어져요.');
    expect([...start.querySelectorAll('.btn-primary')].map((b) => b.textContent)).toEqual(['새 세션 시작']);
    expect(start.querySelectorAll('.start-idea')).toHaveLength(4);
    expect([...start.querySelectorAll('.start-session-title')].map((t) => t.textContent)).toEqual([A.title, B.title]);
    expect(opened()).toEqual([]); // neither the newest nor the remembered one
    expect($('.chat')).toBeNull();
    expect(location.hash).toBe('');
    expect(document.title).toBe('IPverse Studio');
    await tick(10_000);
    expect(opened()).toEqual([]);
  });

  it('a new account sees the same screen without a session list, and 새 세션 시작 opens a session with the caret in its box', async () => {
    sessions = [];
    signIn();
    await open();
    expect($('.start h2')).not.toBeNull();
    expect($('.start-sessions')).toBeNull();
    expect($('#sidebar .sidebar-empty')!.textContent).toBe('아직 세션이 없어요. 위의 ‘새 세션’으로 시작해 보세요.');
    await click($('.start-new'));
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([['/api/sessions', {}]]); // no genre is stamped
    expect(location.hash).toBe('#s=ses_new1');
    expect($('.start')).toBeNull();
    expect(document.activeElement).toBe(composer());
    expect(composer().value).toBe('');
  });

  it('an example makes a session and puts the idea in its chat box, ready to send and not sent', async () => {
    signIn();
    await open();
    const idea = $$('.start-idea')[1];
    await click(idea);
    expect(location.hash).toBe('#s=ses_new1');
    expect(composer().value).toBe('숲을 지키는 꼬마 궁수와 나무 정령을 만들어줘');
    expect(document.activeElement).toBe(composer());
    expect(calls.some((c) => c.url.endsWith('/chat'))).toBe(false);
    expect($('.composer-send')!.getAttribute('aria-disabled')).toBeNull();
    // the session is named after what the idea asks for, not "새 세션"
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/sessions')!.body).toEqual({ title: '숲을 지키는 꼬마 궁수와 나무 정령' });
    expect([$('.hero-title')!.textContent, $$('.session-list .session-title')[0].textContent]).toEqual(['숲을 지키는 꼬마 궁수와 나무 정령', '숲을 지키는 꼬마 궁수와 나무 정령']);
    // the idea is the new session's draft only
    await click(sessionRow(A.title));
    expect(composer().value).toBe('');
  });

  it('opens the session the address names', async () => {
    signIn();
    await open(`#s=${B.sessionId}`);
    expect(opened()).toEqual([B.sessionId]);
    expect($('.hero-title')!.textContent).toBe(B.title);
    expect($('.start')).toBeNull();
  });

  it('an address whose session is gone lands on the start screen with a line that says so, and no error toast', async () => {
    signIn();
    await open('#s=ses_of_another_account');
    expect($('.start h2')).not.toBeNull();
    expect($('.start-notice')!.textContent).toBe('주소에 있는 세션을 찾을 수 없어요. 지워졌거나 다른 계정의 세션일 수 있어요.');
    expect(toasts()).toEqual([]);
    expect(location.hash.replace('#', '')).toBe(''); // the address names no session any more
    expect([...$$('.start-session-title')].map((t) => t.textContent)).toEqual([A.title, B.title]);
    await click($$('.start-session')[0]); // opening one takes the line away
    await click($('.breadcrumb-home'));
    expect($('.start-notice')).toBeNull();
  });

  it('after the open session is deleted the start screen shows, not another session', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    await type(composer(), '지워질 세션의 초안');
    await click($(`.session-list button[aria-label="${A.title} 세션 삭제"]`));
    await click([...$$('[role="alertdialog"] button')].find((b) => b.textContent === '삭제'));
    expect($('.start h2')).not.toBeNull();
    expect([...$$('.start-session-title')].map((t) => t.textContent)).toEqual([B.title]);
    expect(opened()).toEqual([A.sessionId]);
    expect(toasts()).toEqual(['세션을 지웠어요.']);
    expect(sessionStorage.getItem('ipverse.drafts')).toBe('{}'); // its draft went with it
  });

  it('a draft belongs to its session: it does not follow into another one, and a reload keeps it', async () => {
    signIn();
    await open(`#s=${B.sessionId}`);
    await type(composer(), 'B에서 쓰던 문장');
    await click(sessionRow(A.title));
    expect($('.hero-title')!.textContent).toBe(A.title);
    expect(composer().value).toBe('');
    await type(composer(), 'A의 다른 문장');
    await click(sessionRow(B.title));
    expect(composer().value).toBe('B에서 쓰던 문장');
    await close();
    await open(`#s=${A.sessionId}`);
    expect(composer().value).toBe('A의 다른 문장');
  });

  it('when the login runs out, the notice says so in plain words and the same session comes back with its draft', async () => {
    signIn();
    await open(`#s=${B.sessionId}`);
    await type(composer(), '만료 전에 쓰던 문장');
    expired = true;
    await tick(10_000); // the next poll is answered 401
    expect($('.login .notice')!.textContent).toBe('로그인 시간이 지났어요. 다시 로그인하면 하던 작업으로 돌아가요.');
    expect(location.hash).toBe(`#s=${B.sessionId}`);
    expired = false;
    await type($<HTMLInputElement>('#login-username')!, 'luna');
    await type($<HTMLInputElement>('#login-password')!, 'pw');
    await click($('.login-card button[type="submit"]'));
    expect($('.hero-title')!.textContent).toBe(B.title);
    expect(composer().value).toBe('만료 전에 쓰던 문장');
  });

  it('logging out leaves nothing behind: the address, the drafts and the session are gone for the next login', async () => {
    signIn();
    await open(`#s=${B.sessionId}`);
    await type(composer(), '내 초안');
    await click($('.topbar-account'));
    await click([...$$('[role="menuitem"]')].find((i) => i.textContent === '로그아웃'));
    expect($('.login')).not.toBeNull();
    expect($('.login .notice')).toBeNull();
    expect(location.hash.replace('#', '')).toBe(''); // the address names no session any more
    expect(sessionStorage.getItem('ipverse.drafts')).toBe('{}');
    await click($('.login-demo button'));
    expect($('.start h2')).not.toBeNull(); // the demo visitor is not dropped into B
    expect(opened()).toEqual([B.sessionId]);
  });

  it('데모 로그인 says it is a shared account before and after, and the account menu shows who is signed in', async () => {
    await open();
    const demo = $<HTMLButtonElement>('.login-demo button')!;
    expect(demo.textContent).toBe('데모 로그인');
    expect($(`#${demo.getAttribute('aria-describedby')}`)!.textContent).toContain('여러 사람이 함께 쓰는 공용 계정');
    await click(demo);
    // both ways: others' sessions show here, and what is made here shows to them
    expect($$('.start-notice').map((n) => n.textContent)).toEqual(['공용 데모 계정이에요. 다른 사람이 만든 세션이 함께 보이고, 여기서 만든 것도 다른 사람에게 보여요.']);
    expect($('.topbar-account')!.textContent).toBe('데모 계정');
    await click($('.topbar-account'));
    expect($$('[role="menuitem"]').map((i) => i.querySelector('span')!.textContent)).toEqual(['공용 데모 계정으로 로그인 중', '연결 설정', '로그아웃']);
    await close();
    // one's own account: the id typed at the login, and no demo line
    sessionStorage.clear();
    signIn({ user: 'luna_studio' });
    await open();
    expect($('.start-notice')).toBeNull();
    expect($('.topbar-account')!.textContent).toBe('luna_studio');
    await click($('.topbar-account'));
    expect($$('[role="menuitem"]')[0].textContent).toBe('luna_studio 님으로 로그인 중');
  });

  it('Back returns from a session to where the user was (R20-49)', async () => {
    signIn();
    await open();
    const before = history.length;
    await click($$('.start-session')[0]);
    expect(location.hash).toBe(`#s=${A.sessionId}`);
    expect(history.length).toBe(before + 1);
    await click(sessionRow(B.title));
    expect(history.length).toBe(before + 2);
    // Back: the address is A's again
    await act(async () => { history.replaceState(null, '', `#s=${A.sessionId}`); window.dispatchEvent(new PopStateEvent('popstate')); });
    await tick();
    expect($('.hero-title')!.textContent).toBe(A.title);
    // Back again: the start screen
    await act(async () => { history.replaceState(null, '', location.pathname); window.dispatchEvent(new PopStateEvent('popstate')); });
    await tick();
    expect($('.start h2')).not.toBeNull();
    expect($('.chat')).toBeNull();
  });
});

describe('loading, empty and failed are three different screens (R20-43)', { timeout: 30_000 }, () => {
  it('the session list says it is loading, then lists; a new account reads empty only once the answer is in', async () => {
    let answer!: (r: Response) => void;
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input) === '/api/sessions' && (init?.method ?? 'GET') === 'GET'
      ? new Promise<Response>((r) => { answer = r; }) : real(input, init))));
    signIn();
    await open();
    expect($('#sidebar .session-loading [role="status"]')!.textContent).toBe('세션 목록을 불러오고 있어요.');
    expect($('#sidebar .sidebar-empty')).toBeNull();
    expect($('.start-section[aria-busy="true"] [role="status"]')!.textContent).toBe('세션 목록을 불러오고 있어요.');
    await act(async () => { answer(reply({ sessions: [] })); });
    await tick();
    expect($('#sidebar .session-loading')).toBeNull();
    expect($('#sidebar .sidebar-empty')!.textContent).toContain('아직 세션이 없어요.');
  });

  it('a list that did not load says so with 다시 시도, in the sidebar and on the start screen, and no toast', async () => {
    listStatus = 0;
    signIn();
    await open();
    const said = '세션 목록을 불러오지 못했어요. 서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.';
    expect($$('.load-error p').map((p) => p.textContent)).toEqual([said, said]);
    expect($('#sidebar .sidebar-empty')).toBeNull();
    expect(toasts().filter((t) => t!.includes('세션'))).toEqual([]);
    listStatus = 200;
    await click($('.start .load-error button'));
    expect($('.load-error')).toBeNull();
    expect($$('.start-session-title').map((t) => t.textContent)).toEqual([A.title, B.title]);
    expect($$('.session-list .session-title').map((t) => t.textContent)).toEqual([A.title, B.title]);
  });

  it('a session that does not load says so with 다시 시도 instead of skeletons for ever, and comes up when it answers', async () => {
    getStatus = 500;
    signIn();
    await open(`#s=${A.sessionId}`);
    expect($('main .load-error p')!.textContent).toBe('세션을 불러오지 못했어요. 요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요. (오류 500)');
    expect($('.pane[aria-busy="true"]')).toBeNull();
    // the chat beside it says the same, not that it is loading
    expect(composer().placeholder).toBe('세션을 불러오지 못했어요.');
    expect(toasts()).toEqual([]);
    getStatus = 200;
    await click($('main .load-error button'));
    expect($('main .load-error')).toBeNull();
    expect($('.hero-title')!.textContent).toBe(A.title);
  });

  it('an open session that stops answering says 연결 끊김 in the top bar until a poll gets through', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    expect($('.status-pill')!.textContent).toBe('자동 저장됨');
    getStatus = 503;
    await tick(10_000);
    expect($$('.status-pill').map((p) => p.textContent)).toEqual(['연결 끊김 · 다시 연결 중']);
    expect($('.hero-title')!.textContent).toBe(A.title); // what was loaded stays
    expect(toasts()).toEqual([]);
    getStatus = 200;
    await tick(10_000);
    expect($$('.status-pill').map((p) => p.textContent)).toEqual(['자동 저장됨']);
  });
});

describe('sessions: no genre stamp, a name that can be changed, a list that can be searched (R20-49)', { timeout: 30_000 }, () => {
  it('a new session shows no genre; one with a concept shows its own', async () => {
    snaps.set(B.sessionId, snapOf({ ...B, genre: 'rpg-explore' }, {
      session: { ...B, genre: 'rpg-explore', concept: { title: B.title, logline: '골목을 달리는 배달부', style: '네온', palette: ['#ff0000'] } } }));
    signIn();
    await open(`#s=${A.sessionId}`);
    expect($$('.hero-chip').map((c) => c.textContent)).toEqual([]);
    expect($$('.session-list .session-meta').every((m) => !/슈터|RPG/.test(m.textContent!))).toBe(true);
    await click(sessionRow(B.title));
    expect($$('.hero-chip').map((c) => c.textContent)).toEqual(['RPG 탐험', '공통 IP · 0개']);
  });

  it('the name is changed in place: ✎, a field of 60 characters with a count, Enter saves, Esc leaves it', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    await click($('.hero-rename'));
    const field = $<HTMLInputElement>('#session-title-input')!;
    expect([field.value, field.maxLength, document.activeElement === field]).toEqual([A.title, 60, true]);
    await type(field, '달빛 온실 2막');
    expect($('#session-title-count')!.textContent).toBe('8/60');
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect($('.hero-title')!.textContent).toBe(A.title);
    expect(document.activeElement).toBe($('.hero-rename'));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    await click($('.hero-rename'));
    await type($<HTMLInputElement>('#session-title-input')!, '  달빛 온실 2막  ');
    await act(async () => { $('.hero-rename-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await tick();
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])).toEqual([[`/api/sessions/${A.sessionId}`, { title: '달빛 온실 2막' }]]);
    expect($('.hero-title')!.textContent).toBe('달빛 온실 2막');
    expect(sessionRow('달빛 온실 2막')).toBeDefined(); // the list follows
    expect(document.title).toBe('달빛 온실 2막 · IPverse Studio');
  });
});

// A session can be renamed whether or not it is open.
describe('a session is renamed from its row in the list, open or not (R20-49)', { timeout: 30_000 }, () => {
  const rename = async (title: string, to: string) => {
    await click(sessionRow(title).closest('.session-row')!.querySelector('.session-rename'));
    await type($<HTMLInputElement>('.session-rename-form input')!, to);
    await act(async () => { $('.session-rename-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await tick();
  };
  const patches = () => calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body]);

  it('another session\'s name changes on the server and in the lists; the open session stays as it is', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    await rename(B.title, '네온 골목 2막');
    expect(patches()).toEqual([[`/api/sessions/${B.sessionId}`, { title: '네온 골목 2막' }]]);
    expect($$('.session-list .session-title').map((t) => t.textContent)).toEqual([A.title, '네온 골목 2막']);
    expect([$('.hero-title')!.textContent, document.title, location.hash]).toEqual([A.title, `${A.title} · IPverse Studio`, `#s=${A.sessionId}`]);
    await click($('.breadcrumb-home'));
    expect($$('.start-session-title').map((t) => t.textContent)).toEqual([A.title, '네온 골목 2막']); // the start screen's list too
  });

  it('the open session\'s row renames it everywhere: the title row, the top bar and the browser tab follow', async () => {
    signIn();
    await open(`#s=${A.sessionId}`);
    await rename(A.title, '달빛 온실 2막');
    expect(patches()).toEqual([[`/api/sessions/${A.sessionId}`, { title: '달빛 온실 2막' }]]);
    expect([$('.hero-title')!.textContent, $('.topbar-title')!.textContent, document.title]).toEqual(['달빛 온실 2막', '달빛 온실 2막', '달빛 온실 2막 · IPverse Studio']);
    expect(sessionRow('달빛 온실 2막')).toBeDefined();
  });
});

describe('each window of the app says what it is in its tab (R20-52)', () => {
  it('the studio names its open session, the play window and the watch page themselves', () => {
    history.replaceState(null, '', '#s=ses_1');
    expect([pageTitle('달빛 온실의 정원사'), pageTitle()]).toEqual(['달빛 온실의 정원사 · IPverse Studio', 'IPverse Studio']);
    history.replaceState(null, '', '#play=ses_1&g=gm_1');
    expect(pageTitle('달빛 온실의 정원사')).toBe('플레이 창 · IPverse Studio');
    history.replaceState(null, '', '#watch=ses_1');
    expect(pageTitle()).toBe('라이브 시청 · IPverse Studio');
  });
});

// A toast names whose job ended and opens its result; a rejected edit or a card's warning is never the green check.
describe('a job that ends tells whose it was and opens its result (R20-16, R20-09)', { timeout: 30_000 }, () => {
  const lantern = { ipId: 'ip_lantern', kind: 'prop' as const, name: '등불', description: 'a brass lantern', version: 1, imageAssetId: 'ast_l1',
    cutoutAssetId: 'ast_l1c', createdAt: at('03:11:00') };
  const picture = (assetId: string, kind: 'image' | 'cutout') => ({ assetId, kind, ipId: lantern.ipId, key: `k/${assetId}`, url: `/u/${assetId}`,
    contentType: 'image/png', meta: {}, createdAt: at('03:11:00') });
  const draw = (status: 'running' | 'done', extra: object = {}) => ({ jobId: 'job_edit', kind: 'image' as const, provider: 'mediagen_image' as const, status,
    input: { ipId: lantern.ipId, version: 2, edit: 'add a red ribbon' }, outputs: [], deps: [], progress: '', createdAt: at('03:12:00'), updatedAt: at('03:12:30'), ...extra });
  const session = (jobs: object[]) => snapOf(A, { ips: [lantern], assets: [picture('ast_l1', 'image'), picture('ast_l1c', 'cutout')], jobs: jobs as Snapshot['jobs'] });
  const toast = () => $$('.toast').map((t) => [t.className.match(/toast--\w+/)![0], t.querySelector('.toast-text')!.textContent, t.querySelector('.toast-open')?.textContent ?? null]);

  it('a finished picture names its IP, and its link opens the tab where the card is', async () => {
    snaps.set(A.sessionId, session([draw('running')]));
    signIn();
    await open(`#s=${A.sessionId}`);
    expect($('#ip-tab-characters')!.getAttribute('aria-selected')).toBe('true');
    snaps.set(A.sessionId, session([draw('done', { outputs: ['ast_l2', 'ast_l2c'] })]));
    await tick(3000);
    expect(toast()).toEqual([['toast--ok', '등불 이미지 완료', '그림 보기']]);
    await click($('.toast-open'));
    expect($('#ip-tab-props')!.getAttribute('aria-selected')).toBe('true'); // a prop's card is on the 소품 tab
    expect(location.hash).toContain('ip=props');
    expect($('.toast')).toBeNull();
  });

  it('an edit the check kept out of its IP is a warning, never the green 완료', async () => {
    snaps.set(A.sessionId, session([draw('running')]));
    signIn();
    await open(`#s=${A.sessionId}`);
    const note = '수정 검사 실패: 손잡이가 사라짐(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.';
    snaps.set(A.sessionId, session([draw('done', { outputs: ['ast_l2', 'ast_l2c'], error: note, outcome: 'rejected' })]));
    await tick(3000);
    expect(toast()).toEqual([['toast--warn', '등불 수정본(v2)이 검사를 통과하지 못해 적용하지 않았어요: 손잡이가 사라짐. 지금 그림을 그대로 써요.', '그림 보기']]);
    expect($('.toast-icon')!.textContent).toBe('!');
  });

  it('a card button\'s warning comes without the green check', async () => {
    snaps.set(A.sessionId, session([]));
    signIn();
    await open(`#s=${A.sessionId}&ip=props`);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith('/tools/render_3d')
      ? Promise.resolve(reply({ result: { jobId: 'job_mesh', warning: '수정 검사 실패: 손잡이가 사라짐.',
        notice: '수정 검사를 통과하지 못한 그림이라 3D도 그 모습대로 나오니 다시 뽑아 보세요.' } }))
      : real(input, init))));
    await click($$('.card button').find((b) => b.textContent!.includes('3D')));
    expect(toast()).toEqual([['toast--warn', '수정 검사를 통과하지 못한 그림이라 3D도 그 모습대로 나오니 다시 뽑아 보세요.', null]]);
  });
});
