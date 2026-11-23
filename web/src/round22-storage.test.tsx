import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A browser that blocks a site's data throws a SecurityError at the very read of window.localStorage, and one throw
// while React draws leaves a white page: storage is read behind a guard and the page has an error boundary.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const { default: App } = await import('./App');
const { ErrorBoundary } = await import('./components/ErrorBoundary');
const { Fold } = await import('./components/Fold');
const { local, session } = await import('./storage');
const auth = await import('./auth');

let container: HTMLDivElement;
let root: Root;
const kept: Record<string, PropertyDescriptor | undefined> = {};
/** Site data blocked: the read of either storage throws, as the browser does. */
function blockStorage() {
  for (const name of ['localStorage', 'sessionStorage']) {
    kept[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
  }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response));
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const [name, d] of Object.entries(kept)) { if (d) Object.defineProperty(globalThis, name, d); delete kept[name]; }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = (node: ReactNode) => act(async () => root.render(node));

describe('one safe way to the browser\'s storage', () => {
  it('reads, writes and removes when storage is there', () => {
    expect(local.set('k', '1')).toBe(true);
    expect([local.get('k'), localStorage.getItem('k'), session.get('k')]).toEqual(['1', '1', null]);
    local.remove('k');
    expect(local.get('k')).toBeNull();
  });
  it('answers "nothing kept" and never throws when storage is blocked', () => {
    blockStorage();
    expect([local.get('k'), session.get('k'), local.set('k', '1'), session.set('k', '1')]).toEqual([null, null, false, false]);
    expect(() => { local.remove('k'); session.remove('k'); }).not.toThrow();
  });
  it('a fold with a remembered state opens and shuts without it', async () => {
    blockStorage();
    await render(<Fold id="f" title="에이전트" storageKey="ipverse.fold.f"><p>안</p></Fold>);
    const head = container.querySelector<HTMLButtonElement>('#f-head')!;
    await act(async () => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('a browser with site data blocked gets the login page, with the reason, not a white page', () => {
  it('shows the login form and says in one sentence why a login cannot be kept', async () => {
    blockStorage();
    await render(<App />);
    expect(container.querySelector('form.login-card')).not.toBeNull();
    expect(container.querySelector('.notice')!.textContent).toBe(auth.NO_STORAGE);
    expect(auth.NO_STORAGE).toBe('브라우저에서 쿠키와 사이트 데이터를 허용해야 로그인할 수 있어요.');
  });
  it('a login tried anyway fails with that sentence', async () => {
    blockStorage();
    await expect(auth.demoLogin()).rejects.toThrow(auth.NO_STORAGE);
    expect(auth.token()).toBeNull();
  });
  it('says nothing of the kind when storage works', async () => {
    await render(<App />);
    expect(container.querySelector('form.login-card')).not.toBeNull();
    expect(container.querySelector('.notice')).toBeNull();
  });
});

describe('a part of the studio that throws while it is drawn leaves a sentence and 새로고침, not a white page', () => {
  const Broken = (): ReactNode => { throw new Error('boom'); };
  it('shows the sentence with a button that loads the page again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // React reports the caught error
    const reload = vi.fn();
    await render(<ErrorBoundary onReload={reload}><Broken /></ErrorBoundary>);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('화면을 표시하다 문제가 생겼어요. 새로고침해 주세요.');
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe('새로고침');
    await act(async () => button.click());
    expect(reload).toHaveBeenCalledOnce();
  });
  it('draws what it holds when nothing throws', async () => {
    await render(<ErrorBoundary><p>스튜디오</p></ErrorBoundary>);
    expect(container.textContent).toBe('스튜디오');
  });
});
