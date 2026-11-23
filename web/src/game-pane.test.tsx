import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GamePane } from './components/GamePane';
import { JOB_KIND_LABEL, THREE_D_TOTAL, type Asset, type Game, type Ip, type Job, type Message, type Snapshot } from './types';

// The spec request stays pending (no design summary) and the cloud player is a stub: these tests are about the controls.
const spec = vi.hoisted(() => ({ get: vi.fn((): Promise<unknown> => new Promise(() => {})) }));
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), getGameSpec: spec.get }));
vi.mock('./components/UnrealStream', async () => {
  const { createElement } = await import('react');
  return { UnrealStream: ({ kind, big, onBigClose }: { kind: string; big?: boolean; onBigClose?: () => void }) =>
    createElement('p', { className: 'stream-stub', 'data-big': big ? '1' : '0', onClick: onBigClose }, `클라우드 스트림 · ${kind}`) };
});

const game = (gameId: string, createdAt: string, extra: Partial<Game> = {}): Game => ({
  gameId, title: '코어 탈출', genre: 'rpg-quest', specKey: `games/${gameId}/spec.json`,
  previewUrl: `https://cdn.invalid/games/${gameId}/index.html`, createdAt, ...extra,
});
const games = [game('gm_1', '2026-11-05T00:00:00Z'), game('gm_2', '2026-11-05T01:00:00Z', { baseGameId: 'gm_1' })];
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  session: { sessionId: 'ses_1', title: '루나', genre: 'rpg-quest', createdAt: '2026-11-05T00:00:00Z' },
  messages: [], ips: [], assets: [], jobs: [], games: [], ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has none
  localStorage.clear();
  history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const handlers = () => ({ onGenre: vi.fn(), onError: vi.fn(), onDesign: vi.fn(), onExpand: vi.fn(), onEditGame: vi.fn(), onMakeHeld: vi.fn(),
  onMake3d: vi.fn(async (_ipId: string) => undefined) });
const render = async (snap: Snapshot, h = handlers()) => {
  await act(async () => root.render(<GamePane snap={snap} {...h} />));
  return h;
};
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
const engineRadios = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-labelledby="engine-label"] [role="radio"]')];
const openSettings = () => act(async () => $<HTMLButtonElement>('#game-settings-head').click());

