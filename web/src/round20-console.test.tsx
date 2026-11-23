// The live console as a first-timer meets it. The console (GameModal) is mounted over a fake API and a stand-in for
// its play window.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, StandbyState } from './api';
import { GameModal } from './components/GameModal';
import type { Asset, Game } from './types';

// vitest stubs CSS imports, so the stylesheet is read from disk (the specifier is a string: no node types needed)
const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const css = fs.readFileSync(['src/origin.css', 'web/src/origin.css'].find((p) => fs.existsSync(p))!, 'utf8');

const api = vi.hoisted(() => ({
  liveStatus: vi.fn(), liveStandby: vi.fn(), setLiveStandby: vi.fn(), liveAdSettings: vi.fn(),
  highlightSettings: vi.fn(), liveStop: vi.fn(), liveViewer: vi.fn(),
}));
vi.mock('./api', () => api);
/** The IVS player stand-in: how many are mounted (and were ever), what the last one plays, and its "playing" callback. */
const player = vi.hoisted(() => ({ mounted: 0, mounts: 0, src: '', onPlaying: null as null | ((on: boolean) => void) }));
vi.mock('./components/IvsPlayer', async () => {
  const { createElement, useEffect } = await import('react');
  return { IvsPlayer: (p: { src: string; onPlaying?: (on: boolean) => void }) => {
    useEffect(() => { player.mounted++; player.mounts++; return () => { player.mounted--; }; }, []);
    player.src = p.src;
    player.onPlaying = p.onPlaying ?? null;
    return createElement('video', { 'data-ivs': '' });
  } };
});

const game = (gameId = 'gm_1', title = '루나의 궤도 탈출') => ({ gameId, title, genre: 'sf-shooter', specKey: `games/${gameId}/spec.json`,
  previewUrl: 'blob:game', createdAt: '2026-11-05T00:00:00Z' }) as Game;
const trailer = { assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'https://cdn/t.mp4', contentType: 'video/mp4', meta: {},
  createdAt: '2026-11-05T00:00:00Z' } as Asset;
const idle: LiveState = { active: false, channelState: 'IDLE', playbackUrl: '', job: null, stream: null };
const onAir = (job: Partial<NonNullable<LiveState['job']>> = {}, over: Partial<LiveState> = {}): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: 'https://ivs/x.m3u8?token=t',
  job: { jobId: 'job_1', gameId: 'gm_1', adTitle: '루나의 궤도 탈출', everyRounds: 2, adSeconds: 10, startedAt: '2026-11-05T00:00:00Z', adType: 'trailer', roundBase: 0, ...job },
  stream: { state: 'live', rounds: 0, breaks: [], updatedAt: '2026-11-05T00:00:00Z' }, ...over });
const off: StandbyState = { on: false, state: 'off', idle: 0, allocated: 0, max: 2, mode: 'auto', hourlyUsd: 1.512 };

/** A play window as the console finds it behind window.open: its handle, and what the test moves. The one before it
 * is closed: the console keeps its play window across its own mounts. */
let lastPlay: { closed: boolean } | null = null;
function playWindow(at = 'about:blank') {
  if (lastPlay) lastPlay.closed = true;
  const play = { onAir: false, rounds: 0, closed: false, hidden: false as boolean | undefined, waiting: false as boolean | undefined,
    send: undefined as undefined | { hidden: boolean },
    start: vi.fn(async (..._a: unknown[]) => { play.onAir = true; }), stop: vi.fn(async () => { play.onAir = false; }) };
  lastPlay = play;
  const canvas = Object.assign(document.createElement('canvas'), { captureStream: () => ({}) }); // jsdom has no captureStream
  const w = { get closed() { return play.closed; }, focus: vi.fn(),
    location: { href: at, get hash() { return this.href.includes('#') ? this.href.slice(this.href.indexOf('#')) : ''; } },
    get __ipverse() {
      return this.location.href === 'about:blank' ? undefined : { canvas: () => canvas, captured: () => true,
        start: (...a: unknown[]) => play.start(...a), stop: () => play.stop(),
        state: () => ({ onAir: play.onAir, rounds: play.rounds, hidden: play.hidden, waiting: play.waiting, send: play.send }) };
    } };
  vi.stubGlobal('open', vi.fn(() => w));
  return Object.assign(play, { window: w });
}

