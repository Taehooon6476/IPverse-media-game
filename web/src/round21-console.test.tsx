// The live console (GameModal), mounted over a fake API and a stand-in for its play window.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, StandbyState } from './api';
import { GameModal } from './components/GameModal';
import type { Asset, Game } from './types';

const api = vi.hoisted(() => ({
  liveStatus: vi.fn(), liveStandby: vi.fn(), setLiveStandby: vi.fn(), liveAdSettings: vi.fn(),
  highlightSettings: vi.fn(), liveStop: vi.fn(), liveViewer: vi.fn(), listSessions: vi.fn(),
}));
vi.mock('./api', () => api);
/** The IVS player stand-in: what the console's player would say of a stitched ad. */
const player = vi.hoisted(() => ({ onAd: null as null | ((ad: { on: boolean; seconds?: number }) => void) }));
vi.mock('./components/IvsPlayer', async () => {
  const { createElement } = await import('react');
  return { IvsPlayer: (p: { onAd?: (ad: { on: boolean; seconds?: number }) => void }) => {
    player.onAd = p.onAd ?? null;
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

/** A play window as the console finds it behind window.open (round20-console.test.tsx). The one before it is closed:
 * the console keeps its play window across its own mounts. */
let lastPlay: { closed: boolean } | null = null;
function playWindow(at = 'about:blank') {
  if (lastPlay) lastPlay.closed = true;
  const play = { onAir: false, rounds: 0, closed: false, hidden: false as boolean | undefined, waiting: false as boolean | undefined,
    start: vi.fn(async (..._a: unknown[]) => { play.onAir = true; }), stop: vi.fn(async () => { play.onAir = false; }) };
  lastPlay = play;
  const canvas = Object.assign(document.createElement('canvas'), { captureStream: () => ({}) }); // jsdom has no captureStream
  const w = { get closed() { return play.closed; }, focus: vi.fn(),
    location: { href: at, get hash() { return this.href.includes('#') ? this.href.slice(this.href.indexOf('#')) : ''; } },
    get __ipverse() {
      return this.location.href === 'about:blank' ? undefined : { canvas: () => canvas, captured: () => true,
        start: (...a: unknown[]) => play.start(...a), stop: () => play.stop(),
        state: () => ({ onAir: play.onAir, rounds: play.rounds, hidden: play.hidden, waiting: play.waiting }) };
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
  if (lastPlay) lastPlay.closed = true; // the console keeps its play window across its own mounts: each case starts with none
  localStorage.clear();
  history.replaceState(null, '', '/');
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  api.liveStatus.mockResolvedValue(idle);
  api.liveStandby.mockResolvedValue(off);
  api.setLiveStandby.mockResolvedValue(off);
  api.liveViewer.mockResolvedValue({ warmed: false });
  api.liveStop.mockResolvedValue(idle);
  api.listSessions.mockResolvedValue({ sessions: [] });
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
const errors = () => onError.mock.calls.map((c) => (c[0] as Error).message);
const notices = () => onNotice.mock.calls.map((c) => c[0] as string);
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

// The console says what the server's answer says (a 200 with on false after 지금 내리기), and says before the press that
// a server started ahead goes by itself after ten minutes.
describe('미리 켜기 says what the server answered, not what was pressed (new finding 3, R20-06)', () => {
  const until = Math.floor(new Date(2026, 10, 16, 14, 32, 10).getTime() / 1000);
  const warming: StandbyState = { ...off, on: true, state: 'warming', allocated: 1, mode: 'on', prewarm: true, until };
  const line = () => $('.standby-line');
  const warm = () => find('.standby-line button', '미리 켜기');
  async function playableTab() {
    history.replaceState(null, '', '/#adtype=playable');
    await render();
    await tick(5000);
  }

  it('an answer that started nothing is said: the button is 미리 켜기 again, and a toast names the way that works', async () => {
    await playableTab();
    api.setLiveStandby.mockResolvedValue({ ...off, mode: 'off' }); // taken down by hand a moment ago (지금 내리기)
    await click(warm());
    expect(api.setLiveStandby.mock.calls).toEqual([['ses_1', true, true]]);
    expect(errors()).toEqual(['플레이어블 서버를 꺼 둔 상태라 미리 켜지 못했어요. 고급 설정의 ‘플레이어블 서버’ 스위치로 켤 수 있어요.']);
    expect(notices()).toEqual([]);
    expect(line()!.textContent).toContain('플레이어블 서버가 꺼져 있어요');
    expect(warm()).toBeTruthy();
    expect(find('.standby-line button', '지금 내리기')).toBeUndefined();
    await tick(2500); // the button's own "it failed" moment
    expect(warm()!.textContent).toBe('미리 켜기 · 시간당 약 $1.51');
  });

  it('with the switch not set by hand: it could not be started, try again', async () => {
    await playableTab();
    api.setLiveStandby.mockResolvedValue(off);
    await click(warm());
    expect(errors()).toEqual(['플레이어블 서버를 켜지 못했어요. 잠시 뒤 다시 눌러 주세요.']);
  });

  it("a refusal is shown in the server's own sentence, and the button stays 미리 켜기", async () => {
    await playableTab();
    const refusal = Object.assign(new Error('다른 사용자가 방송 중이라 플레이어블 서버를 바꿀 수 없어요. 방송이 끝난 뒤 다시 시도해 주세요.'), { name: 'ApiError', status: 409, code: 'live_busy' });
    api.setLiveStandby.mockRejectedValue(refusal);
    await click(warm());
    expect(onError.mock.calls.map((c) => c[0])).toEqual([refusal]);
    expect(warm()).toBeTruthy();
    expect(find('.standby-line button', '지금 내리기')).toBeUndefined();
  });

  it('while the answer is on its way the button says so and takes no second press', async () => {
    await playableTab();
    const answer = deferred<StandbyState>();
    api.setLiveStandby.mockReturnValue(answer.promise);
    await click(warm());
    const busy = $<HTMLButtonElement>('.standby-line button')!;
    expect(busy.textContent).toContain('켜는 중…');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(line()!.textContent).toContain('플레이어블 서버가 꺼져 있어요'); // nothing is claimed before the answer
    await click(busy);
    expect(api.setLiveStandby).toHaveBeenCalledTimes(1);
    api.liveStandby.mockResolvedValue(warming);
    await act(async () => { answer.resolve(warming); await vi.advanceTimersByTimeAsync(0); });
    expect(line()!.textContent).toContain('플레이어블 서버를 미리 켜는 중이에요');
    expect(find('.standby-line button', '지금 내리기')!.textContent).toBe('지금 내리기'); // a new button: no tick of the press on it
    expect(notices().filter((t) => t.startsWith('플레이어블 서버를 미리 켜는 중이에요'))).toHaveLength(1);
    expect(errors()).toEqual([]);
  });

  it('지금 내리기 says 내리는 중… until the answer, then the line and the button are the answer', async () => {
    api.liveStandby.mockResolvedValue(warming);
    await playableTab();
    const answer = deferred<StandbyState>();
    api.setLiveStandby.mockReturnValue(answer.promise);
    await click(find('.standby-line button', '지금 내리기'));
    expect($('.standby-line button')!.textContent).toContain('내리는 중…');
    api.liveStandby.mockResolvedValue(off);
    await act(async () => { answer.resolve(off); await vi.advanceTimersByTimeAsync(0); });
    expect(warm()!.textContent).toBe('미리 켜기 · 시간당 약 $1.51');
    expect(notices().at(-1)).toContain('플레이어블 서버를 내렸어요');
  });

  it('before the press the line says a server started ahead goes by itself after 10 minutes without a broadcast', async () => {
    await playableTab();
    expect(line()!.textContent).toContain('미리 켠 서버는 10분 안에 라이브를 켜지 않으면 자동으로 내려가요');
    expect(line()!.textContent).toContain('켜져 있는 동안 시간당 약 $1.51');
    expect(api.setLiveStandby).not.toHaveBeenCalled();
  });

  it("the minutes are the server's own where its answer carries them (prewarmSec)", async () => {
    api.liveStandby.mockResolvedValue({ ...off, prewarmSec: 900 } as StandbyState);
    await playableTab();
    expect(line()!.textContent).toContain('미리 켠 서버는 15분 안에 라이브를 켜지 않으면 자동으로 내려가요');
  });
});

// 취소 on the takeover question is no failed press; the question names the session on air and says the limit and the
// price of what its yes starts.
describe('the takeover question (new findings 16, 17)', () => {
  const refused = () => ({ name: 'ApiError', status: 409, code: 'live_other_session', message: '내 다른 세션에서 방송 중이에요. 그 방송을 먼저 꺼 주세요.' });
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  const said = () => dialog()!.querySelector('.dialog-lead')!.textContent ?? '';
  const button = (text: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === text);
  /** The account's sessions, and which of them is on air with which game. */
  function account(onAirIn: string | null, gameTitle = '사구의 유적: 30초 생존') {
    api.listSessions.mockResolvedValue({ sessions: [{ sessionId: 'ses_1', title: '달 기지' }, { sessionId: 'ses_2', title: '모래 유적' }, { sessionId: 'ses_3', title: '새 세션' }]
      .map((s) => ({ ...s, genre: 'sf-shooter', createdAt: '2026-11-05T00:00:00Z' })) });
    api.liveStatus.mockImplementation(async (id: string) => (id === onAirIn ? onAir({ gameId: 'gm_x', adTitle: gameTitle }) : idle));
  }
  /** The console's 라이브 켜기, refused once by the server: the account's other session is on air. */
  async function ask() {
    const play = playWindow();
    play.start.mockRejectedValueOnce(refused());
    await render();
    await click(toggle());
    await tick(1000);
    return play;
  }

  it('취소 is not a failed press: no shake, no 실패, and the button is at rest with the focus it had', async () => {
    account('ses_2');
    const play = playWindow();
    play.start.mockRejectedValueOnce(refused());
    await render();
    toggle().focus();
    await click(toggle());
    await tick(1000);
    expect(dialog()).not.toBeNull();
    await click(button('취소'));
    expect(dialog()).toBeNull();
    expect(toggle().textContent).toBe('● 라이브 켜기');
    expect(toggle().className).not.toMatch(/is-error|is-done|is-busy/);
    expect(toggle().querySelector('[role="status"]')!.textContent).toBe('');
    expect(toggle().getAttribute('aria-busy')).toBe('false');
    expect(document.activeElement).toBe(toggle());
    await tick(3000);
    expect(toggle().textContent).toBe('● 라이브 켜기');
    expect(errors()).toEqual([]);
    expect(play.start).toHaveBeenCalledTimes(1);
    // and it starts again as any first press does
    await click(toggle());
    await tick(1000);
    expect(play.start).toHaveBeenCalledTimes(2);
    expect(play.start.mock.calls[1][4]).toBeUndefined();
  });

  it('names the session on air by its title and its game, says its watch page stops, and gives the 45-minute limit', async () => {
    account('ses_2');
    await ask();
    expect(dialog()!.querySelector('h2')!.textContent).toBe('다른 세션이 방송 중이에요');
    expect(said()).toBe('‘모래 유적’ 세션에서 ‘사구의 유적: 30초 생존’ 방송 중이에요. 그 방송을 끄면 보고 있던 시청 창도 멈춰요. '
      + '새 방송은 최대 45분 뒤 자동으로 꺼져요. 그 방송을 끄고 이 게임을 방송할까요?');
    expect(button('끄고 방송하기')).toBeTruthy();
    // it looked among the account's other sessions, never at this one for that
    expect(api.liveStatus.mock.calls.map((c) => c[0]).filter((id) => id !== 'ses_1').sort()).toEqual(['ses_2', 'ses_3']);
  });

  it("a playable broadcast's yes also starts the playable server: its price is in the question", async () => {
    account('ses_2');
    history.replaceState(null, '', '/#adtype=playable');
    const play = await ask();
    expect(said()).toContain('새 방송은 최대 45분 뒤 자동으로 꺼져요. 플레이어블 서버가 켜져요 (켜져 있는 동안 시간당 약 $1.51). 그 방송을 끄고 이 게임을 방송할까요?');
    await click(button('끄고 방송하기'));
    await tick(1000);
    expect(play.start.mock.calls[1]).toEqual([2, 'playable', 90, false, true]);
  });

  it('a session on air that cannot be found (a start still under way, a list that fails) is asked about without a name', async () => {
    account(null);
    const play = await ask();
    expect(said()).toBe('내 다른 세션이 방송 중이에요. 그 방송을 끄면 보고 있던 시청 창도 멈춰요. 새 방송은 최대 45분 뒤 자동으로 꺼져요. 그 방송을 끄고 이 게임을 방송할까요?');
    await click(button('취소'));
    api.listSessions.mockRejectedValue(new Error('offline'));
    play.start.mockRejectedValueOnce(refused());
    await click(toggle());
    await tick(1000);
    expect(said()).toContain('내 다른 세션이 방송 중이에요.');
  });

  it('the question does not wait for a look that takes long: after 3 s it is asked without the name', async () => {
    api.listSessions.mockReturnValue(new Promise(() => undefined));
    await ask();
    expect(dialog()).toBeNull();
    expect(toggle().textContent).toContain('플레이 창 준비 중…'); // the press is still on its way
    await tick(2500);
    expect(said()).toContain('내 다른 세션이 방송 중이에요.');
  });

  it('an account with many sessions is looked through six at a time, and no further once the question is up', async () => {
    api.listSessions.mockResolvedValue({ sessions: Array.from({ length: 40 }, (_, i) => ({ sessionId: `ses_${i + 1}`, title: `세션 ${i + 1}`, genre: 'sf-shooter', createdAt: '2026-11-05T00:00:00Z' })) });
    const asked: string[] = [];
    api.liveStatus.mockImplementation((id: string) => {
      if (id !== 'ses_1') asked.push(id);
      return new Promise((resolve) => setTimeout(() => resolve(idle), id === 'ses_1' ? 0 : 1200)); // a slow server
    });
    const play = playWindow();
    play.start.mockRejectedValueOnce(refused());
    await render();
    await click(toggle());
    await tick(600);
    expect(asked).toHaveLength(6);
    await tick(3000);
    expect(said()).toContain('내 다른 세션이 방송 중이에요.');
    await tick(10_000);
    expect(asked.length).toBeLessThanOrEqual(18); // three rounds inside the 3 s, not all 39
  });

  it('a session on air whose game has no name is named alone', async () => {
    account('ses_3', '');
    await ask();
    expect(said()).toContain('‘새 세션’ 세션에서 방송 중이에요.');
  });
});

/** A break as the status carries it: what each viewer got ('' = no viewer, the default). */
const picksOf = (titles: string[]) => Object.fromEntries(['', 'v-minji', 'v-junho', 'v-seoyeon', 'v-hyunwoo']
  .map((v, i) => [v, { title: titles[i % titles.length], creative: `cr_${i % titles.length}`, seconds: 16, url: 'https://cdn/ad.mp4' }]));
const MANY = picksOf(['사구의 유적', '강철 기사', '네온 드리프트', '구름섬 보물', '스타 워든']);
const ONE = picksOf(['사구의 유적']);
const adBreak = (round: number, picks: AdBreak['picks'], over: Partial<AdBreak> = {}): AdBreak =>
  ({ round, eventId: `t_${round}`, at: new Date().toISOString(), kind: 'trailer', seconds: 16, picks, ...over });
const streamOf = (rounds: number, breaks: AdBreak[]) => ({ state: 'live', rounds, breaks, updatedAt: '2026-11-05T00:00:00Z' });
/** The console on air beside its play window, with what the status says. */
async function onAirConsole(live: LiveState) {
  const play = playWindow();
  play.onAir = true;
  api.liveStatus.mockResolvedValue(live);
  await render();
  await click(find('button', '플레이 창 열기'));
  await tick();
  return play;
}
const chip = (name: string) => [...container.querySelectorAll('.live-chips > div')].find((d) => d.querySelector('dt')?.textContent === name)
  ?.querySelector('dd')?.textContent;

// Each viewer gets another ad: the banner says so and names the default pick as an example only.
describe("the console's banner says that the viewers get different ads, with one of them as an example (new finding 20)", () => {
  const banner = () => $('.console-ad span')!.textContent;

  it('picks that differ: 시청자마다 다른 광고가 나가요 · 예: the one the console shows', async () => {
    await onAirConsole(onAir({}, { stream: streamOf(2, [adBreak(2, MANY)]) }));
    expect(banner()).toBe('광고 송출 · 전체 화면 트레일러 · 시청자마다 다른 광고가 나가요 · 예: 사구의 유적');
    // the example is what the console plays: the preview is that same ad's
    expect($('.console-trailer')!.getAttribute('aria-label')).toBe('전체 화면 광고 미리보기: 사구의 유적');
  });

  it('every viewer got the same one: it is named as the ad that goes out, as before', async () => {
    await onAirConsole(onAir({}, { stream: streamOf(2, [adBreak(2, ONE)]) }));
    expect(banner()).toBe('광고 송출 · 전체 화면 트레일러 · 사구의 유적 · 시청자에게 나가는 광고를 여기에도 보여 드려요');
  });

  it('a corner round and a playable round say it the same way', async () => {
    await onAirConsole(onAir({ adType: 'corner' }, { stream: streamOf(1, [adBreak(1, MANY, { kind: 'corner', eventId: 'c_1' })]) }));
    expect(banner()).toBe('광고 송출 · 코너 트레일러 · 시청자마다 다른 광고가 나가요 · 예: 사구의 유적');
    api.liveStatus.mockResolvedValue(onAir({ adType: 'playable' }, { stream: streamOf(2, [adBreak(2, MANY, { kind: 'playable', playable: true, eventId: 'p_2' })]) }));
    await tick(4000);
    expect(banner()).toBe('광고 송출 · 플레이어블 광고 · 시청자마다 다른 광고가 나가요 · 예: 사구의 유적');
  });

  it('a break that names no viewer (a job from before the viewers) is the one ad it names', async () => {
    await onAirConsole(onAir({}, { stream: streamOf(2, [adBreak(2, { '': MANY[''] })]) }));
    expect(banner()).toBe('광고 송출 · 전체 화면 트레일러 · 사구의 유적 · 시청자에게 나가는 광고를 여기에도 보여 드려요');
  });

  it("the 라이브 방송 tab's badge over a stitched ad says the same of the newest full-screen break", async () => {
    await onAirConsole(onAir({}, { stream: streamOf(2, [adBreak(2, ONE)]) }));
    await click($('#game-view-live'));
    await act(async () => player.onAd!({ on: true, seconds: 16 }));
    expect($('.live-ad')!.textContent).toBe('광고 중 · 모든 시청자가 같은 트레일러');
    api.liveStatus.mockResolvedValue(onAir({}, { stream: streamOf(4, [adBreak(2, ONE), adBreak(4, MANY)]) }));
    await tick(4000);
    expect($('.live-ad')!.textContent).toBe('광고 중 · 시청자마다 다른 트레일러');
  });
});

// The status of a session whose broadcast ended names what it sent (lastBroadcast: its rounds and its ads, server/live.py
// _status); with a status that names none, the console keeps the last count it saw.
describe('the ads that went out stay counted after 라이브 끄기, as the last broadcast\'s (new finding 21)', () => {
  const breaks = [2, 4, 6].map((n) => adBreak(n, MANY));
  /** Off air, with the server's word on the broadcast that ended. */
  const ended = (rounds: number, ads: number) => ({ ...idle, lastBroadcast: { rounds, ads } }) as LiveState;
  async function stopAfterSix(stopped: LiveState) {
    const play = await onAirConsole(onAir({}, { stream: streamOf(6, breaks) }));
    play.rounds = 6;
    await tick(4000);
    expect([chip('끝난 판'), chip('나간 광고')?.startsWith('3회')]).toEqual(['6판', true]);
    play.stop.mockImplementation(async () => { play.onAir = false; api.liveStatus.mockResolvedValue(stopped); });
    await click(toggle());
    await tick(2000);
    return play;
  }

  it('a status that drops the stream at the stop: the console keeps the count it last saw', async () => {
    await stopAfterSix(idle);
    expect(chip('방송 상태')).toBe('꺼짐');
    expect(chip('끝난 판')).toBe('6판');
    expect(chip('지난 방송 광고')).toMatch(/^3회 · /);
    expect(chip('나간 광고')).toBeUndefined(); // one chip for the ads: it says whose they are
  });

  it("the status's own count of the broadcast that ended is the one shown: an ad the console had not seen yet counts", async () => {
    await stopAfterSix(ended(6, 4));
    expect(chip('지난 방송 광고')).toBe('4회'); // (no time: the console's list ends an ad earlier)
    expect(chip('끝난 판')).toBe('6판');
  });

  it('with the same count as the console saw, the time of the last ad stays beside it', async () => {
    await stopAfterSix(ended(6, 3));
    expect(chip('지난 방송 광고')).toMatch(/^3회 · /);
  });

  it('a console opened after the stop reads it too, and with none says 0회 plainly', async () => {
    api.liveStatus.mockResolvedValue(ended(6, 3));
    await render();
    expect(chip('지난 방송 광고')).toBe('3회');
    expect(chip('끝난 판')).toBe('6판');
    expect(chip('나간 광고')).toBeUndefined();
    api.liveStatus.mockResolvedValue(idle);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(chip('나간 광고')).toBe('0회');
    expect(chip('지난 방송 광고')).toBeUndefined();
  });

  it('the next broadcast starts its own count', async () => {
    const play = await stopAfterSix(idle);
    api.liveStatus.mockResolvedValue(onAir({ jobId: 'job_2' }, { stream: streamOf(6, []) }));
    await click(toggle());
    await tick(4000);
    expect(play.start).toHaveBeenCalledTimes(1);
    expect(chip('나간 광고')).toBe('0회');
    expect(chip('지난 방송 광고')).toBeUndefined();
  });

  // (a broadcast that ends before its first status has no stream of its own: the count kept is never an older one's)
  it('a next broadcast that ended before it had a count leaves none of the one before it', async () => {
    const play = await stopAfterSix(idle);
    play.start.mockImplementation(async () => { play.onAir = true; api.liveStatus.mockResolvedValue(onAir({ jobId: 'job_2' }, { stream: null })); });
    await click(toggle());
    await tick(4000);
    expect(chip('나간 광고')).toBe('0회');
    play.stop.mockImplementation(async () => { play.onAir = false; api.liveStatus.mockResolvedValue(idle); });
    await click(toggle());
    await tick(2000);
    expect(chip('방송 상태')).toBe('꺼짐');
    expect(chip('나간 광고')).toBe('0회');
    expect(chip('지난 방송 광고')).toBeUndefined();
  });
});

// The status carries how many ads the broadcast has to give at one break, by style (job.adChoices, server/live.py
// _ad_choices); with a status that carries none, the viewers' picks of the newest break say it.
describe('with one ad to give the console says why every viewer gets the same one, and how to change that (C-01)', () => {
  const what = () => $('.ad-type-what')!.textContent ?? '';
  const WHY = '지금은 광고로 나갈 트레일러가 1개뿐이라 가상 시청자 4명이 모두 같은 광고를 받아요. 트레일러를 더 만들면(다른 세션에서 만든 것도 함께 써요) 시청자마다 프로필에 맞는 광고가 나가요.';
  /** The server's count: the account's trailers, and its published games. */
  const choices = (trailer: number, playable = 1) => ({ adChoices: { trailer, playable } }) as Partial<NonNullable<LiveState['job']>>;

  it("the server's count of 1: said from the start of the broadcast, in the style's own line", async () => {
    await onAirConsole(onAir(choices(1, 3)));
    expect($('.same-ad-note')!.textContent).toBe(WHY);
    expect(what()).toContain('판이 끝나면 시청자 화면 전체에 트레일러가 나와요.');
    expect(what()).not.toContain('시청자마다 다른 트레일러를 받아요'); // not beside the sentence that says otherwise
  });

  it('no count from the server: the newest break whose viewers all got one ad says it', async () => {
    await onAirConsole(onAir());
    expect($('.same-ad-note')).toBeNull(); // nothing went out yet: nothing is known
    expect(what()).toContain('시청자마다 다른 트레일러를 받아요.');
    api.liveStatus.mockResolvedValue(onAir({}, { stream: streamOf(2, [adBreak(2, ONE)]) }));
    await tick(4000);
    expect($('.same-ad-note')!.textContent).toBe(WHY);
    api.liveStatus.mockResolvedValue(onAir({}, { stream: streamOf(4, [adBreak(2, ONE), adBreak(4, MANY)]) }));
    await tick(4000);
    expect($('.same-ad-note')).toBeNull();
  });

  it("the server's count wins over a break whose picks happen to be one: several ads, no note", async () => {
    await onAirConsole(onAir(choices(3), { stream: streamOf(2, [adBreak(2, ONE)]) }));
    expect($('.same-ad-note')).toBeNull();
  });

  it('a playable broadcast says it of its games: its count is the published games\', whatever the trailers', async () => {
    api.liveStandby.mockResolvedValue({ ...off, on: true, state: 'ready', idle: 1, allocated: 1 });
    await onAirConsole(onAir({ adType: 'playable', playableSeconds: 90, ...choices(4, 1) }));
    expect($('.same-ad-note')!.textContent).toBe('지금은 광고로 나갈 게임이 1개뿐이라 가상 시청자 4명이 모두 같은 게임 카드를 받아요. 게임을 더 게시하면(다른 세션에서 게시한 것도 함께 써요) 시청자마다 프로필에 맞는 게임이 나가요.');
    api.liveStatus.mockResolvedValue(onAir({ adType: 'playable', playableSeconds: 90, ...choices(1, 3) }));
    await tick(4000);
    expect($('.same-ad-note')).toBeNull();
  });

  it('off air nothing is known of it, and the other tabs of a broadcast do not carry it', async () => {
    await render();
    expect($('.same-ad-note')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await onAirConsole(onAir(choices(1)));
    await click($('#adtype-tab-playable'));
    expect($('.same-ad-note')).toBeNull();
  });
});

// The interval's label has no literal N, 플레이 창 열기 is not a second primary button beside 라이브 켜기, and under
// another game's title the header does not read 방송 중 · 내 플레이 화면.
describe('the console\'s wording (new finding 32, R20-46)', () => {
  it("the ad interval reads as the play window's: 광고 간격 [2] 판마다, no literal N", async () => {
    await render();
    const field = find('label.field', '광고 간격')!;
    expect(field.textContent).toBe('광고 간격판마다');
    expect(field.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('2');
    expect(container.textContent).not.toMatch(/N판/);
    // on every tab
    for (const tab of ['playable', 'corner']) {
      await click($(`#adtype-tab-${tab}`));
      expect(find('label.field', '광고 간격')!.textContent).toBe('광고 간격판마다');
    }
  });

  it('off air 라이브 켜기 is the one lit button: 플레이 창 열기 on the stage is a plain one', async () => {
    await render();
    const open = find('#game-modal-stage button', '플레이 창 열기')!;
    expect(open.classList.contains('btn-primary')).toBe(false);
    expect(toggle().classList.contains('btn-primary')).toBe(true);
    expect(container.querySelectorAll('.game-modal .btn-primary')).toHaveLength(1);
  });

  it('on air with another of its games the header names that game, not 내 플레이 화면', async () => {
    playWindow('/#play=ses_1&g=gm_old');
    api.liveStatus.mockResolvedValue(onAir({ gameId: 'gm_old', adTitle: '루나의 궤도 탈출 (첫 버전)' }));
    await render(game('gm_1'));
    await tick();
    expect($('.game-modal-head .eyebrow')!.textContent).toBe('● 방송 중 · “루나의 궤도 탈출 (첫 버전)”');
  });
});
