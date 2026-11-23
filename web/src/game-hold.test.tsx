import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_KIND_LABEL, type Asset, type Game, type Ip, type Job, type Message, type Snapshot } from './types';

vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const { default: App } = await import('./App');

// A game request held for a hero's 3D: when her rig finishes with the studio open, the page must go on to the game
// without the request being typed again. The whole studio is mounted over a fake API, as the page polls it.
const SID = 'ses_f3e77ae920';
const ASK = '이 IP들로 30초 생존 게임 만들어줘';
const at = (clock: string) => `2026-11-11T${clock}Z`;
const session = { sessionId: SID, title: '달빛 온실의 정원사 기사', genre: 'sf-shooter' as const, concept: null, createdAt: at('01:28:30.000') };
const asset = (assetId: string, kind: Asset['kind']): Asset => ({
  assetId, kind, ipId: 'ip_hero', key: `sessions/${SID}/${assetId}`, url: `/u/${assetId}`, contentType: 'application/octet-stream', meta: {}, createdAt: at('01:30:00.000'),
});
const job = (kind: Job['kind'], status: Job['status'], extra: Partial<Job> = {}): Job => ({
  jobId: `job_${kind}`, kind, provider: 'rig', status, input: { ipId: 'ip_hero' }, outputs: [], deps: [], progress: '',
  createdAt: at('01:34:35.000'), updatedAt: at('01:44:26.841'), ...extra,
});
const said = (messageId: string, role: Message['role'], text: string, ts: string, extra: object = {}): Message => ({
  messageId, role, text, status: 'done', toolEvents: [], ts: at(ts), ...extra,
});
const hero: Ip = { ipId: 'ip_hero', kind: 'character', name: '세린', description: 'a girl knight in silver armor', version: 1,
  imageAssetId: 'ast_image', cutoutAssetId: 'ast_cutout', createdAt: at('01:28:50.000') };
const pictures = [asset('ast_image', 'image'), asset('ast_cutout', 'cutout')];
// the request the agent held (server/agent.py _note_hold), its answer, and the line that came after it
const talk = [said('u1', 'user', ASK, '01:34:32.222', { gameHeld: { ipIds: ['ip_hero'] } }),
  said('a1', 'assistant', "세린 3D가 끝나면 화면의 '게임에 반영'으로 만들 수 있어요.", '01:34:32.229'),
  said('u2', 'user', '소품도 3D로 만들어줘', '01:34:46.978'), said('a2', 'assistant', '달빛 물뿌리개 3D를 등록했습니다.', '01:34:46.985')];
const snap = (extra: Partial<Snapshot>): Snapshot => ({ session, messages: talk, ips: [hero], assets: pictures, jobs: [], games: [], ...extra });

const meshing = snap({ jobs: [job('apose', 'done'), job('mesh3d', 'running'), job('render3d', 'queued'), job('rig', 'queued')] });
const meshed = { ips: [{ ...hero, glbAssetId: 'ast_glb' }], assets: [...pictures, asset('ast_glb', 'glb')] };
const rigging = snap({ ...meshed, jobs: [job('apose', 'done'), job('mesh3d', 'done'), job('render3d', 'running'), job('rig', 'running')] });
const rigged = snap({ ips: [{ ...hero, glbAssetId: 'ast_glb', riggedGlbAssetId: 'ast_rig' }], assets: [...meshed.assets, asset('ast_rig', 'rigged_glb')],
  jobs: [job('apose', 'done'), job('mesh3d', 'done'), job('render3d', 'running'), job('rig', 'done')] });
const game: Game = { gameId: 'gm_0540a4d435', title: '달빛 온실 30초 방어전', genre: 'sf-shooter', specKey: 'games/gm_0540a4d435/spec.json',
  previewUrl: '/games/gm_0540a4d435/index.html', createdAt: at('01:47:01.981') };