let container: HTMLDivElement;
let root: Root;
const onNotice = vi.fn();
const onError = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  player.mounted = 0;
  player.mounts = 0;
  localStorage.clear();
  history.replaceState(null, '', '/');
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  api.liveStatus.mockResolvedValue(idle);
  api.liveStandby.mockResolvedValue(off);
  api.setLiveStandby.mockResolvedValue(off);
  api.liveViewer.mockResolvedValue({ warmed: false });
  api.liveStop.mockResolvedValue(idle);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(g: Game = game(), assets: Asset[] = [trailer], sessionId = 'ses_1') {
  await act(async () => root.render(<GameModal sessionId={sessionId} game={g} url="blob:game" assets={assets}
    onClose={vi.fn()} onError={onError} onNotice={onNotice} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // the first GET /live and GET /live/standby
}
const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector);
const find = (selector: string, text: string) => [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.includes(text));
const click = (el: HTMLElement | null | undefined) => act(async () => { el!.click(); await vi.advanceTimersByTimeAsync(0); });
const toggle = () => $<HTMLButtonElement>('.live-toggle')!;
const chip = (name: string) => [...container.querySelectorAll('.live-chips > div')].find((d) => d.querySelector('dt')?.textContent === name)
  ?.querySelector('dd')?.textContent;
const errors = () => onError.mock.calls.map((c) => (c[0] as Error).message);
const notices = () => onNotice.mock.calls.map((c) => c[0] as string);
const eyebrow = () => $('.game-modal-head .eyebrow')!.textContent ?? '';
const liveTab = () => $<HTMLButtonElement>('#game-view-live')!;

// The play window is closed on air with the console on 라이브 방송: the job stops and IVS goes offline with no word of its own.
describe('the broadcast ending under the console is said, and the console leaves the 라이브 방송 tab (R20-19)', () => {
  async function onAirOnLiveTab() {
    const play = playWindow();
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir());
    await render();
    await click(find('button', '▶ 플레이 창 열기'));
    await tick();
    await click(liveTab());
    expect(liveTab().getAttribute('aria-selected')).toBe('true');
    return play;
  }

  it('a play window closed on air: back on 플레이 화면, with a toast that says what happened and what to press', async () => {
    const play = await onAirOnLiveTab();
    expect(eyebrow()).toContain('LIVE');
    play.closed = true; // Cmd+W: its pagehide ends the job on the server
    api.liveStatus.mockResolvedValue(idle);
    await tick(2000); // the console asks the server as soon as it sees the window gone, not a poll (4 s) later
    expect($('#game-view-play')!.getAttribute('aria-selected')).toBe('true');
    expect(liveTab().disabled).toBe(true);
    expect(notices().at(-1)).toBe('플레이 창이 닫혀서 방송이 꺼졌어요. 다시 하려면 ‘라이브 켜기’를 눌러 주세요.');
    expect(eyebrow()).not.toContain('LIVE');
    expect(toggle().textContent).toBe('● 라이브 켜기');
  });

  it('a broadcast ended elsewhere (the 45-minute cap, another start) is said too, once', async () => {
    await onAirOnLiveTab();
    api.liveStatus.mockResolvedValue(idle);
    await tick(8000);
    expect(notices().filter((t) => t.includes('방송이 꺼졌어요'))).toEqual(['방송이 꺼졌어요. 다시 하려면 ‘라이브 켜기’를 눌러 주세요.']);
    expect($('#game-view-play')!.getAttribute('aria-selected')).toBe('true');
  });

  // the server names a broadcast its owner ended by starting another session's (status.endedBy)
  it("the owner's start in another session is named as that", async () => {
    await onAirOnLiveTab();
    api.liveStatus.mockResolvedValue({ ...idle, endedBy: 'takeover' });
    await tick(8000);
    expect(notices().filter((t) => t.includes('방송이 꺼졌어요'))).toEqual(['내 다른 세션에서 라이브를 켜서 이 방송이 꺼졌어요.']);
  });

  it("its own 라이브 끄기 says 라이브를 껐어요, not that the broadcast went off by itself", async () => {
    const play = await onAirOnLiveTab();
    play.stop.mockImplementation(async () => { play.onAir = false; api.liveStatus.mockResolvedValue(idle); });
    await click(toggle());
    await tick(5000);
    expect(notices().filter((t) => t.includes('껐어요') || t.includes('꺼졌어요'))).toEqual(['라이브를 껐어요.']);
  });

  it('says LIVE only while the stream is up: 연결 중 before it', async () => {
    const play = playWindow();
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir({}, { channelState: 'STARTING' }));
    await render();
    await click(liveTab());
    expect(eyebrow()).not.toContain('LIVE');
    expect(eyebrow()).toContain('연결 중');
    expect($('#game-modal-stage')!.textContent).toContain('방송에 연결하는 중이에요');
    api.liveStatus.mockResolvedValue(onAir());
    await tick(4000);
    expect(eyebrow()).toContain('● LIVE');
  });

  it('a play window closed while a start is awaited ends the wait: the button is not left on 플레이 창 준비 중…', async () => {
    const play = playWindow();
    play.start.mockImplementation(() => new Promise<void>(() => undefined)); // its window goes away: never settles
    await render();
    await click(toggle());
    await tick(1000);
    expect(toggle().textContent).toContain('플레이 창 준비 중…');
    play.closed = true;
    await tick(1000);
    expect(errors().at(-1)).toBe('플레이 창이 닫혀서 방송을 켜지 못했어요. ‘라이브 켜기’를 다시 눌러 주세요.');
    await tick(2500); // the button's own "it failed" moment
    expect(toggle().textContent).toBe('● 라이브 켜기');
    expect(toggle().disabled).toBe(false);
  });
});