describe('게임 설정: genre, version and run mode in one fold', () => {
  // a brand-new session's fold must not show the server's default genre
  it('names no genre in its header before the session has a game, unless one was chosen', async () => {
    const head = () => $<HTMLButtonElement>('#game-settings-head').textContent;
    await render(snapshot({ session: { sessionId: 'ses_1', title: '새 세션', genre: 'sf-shooter', createdAt: '2026-11-05T00:00:00Z' } }));
    expect(head()).toBe('게임 설정');
    await render(snapshot()); // RPG 퀘스트: not the default, so somebody chose it
    expect(head()).toBe('게임 설정RPG 퀘스트');
    await render(snapshot({ session: { sessionId: 'ses_1', title: '루나', genre: 'sf-shooter', createdAt: '2026-11-05T00:00:00Z' }, games }));
    expect(head()).toContain('SF 슈터 · v2 · 브라우저');
  });

  it('starts folded with the current values in its header, holds all three settings and remembers being opened', async () => {
    await render(snapshot({ games }));
    const head = $<HTMLButtonElement>('#game-settings-head');
    const region = $('#game-settings-region');
    expect([head.getAttribute('aria-expanded'), head.getAttribute('aria-controls')]).toEqual(['false', 'game-settings-region']);
    expect(region.hasAttribute('inert')).toBe(true);
    expect(head.textContent).toContain('RPG 퀘스트 · v2 · 브라우저');
    expect(region.querySelector('[role="group"][aria-labelledby="genre-label"] .dropdown')).not.toBeNull();
    expect(region.querySelector('[role="group"][aria-labelledby="genre-label"]')!.textContent).toContain('새 게임의 기본 장르예요');
    expect(region.querySelectorAll('[role="radiogroup"][aria-labelledby="game-ver-label"] [role="radio"]')).toHaveLength(2);
    expect(engineRadios().map((r) => [r.textContent, region.contains(r)])).toEqual([['브라우저 미리보기', true], ['클라우드 플레이', true]]);
    expect(container.querySelector('[role="tablist"][aria-label="실행 방식"]')).toBeNull(); // no second tab strip above the preview
    // the preview the settings drive stays outside the fold
    expect(region.querySelector('.preview')).toBeNull();
    expect(container.querySelector('.preview .game-start')).not.toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled(); // a folded strip does not scroll the pane

    await openSettings();
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(region.hasAttribute('inert')).toBe(false);
    expect(localStorage.getItem('ipverse.gameSettingsOpen')).toBe('1');

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(snapshot({ games }));
    expect($('#game-settings-head').getAttribute('aria-expanded')).toBe('true');
  });

  it('switches the preview between the browser and the cloud from the fold, by click and by arrow keys, in #engine=', async () => {
    await render(snapshot({ games }));
    await openSettings();
    expect(engineRadios().map((r) => [r.getAttribute('aria-checked'), r.tabIndex])).toEqual([['true', 0], ['false', -1]]);
    await act(async () => engineRadios()[1].click());
    expect($('.preview .stream-stub').textContent).toBe('클라우드 스트림 · web');
    expect(container.querySelector('.game-start')).toBeNull();
    // cloud run mode has no poster: the line about ● 라이브 방송 sits under the stream, once
    expect(container.querySelectorAll('#preview-live-hint')).toHaveLength(1);
    expect(location.hash).toContain('engine=stream');
    expect($('#game-settings-head').textContent).toContain('v2 · 클라우드');

    await key(engineRadios()[1], 'ArrowRight'); // wraps around to 브라우저
    expect(document.activeElement).toBe(engineRadios()[0]);
    expect(engineRadios()[0].getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('.preview .game-start')).not.toBeNull();
    expect(location.hash).toContain('engine=browser');
  });

  it('opens an Unreal game on the cloud until a run mode is picked, and follows an #engine= link', async () => {
    await render(snapshot({ games: [game('gm_ue', '2026-11-05T00:00:00Z', { engine: 'unreal' })] }));
    expect($('.stream-stub').textContent).toBe('클라우드 스트림 · unreal');
    expect(engineRadios().map((r) => r.textContent)).toEqual(['Unreal (클라우드)', '브라우저 미리보기']);
    expect($('#game-settings-head').textContent).toContain('RPG 퀘스트 · v1 · 클라우드');
    expect(container.querySelector('[aria-labelledby="game-ver-label"]')).toBeNull(); // one version: nothing to pick

    await act(async () => root.unmount());
    history.replaceState(null, '', '/#engine=stream');
    root = createRoot(container);
    await render(snapshot({ games }));
    expect(container.querySelector('.stream-stub')).not.toBeNull();
  });

  it('picks a version (click or arrows) and the genre inside the fold', async () => {
    const h = await render(snapshot({ games }));
    await openSettings();
    const [v1, v2] = [$<HTMLButtonElement>('#game-ver-gm_1'), $<HTMLButtonElement>('#game-ver-gm_2')];
    expect([v1.getAttribute('aria-checked'), v2.getAttribute('aria-checked')]).toEqual(['false', 'true']); // the newest first
    await act(async () => v1.click());
    expect(v1.getAttribute('aria-checked')).toBe('true');
    expect($('#game-settings-head').textContent).toContain('RPG 퀘스트 · v1 · 브라우저');
    expect($('.game-start .muted').textContent).toBe('버전 1');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled(); // open: the picked version is scrolled into the strip
    await key(v1, 'End');
    expect(document.activeElement).toBe(v2);
    expect($('.game-start .muted').textContent).toBe('버전 2 · v1에서 수정');

    await act(async () => $<HTMLButtonElement>('#game-settings-region .dropdown-button').click());
    await act(async () => [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === 'SF 슈터')!.click());
    expect(h.onGenre).toHaveBeenCalledWith('sf-shooter');
  });
});

