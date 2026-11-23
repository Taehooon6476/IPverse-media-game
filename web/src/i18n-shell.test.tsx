import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Session } from './types';

// The studio's shell in English (web/src/i18n/en-shell.ts): on each main screen nothing a user can read or hear is
// Korean except what the user wrote and what other packages' files say (dates from types.ts, the toggle's 한국어).

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('ipverse.lang', 'en');
  container = document.body.appendChild(document.createElement('div'));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function draw(node: ReactNode): HTMLDivElement {
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}
const click = (el: Element | null | undefined) => act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

/** Every Korean text of a screen: what it shows and what it says to a screen reader or in a tooltip. Not the toggle
 * (it names Korean in Korean) and not a date (types.ts fmtTime, another package's). */
function korean(el: Element): string[] {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.lang-toggle, time, .session-meta').forEach((x) => x.remove());
  const texts = [copy.textContent ?? ''];
  copy.querySelectorAll('*').forEach((x) => {
    for (const name of ['title', 'aria-label', 'placeholder', 'alt', 'value']) if (x.hasAttribute(name)) texts.push(x.getAttribute(name)!);
  });
  return texts.filter((text) => /[가-힣ㄱ-ㅎ]/.test(text));
}

const session: Session = { sessionId: 'ses_en', title: 'Luna of the star forest', genre: 'rpg-quest', concept: null, createdAt: '2026-11-18T03:00:00.000Z' } as Session;
const sessions = Array.from({ length: 10 }, (_, i) => ({ sessionId: `ses_${i}`, title: `Session ${i}`, genre: 'rpg-quest' as const, createdAt: '2026-11-18T03:00:00.000Z' }));