// The play window is found by its name: one left open on another game must not be mirrored or started by this console.
describe('the console drives only the play window of its own game (R20-46)', () => {
  it('a play window left on another version is not mirrored; 라이브 켜기 brings it to this game, then starts', async () => {
    const play = playWindow('/#play=ses_1&g=gm_old');
    await render(game('gm_1'));
    await click(find('button', '▶ 플레이 창 열기'));
    expect(play.window.location.href).toBe('/#play=ses_1&g=gm_1'); // off air: it is sent to this game
    await tick();
    expect(chip('플레이 창')).toBe('열림');
  });

  it("an earlier console's play window, still on its game, is no play window of this one", async () => {
    const play = playWindow();
    await render(game('gm_old'));
    await click(find('button', '▶ 플레이 창 열기'));
    await tick();
    expect(chip('플레이 창')).toBe('열림');
    await act(async () => root.render(null)); // the modal is closed; the play window stays
    await render(game('gm_1'));
    await tick(2000);
    expect(chip('플레이 창')).toBe('닫힘'); // v1's window is not this console's
    expect($('#game-modal-stage video:not([hidden])')).toBeNull(); // and is not mirrored under v2's title
    await click(toggle());
    await tick(1000);
    expect(play.window.location.href).toBe('/#play=ses_1&g=gm_1');
    expect(play.start).toHaveBeenCalledTimes(1);
  });

  it('a play window on air with another game is left alone: the console says to stop that broadcast first', async () => {
    const play = playWindow('/#play=ses_other&g=gm_x');
    play.onAir = true;
    await render(game('gm_1'));
    await click(toggle());
    await tick(1000);
    expect(errors().at(-1)).toBe('플레이 창이 다른 게임을 방송하고 있어요. 그 방송을 끈 뒤 다시 눌러 주세요.');
    expect(play.window.location.href).toBe('/#play=ses_other&g=gm_x');
    expect(play.start).not.toHaveBeenCalled();
    await tick(3000);
    expect(toggle().textContent).toBe('● 라이브 켜기');
  });

  it('this session on air with another of its games: the console says which, and offers no second play window', async () => {
    playWindow('/#play=ses_1&g=gm_old');
    api.liveStatus.mockResolvedValue(onAir({ gameId: 'gm_old', adTitle: '루나의 궤도 탈출 (첫 버전)' }));
    await render(game('gm_1'));
    await tick();
    const stage = $('#game-modal-stage')!.textContent ?? '';
    expect(stage).toContain('지금 방송 중인 게임은 따로 있어요 (“루나의 궤도 탈출 (첫 버전)”)');
    expect(stage).toContain('‘라이브 끄기’');
    expect(find('button', '▶ 플레이 창 열기')).toBeUndefined();
    expect(toggle().textContent).toBe('■ 라이브 끄기');
  });
});

// A session without a trailer, or a blocked popup, is said with the way out, not blamed on the game.
describe('what stops a start is said where it is, with the way out (R20-48)', () => {
  it('no trailer: above the ad styles, where one is made and which style needs none', async () => {
    await render(game(), []);
    const need = $('.live-need')!;
    expect(need.textContent).toBe('이 세션에 트레일러가 없어서 ‘전체 화면 트레일러’와 ‘코너 트레일러’ 방송은 켤 수 없어요. '
      + '영상 탭의 ‘연출해서 만들기’로 트레일러를 만들거나, ‘플레이어블 광고’ 탭에서 시작하세요.');
    // in the reading order before the styles it is about, and outside the fold
    expect(need.compareDocumentPosition($('.ad-type')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(find('button', '트레일러가 필요해요')!.hasAttribute('disabled')).toBe(true);
    await click($('#adtype-tab-playable'));
    expect(toggle().textContent).toBe('● 라이브 켜기'); // the way on without a trailer
    expect(toggle().disabled).toBe(false);
  });

  it('a blocked popup is said at once, with how to allow it', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    await render();
    await click(toggle());
    expect(errors()).toEqual(['팝업이 차단돼서 플레이 창을 열지 못했어요. 주소창 오른쪽의 팝업 차단 아이콘을 눌러 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.']);
    await click(find('button', '▶ 플레이 창 열기'));
    expect(errors()).toHaveLength(2);
    await click(find('button', '시청 창 열기'));
    expect(errors().at(-1)).toContain('팝업이 차단돼서 시청 창을 열지 못했어요.');
  });
});

// One channel serves every account: the server refuses a start while another account is on air (409), and wants the
// user's word before it ends a broadcast of the same owner's other session (409, then `takeover: true`).
describe('a start that would end another broadcast (C-02)', () => {
  const refused = (code: string, message: string) => ({ name: 'ApiError', status: 409, code, message, toString: () => `ApiError: ${message}` });
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');

  it("another account's broadcast: the server's sentence is shown, and nothing is asked", async () => {
    const play = playWindow();
    play.start.mockRejectedValue(refused('live_busy', '다른 사용자가 방송 중이에요. 끝난 뒤(최대 45분) 다시 시도해 주세요'));
    await render();
    await click(toggle());
    await tick(1000);
    expect(errors()).toEqual(['다른 사용자가 방송 중이에요. 끝난 뒤(최대 45분) 다시 시도해 주세요']);
    expect(dialog()).toBeNull();
    expect(play.start).toHaveBeenCalledTimes(1);
  });

  it("the same owner's other session: the console asks, and only a yes sends the takeover", async () => {
    const play = playWindow();
    // the server's answer (server/live.py start): 409 live_other_session; its code says it, whatever its sentence
    play.start.mockRejectedValueOnce(refused('live_other_session', '먼저 켜 둔 방송을 꺼 주세요.'));
    await render();
    await click(toggle());
    await tick(1000);
    // (this fake API has no session list, so the question names no session)
    expect(dialog()!.textContent).toContain('내 다른 세션이 방송 중이에요.');
    expect(dialog()!.textContent).toContain('그 방송을 끄고 이 게임을 방송할까요?');
    expect(errors()).toEqual([]); // a question, not a failure
    expect(play.start).toHaveBeenCalledTimes(1);
    expect(play.start.mock.calls[0][4]).toBeUndefined(); // the first try never takes over
    await click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === '끄고 방송하기'));
    await tick(1000);
    expect(play.start).toHaveBeenCalledTimes(2);
    expect(play.start.mock.calls[1]).toEqual([2, 'trailer', 90, true, true]);
    expect(dialog()).toBeNull();
    expect(notices().some((t) => t.startsWith('라이브를 켰어요'))).toBe(true);
  });

  it('a no leaves the other broadcast alone and says nothing more', async () => {
    const play = playWindow();
    play.start.mockRejectedValueOnce(refused('live_other_session', '내 다른 세션에서 방송 중이에요. 그 방송을 먼저 꺼 주세요.'));
    await render();
    await click(toggle());
    await tick(1000);
    await click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === '취소'));
    await tick(3000);
    expect(play.start).toHaveBeenCalledTimes(1);
    expect(errors()).toEqual([]);
    expect(dialog()).toBeNull();
    expect(toggle().textContent).toBe('● 라이브 켜기');
    expect(toggle().disabled).toBe(false);
  });
});