describe('preview bar: 크게 보기 and 라이브 방송 are buttons, 이 게임 수정 stays in ⋯', () => {
  it('shows 크게 보기, a visible ● 라이브 방송 with its one-line hint, and a ⋯ menu', async () => {
    const h = await render(snapshot({ games }));
    const bar = $('.preview-bar');
    expect([...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')))
      .toEqual(['코어 탈출 크게 보기', '코어 탈출 라이브 방송', '코어 탈출 더보기']);
    // 라이브 방송 has a button of its own on the bar, not only an item in the ⋯ menu
    const live = bar.querySelector<HTMLButtonElement>('.preview-action-live')!;
    expect(live.textContent).toBe('● 라이브 방송');
    const hint = document.getElementById(live.getAttribute('aria-describedby')!)!;
    expect(hint.closest('[hidden], [inert]')).toBeNull();
    expect(hint.textContent).toBe('방송을 켜면 가상 시청자마다 다른 광고가 나가는 걸 볼 수 있어요.');
    // under the start button and the version, not on a row above them: a row there pushes 게임 시작 out of a laptop-height pane
    const order = [...$('.game-start').children].map((c) => c.className);
    expect(order.indexOf('preview-hint')).toBeGreaterThan(order.findIndex((c) => c.includes('game-start-btn')));
    expect($('.game-start .muted').textContent).toBe('버전 2 · v1에서 수정');
    await act(async () => live.click());
    expect(h.onExpand).toHaveBeenCalledWith(games[1], games[1].previewUrl);

    const more = bar.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    await act(async () => more.click());
    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['이 게임 수정']);
    expect(document.activeElement).toBe(items[0]);
    await act(async () => items[0].click());
    expect(h.onEditGame).toHaveBeenCalledWith(games[1], 2);
    expect(document.activeElement).toBe(more);

    await act(async () => bar.querySelector<HTMLButtonElement>('.preview-action-primary')!.click());
    expect(container.querySelector('[role="dialog"][aria-labelledby="big-game-title"]')).not.toBeNull();
  });

  it('keeps the 게임 설계 pane button, and 이 게임 수정 when there is no browser build', async () => {
    const h = await render(snapshot({ games: [game('gm_ue', '2026-11-05T00:00:00Z', { engine: 'unreal', previewUrl: '' })] }));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.pane-head button')].find((b) => b.textContent === '✎ 게임 설계')!.click());
    expect(h.onDesign).toHaveBeenCalledOnce();
    // no browser build: 크게 보기 enlarges the Unreal stream itself
    expect($('.preview-action-primary').textContent).toBe('⤢ 크게 보기');
    expect(container.querySelector('.preview-action-live')).toBeNull(); // the broadcast sends the browser build
    expect(container.querySelector('.preview-hint')).toBeNull();
    await act(async () => $<HTMLButtonElement>('.preview-bar button[aria-haspopup="menu"]').click());
    expect([...document.body.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual(['이 게임 수정']);
  });

  it('round 9 M24: in cloud run mode 크게 보기 enlarges the stream, never a local browser copy', async () => {
    history.replaceState(null, '', '/#engine=stream');
    await render(snapshot({ games }));
    expect($('.stream-stub').dataset.big).toBe('0');
    await act(async () => $<HTMLButtonElement>('.preview-action-primary').click());
    expect(container.querySelector('[aria-labelledby="big-game-title"]')).toBeNull(); // no BigGameModal
    expect(container.querySelector('iframe')).toBeNull(); // no local copy of the game
    expect($('.stream-stub').dataset.big).toBe('1');
    await act(async () => $('.stream-stub').click()); // the stream's own 닫기
    expect($('.stream-stub').dataset.big).toBe('0');
  });
});

// The pane's frame is too small to play in, and a second copy in 크게 보기 would run two heavy iframes at once.
describe('게임 시작 opens the big view; the pane keeps a poster and never runs a copy of its own (R20-13)', () => {
  const frames = () => [...document.body.querySelectorAll('iframe')];
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="big-game-title"]');

  it('one game at a time: in the big view, with the poster (title and version) still in the pane', async () => {
    await render(snapshot({ games }));
    expect(frames()).toHaveLength(0);
    await act(async () => $<HTMLButtonElement>('.game-start-btn').click());
    expect(dialog()).not.toBeNull();
    expect(frames().map((f) => [f.getAttribute('src'), dialog()!.contains(f)])).toEqual([[games[1].previewUrl, true]]);
    expect($('.preview .game-start .game-start-title').textContent).toBe('코어 탈출');
    expect($('.preview .game-start .muted').textContent).toBe('버전 2 · v1에서 수정');
    // 크게 보기 on top of a game that was started is still that one game
    await act(async () => $<HTMLButtonElement>('.preview-action-primary').click());
    expect(frames()).toHaveLength(1);
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="닫기"]')!.click());
    expect(dialog()).toBeNull();
    expect(frames()).toHaveLength(0); // closed: nothing keeps running behind the page
    expect(container.querySelector('.preview .game-start-btn')).not.toBeNull();
  });

  it('the keys go to the game as it opens: the frame has the focus, not 닫기 (R20-52)', async () => {
    await render(snapshot({ games }));
    await act(async () => $<HTMLButtonElement>('.game-start-btn').click());
    expect(document.activeElement).toBe(frames()[0]);
  });
});

// A game needs a hero whose 3D is finished: the empty state says the order (a character, its 3D, then the game).
describe('a session with no game says what a game needs first (R20-14)', () => {
  const hero: Ip = { ipId: 'ip_hero', kind: 'character', name: '세린', description: 'a girl knight', version: 1, imageAssetId: 'ast_i',
    cutoutAssetId: 'ast_c', createdAt: '2026-11-05T00:00:00Z' };
  const asset = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, ipId: 'ip_hero', key: assetId, url: `/u/${assetId}`,
    contentType: 'application/octet-stream', meta: {}, createdAt: '2026-11-05T00:00:00Z' });
  const job = (kind: Job['kind'], status: Job['status']): Job => ({ jobId: `job_${kind}`, kind, provider: 'img3d', status, input: { ipId: 'ip_hero' },
    outputs: [], deps: [], progress: '', createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' });
  const empty = () => $('.empty-state');
  const steps = () => [...empty().querySelectorAll('.game-needs li')];
  const current = () => steps().findIndex((li) => li.getAttribute('aria-current') === 'step') + 1;
  const design = () => [...empty().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '게임 설계')!;
  const headButton = () => [...container.querySelectorAll<HTMLButtonElement>('.pane-head button')].find((b) => b.textContent === '✎ 게임 설계')!;
  /** The one lit button of the empty state: the step to do now. */
  const stepButton = () => empty().querySelector<HTMLButtonElement>('button.btn-primary');
  /** How often the chat was asked to open with the caret in its box (ChatDock CHAT_BOX_EVENT) while `press` ran. */
  const chatAsked = async (press: () => void) => {
    const asked = vi.fn();
    window.addEventListener('ipverse:chat-box', asked);
    await act(async () => press());
    window.removeEventListener('ipverse:chat-box', asked);
    return asked.mock.calls.length;
  };

  it('no IP yet: the three steps in order, the first one current and offered as the lit button; 게임 설계 is not the lit action', async () => {
    const h = await render(snapshot());
    expect(empty().querySelector('h3')!.textContent).toBe('게임은 3D 주인공이 준비되면 만들 수 있어요');
    // the chain's time comes from the steps' own table, as the card's and the agent's do
    expect(steps().map((li) => li.textContent)).toEqual(['① 채팅으로 캐릭터 만들기', `② 캐릭터 카드의 ‘3D로 만들기’ (보통 ${THREE_D_TOTAL})`, '③ 게임 설계']);
    expect(current()).toBe(1);
    // the step is a button that goes to the chat's box
    expect(stepButton()!.textContent).toBe('채팅으로 캐릭터 만들기');
    expect(await chatAsked(() => stepButton()!.click())).toBe(1);
    expect(design()).toBeUndefined(); // one button in the empty state: the step
    expect(headButton().classList.contains('btn-edit')).toBe(false);
    await act(async () => headButton().click()); // 게임 설계 is still a way in for whoever wants to look
    expect(h.onDesign).toHaveBeenCalledOnce();
  });

  it('a character with no 3D: step ② is the one to do, and its button starts her 3D; while it runs, the step it is at is named from the table', async () => {
    const h = await render(snapshot({ ips: [hero], assets: [asset('ast_i', 'image'), asset('ast_c', 'cutout')] }));
    expect(current()).toBe(2);
    expect(stepButton()!.textContent).toBe('세린 3D로 만들기');
    await act(async () => stepButton()!.click());
    expect(h.onMake3d).toHaveBeenCalledExactlyOnceWith('ip_hero');
    await render(snapshot({ ips: [hero], assets: [asset('ast_i', 'image'), asset('ast_c', 'cutout')], jobs: [job('apose', 'done'), job('mesh3d', 'running'), job('rig', 'queued')] }));
    expect(current()).toBe(2);
    expect(steps()[1].textContent).toBe(`② 세린 3D 만드는 중 · ${JOB_KIND_LABEL.mesh3d}`);
    expect(empty().querySelector('button')).toBeNull(); // nothing to press while it runs
    // before her first picture has landed there is nothing to make 3D from: the button waits and says so
    await render(snapshot({ ips: [{ ...hero, imageAssetId: undefined }] }));
    expect([stepButton()!.textContent, stepButton()!.disabled]).toEqual(['세린 그림 그리는 중', true]);
  });

  // A chat request makes a game with a 3D prop as the player (server/tools.py hold_heroes, _needs_3d): the empty
  // state must not say a character is needed.
  it('a session with no character says what chat does there: an IP whose 3D is in is the player', async () => {
    const lamp: Ip = { ...hero, ipId: 'ip_lamp', kind: 'prop', name: '반딧불 등불', glbAssetId: 'ast_g' };
    await render(snapshot({ ips: [lamp], assets: [asset('ast_i', 'image'), asset('ast_g', 'glb')] }));
    expect(empty().querySelector('h3')!.textContent).toBe('채팅으로 요청하면 게임을 만들 수 있어요');
    expect(empty().querySelector('p')!.textContent).toBe('캐릭터가 없는 세션에서는 3D가 끝난 ‘반딧불 등불’이 주인공으로 나와요.');
    // why the one button is the chat's
    expect(empty().querySelector('small')!.textContent).toBe('소품이나 적이 주인공인 게임은 채팅으로 요청해 주세요. ‘게임 설계’는 3D가 끝난 캐릭터가 있을 때 쓸 수 있어요.');
    expect(empty().querySelector('.game-needs')).toBeNull();
    expect(stepButton()!.textContent).toBe('채팅으로 게임 요청하기');
    expect(await chatAsked(() => stepButton()!.click())).toBe(1);
    expect(headButton().classList.contains('btn-edit')).toBe(false); // the form still needs a character
    // before its 3D: the steps, and that an IP in 3D will do
    await render(snapshot({ ips: [{ ...lamp, glbAssetId: undefined }], assets: [asset('ast_i', 'image')] }));
    expect(current()).toBe(1);
    expect(empty().querySelector('small')!.textContent).toBe('캐릭터 없이도 돼요. 지금 있는 IP를 3D로 만든 뒤 채팅으로 게임을 요청하면 그 IP가 주인공으로 나와요.');
    // a whole-scene background is scenery, never the player
    await render(snapshot({ ips: [{ ...lamp, usage: 'background' }], assets: [asset('ast_i', 'image'), asset('ast_g', 'glb')] }));
    expect(empty().querySelector('h3')!.textContent).toBe('게임은 3D 주인공이 준비되면 만들 수 있어요');
    expect(empty().querySelector('small')).toBeNull();
  });

  it('a hero whose 3D is finished: 게임 설계 is the screen\'s action again', async () => {
    await render(snapshot({ ips: [{ ...hero, glbAssetId: 'ast_g', riggedGlbAssetId: 'ast_r' }],
      assets: [asset('ast_i', 'image'), asset('ast_c', 'cutout'), asset('ast_g', 'glb'), asset('ast_r', 'rigged_glb')] }));
    expect(empty().querySelector('h3')!.textContent).toBe('내 IP가 등장하는 게임을 만들어 보세요');
    expect(empty().querySelector('.game-needs')).toBeNull();
    expect(design().classList.contains('btn-primary')).toBe(true);
    expect(headButton().classList.contains('btn-edit')).toBe(true);
  });
});

// A game asked for in chat while the hero's 3D runs is held and offered once per browser as a toast; the pane
// keeps the request for a user who missed or closed it.
describe('a held game request stays in the game pane until it is answered (C-06)', () => {
  const at = (clock: string) => `2026-11-11T${clock}Z`;
  const hero: Ip = { ipId: 'ip_hero', kind: 'character', name: '세린', description: 'a girl knight', version: 1, imageAssetId: 'ast_i',
    cutoutAssetId: 'ast_c', createdAt: at('01:28:50') };
  const asset = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, ipId: 'ip_hero', key: assetId, url: `/u/${assetId}`,
    contentType: 'application/octet-stream', meta: {}, createdAt: at('01:30:00') });
  const job = (kind: Job['kind'], status: Job['status']): Job => ({ jobId: `job_${kind}`, kind, provider: 'img3d', status, input: { ipId: 'ip_hero' },
    outputs: [], deps: [], progress: '', createdAt: at('01:34:35'), updatedAt: at('01:40:00') });
  const said = (messageId: string, role: Message['role'], text: string, ts: string, extra: object = {}): Message =>
    ({ messageId, role, text, status: 'done', toolEvents: [], ts: at(ts), ...extra });
  const ASK = '이 IP들로 30초 생존 게임 만들어줘';
  const talk = [said('u1', 'user', ASK, '01:34:32', { gameHeld: { ipIds: ['ip_hero'] } }), said('a1', 'assistant', '보류해 두었어요.', '01:34:33')];
  const pictures = [asset('ast_i', 'image'), asset('ast_c', 'cutout')];
  const waiting = (over: Partial<Snapshot> = {}) => snapshot({ ips: [hero], assets: pictures, messages: talk,
    jobs: [job('apose', 'done'), job('mesh3d', 'running'), job('rig', 'queued')], ...over });
  const ready = (over: Partial<Snapshot> = {}) => snapshot({ ips: [{ ...hero, glbAssetId: 'ast_g', riggedGlbAssetId: 'ast_r' }],
    assets: [...pictures, asset('ast_g', 'glb'), asset('ast_r', 'rigged_glb')], messages: talk,
    jobs: [job('apose', 'done'), job('mesh3d', 'done'), job('rig', 'done')], ...over });
  const card = () => container.querySelector<HTMLElement>('.held-game');
  const make = () => card()!.querySelector<HTMLButtonElement>('button');

  it('while the hero\'s 3D runs: the request, whose 3D it waits for and the step that is on now, with no button yet', async () => {
    await render(waiting());
    expect(card()!.querySelector('h3')!.textContent).toBe('보류 중인 게임 요청');
    expect(card()!.textContent).toContain(`“${ASK}”`);
    expect(card()!.textContent).toContain('세린 3D가 끝나면 여기에서 만들 수 있어요');
    expect(card()!.textContent).toContain(`지금 ${JOB_KIND_LABEL.mesh3d} 단계`); // the step's name from the steps' own table
    expect(make()).toBeNull();
    // the card is the pane's word on the game to come: the steps to a first game are not repeated under it
    expect(container.querySelector('.game-needs')).toBeNull();
  });

  it('once the 3D is in: a 게임 만들기 button, the same on every load, that asks for the held request', async () => {
    const h = await render(ready());
    expect(card()!.textContent).toContain('세린 3D가 준비됐어요');
    expect(make()!.textContent).toBe('게임 만들기'); // a held request has no game yet (not 게임에 반영)
    expect(make()!.disabled).toBe(false);
    await act(async () => make()!.click());
    expect(h.onMakeHeld).toHaveBeenCalledOnce();
    await act(async () => root.unmount()); // a reload, or the next day's login: no once-only gate
    root = createRoot(container);
    await render(ready());
    expect(make()!.textContent).toBe('게임 만들기');
  });

  it('while the answer is being made the button waits; a game made after the request takes the card away', async () => {
    const asking = [...talk, said('u2', 'user', ASK, '01:45:00'), said('a2', 'assistant', '', '01:45:01', { status: 'pending' })];
    await render(ready({ messages: asking }));
    expect(make()!.disabled).toBe(true);
    expect(make()!.textContent).toBe('답변을 만드는 중…');
    const made = game('gm_new', at('01:47:01'));
    await render(ready({ messages: [...asking.slice(0, -1), said('a2', 'assistant', '게임을 만들었어요.', '01:45:01')], games: [made] }));
    expect(card()).toBeNull();
  });

  // two presses inside the first request's round trip must not send the held request twice
  it('while a send is on its way the button waits too, and its own send shows on it until it is in', async () => {
    await act(async () => root.render(<GamePane snap={ready()} {...handlers()} sending />)); // the toast's button sent it, or the message box a line
    expect([make()!.disabled, make()!.textContent]).toEqual([true, '보내는 중…']);
    let sent!: () => void;
    const h = { ...handlers(), onMakeHeld: vi.fn(() => new Promise<void>((r) => { sent = r; })) };
    await render(ready(), h);
    await act(async () => make()!.click());
    expect([make()!.getAttribute('aria-busy'), make()!.textContent]).toEqual(['true', '보내는 중…']);
    await act(async () => make()!.click()); // a second press while it is on its way
    expect(h.onMakeHeld).toHaveBeenCalledOnce();
    await act(async () => sent());
    expect(make()!.querySelector('[role="status"]')!.textContent).toBe('게임 만들기: 보냈어요');
  });

  it('a hero whose 3D was never started, or failed: the card says what to press', async () => {
    await render(waiting({ jobs: [] }));
    expect(card()!.textContent).toContain('세린의 3D가 아직 없어요. 캐릭터 카드의 ‘3D로 만들기’를 누르면, 끝난 뒤 여기에서 만들 수 있어요');
    expect(make()).toBeNull();
  });

  it('a request that waits for a cast (one of them in 3D is enough) names the one whose 3D is in, not all of them', async () => {
    const other: Ip = { ...hero, ipId: 'ip_b', name: '보리', imageAssetId: 'ast_bi', cutoutAssetId: 'ast_bc' };
    const both = [said('u1', 'user', ASK, '01:34:32', { gameHeld: { ipIds: ['ip_hero', 'ip_b'] } }), talk[1]];
    await render(ready({ ips: [{ ...hero, glbAssetId: 'ast_g', riggedGlbAssetId: 'ast_r' }, other], messages: both }));
    expect(card()!.querySelector('[role="status"]')!.textContent).toBe('세린 3D가 준비됐어요. 요청해 둔 게임을 지금 만들 수 있어요.');
    expect(make()!.textContent).toBe('게임 만들기');
    await render(waiting({ ips: [hero, other], messages: both })); // neither is in yet: it waits for both by name
    expect(card()!.querySelector('[role="status"]')!.textContent).toContain('세린, 보리 3D가 끝나면 여기에서 만들 수 있어요');
  });

  it('with an older game on screen the card sits above its preview; a request that names no held IP shows no card', async () => {
    const old = game('gm_old', at('01:00:00'));
    await render(waiting({ games: [old] }));
    expect(card()).not.toBeNull();
    expect(card()!.compareDocumentPosition($('.preview')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await render(snapshot({ ips: [hero], assets: pictures, messages: [said('u1', 'user', ASK, '01:34:32')] })); // nothing was held
    expect(card()).toBeNull();
  });
});

// '게임 설정' is the fold (genre, version, run mode); the saved design the 설계 요약 tab reads is 게임 설계.
describe('the 설계 요약 tab calls the saved design 게임 설계 (R20-51)', () => {
  it('while it loads and when it cannot be read, in 해요체', async () => {
    await render(snapshot({ games }));
    await act(async () => $<HTMLButtonElement>('#game-tab-spec').click());
    expect($('#game-panel-spec').textContent).toBe('게임 설계를 불러오고 있어요…');
    await act(async () => root.unmount());
    root = createRoot(container);
    spec.get.mockRejectedValueOnce(new Error('503'));
    await render(snapshot({ games }));
    await act(async () => $<HTMLButtonElement>('#game-tab-spec').click());
    expect($('#game-panel-spec').textContent).toBe('게임 설계를 불러오지 못했어요.');
    expect($('#game-settings-head').textContent).toContain('게임 설정'); // the fold keeps its name
  });
});

// The games take a keyboard and a mouse only: a phone is told before ▶ 게임 시작.
describe('a touch device is told before the press that the game needs a keyboard (R20-30)', () => {
  it("the poster carries the game page's own sentence with 게임 시작; the stylesheet shows it where the pointer is a finger", async () => {
    await render(snapshot({ games }));
    const note = $('.preview .game-start .keys-note');
    expect(note.textContent).toBe('이 게임은 키보드와 마우스로 플레이해요. PC에서 열어 주세요.');
    expect($<HTMLButtonElement>('.game-start-btn').getAttribute('aria-describedby')).toBe(note.id);
    expect($('.preview .game-start .muted').textContent).toBe('버전 2 · v1에서 수정'); // the poster's own lines as before
  });
});

// Plain names in sight; a service's or a format's name (GameLift Streams, GameSpec JSON) in a tooltip or behind a fold.
describe('the game pane names its run modes and its raw design in plain words (round20 review, web note 13)', () => {
  const NAMES = /GameLift|Amazon|AWS|GameSpec|JSON/;

  it('실행 방식: 브라우저 미리보기 and 클라우드 플레이; the service is the option\'s tooltip', async () => {
    await render(snapshot({ games }));
    await openSettings();
    expect(engineRadios().map((r) => r.textContent)).toEqual(['브라우저 미리보기', '클라우드 플레이']);
    expect(engineRadios()[1].title).toBe('클라우드 GPU 서버에서 실행해 이 창으로 보여 줘요 (Amazon GameLift Streams)');
    expect($('#game-settings-region').textContent).not.toMatch(NAMES);
  });

  it('설계 요약: the raw design is 개발자용 설계 데이터, folded; the format is named in its tooltip and inside the fold', async () => {
    spec.get.mockResolvedValueOnce({ version: 2, title: '코어 탈출' });
    await render(snapshot({ games }));
    await act(async () => $<HTMLButtonElement>('#game-tab-spec').click());
    const fold = $<HTMLDetailsElement>('.game-spec-details');
    const summary = fold.querySelector('summary')!;
    expect(fold.open).toBe(false);
    expect(summary.textContent).toBe('개발자용 설계 데이터 보기');
    expect(summary.title).toBe('GameSpec JSON');
    expect(summary.textContent).not.toMatch(NAMES);
    expect(fold.querySelector('pre')!.getAttribute('aria-label')).toBe('게임 설계 데이터 (GameSpec JSON)');
    expect(fold.querySelector('pre')!.textContent).toContain('"title": "코어 탈출"');
  });
});