describe('the shell in English', () => {
  it('the login page: logging in, signing up with its rules, and what is wrong with what was typed', async () => {
    const { Login, formProblems } = await import('./components/Login');
    const el = draw(<Login notice={null} onLogin={async () => undefined} onDemo={async () => undefined} />);
    expect(el.querySelector('h1')!.textContent).toBe('Start a new world');
    expect([...el.querySelectorAll('.auth-tab')].map((b) => b.textContent)).toEqual(['Log in', 'Sign up']);
    expect(el.querySelector('.login-foot')!.textContent).toBe('New here? Sign up to get started.');
    expect(el.querySelector('.lang-toggle')!.textContent).toBe('한국어');
    expect(korean(el)).toEqual([]);

    click(el.querySelector('#auth-tab-signup'));
    expect([...el.querySelectorAll('.pw-rules li')].map((li) => li.textContent)).toEqual(['12+ characters', 'uppercase letter', 'lowercase letter', 'number', 'symbol']);
    act(() => { el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(el.querySelector('#login-username-error')!.textContent).toBe('Enter your ID.');
    expect(korean(el)).toEqual([]);

    expect(formProblems('signup', 'a b', 'short', 'x')).toEqual({
      username: 'Use 3–32 letters, numbers, underscores (_), periods (.) or hyphens (-) for the ID.',
      password: 'The password still needs: 12+ characters, uppercase letter, number, symbol.',
    });
    expect(formProblems('signup', 'luna', 'Abcdefghij1!x', 'other').confirm).toBe('The passwords do not match. Check them once more.');
  });

  it('the start screen: its steps, the example ideas in English, the recent sessions', async () => {
    const { StartScreen } = await import('./components/StartScreen');
    const { IDEAS, ideaTitle } = await import('./ideas');
    const el = draw(<StartScreen sessions={sessions} error={null} onRetry={() => undefined} onCreate={async () => true} onSelect={() => undefined} demo missing />);
    expect(el.querySelector('h2')!.textContent).toBe('Start with a one-line idea');
    expect([...el.querySelectorAll('.start-idea > span:first-child')].map((x) => x.textContent)).toEqual(IDEAS);
    expect(IDEAS[0]).toBe('Make a space cat explorer and a survey drone');
    expect(el.querySelector('#start-recent-title')!.textContent).toBe('Recent sessions 10');
    expect(el.querySelector('.start-more')!.textContent).toBe('Show all 10 sessions');
    expect(korean(el)).toEqual([]);
    // a session opened from an example is named after what the idea asks for
    expect(IDEAS.map(ideaTitle)).toEqual(['A space cat explorer and a survey drone', 'A little archer who guards the forest and a tree spirit',
      'A delivery robot in a neon city and a hover scooter', 'An archaeologist exploring desert ruins and a golden compass']);
    expect(ideaTitle('우주 고양이 탐험가와 탐사용 드론을 만들어줘')).toBe('우주 고양이 탐험가와 탐사용 드론'); // a Korean line typed there still is
  });

  it('the start screen while the list did not load', async () => {
    const { StartScreen } = await import('./components/StartScreen');
    const el = draw(<StartScreen sessions={null} error="Could not reach the server." onRetry={() => undefined} onCreate={async () => true} onSelect={() => undefined} demo={false} missing={false} />);
    expect(el.querySelector('.load-error, [role="alert"]')?.textContent ?? el.textContent).toContain('The sessions could not be loaded.');
    expect(korean(el)).toEqual([]);
  });

  it('the sidebar: the new-session form, the folds, the session list with its find box and row buttons', async () => {
    const { Sidebar } = await import('./components/Sidebar');
    localStorage.setItem('ipverse.workOpen', '1');
    localStorage.setItem('ipverse.connOpen', '1');
    const el = draw(<Sidebar sessions={sessions} currentId="ses_1" open onClose={() => undefined} onSelect={() => undefined} onHome={() => undefined}
      onCreate={async () => true} onPublish={() => undefined} onLogout={() => undefined} connections={null} connectionsError="Could not reach the server."
      onRetryConnections={() => undefined} onConnections={() => undefined} onSkills={() => undefined} onDelete={async () => undefined}
      onRename={async () => undefined} account={{ user: 'luna', demo: false }} />);
    click(el.querySelector('.new-session'));
    expect(el.querySelector('label[for="new-session-title"]')!.textContent).toBe('Session title');
    expect(el.querySelector<HTMLInputElement>('#session-find')!.placeholder).toBe('Find a session by name');
    expect(el.querySelector('.session-rename')!.getAttribute('aria-label')).toBe('Rename Session 0');
    expect(el.querySelector('.session-delete')!.getAttribute('aria-label')).toBe('Delete session Session 0');
    expect(el.querySelector('.sidebar-who')!.textContent).toBe('Logged in as luna');
    click(el.querySelector('.session-rename'));
    expect(korean(el)).toEqual([]);
  });

  it('the sidebar with no session yet', async () => {
    const { Sidebar } = await import('./components/Sidebar');
    const el = draw(<Sidebar sessions={[]} currentId={null} open={false} onClose={() => undefined} onSelect={() => undefined} onCreate={async () => true}
      onPublish={() => undefined} onLogout={() => undefined} connections={null} onConnections={() => undefined} />);
    expect([...el.querySelectorAll('.sidebar-empty')].map((p) => p.textContent)).toContain('No sessions yet. Start with ‘New session’ above.');
    expect(korean(el)).toEqual([]);
  });

  it('the top bar: skip links, the crumb, the offline pill, publish and the account menu', async () => {
    const { TopBar } = await import('./components/TopBar');
    const el = draw(<TopBar session={session} activeJobs={[]} onCancelJob={async () => undefined} navOpen={false} onMenu={() => undefined}
      onPublish={() => undefined} onLogout={() => undefined} onConnections={() => undefined} account={{ user: null, demo: true }} offline
      onHome={() => undefined} chat />);
    expect([...el.querySelectorAll('.skip-link')].map((a) => a.textContent?.trim())).toEqual(['Skip to the workspace', 'Skip to the chat box']);
    expect(el.querySelector('.status-pill')!.textContent).toBe('Offline · reconnecting');
    expect(el.querySelector('.breadcrumb-home')!.textContent).toBe('Workspace');
    expect(el.querySelector('.topbar-account-name')!.textContent).toBe('Demo account');
    click(el.querySelector('.topbar-account'));
    expect(document.body.textContent).toContain('Logged in to the shared demo account');
    expect(document.body.textContent).toContain('Connections');
    expect(document.body.textContent).toContain('Log out');
    expect(korean(document.body)).toEqual([]);
  });

  it('the top bar of the start screen', async () => {
    const { TopBar } = await import('./components/TopBar');
    const el = draw(<TopBar session={null} activeJobs={[]} onCancelJob={async () => undefined} navOpen={false} onMenu={() => undefined}
      onPublish={() => undefined} onLogout={() => undefined} onConnections={() => undefined} account={{ user: 'luna', demo: false }} />);
    expect(el.querySelector('.topbar-title')!.textContent).toBe('Home');
    expect(korean(el)).toEqual([]);
  });

  it('the chat of a new session: the intro, the examples, the hints of the message box', async () => {
    const { ChatDock } = await import('./components/ChatDock');
    const el = draw(<ChatDock sessionId="ses_en" messages={[]} draft="" onDraft={() => undefined} onSend={() => undefined} disabled={false} />);
    expect(el.querySelector('.chat-head-title')!.textContent).toBe('Make with AI');
    expect(el.querySelector('.chat-intro strong')!.textContent).toBe('What world do you want to make?');
    expect([...el.querySelectorAll('.chat-example')].map((b) => b.textContent)[0]).toBe('Make a space cat explorer and a survey drone');
    expect(el.querySelector('#composer-help')!.textContent).toBe('Type something to send.');
    expect(el.querySelector('.composer-send')!.textContent).toBe('Send');
    expect(korean(el)).toEqual([]);
  });

  it('the chat with messages: the marks of a user\'s own lines are labels in English, the text is as it was written', async () => {
    const { ChatDock, MAX_CHARS, userText } = await import('./components/ChatDock');
    const at = '2026-11-18T03:00:00.000Z';
    const messages = [
      { messageId: 'm1', role: 'user', status: 'done', ts: at, text: '[이미지 모델: Krea (krea)] [에셋 수정 ipId=ip_0123456789] Luna: give her a red scarf' },
      { messageId: 'm2', role: 'assistant', status: 'failed', ts: at, text: 'The picture service did not answer.' },
      { messageId: 'm3', role: 'user', status: 'done', ts: at, text: '[게임 수정 gameId=gm_0123456789] The new 3D is ready: remake \'Star run\' with the same design.' },
      { messageId: 'm4', role: 'assistant', status: 'pending', ts: at, text: '' },
    ] as unknown as Message[];
    const el = draw(<ChatDock sessionId="ses_en" messages={messages} draft={'x'.repeat(MAX_CHARS + 5)} onDraft={() => undefined} onSend={() => undefined} disabled />);
    expect([...el.querySelectorAll('.chat-model-chips .badge')].map((b) => b.textContent)).toEqual(['Image model: Krea', 'Edit image', 'Edit game']);
    expect(el.querySelector('.msg-flag')!.textContent).toBe('The request was not completed');
    expect(el.querySelector('.thinking')!.textContent).toBe('Working on your request…');
    expect(el.querySelector('#composer-count')!.textContent).toBe('4,005 / 4,000 characters');
    expect(korean(el)).toEqual([]);
    // what a drawer of the Korean page stored reads as labels here too
    expect(userText('[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n[스킬 racing] 장르 모듈: x\n[출연 IP cast_ip_ids=ip_0123456789] Luna')).toEqual(
      { chips: ['Game design'], body: 'Genre skill: racing\nCast IPs: Luna' });
    expect(userText('[트레일러 연출] 전체 길이 약 30초, 영상 모델 Luma. 연출: slow push in').body).toBe('about 30 s · Luma\nslow push in');
  });

  it('toasts: their region, their links and the close button', async () => {
    const { Toasts } = await import('./components/Toasts');
    const el = draw(<Toasts toasts={[{ id: 1, level: 'ok', text: 'Luna Image done', open: 'characters' }, { id: 2, level: 'error', text: 'Luna Rig failed', open: 'pipeline' },
      { id: 3, level: 'ok', text: 'Session deleted.', open: 'other' }]} onDismiss={() => undefined} onAction={() => undefined} onOpen={() => undefined} />);
    expect(el.querySelector('.toasts')!.getAttribute('aria-label')).toBe('Notifications');
    expect([...el.querySelectorAll('.toast-open')].map((b) => b.textContent?.trim())).toEqual(['View picture', 'View in Jobs', 'View']);
    expect(el.querySelector('.toast-close')!.getAttribute('aria-label')).toBe('Dismiss notification');
    expect(korean(el)).toEqual([]);
  });

  it('the sentences api.ts and auth.ts write: errors, the held game\'s offer, a job that ended', async () => {
    const api = await import('./api');
    const auth = await import('./auth');
    expect(new api.AuthError().message).toBe('Your login has expired. Log in again to return to your work.');
    expect(auth.OFFLINE).toBe('The server could not be reached. Check your internet connection and try again.');
    // a sentence of ours (marked: i18n.said) is said as written; the browser's own error, or a bare code, is not
    expect(api.errorMessage((await import('./i18n')).said(auth.OFFLINE))).toBe(auth.OFFLINE);
    expect(api.errorMessage(new TypeError('Failed to fetch'))).toBe('Something went wrong. Try again in a moment.');
    expect(api.errorMessage(new Error('placementTimeout'))).toBe('Something went wrong. Try again in a moment.');
    expect(api.errorMessage(new api.ApiError(409, 'This ID is taken'))).toBe('This ID is taken'); // the server's, in the request's language
    expect(api.MAKE_HELD).toBe('Make game');
    expect(api.noSkeleton('Luna')).toBe('‘Luna’ has a shape that cannot take a rig.');

    const at = '2026-11-18T03:00:00.000Z';
    const job = (status: string, extra: object = {}) => ({ jobId: 'job_1', kind: 'image', status, input: { ipId: 'ip_1' }, outputs: [], createdAt: at, updatedAt: at, ...extra });
    const ips = [{ ipId: 'ip_1', kind: 'character', name: 'Luna', description: '', version: 1, createdAt: at }];
    const said = (next: object) => api.diffJobs([job('running')] as never, [next] as never, null, ips as never).map((toast) => toast.text);
    const { JOB_KIND_LABEL } = await import('./types'); // the kind's word is types.ts's (another package's dictionary)
    expect(said(job('done'))).toEqual([`Done: Luna ${JOB_KIND_LABEL.image}`]); // not 'Luna Image done'
    expect(said(job('failed'))[0]).toMatch(new RegExp(`^Luna ${JOB_KIND_LABEL.image} failed`));

    const game = { gameId: 'gm_1', title: 'Star run', createdAt: at };
    const snap = { session, messages: [], ips, assets: [], jobs: [], games: [game] };
    expect(api.rebuildRequest(snap as never)!.text).toBe('[게임 수정 gameId=gm_1] The new 3D is ready: remake \'Star run\' with the same design and the same cast IPs, '
      + 'using their 3D models. Keep everything else as it is.'); // the mark in front is the agent's
    const rig = { ...job('done'), kind: 'rig' };
    expect(api.diffJobs([{ ...rig, status: 'running' }] as never, [rig] as never, 'remake', ips as never)[0]).toMatchObject(
      { text: 'New 3D is ready (Luna). Apply it to the game? The game is remade as a new version.', action: { label: 'Apply to game' } });
    expect(api.diffJobs([{ ...rig, status: 'running' }] as never, [rig] as never, 'held', ips as never)[0]).toMatchObject(
      { text: 'The 3D of Luna is ready. Make the game you asked for?', action: { label: 'Make game' } });
  });

  it('the demo login says the page\'s language to the server (it does not go through api.ts\'s request)', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    vi.stubGlobal('fetch', fetch);
    const auth = await import('./auth');
    await expect(auth.demoLogin()).rejects.toThrow('The demo account could not be opened. Try again in a moment. (Error 503)');
    expect(fetch).toHaveBeenCalledWith('/api/demo-login', { method: 'POST', headers: { 'X-Lang': 'en' } });
  });

  it('the shared pieces: a confirm dialog, the error boundary, a pane that loads, an action button, the panes\' handle', async () => {
    const { ConfirmDialog } = await import('./components/ConfirmDialog');
    const { ErrorBoundary } = await import('./components/ErrorBoundary');
    const { Skeleton } = await import('./components/Skeleton');
    const { ActionButton } = await import('./components/ActionButton');
    const { SplitPanes } = await import('./components/SplitPanes');
    const Broken = () => { throw new Error('boom'); };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const el = draw(<>
      <ConfirmDialog title="Unpublish" message="The link stops working." confirmLabel="Unpublish" onConfirm={() => undefined} onCancel={() => undefined} />
      <ErrorBoundary onReload={() => undefined}><Broken /></ErrorBoundary>
      <Skeleton label="Game" />
      <ActionButton label="Retry" run={async () => undefined} />
      <SplitPanes left={<p>left</p>} right={<p>right</p>} />
    </>);
    expect(document.querySelector('.confirm-cancel')!.textContent).toBe('Cancel'); // (the dialog is drawn on <body>)
    expect(el.querySelector('.crash')!.textContent).toBe('Something went wrong while showing this screen. Reload the page.Reload');
    expect(el.querySelector('.pane .sr-only')!.textContent).toBe('Loading: Game');
    expect(el.querySelector('.split-handle')!.getAttribute('aria-label')).toBe('Width of the IP pane and the game pane');
    expect(korean(document.body)).toEqual([]);
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Retry'))!;
    await act(async () => { retry.click(); });
    expect(retry.querySelector('[role="status"]')!.textContent).toBe('Retry: Queued');
    expect(korean(document.body)).toEqual([]);
  });
});
