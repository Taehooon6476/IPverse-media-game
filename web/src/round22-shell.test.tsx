import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, Ip, Message, Snapshot } from './types';

// The studio shell: the whole studio is mounted over a fake API, as the page polls it.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const { default: App } = await import('./App');

const SID = 'ses_r22';
const at = (clock: string) => `2026-11-18T${clock}Z`;
const session = { sessionId: SID, title: '별빛 숲의 리라', genre: 'rpg-quest' as const, concept: null, createdAt: at('03:00:00.000') };
const lantern: Ip = { ipId: 'ip_lantern', kind: 'prop', name: '반딧불 등불', description: '', version: 1, imageAssetId: 'ast_img', cutoutAssetId: 'ast_cut',
  glbAssetId: 'ast_glb', createdAt: at('03:01:00.000') };
const asset = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, ipId: 'ip_lantern', key: `sessions/${SID}/${assetId}`, url: `/u/${assetId}`,
  contentType: 'application/octet-stream', meta: {}, createdAt: at('03:01:30.000') });
const snap = (extra: Partial<Snapshot> = {}): Snapshot => ({ session, messages: [], ips: [lantern], assets: [asset('ast_img', 'image'), asset('ast_cut', 'cutout'), asset('ast_glb', 'glb')],
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

// A request answered by a question starts no job: the toast must not promise progress in 작업 현황.
describe('an edit request\'s toast says only what is true when it is sent', () => {
  it('promises an answer in the chat, not a job in 작업 현황', async () => {
    served = snap();
    const said = (messageId: string, role: Message['role'], text: string): Message => ({ messageId, role, text, status: 'done', ts: at('03:20:00.000') });
    answer = (method, url, body) => {
      if (method === 'POST' && url.endsWith('/chat')) {
        served = snap({ messages: [said('m1', 'user', (body as { text: string }).text), said('m2', 'assistant', '어떤 모습으로 바꿀까요?')] });
      }
      return {};
    };
    await open('&ip=props');
    await press(document.querySelector<HTMLButtonElement>('button[aria-label="반딧불 등불 자연어로 수정하기"]')!);
    const box = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, '전혀 다른 물건으로 바꿔줘');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(byText('.dialog-footer button', '수정 요청'));
    expect(calls.map((c) => c.url)).toEqual([`/api/sessions/${SID}/chat`]);
    expect(toasts()).toEqual(['요청을 보냈어요. 답변은 채팅에 보여요.']);
    expect(served.jobs).toEqual([]); // the answer was a question: nothing for 작업 현황 to show
  });
});

// The logo, 시작 화면, a delete and 로그아웃 must not leave a session's tab (#ip=…) in the address.
describe('the start screen\'s and the login page\'s address carries no session state', () => {
  const address = () => `${location.pathname}${location.search}${location.hash}`;

  it('leaves no tab behind on the way to the start screen, as a step Back undoes', async () => {
    served = snap();
    await open('&ip=props&game=play');
    const steps = history.length;
    await press(byText('.side-home', '시작 화면'));
    expect(document.querySelector('#start-title')).not.toBeNull();
    expect(address()).toBe('/');
    expect(history.length).toBe(steps + 1); // Back returns to the session, on its tab
  });

  it('leaves none after a delete of the open session', async () => {
    served = snap();
    answer = () => ({ deleted: SID });
    await open('&ip=props');
    await press(document.querySelector<HTMLButtonElement>(`button[aria-label="${session.title} 세션 삭제"]`)!);
    await press(document.querySelector<HTMLButtonElement>('.btn-danger')!);
    expect(calls.map((c) => c.method)).toContain('DELETE');
    expect(address()).toBe('/');
  });

  it('leaves none on the login page after 로그아웃', async () => {
    served = snap();
    await open('&ip=props');
    await press(byText('.sidebar button', '로그아웃'));
    expect(document.querySelector('.app')).toBeNull();
    expect(address()).toBe('/');
  });
});