// No round and no ad come until 임무 시작 is pressed in the play window: the console says the steps, their order and the limit.
describe('the console says what to do next (R20-04)', () => {
  const steps = () => [...container.querySelectorAll('.live-steps li')];
  const current = () => steps().findIndex((li) => li.getAttribute('aria-current') === 'step') + 1;
  async function onAirConsole(play: ReturnType<typeof playWindow>, live: LiveState = onAir()) {
    play.onAir = true;
    api.liveStatus.mockResolvedValue(live);
    await render();
    await click(find('button', '▶ 플레이 창 열기'));
    await tick();
  }

  it('a numbered line at the top names the three steps and marks the one the user is at', async () => {
    const play = playWindow();
    await render();
    expect(steps().map((li) => li.textContent)).toEqual(['① 라이브 켜기 (플레이 창이 열려요)', '② 플레이 창에서 ‘임무 시작’을 눌러 플레이',
      '③ 시청 창에서 가상 시청자 4명이 받는 광고 보기']);
    // above the stage: the first thing under the title
    expect($('.live-steps')!.compareDocumentPosition($('#game-modal-stage')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(current()).toBe(1);
    play.onAir = true;
    play.waiting = true;
    api.liveStatus.mockResolvedValue(onAir());
    await click(find('button', '▶ 플레이 창 열기'));
    await tick(4000);
    expect(current()).toBe(2);
    play.waiting = false;
    play.rounds = 1;
    api.liveStatus.mockResolvedValue(onAir({}, { stream: { state: 'live', rounds: 1, breaks: [], updatedAt: '' } }));
    await tick(4000);
    expect(current()).toBe(3);
  });

  it('under 라이브 켜기: what it will do and the 45-minute limit; gone once on air', async () => {
    const play = playWindow();
    await render();
    const does = $('.live-go-does')!;
    expect(does.textContent).toBe('플레이 창의 게임 화면을 방송해요 · 최대 45분 뒤 자동으로 꺼져요');
    expect(does.parentElement!.contains(toggle())).toBe(true); // the line belongs to the button's group
    await onAirConsole(play);
    expect($('.live-go-does')).toBeNull();
  });

  it('on air with the game at its briefing: a notice over the stage, with a button that brings the play window up', async () => {
    const play = playWindow();
    play.waiting = true;
    await onAirConsole(play);
    const notice = $('.stage-notice')!;
    expect(notice.textContent).toContain('플레이 창에서 ‘임무 시작’을 눌러야 판이 시작돼요. 광고는 2판이 끝날 때마다 나가요.');
    expect($('#game-modal-stage')!.contains(notice)).toBe(true);
    await click(find('.stage-notice button', '플레이 창으로 가기'));
    expect(play.window.focus).toHaveBeenCalledTimes(1);
    play.waiting = false; // 임무 시작 was pressed
    await tick();
    expect($('.stage-notice')).toBeNull();
  });

  it('a play window that does not say whether it waits (an older one): the notice shows until the first round is in', async () => {
    const play = playWindow();
    play.waiting = undefined;
    await onAirConsole(play);
    expect($('.stage-notice')!.textContent).toContain('‘임무 시작’');
    api.liveStatus.mockResolvedValue(onAir({}, { stream: { state: 'live', rounds: 1, breaks: [], updatedAt: '' } }));
    await tick(4000);
    expect($('.stage-notice')).toBeNull();
  });

  it("the built-in player (#demo=1) starts its rounds itself: no notice", async () => {
    history.replaceState(null, '', '/#demo=1');
    const play = playWindow();
    play.waiting = undefined;
    await onAirConsole(play);
    expect($('.stage-notice')).toBeNull();
  });

  // Between rounds the game shows its briefing for a moment and starts the next round itself: the play window does not
  // report that as a wait (class "again"), so the line stays at ③; only a game that really waits brings ② back.
  it('between rounds the line stays at ③: the play window says the game is not waiting', async () => {
    const play = playWindow();
    play.rounds = 1;
    play.waiting = false;
    await onAirConsole(play, onAir({}, { stream: { state: 'live', rounds: 1, breaks: [], updatedAt: '' } }));
    await tick(4000);
    expect(current()).toBe(3);
    expect($('.stage-notice')).toBeNull();
    play.waiting = true;
    await tick();
    expect(current()).toBe(2);
    expect($('.stage-notice')!.textContent).toContain('‘임무 시작’');
  });

  it('a chip counts the rounds to the next ad', async () => {
    const play = playWindow();
    await render();
    expect(chip('다음 광고까지')).toBeUndefined(); // off air: no ad is coming
    await onAirConsole(play, onAir({ everyRounds: 3, roundBase: 4 }, { stream: { state: 'live', rounds: 5, breaks: [], updatedAt: '' } }));
    await tick(4000); // the console's next status poll
    expect(chip('다음 광고까지')).toBe('2판'); // 1 of 3 rounds played since the broadcast's first report
    expect(chip('끝난 판')).toBe('5판');
  });

  it("the 라이브 방송 tab's reason is text in sight while it is off, not a tooltip", async () => {
    await render();
    expect(liveTab().disabled).toBe(true);
    expect(liveTab().hasAttribute('title')).toBe(false);
    const why = document.getElementById(liveTab().getAttribute('aria-describedby')!)!;
    expect(why.textContent).toBe('‘라이브 방송’ 탭은 라이브를 켜면 열려요');
    expect(why.closest('[hidden], .sr-only')).toBeNull();
    api.liveStatus.mockResolvedValue(onAir());
    await tick(4000);
    expect(liveTab().disabled).toBe(false);
    expect($('.view-switch-why')).toBeNull();
  });
});

// A broadcast needs the play window beside the console, and on a phone window.open gives a tab.
describe('on a touch device the console says a broadcast needs a PC (R20-30)', () => {
  it("one line under the steps; a note, not a lock: 라이브 켜기 stays as it is", async () => {
    await render();
    const note = $('.live-pc-note')!;
    expect(note.textContent).toBe('라이브 방송은 창 두 개를 나란히 띄워야 해서 PC 브라우저에서만 켤 수 있어요.');
    expect(note.getAttribute('role')).toBe('note');
    expect($('.live-steps')!.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition($('#game-modal-stage')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle().disabled).toBe(false);
  });
});

// The broadcast is the play window's canvas, and a hidden or fully covered window draws no frames: the mirror stops,
// no round ends, no ad goes out.
describe('a covered play window is said in the console (R20-05)', () => {
  async function onAirConsole(play: ReturnType<typeof playWindow>) {
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir({}, { stream: { state: 'live', rounds: 1, breaks: [], updatedAt: '' } }));
    await render();
    await click(find('button', '▶ 플레이 창 열기'));
    await tick();
  }
  const alert = () => $('.stage-notice[role="alert"]');

  it('on air and covered: an alert over the stage, with a button that brings the play window to the front', async () => {
    const play = playWindow();
    play.hidden = true;
    await onAirConsole(play);
    expect(alert()!.textContent).toContain('플레이 창이 가려져서 게임과 방송이 멈췄어요. 플레이 창을 이 창 옆에 나란히 두세요.');
    expect($('#game-modal-stage')!.contains(alert())).toBe(true);
    expect(chip('플레이 창')).toBe('가려짐 · 화면 멈춤');
    await click(find('.stage-notice button', '플레이 창 보기'));
    expect(play.window.focus).toHaveBeenCalledTimes(1);
    play.hidden = false; // it is in sight again
    await tick();
    expect(alert()).toBeNull();
    expect(chip('플레이 창')).toBe('열림');
  });

  it('comes before the 임무 시작 notice: one thing to do at a time', async () => {
    const play = playWindow();
    play.hidden = true;
    play.waiting = true;
    await onAirConsole(play);
    expect(container.querySelectorAll('.stage-notice')).toHaveLength(1);
    expect(alert()).not.toBeNull();
  });

  it('a play window from before round 20 says it through its send sample', async () => {
    const play = playWindow();
    play.hidden = undefined;
    play.send = { hidden: true };
    await onAirConsole(play);
    expect(alert()).not.toBeNull();
  });

  it('off air a covered play window is no alarm', async () => {
    const play = playWindow();
    play.hidden = true;
    await render();
    await click(find('button', '▶ 플레이 창 열기'));
    await tick();
    expect(alert()).toBeNull();
  });

  it('says to keep the two windows side by side before anything is covered', async () => {
    playWindow(); // (no play window is open: the console looks at one it knows as it opens, not a second later)
    await render();
    expect($('#game-modal-stage')!.textContent).toContain('플레이 창이 가려지면 게임과 방송이 멈춰요. 이 창 옆에 나란히 두세요.');
    expect($('#game-modal-hint')!.textContent).toContain('플레이 창은 가리거나 최소화하지 말고 이 창 옆에 나란히 두세요.');
  });
});

// Nothing costs money without saying so first: the tab itself starts nothing (it is kept in the hash, so reopening
// the console would pre-warm a paid GPU host). The line on the tab says the price, and 미리 켜기 starts the server.
describe('the 플레이어블 tab starts no server by itself: 미리 켜기 does, with the price on it (R20-06)', () => {
  const until = Math.floor(new Date(2026, 10, 16, 14, 32, 10).getTime() / 1000);
  const warming: StandbyState = { ...off, on: true, state: 'warming', allocated: 1, mode: 'on', prewarm: true, until };
  const ready: StandbyState = { ...warming, state: 'ready', idle: 1 };
  const line = () => $('.standby-line');
  const region = () => $('#live-adv-region')!;
  const prewarms = () => api.setLiveStandby.mock.calls.filter((c) => c[1] === true && c[2] === true);

  it('a tab remembered in the address starts nothing: the line says what the server is for, and 미리 켜기 names the price', async () => {
    history.replaceState(null, '', '/#adtype=playable');
    await render();
    await tick(12_000);
    expect(api.setLiveStandby).not.toHaveBeenCalled();
    expect(line()!.textContent).toContain('플레이어블 서버가 꺼져 있어요');
    expect(region().contains(line())).toBe(false); // in sight with 고급 설정 folded
    api.setLiveStandby.mockResolvedValue(warming);
    await click(find('.standby-line button', '미리 켜기 · 시간당 약 $1.51'));
    expect(prewarms()).toEqual([['ses_1', true, true]]);
  });

  it('a pick of the tab says what the server costs before anything starts; 미리 켜기 starts it and says so on the tab and in a toast: the wait, the price, when it goes, 지금 내리기', async () => {
    api.setLiveStandby.mockResolvedValue(warming);
    await render();
    expect(line()).toBeNull(); // the trailer tab: no word about a server
    await click($('#adtype-tab-playable'));
    await tick(6000);
    expect(api.setLiveStandby).not.toHaveBeenCalled(); // the pick spends nothing
    expect(line()!.textContent).toContain('플레이어블 서버가 꺼져 있어요');
    expect(line()!.textContent).toContain('켜져 있는 동안 시간당 약 $1.51'); // also what 라이브 켜기 on this tab will cost
    expect(notices().filter((t) => t.includes('플레이어블 서버'))).toEqual([]);
    api.liveStandby.mockResolvedValue(warming);
    await click(find('.standby-line button', '미리 켜기 · 시간당 약 $1.51'));
    expect(prewarms()).toEqual([['ses_1', true, true]]);
    const said = line()!.textContent ?? '';
    expect(said).toContain('플레이어블 서버를 미리 켜는 중이에요');
    expect(said).toContain('보통 4–6분');
    expect(said).toMatch(/방송을 시작하지 않으면 .*2:32에 자동으로 내려가요/);
    expect(said).toContain('켜져 있는 동안 시간당 약 $1.51');
    expect(region().contains(line())).toBe(false);
    expect(notices().filter((t) => t.startsWith('플레이어블 서버를 미리 켜는 중이에요'))).toHaveLength(1);
    expect(notices().at(-1)).toContain('시간당 약 $1.51');

    api.liveStandby.mockResolvedValue(ready);
    await tick(5000);
    expect(line()!.textContent).toContain('준비 완료 · 지금 라이브를 켜면 카드가 바로 열려요');

    api.setLiveStandby.mockResolvedValue(off);
    api.liveStandby.mockResolvedValue(off);
    await click(find('.standby-line button', '지금 내리기'));
    expect(api.setLiveStandby).toHaveBeenLastCalledWith('ses_1', false);
    expect(line()!.textContent).toContain('플레이어블 서버가 꺼져 있어요');
  });

  // a playable broadcast starts the server too: its price is beside the button that starts it (on a narrow window the
  // tab's own line is below the fold)
  it('라이브 켜기 says what a playable broadcast costs, on that tab only', async () => {
    await render();
    const does = () => $('.live-go-does')!.textContent ?? '';
    expect(does()).toBe('플레이 창의 게임 화면을 방송해요 · 최대 45분 뒤 자동으로 꺼져요');
    await click($('#adtype-tab-playable'));
    await tick(4000);
    expect(does()).toBe('플레이 창의 게임 화면을 방송해요 · 최대 45분 뒤 자동으로 꺼져요 · 플레이어블 서버가 켜져요 (켜져 있는 동안 시간당 약 $1.51)');
    await click($('#adtype-tab-corner'));
    expect(does()).not.toContain('플레이어블 서버');
  });

  it('neither the arrow keys to the tab nor a click on the tab the address had left open start it', async () => {
    api.setLiveStandby.mockResolvedValue(warming);
    await render();
    await act(async () => {
      $('#adtype-tab-trailer')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect($('#adtype-tab-playable')!.getAttribute('aria-selected')).toBe('true');
    await tick(6000);
    expect(api.setLiveStandby).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    history.replaceState(null, '', '/#adtype=playable');
    await render();
    await click($('#adtype-tab-playable'));
    await tick(6000);
    expect(api.setLiveStandby).not.toHaveBeenCalled();
  });

  it('never under a broadcast, and not when one ends with the tab still open (round 17: an idle host held 13–15 minutes more)', async () => {
    const play = playWindow();
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir({ adType: 'playable', playableSeconds: 90 }));
    api.liveStandby.mockResolvedValue({ ...off, on: true, state: 'ready', idle: 1, allocated: 1 });
    await render();
    await click(find('button', '▶ 플레이 창 열기'));
    await tick(5000);
    expect($('#adtype-tab-playable')!.getAttribute('aria-selected')).toBe('true');
    expect(line()!.textContent).toContain('라이브를 끄면 자동으로 내려가요');
    expect(find('.standby-line button', '지금 내리기')).toBeUndefined();
    play.onAir = false;
    api.liveStatus.mockResolvedValue(idle);
    api.liveStandby.mockResolvedValue(off);
    await tick(10_000);
    expect(prewarms()).toHaveLength(0);
  });
});

// 지금 내리기's toast offers no 되돌리기 that would turn the server on again, and on air 변경 적용 on the 플레이어블 tab
// (which makes the broadcast a playable one: server/live.py ad_settings) says the price beside it.
describe('every control of the console that starts the playable server says its price first (round20 review, web note 12)', () => {
  const line = () => $('.standby-line');
  const held: StandbyState = { ...off, on: true, state: 'ready', idle: 1, allocated: 1, mode: 'on', prewarm: true };
  async function onAirWith(job: Partial<NonNullable<LiveState['job']>>) {
    const play = playWindow();
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir(job));
    await render();
    await click(find('button', '▶ 플레이 창 열기'));
    await tick(5000);
  }

  it('지금 내리기 says the server went down and puts no button on its toast: the way back is 미리 켜기, with its price', async () => {
    api.liveStandby.mockResolvedValue(held);
    history.replaceState(null, '', '/#adtype=playable');
    await render();
    await tick(5000);
    api.setLiveStandby.mockResolvedValue(off);
    api.liveStandby.mockResolvedValue(off);
    await click(find('.standby-line button', '지금 내리기'));
    const said = onNotice.mock.calls.at(-1)!;
    expect(said[0]).toContain('플레이어블 서버를 내렸어요');
    expect(said[1]).toBeUndefined();
    expect(find('.standby-line button', '미리 켜기 · 시간당 약 $1.51')).toBeTruthy();
    expect(api.setLiveStandby.mock.calls.filter((c) => c[1] === true)).toEqual([]); // nothing turned it on again
  });

  it('the switch in 고급 설정 turned off: no button on that toast either', async () => {
    api.liveStandby.mockResolvedValue(held);
    history.replaceState(null, '', '/#adtype=playable');
    await render();
    await tick(5000);
    api.setLiveStandby.mockResolvedValue(off);
    await click($('#live-adv-head'));
    await click($('.standby-row [role="switch"]'));
    expect(api.setLiveStandby).toHaveBeenLastCalledWith('ses_1', false);
    expect(onNotice.mock.calls.at(-1)![1]).toBeUndefined();
  });

  it('on air with another style, the 플레이어블 tab says before 변경 적용 that it starts the server, the wait and the price', async () => {
    await onAirWith({ adType: 'trailer', corner: true });
    expect(line()).toBeNull();
    await click($('#adtype-tab-playable'));
    await tick(5000);
    expect(find('.ad-type-fields button', '변경 적용')).toBeTruthy();
    expect(line()!.textContent).toBe('‘변경 적용’을 누르면 플레이어블 서버가 켜져요 · 보통 4–6분 뒤부터 카드가 열려요 · 라이브를 끄면 자동으로 내려가요 · 켜져 있는 동안 시간당 약 $1.51');
    expect(line()!.closest('.ad-type-body')!.contains(find('.ad-type-fields button', '변경 적용')!)).toBe(true); // beside the button
    expect(api.setLiveStandby).not.toHaveBeenCalled();
    expect(api.liveAdSettings).not.toHaveBeenCalled();
  });

  it('a server that is up already costs what it costs: the line says so, and what the press changes', async () => {
    api.liveStandby.mockResolvedValue({ ...held, prewarm: false });
    await onAirWith({ adType: 'corner' });
    await click($('#adtype-tab-playable'));
    await tick(5000);
    expect(line()!.textContent).toBe('‘변경 적용’을 누르면 플레이어블 광고로 바뀌어요 · 플레이어블 서버는 이미 켜져 있어요 · 켜져 있는 동안 시간당 약 $1.51');
  });

  it("the price is there before the server's state is read, and while it cannot be read", async () => {
    api.liveStandby.mockRejectedValue(new Error('503'));
    await onAirWith({ adType: 'trailer' });
    await click($('#adtype-tab-playable'));
    await tick(5000);
    expect(line()!.textContent).toContain('‘변경 적용’을 누르면 플레이어블 서버가 켜져요');
    expect(line()!.textContent).toContain('켜져 있는 동안 시간당 약 $1.51');
  });

  // the mock mode's /live/standby answer carries no price: the button must not read the figure off the answer alone
  it('an answer with no price does not take the console down: the button names the figure the client knows', async () => {
    playWindow(); // (no play window is open: the one of the case before is closed)
    api.liveStandby.mockResolvedValue({ on: false, state: 'off', idle: 0, allocated: 0, max: 2, mode: 'auto' } as unknown as StandbyState);
    history.replaceState(null, '', '/#adtype=playable');
    await render();
    await tick(5000);
    expect(find('.standby-line button', '미리 켜기 · 시간당 약 $1.51')).toBeTruthy();
    expect(line()!.textContent).toContain('켜져 있는 동안 시간당 약 $1.51');
  });

  it('a playable broadcast on air keeps its own line: nothing is left to start', async () => {
    api.liveStandby.mockResolvedValue({ ...off, on: true, state: 'ready', idle: 1, allocated: 1 });
    await onAirWith({ adType: 'playable', playableSeconds: 90 });
    expect(line()!.textContent).toContain('플레이어블 서버 준비 완료 · 카드를 누르면 바로 열려요 · 라이브를 끄면 자동으로 내려가요');
    expect(line()!.textContent).not.toContain('변경 적용');
  });
});

// A new creative is usable 90 s after a 1-second warm-up break, and a warm-up goes out only while a viewer's player
// is playing: the console keeps a player (and its /live/viewer heartbeat) on both tabs.
describe('the console watches its own broadcast from the moment the channel is up, on both tabs (C-01)', () => {
  async function onAirConsole(live: LiveState = onAir()) {
    const play = playWindow();
    play.onAir = true;
    api.liveStatus.mockResolvedValue(live);
    await render();
    return play;
  }
  const box = () => $('.stage-live')!;

  it('on 플레이 화면: a muted player out of sight, and its viewer heartbeat once it plays', async () => {
    await onAirConsole();
    expect($('#game-view-play')!.getAttribute('aria-selected')).toBe('true');
    expect(player.mounted).toBe(1);
    expect(player.src).toBe('https://ivs/x.m3u8?token=t');
    expect([box().classList.contains('is-off'), box().getAttribute('aria-hidden')]).toEqual([true, 'true']);
    expect(api.liveViewer).not.toHaveBeenCalled(); // nothing plays yet: no viewer for a warm-up to reach
    await act(async () => player.onPlaying!(true));
    expect(api.liveViewer.mock.calls).toEqual([['ses_1']]);
    await tick(15_000);
    expect(api.liveViewer).toHaveBeenCalledTimes(2);
  });

  it('the 라이브 방송 tab shows that same player at once: no second one, and the heartbeat goes on', async () => {
    await onAirConsole();
    await act(async () => player.onPlaying!(true));
    await click(liveTab());
    expect([player.mounted, player.mounts]).toEqual([1, 1]);
    expect([box().classList.contains('is-off'), box().getAttribute('aria-hidden')]).toEqual([false, null]);
    expect($('.live-badge')!.textContent).toBe('● LIVE');
    await click($('#game-view-play'));
    expect([player.mounted, player.mounts]).toEqual([1, 1]);
    expect(box().classList.contains('is-off')).toBe(true);
    expect($('.live-badge')).toBeNull(); // the mirror is not the broadcast
    await tick(15_000);
    expect(api.liveViewer).toHaveBeenCalledTimes(2); // one beat every 15 s, not one more for each tab switch
  });

  it('no player before the channel is up, and none once the broadcast is off', async () => {
    await onAirConsole(onAir({}, { channelState: 'STARTING' }));
    expect(player.mounted).toBe(0);
    api.liveStatus.mockResolvedValue(onAir());
    await tick(4000);
    expect(player.mounted).toBe(1);
    api.liveStatus.mockResolvedValue(idle);
    await tick(4000);
    expect(player.mounted).toBe(0);
  });
});

// The console's main flow uses plain words; AWS service names stay inside 고급 설정.
describe('plain words in the console; the service names stay inside 고급 설정 (R20-20)', () => {
  const NAMES = /IVS|MediaTailor|GameLift|SSAI|Pegasus|Bedrock|AMAZON|Amazon/;
  /** What the console says in sight with 고급 설정 folded: its text without the fold's region. */
  const said = () => {
    const copy = container.cloneNode(true) as HTMLElement;
    copy.querySelector('#live-adv-region')?.remove();
    return copy.textContent ?? '';
  };
  const what = () => $('.ad-type-what')!.textContent ?? '';

  it('off air: each ad style is its name and one plain line; no service name in sight', async () => {
    await render();
    expect([...container.querySelectorAll('[role="tablist"][aria-label="광고 스타일"] [role="tab"]')].map((t) => t.textContent))
      .toEqual(['전체 화면 트레일러', '플레이어블 광고', '코너 트레일러']);
    expect(what()).toContain('판이 끝나면 시청자 화면 전체에 트레일러가 나와요. 시청자마다 다른 트레일러를 받아요.');
    expect(said()).not.toMatch(NAMES);
    await click($('#adtype-tab-playable'));
    expect(what()).toContain('판이 끝나면 시청자마다 게임 카드가 떠요. 누르면 설치 없이 바로 해 볼 수 있어요.');
    expect(said()).not.toMatch(NAMES);
    await click($('#adtype-tab-corner'));
    expect(what()).toContain('판이 끝나면 화면 구석에 작은 트레일러가 떠요. 방송은 끊기지 않아요.');
    expect(said()).not.toMatch(NAMES);
    expect(chip('방송 상태')).toBe('꺼짐');
    expect(chip('나간 광고')).toBe('0회');
  });

  it('on air, on both tabs: the header, the chips and the stage say it in plain words', async () => {
    const play = playWindow();
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir());
    await render();
    await click(find('button', '▶ 플레이 창 열기'));
    await tick();
    expect(chip('방송 상태')).toBe('방송 중');
    expect($('.mirror-badge')!.textContent).toBe('내 플레이 화면 (방송은 몇 초 늦게 나가요)');
    expect(said()).not.toMatch(NAMES);
    await click(liveTab());
    expect(said()).not.toMatch(NAMES);
    api.liveStatus.mockResolvedValue(onAir({}, { channelState: 'STARTING' }));
    await tick(4000);
    expect(chip('방송 상태')).toBe('연결 중');
    expect(said()).not.toMatch(NAMES);
  });

  it('the services are still named once, for whoever opens 고급 설정', async () => {
    await render();
    expect($('#live-adv-region')!.textContent).toMatch(/IVS/);
    expect($('#live-adv-region')!.textContent).toMatch(/MediaTailor/);
    await click($('#adtype-tab-playable'));
    expect($('#live-adv-region')!.textContent).toMatch(/GameLift Streams/);
  });
});

// jsdom lays nothing out, so the rules are pinned here: the stage is capped so the controls stay above the fold, and
// the play and watch windows' grids have a column rule so their bars are not clipped in a narrow window.
describe('the live windows keep their controls at real window sizes (R20-36)', () => {
  const rule = (selector: string) => css.match(new RegExp(`\\n${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  // (on air the stage's cap is the window's and gives way to the controls: the rules are in live-css.test.ts)
  it('before a broadcast the stage is capped, so the ad styles and their values are in sight; on air it is not the setup stage', async () => {
    const play = playWindow();
    await render();
    const stage = () => $('#game-modal-stage')!;
    expect(stage().classList.contains('game-modal-stage--setup')).toBe(true);
    await click(find('button', '▶ 플레이 창 열기')); // a mirror alone is no broadcast: the settings are still to be chosen
    await tick();
    expect(stage().classList.contains('game-modal-stage--setup')).toBe(true);
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir());
    await tick(4000);
    expect(stage().classList.contains('game-modal-stage--setup')).toBe(false);
    // the cap follows the window's height and stops at a fixed size
    expect(rule('.game-modal-stage--setup')).toMatch(/max-height:\s*min\(\d+vh,\s*\d+px\)/);
  });

  it("a popup window's one column never grows past the window, and its bar wraps instead of being cut", () => {
    expect(rule('.popup-window')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule('.popup-bar')).toMatch(/flex-wrap:\s*wrap/);
  });
});