let served: Snapshot; // what GET /api/sessions/{id} answers now
let chats: { text: string }[]; // the bodies of POST /chat
let tools: { tool: string; args: unknown }[]; // the card tools that were run (POST /tools/<name>[/async])
let chatGate: Promise<void> | null; // POST /chat answers once this resolves: a test can stand inside its round trip
let root: Root | null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} }); // the game pane's sticky header
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32)); // the body hash, without a real async hop
  localStorage.clear();
  sessionStorage.setItem('ipverse.tokens', JSON.stringify({ access: 'tok', exp: Date.now() + 3_600_000 }));
  history.replaceState(null, '', `#s=${SID}`);
  chats = [];
  tools = [];
  chatGate = null;
  root = null;
  const reply = (data: unknown, status = 200) => ({ status, json: async () => data }) as unknown as Response;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === `/api/sessions/${SID}`) return reply(served);
    if (url === '/api/sessions') return reply({ sessions: [{ sessionId: SID, title: session.title, genre: session.genre, createdAt: session.createdAt }] });
    if (url === `/api/sessions/${SID}/chat` && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      chats.push(body);
      await chatGate;
      // as server/app.py chat() stores it: the line, and the answer still being made
      served = { ...served, messages: [...served.messages, said('u9', 'user', body.text, '01:44:40.000'),
        said('a9', 'assistant', '', '01:44:40.001', { status: 'pending' })] };
      return reply({ messageId: 'a9' }, 202);
    }
    if (url.startsWith(`/api/sessions/${SID}/tools/`) && init.method === 'POST') { // a card button's tool (runTool, runToolAsync)
      tools.push({ tool: url.split('/tools/')[1], args: JSON.parse(String(init.body)) });
      return reply({ messageId: 'm_tool' }, 202);
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

/** The studio opened on the session (a new page load: the browser's storage stays). */
async function open() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<App />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
async function close() {
  if (!root) return;
  await act(async () => root!.unmount());
  container.remove();
  root = null;
}
/** The next poll: 3 s while a job runs or an answer is being made, else 10 s. */
const poll = (ms = 3000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => ({
  text: t.querySelector('.toast-text')!.textContent, action: t.querySelector('.toast-action')?.textContent ?? null }));
const click = async (label = '게임 만들기') => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.toast-action')].find((b) => b.textContent === label)!;
  await act(async () => { button.click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};
// A held request is a game that does not exist yet, so the button is 게임 만들기, whether her rig lands in front of the
// page (RIG_OFFER) or the page finds it done (HELD_OFFER); 게임에 반영 re-makes an existing game.
const HELD_OFFER = { text: '세린 3D가 준비됐어요. 요청해 둔 게임을 만들까요?', action: '게임 만들기' };
const RIG_OFFER = HELD_OFFER;
const REMAKE_OFFER = { text: '새 3D가 준비됐어요 (세린). 게임에 반영할까요? 새 버전으로 다시 만들어요.', action: '게임에 반영' };

// the whole studio mounts in each case: a case gets 30 s instead of the default 5
describe('a game asked for in chat and held for the hero 3D comes back with one click', { timeout: 30_000 }, () => {
  it('offers 게임 만들기 when her rig lands in front of the page, and the click sends the held request', async () => {
    served = rigging;
    await open();
    expect(toasts()).toEqual([]);
    served = rigged;
    await poll();
    expect(toasts()).toEqual([RIG_OFFER]);
    await click();
    expect(chats).toEqual([{ text: ASK }]); // the request that was held, not "소품도 3D로 만들어줘"
    expect(toasts()).toEqual([]);
    await poll(); // the game is being made: nothing offers the request a second time
    expect(toasts()).toEqual([]);
  });

  it('offers it when the session is opened after the rig landed, once', async () => {
    served = rigged; // the page was closed when the rig finished
    await open();
    expect(toasts()).toEqual([HELD_OFFER]);
    await poll(10_000);
    expect(toasts()).toEqual([HELD_OFFER]); // one toast, not one a poll
    await click();
    expect(chats).toEqual([{ text: ASK }]);
    await close();
    chats = [];
    served = rigged; // a page load later, the request still unanswered (the click's turn failed)
    await open();
    expect(toasts()).toEqual([]);
  });

  // The offer is a toast, once per browser; the game pane must keep showing the held request on every later load.
  it('keeps the request in the game pane on every load: 게임 만들기 there sends it, also after the toast was used up', async () => {
    const card = () => document.querySelector<HTMLElement>('.held-game');
    served = rigging;
    await open();
    expect(card()!.textContent).toContain('세린 3D가 끝나면 여기에서 만들 수 있어요'); // while her rig runs: no button yet
    expect(card()!.querySelector('button')).toBeNull();
    served = rigged;
    await poll();
    expect(toasts()).toEqual([RIG_OFFER]);
    await close();
    await open(); // a new page load: the toast does not come twice
    expect(toasts()).toEqual([]);
    const make = card()!.querySelector<HTMLButtonElement>('button')!;
    expect(make.textContent).toBe('게임 만들기');
    await act(async () => { make.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(chats).toEqual([{ text: ASK }]); // the request that was held, as the toast's button sends it
    // the answer is being made: the card stays, and its button waits
    expect(card()!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    served = { ...rigged, messages: [...served.messages.slice(0, -1), said('a9', 'assistant', '30초 생존 게임을 만들었습니다.', '01:44:40.001')],
      games: [{ ...game, createdAt: at('01:47:01.981') }] };
    await poll();
    expect(card()).toBeNull(); // answered: the game was made after the request
  });

  it('does not offer it again on the next open when it was shown and left alone', async () => {
    served = rigging;
    await open();
    served = rigged;
    await poll();
    expect(toasts()).toEqual([RIG_OFFER]);
    await close();
    await open();
    expect(toasts()).toEqual([]);
  });

  it('takes the standing offer away when the user typed the request again and that made the game', async () => {
    served = rigging;
    await open();
    served = rigged;
    await poll();
    expect(toasts()).toEqual([RIG_OFFER]);
    // the game made by asking again in chat after the 3D finished
    const again = [...talk, said('u3', 'user', `3D가 끝났으니 ${ASK}`, '01:46:40.011'), said('a3', 'assistant', '', '01:46:40.017', { status: 'pending' })];
    served = { ...rigged, messages: again };
    await poll(10_000);
    expect(toasts()).toEqual([RIG_OFFER]);
    await click(); // while that answer is being made, the click sends no second request
    expect(chats).toEqual([]);
    expect(toasts()).toEqual([{ text: '지금 만드는 답변이 끝난 뒤에 눌러 주세요.', action: '게임 만들기' }]);
    served = { ...rigged, messages: [...again.slice(0, -1), said('a3', 'assistant', '30초 생존 게임을 만들었습니다.', '01:46:40.017')], games: [game] };
    await poll();
    expect(toasts()).toEqual([]);
    await close();
    await open();
    expect(toasts()).toEqual([]);
  });

  it('offers nothing for a hero whose mesh failed; a retry that lands brings the offer', async () => {
    served = meshing;
    await open();
    const dead = (kind: Job['kind'], error: string) => job(kind, 'failed', { error });
    served = snap({ jobs: [job('apose', 'done'), dead('mesh3d', 'GPU 서버가 응답하지 않습니다'), dead('render3d', '선행 작업 실패'), dead('rig', '선행 작업 실패')] });
    await poll();
    expect(toasts().map((t) => t.action)).toEqual([null, null, null]);
    expect(toasts()[0].text).toBe(`세린 ${JOB_KIND_LABEL.mesh3d} 실패: GPU 서버가 응답하지 않습니다`); // whose job it was
    await close();
    await open(); // nothing is ready: nothing to offer
    expect(toasts()).toEqual([]);
    served = rigging; // 다시 시도, and the mesh is in
    await poll(10_000);
    served = rigged;
    await poll();
    expect(toasts().filter((t) => t.action)).toEqual([RIG_OFFER]);
  });

  it('offers nothing on a rig that failed over a finished mesh: the hold waits for her rig', async () => {
    served = rigging;
    await open();
    const failed = { ...rigging, jobs: rigging.jobs.map((j) => (j.kind === 'rig' ? { ...j, status: 'failed' as const, error: '스켈레톤을 맞추지 못했습니다' } : j)) };
    served = failed;
    await poll();
    expect(toasts()).toEqual([{ text: `세린 ${JOB_KIND_LABEL.rig} 실패: 스켈레톤을 맞추지 못했습니다`, action: null }]);
    await close();
    await open();
    expect(toasts()).toEqual([]);
    served = rigging; // 다시 시도
    await poll();
    served = rigged;
    await poll();
    expect(toasts()).toEqual([RIG_OFFER]);
  });

  // A refused skeleton is not a failure to wait out: a retry cannot succeed, so the game is offered with the model she has.
  it('a refused skeleton makes the held request ready: the toast and the card offer the game without the walk, and another picture', async () => {
    served = rigging;
    await open();
    const refused = { ...rigging, jobs: rigging.jobs.map((j) => (j.kind === 'rig' ? { ...j, status: 'failed' as const,
      error: '움직임 뼈대를 넣을 수 없는 모양입니다: not a full body: legs are missing or cut off (hips at 30% of the height)' } : j)) };
    served = refused;
    await poll();
    expect(toasts()).toEqual([{ text: '‘세린’은 움직임 뼈대를 넣을 수 없는 모습이에요. 걷는 동작 없이 그대로 게임을 만들까요?', action: '게임 만들기' }]);
    expect(document.querySelector('.toast')!.className).toContain('toast--warn'); // not the green check: it is not what was asked
    const card = document.querySelector<HTMLElement>('.held-game')!;
    expect(card.querySelector('[role="status"]')!.textContent).toBe('‘세린’은 움직임 뼈대를 넣을 수 없는 모습이에요. 걷는 동작 없이 그대로 게임을 만들 수 있어요.');
    const buttons = () => [...card.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons().map((b) => b.textContent)).toEqual(['게임 만들기', '그림 다시 뽑기']);
    expect(buttons()[0].className).toContain('btn-primary');
    expect(card.querySelector('.held-game-more')!.textContent).toBe('걷는 동작을 넣으려면 머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림으로 다시 뽑은 뒤 3D를 다시 만들어 주세요.');
    // 그림 다시 뽑기: another picture of her, as her card's own button asks for it
    await act(async () => { buttons()[1].click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(tools).toEqual([{ tool: 'reroll_ip_image/async', args: { ipId: 'ip_hero' } }]);
    expect(chats).toEqual([]);
    // 게임 만들기: the request that was held, as it was
    await act(async () => { buttons()[0].click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(chats).toEqual([{ text: ASK }]);
    await close();
    chats = [];
    served = refused; // a later page load: the toast was shown once, the card still offers the game
    await open();
    expect(toasts()).toEqual([]);
    expect([...document.querySelectorAll<HTMLButtonElement>('.held-game button')].map((b) => b.textContent)).toEqual(['게임 만들기', '그림 다시 뽑기']);
  });

  it('waits for the answer that holds the request before it offers it', async () => {
    // the rig landed while the agent was still writing the answer of the turn that held the game
    const writing = [talk[0], said('a1', 'assistant', '', '01:34:32.229', { status: 'pending' })];
    served = { ...rigged, messages: writing };
    await open();
    expect(toasts()).toEqual([]);
    served = { ...rigged, messages: talk.slice(0, 2) };
    await poll();
    expect(toasts()).toEqual([HELD_OFFER]);
  });

  it('says so when the click finds nothing to make: a newer request waits for another hero', async () => {
    served = rigged;
    await open();
    expect(toasts()).toEqual([HELD_OFFER]);
    // a second game was asked for with 카이, who has no 3D: it replaced the first, and it cannot be made yet
    const kai: Ip = { ...hero, ipId: 'ip_kai', name: '카이' };
    served = { ...rigged, ips: [...rigged.ips, kai], messages: [...talk,
      said('u3', 'user', '카이가 주인공인 보스전 게임으로 만들어줘', '01:45:10.000', { gameHeld: { ipIds: ['ip_kai'] } }),
      said('a3', 'assistant', '카이 3D를 걸어 두었습니다.', '01:45:10.007')] };
    await poll();
    await click();
    expect(chats).toEqual([]);
    expect(toasts()).toEqual([{ text: '주인공의 3D가 아직 끝나지 않아 지금은 게임을 만들 수 없어요.', action: null }]);
  });

  it('still re-makes the newest game with a new rig when nothing is held', async () => {
    const plain = talk.map((m) => ({ ...m, gameHeld: undefined })); // no request was held: the game was made at once
    const made = { ...game, createdAt: at('01:40:00.000') };
    served = { ...rigging, messages: plain, games: [made] };
    await open();
    expect(toasts()).toEqual([]);
    served = { ...rigged, messages: plain, games: [made] };
    await poll();
    expect(toasts()).toEqual([REMAKE_OFFER]);
    await click('게임에 반영');
    expect(chats.map((c) => c.text)).toEqual(["[게임 수정 gameId=gm_0540a4d435] 새 3D가 준비됐으니 '달빛 온실 30초 방어전'을(를) 같은 설계와 출연 IP 그대로 "
      + '다시 만들어 3D 모델로 바꿔줘. 나머지는 그대로 둬.']);
  });

  it('keeps a standing offer through a burst of job toasts: of the three that show, the plain ones go first', async () => {
    const more = [job('image', 'running', { jobId: 'job_image2', input: { ipId: 'ip_new' } }),
      job('shot', 'running', { jobId: 'job_shot' }), job('trailer', 'running', { jobId: 'job_trailer', input: { title: '예고편' } })];
    served = { ...rigged, jobs: [...rigged.jobs, ...more] };
    await open();
    expect(toasts()).toEqual([HELD_OFFER]);
    served = { ...rigged, jobs: [...rigged.jobs, ...more.map((j) => ({ ...j, status: 'done' as const }))] };
    await poll(); // three jobs land in one poll: the offer is made once, so it must not be the toast that gives way
    expect(toasts()).toEqual([HELD_OFFER, { text: `세린 ${JOB_KIND_LABEL.shot} 완료`, action: null }, { text: `예고편 ${JOB_KIND_LABEL.trailer} 완료`, action: null }]);
  });

  it('keeps the offer for the studio: a window of this app that shows no toasts does not use it up', async () => {
    // an #ad= (or #play=, #watch=) window whose address also names the session polls it too, and shows another page
    history.replaceState(null, '', `#s=${SID}&ad=ad_1`);
    served = rigged;
    await open();
    expect(document.querySelector('.toasts')).toBeNull();
    await close();
    history.replaceState(null, '', `#s=${SID}`);
    await open();
    expect(toasts()).toEqual([HELD_OFFER]);
  });

  it('drops an offer when another session is opened: it would send that session a request', async () => {
    served = rigged;
    await open();
    expect(toasts()).toEqual([HELD_OFFER]);
    await act(async () => { history.replaceState(null, '', '#s=ses_other'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(toasts().filter((t) => t.action)).toEqual([]);
  });
});

// Two presses inside the first request's round trip must not send the held request twice: server/app.py chat()
// takes a second line while a turn is pending, which would make two games.
describe('the held request is sent once, however often 게임 만들기 is pressed (round20 review, web B2)', { timeout: 30_000 }, () => {
  const card = () => document.querySelector<HTMLElement>('.held-game');
  const make = () => card()!.querySelector<HTMLButtonElement>('button')!;
  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const composer = () => document.querySelector<HTMLTextAreaElement>('#composer')!;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text);
    composer().dispatchEvent(new Event('input', { bubbles: true }));
  });
  /** The request is on its way until the returned function is called. */
  const hold = () => { let answer!: () => void; chatGate = new Promise<void>((r) => { answer = r; }); return () => act(async () => { answer(); }); };
  /** The studio on the session with her rig in, the toast used up on an earlier load: the card is what offers the game. */
  const openOnCard = async () => {
    localStorage.setItem('ipverse.gameOffered', JSON.stringify(['u1']));
    served = rigged;
    await open();
    expect(toasts()).toEqual([]);
    expect(make().textContent).toBe('게임 만들기');
  };

  it('a double click on the card sends one request', async () => {
    await openOnCard();
    await act(async () => { make().click(); make().click(); });
    await settle();
    expect(chats).toEqual([{ text: ASK }]);
  });

  it('a second press while the request is on its way sends nothing; the button says so and keeps the focus', async () => {
    await openOnCard();
    const answer = hold();
    make().focus();
    await act(async () => { make().click(); });
    await settle();
    expect(make().textContent).toBe('보내는 중…');
    expect([make().getAttribute('aria-busy'), make().getAttribute('aria-disabled'), make().disabled]).toEqual(['true', 'true', false]);
    expect(document.activeElement).toBe(make()); // a button that turns itself off here would drop the focus to <body>
    await act(async () => { make().click(); });
    await settle();
    expect(chats).toEqual([{ text: ASK }]);
    await answer();
    await settle();
    expect(chats).toEqual([{ text: ASK }]);
    expect(make().querySelector('[role="status"]')!.textContent).toBe('게임 만들기: 보냈어요'); // said once it is in
    expect(document.activeElement).toBe(make());
    await poll(); // ... and from here the answer being made holds it
    expect(make().textContent).toBe('답변을 만드는 중…');
    await act(async () => { make().click(); });
    await settle();
    expect(chats).toEqual([{ text: ASK }]);
  });

  it('the toast\'s 게임 만들기 and then the card\'s: one request, and the card shows it is on its way', async () => {
    served = rigged;
    await open();
    expect(toasts()).toEqual([HELD_OFFER]);
    const answer = hold();
    await click(); // the toast's button: the toast closes on the press
    expect(toasts()).toEqual([]);
    expect(make().textContent).toBe('보내는 중…');
    expect(make().disabled).toBe(true);
    await act(async () => { make().click(); });
    await settle();
    await answer();
    await settle();
    expect(chats).toEqual([{ text: ASK }]);
    expect(make().textContent).toBe('답변을 만드는 중…');
  });

  it('a line on its way from the message box holds the offer: the card waits, and the toast says to press after the answer', async () => {
    served = rigged;
    await open();
    expect(toasts()).toEqual([HELD_OFFER]);
    const answer = hold();
    await type(`3D가 끝났으니 ${ASK}`); // the request typed again
    await act(async () => { document.querySelector<HTMLFormElement>('.composer')!.requestSubmit(); });
    await settle();
    expect(chats).toHaveLength(1);
    expect(make().disabled).toBe(true);
    await click(); // the toast's button, before the line's answer shows as being made
    expect(chats).toHaveLength(1);
    expect(toasts()).toEqual([{ text: '지금 만드는 답변이 끝난 뒤에 눌러 주세요.', action: '게임 만들기' }]);
    await answer();
    await settle();
    expect(chats.map((c) => c.text)).toEqual([`3D가 끝났으니 ${ASK}`]);
  });

  it('what is typed in the message box stays there: the held request is not its line', async () => {
    await openOnCard();
    await type('그리고 소품도 하나 더');
    await act(async () => { make().click(); });
    await settle();
    expect(chats).toEqual([{ text: ASK }]);
    expect(composer().value).toBe('그리고 소품도 하나 더');
  });

  it('a request that could not be sent can be pressed again', async () => {
    await openOnCard();
    const real = globalThis.fetch;
    let down = true;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (down && String(input).endsWith('/chat')
      ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init))));
    await act(async () => { make().click(); });
    await settle();
    expect(toasts()).toEqual([{ text: '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', action: null }]);
    expect(document.querySelector('.toast--error .toast-life')).toBeNull(); // in the studio what failed stays said until it is closed
    expect(make().disabled).toBe(false);
    down = false;
    await poll(2100); // the button's own 2 s of saying it failed
    await act(async () => { make().click(); });
    await settle();
    expect(chats).toEqual([{ text: ASK }]);
  });
});
