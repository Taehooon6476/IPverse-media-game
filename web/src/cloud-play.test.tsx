// Cloud play and playable ads end what they abandon, say why in Korean, start the trial on the first input, say
// 준비 완료 only when the game had time to load, and the control room's ad tab never jumps back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, StandbyState } from './api';
import type { Asset, Game } from './types';

const api = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  }
  return {
    ApiError,
    getRelease: vi.fn(), startStream: vi.fn(), pollStream: vi.fn(), stopStream: vi.fn(),
    getPlayableAd: vi.fn(), startAdStream: vi.fn(), pollAdStream: vi.fn(), stopAdStream: vi.fn(), playedAdStream: vi.fn(),
    startLauncher: vi.fn(), pollLauncher: vi.fn(), stopLauncher: vi.fn(), livePlay: vi.fn(), hintLauncher: vi.fn(),
    liveStatus: vi.fn(), liveStandby: vi.fn(), setLiveStandby: vi.fn(), liveAdSettings: vi.fn(),
    highlightSettings: vi.fn(), liveStop: vi.fn(), liveViewer: vi.fn(),
  };
});
vi.mock('./api', () => api);
vi.mock('./components/IvsPlayer', () => ({ IvsPlayer: () => null }));
const sdk = vi.hoisted(() => ({ last: null as null | { clientConnection: { connectionState: (s: string) => void } },
  link: null as null | Promise<void> })); // link: the signal exchange takes until this settles
vi.mock('./vendor/gameliftstreams/gameliftstreams-1.3.0.mjs', () => ({
  GameLiftStreams: class {
    constructor(opts: never) { sdk.last = opts; }
    generateSignalRequest() { return Promise.resolve('offer'); }
    processSignalResponse() { return sdk.link ?? Promise.resolve(); }
    attachInput() {}
    close() {}
  },
}));

const { UnrealStream } = await import('./components/UnrealStream');
const { LivePlayable, QUEUE_POLL_MS } = await import('./components/LivePlayable');
const { PlayableAdPage } = await import('./components/PlayableAdPage');
const { GameModal } = await import('./components/GameModal');

const game = { gameId: 'gm_1', title: '해골 왕의 지하 묘지', genre: 'sf-shooter', specKey: 'k', previewUrl: 'blob:game',
  createdAt: '2026-11-05T00:00:00Z' } as Game;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  sdk.link = null;
  history.replaceState(null, '', '/');
  api.getRelease.mockResolvedValue({ ad: null });
  api.stopStream.mockResolvedValue({});
  api.stopAdStream.mockResolvedValue({});
  api.playedAdStream.mockResolvedValue({ plays: 1 });
  api.getPlayableAd.mockResolvedValue({ ctaUrl: '' });
  api.stopLauncher.mockResolvedValue({});
  api.startLauncher.mockResolvedValue({ launchId: 'l1', streamId: 's9', status: 'ACTIVE', signalResponse: 'answer' });
  api.livePlay.mockResolvedValue({ mode: 'launch', adId: 'ad_1', waitsForInput: true, seconds: 30 });
  api.hintLauncher.mockResolvedValue({ launchId: 'l1', preload: 'https://cdn/games/gm_1/index.html' });
  HTMLMediaElement.prototype.play = () => Promise.resolve(); // jsdom has no media playback
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
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('studio cloud play (UnrealStream)', () => {
  const mount = () => act(async () => root.render(<UnrealStream sessionId="ses_1" game={game} kind="web" />));

  it('취소 while the start request is still in flight ends the session it returns', async () => {
    const start = deferred<{ streamId: string; status: string; gameId: string }>();
    api.startStream.mockReturnValue(start.promise);
    await mount();
    await act(async () => button('클라우드로 플레이')!.click());
    await flush();
    expect(api.startStream).toHaveBeenCalledTimes(1);
    await act(async () => button('취소')!.click());
    await act(async () => start.resolve({ streamId: 'MvwL2', status: 'ACTIVATING', gameId: 'gm_1' }));
    await flush();
    expect(api.stopStream).toHaveBeenCalledWith('ses_1', 'MvwL2');
    expect(api.pollStream).not.toHaveBeenCalled();
  });

  it('a window whose stream another window replaced says why, in sight above 다시 시도', async () => {
    vi.useFakeTimers();
    api.startStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVATING', gameId: 'gm_1' });
    api.pollStream.mockRejectedValue(new api.ApiError(409, '이 세션의 클라우드 플레이를 다른 창(또는 기기)에서 시작해서 이 창의 스트림은 닫았어요. 여기서 계속하려면 다시 시도를 누르세요'));
    await mount();
    await act(async () => button('클라우드로 플레이')!.click());
    await advance(2500);
    const headline = container.querySelector('.unreal-overlay .unreal-headline')!;
    expect(headline.textContent).toContain('다른 창');
    expect(button('다시 시도')).toBeTruthy();
    expect(api.stopStream).toHaveBeenCalledWith('ses_1', 's1');
  });

  // A cold start takes several minutes, and the session is a paid GPU host for up to 30 minutes.
  it('says before the press what opens, how long the wait can be and what it costs (C-05)', async () => {
    await mount();
    const idle = container.querySelector('.unreal-overlay')!.textContent ?? '';
    expect(idle).toContain('이 게임을 클라우드 GPU 서버에서 실행해 이 창으로 보여 줘요');
    expect(idle).toContain('처음 켤 때는 4–6분, 서버가 켜져 있으면 10–20초 걸려요');
    expect(idle).toContain('켜 둔 동안 시간당 약 $1.51 · 30분 뒤 자동으로 꺼져요');
    expect(idle).not.toMatch(/GameLift|Amazon|AWS/);
  });

  it('the wait says which step it is at, and never 보통 1–2분', async () => {
    vi.useFakeTimers();
    api.startStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVATING', gameId: 'gm_1' });
    api.pollStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVATING' });
    let linked: () => void = () => undefined;
    sdk.link = new Promise<void>((r) => { linked = r; });
    await mount();
    await act(async () => button('클라우드로 플레이')!.click());
    await advance(2500);
    const wait = () => container.querySelector('.unreal-overlay')!.textContent ?? '';
    expect(wait()).toContain('1/2 · GPU 서버를 켜는 중이에요');
    // the seconds tick inside this live region: aria-hidden, or a screen reader is told the whole line every second
    const ticking = () => container.querySelector('.unreal-overlay [aria-hidden="true"]:not(.spinner)')?.textContent ?? '';
    expect(container.querySelector('.unreal-overlay')!.getAttribute('role')).toBe('status');
    expect(ticking()).toMatch(/^ · \d+초$/);
    expect(wait()).toContain('처음 켤 때는 4–6분, 서버가 켜져 있으면 10–20초 걸려요');
    expect(wait()).not.toContain('1–2분');
    api.pollStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVE', signalResponse: 'answer' });
    await advance(2500);
    expect(wait()).toContain('2/2 · 게임 화면을 연결하는 중이에요');
    await act(async () => { linked(); });
    await flush();
    expect(container.querySelector('.badge--done')!.textContent).toBe('스트리밍 중');
  });

  it('a start past the group capacity shows the Korean capacity message, not an endless wait', async () => {
    api.startStream.mockRejectedValue(new api.ApiError(503, '지금은 클라우드 GPU 2대가 모두 사용 중이에요. 다른 창이나 다른 사람의 클라우드 플레이가 끝나면 다시 시도해 주세요.'));
    await mount();
    await act(async () => button('클라우드로 플레이')!.click());
    await flush();
    expect(container.querySelector('.unreal-headline')!.textContent).toContain('2대가 모두 사용 중');
    expect(container.textContent).not.toContain('보통 1–2분');
  });

  // Nothing costs money without its price first: 다시 시도 and 다시 플레이 start the same paid server as the first press.
  const cost = '켜 둔 동안 시간당 약 $1.51 · 30분 뒤 자동으로 꺼져요';
  it('다시 시도 after a failure starts the paid server again: the price and the limit are beside it', async () => {
    api.startStream.mockRejectedValue(new api.ApiError(503, '지금은 클라우드 GPU 2대가 모두 사용 중이에요.'));
    await mount();
    await act(async () => button('클라우드로 플레이')!.click());
    await flush();
    expect(button('다시 시도')).toBeTruthy();
    expect(container.querySelector('.unreal-overlay')!.textContent).toContain(cost);
  });

  it('다시 플레이 after the session ended: the same', async () => {
    api.startStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVE', signalResponse: 'answer', gameId: 'gm_1' });
    await mount();
    await act(async () => button('클라우드로 플레이')!.click());
    await flush();
    expect(container.querySelector('.badge--done')!.textContent).toBe('스트리밍 중');
    // the server ends the session (its 30 minutes, or idle)
    await act(async () => (sdk.last!.clientConnection as unknown as { serverDisconnect: () => void }).serverDisconnect());
    await flush();
    expect(button('다시 플레이')).toBeTruthy();
    expect(container.querySelector('.unreal-overlay')!.textContent).toContain(cost);
  });

  it('the Unreal kind names no figure it does not have, but says that it costs and when it ends', async () => {
    api.startStream.mockRejectedValue(new api.ApiError(503, '지금은 자리가 없어요.'));
    await act(async () => root.render(<UnrealStream sessionId="ses_1" game={game} kind="unreal" />));
    await act(async () => button('Unreal로 플레이')!.click());
    await flush();
    expect(container.querySelector('.unreal-overlay')!.textContent).toContain('켜 둔 동안 GPU 서버 요금이 들어요 · 30분 뒤 자동으로 꺼져요');
  });
});

/** A card click for the slot: viewer v, break e1, the game's playable ad. */
const req = (key: number, viewerId = 'v-junho') => ({ key, viewerId, eventId: 'e1', adId: 'ad_1', title: 'G', seconds: 30 });
/** The id a page gives its launcher before it asks for it. */
const LAUNCH_ID = expect.stringMatching(/^[a-f0-9]{12}$/);
/** The name a page gives a click's own session before it asks for it. */
const START_ID = expect.stringMatching(/^st_[a-f0-9]{12}$/);

describe('live playable slot (LivePlayable): one game-agnostic warm launcher per page', () => {
  const mount = (request: ReturnType<typeof req> | null, props: Record<string, unknown> = {}) => act(async () => root.render(
    <LivePlayable sessionId="ses_1" request={request} standby standbyToken="tok" {...props} />));

  it('keeps the launcher connected and hidden, ready as soon as it connects (it waits for any game)', async () => {
    vi.useFakeTimers();
    const onWarm = vi.fn();
    await mount(null, { onWarm });
    await flush();
    expect(api.startLauncher).toHaveBeenCalledWith('ses_1', 'offer', 'tok', undefined, { launchId: LAUNCH_ID, grid: true }); // no viewer named
    expect(api.startAdStream).not.toHaveBeenCalled(); // no game is fixed to the warm host
    await act(async () => sdk.last!.clientConnection.connectionState('connected'));
    expect(onWarm).toHaveBeenLastCalledWith('ready', expect.any(Number));
    expect(container.querySelector('.lp-stage.is-on')).toBeNull();
  });

  it('a launcher still starting is told as the usual 20 s on a server that is up, and after one connected as what that one took (R20-48, C-05)', async () => {
    vi.useFakeTimers();
    const onWarm = vi.fn();
    await mount(null, { onWarm });
    await flush();
    expect(onWarm.mock.calls[0]).toEqual(['warming', undefined, 20]); // the usual wait on a server that is up
    await advance(12_000);
    await act(async () => sdk.last!.clientConnection.connectionState('connected'));
    expect(onWarm).toHaveBeenLastCalledWith('ready', 12);
    // the launcher is lost and warms again: this page knows by now how long one takes here
    onWarm.mockClear();
    await act(async () => sdk.last!.clientConnection.connectionState('failed'));
    await advance(5_000);
    await flush();
    expect(onWarm.mock.calls.find((c) => c[0] === 'warming')).toEqual(['warming', undefined, 12]);
  });

  it("names the page's likely viewer at the start and a card's game once its launcher exists, once per card (round 17)", async () => {
    vi.useFakeTimers();
    const hint = { viewerId: 'v-junho', eventId: 'e1' };
    await mount(null, { viewerId: 'v-junho', hint });
    await flush();
    // its game loads ahead of the cue; the page shows every viewer's tile (시청자 4명), so theirs load after it
    expect(api.startLauncher).toHaveBeenCalledWith('ses_1', 'offer', 'tok', 'v-junho', { launchId: LAUNCH_ID, grid: true });
    await act(async () => sdk.last!.clientConnection.connectionState('connected'));
    expect(api.hintLauncher).toHaveBeenCalledWith('ses_1', 'l1', { ...hint, grid: true });
    await mount(null, { viewerId: 'v-junho', hint: { ...hint } }); // the same card again: no second call
    await mount(null, { viewerId: 'v-junho', hint: { viewerId: 'v-junho', eventId: 'e2' } });
    expect(api.hintLauncher).toHaveBeenCalledTimes(2);
    expect(api.hintLauncher).toHaveBeenLastCalledWith('ses_1', 'l1', { viewerId: 'v-junho', eventId: 'e2', grid: true });
  });

  it("tells its launcher when the page's viewers change after it started (the viewer list loaded, 1명 보기) (round 18)", async () => {
    vi.useFakeTimers();
    await mount(null); // the grid's viewers had not loaded when the launcher started
    await flush();
    await act(async () => sdk.last!.clientConnection.connectionState('connected'));
    expect(api.hintLauncher).not.toHaveBeenCalled();
    await mount(null, { viewerId: 'v-minji' });
    expect(api.hintLauncher).toHaveBeenLastCalledWith('ses_1', 'l1', { viewerId: 'v-minji', grid: true });
    await mount(null, { viewerId: 'v-minji' }); // nothing changed: nothing sent
    expect(api.hintLauncher).toHaveBeenCalledTimes(1);
    history.replaceState(null, '', '/#view=one'); // 1명 보기 as 박준호: only his card can be clicked here
    await mount(null, { viewerId: 'v-junho' });
    expect(api.hintLauncher).toHaveBeenLastCalledWith('ses_1', 'l1', { viewerId: 'v-junho', grid: false });
    expect(api.hintLauncher).toHaveBeenCalledTimes(2);
  });

  it('a window closed while its launcher start is in flight ends the launcher it asked for (round 18)', async () => {
    // a session whose answer never arrives must not hold a seat
    vi.useFakeTimers();
    api.startLauncher.mockReturnValue(new Promise(() => undefined)); // the answer never reaches a closed window
    await mount(null);
    await flush();
    const named = api.startLauncher.mock.calls[0][4].launchId;
    expect(named).toMatch(/^[a-f0-9]{12}$/);
    expect(api.stopLauncher).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await flush();
    expect(api.stopLauncher).toHaveBeenCalledTimes(1);
    expect(api.stopLauncher).toHaveBeenCalledWith('ses_1', named);
  });

  it('a start that was answered is ended once, by the id the server gave (round 18)', async () => {
    vi.useFakeTimers();
    await mount(null);
    await flush();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await flush();
    expect(api.stopLauncher.mock.calls).toEqual([['ses_1', 'l1']]);
  });

  it('a refused start (every seat taken) asks again within 30 s, not after 3 minutes (round 18)', async () => {
    vi.useFakeTimers();
    api.startLauncher.mockRejectedValue(new api.ApiError(503, '지금은 체험할 자리가 모두 찼어요'));
    await mount(null);
    await flush();
    const seconds = async (n: number) => { for (let i = 0; i < n; i++) await advance(1000); };
    await seconds(5 + 15 + 30 + 1); // the 5 s and 15 s steps, then 30 s at most
    expect(api.startLauncher).toHaveBeenCalledTimes(4);
    await seconds(30);
    expect(api.startLauncher).toHaveBeenCalledTimes(5);
    api.startLauncher.mockRejectedValue(new Error('network')); // a start that failed otherwise keeps the long steps
    await seconds(30);
    expect(api.startLauncher).toHaveBeenCalledTimes(6);
    await seconds(60);
    expect(api.startLauncher).toHaveBeenCalledTimes(6);
  });

  it("a click hands the launcher that viewer's game and reveals the stream at once", async () => {
    vi.useFakeTimers();
    const onPlaying = vi.fn();
    await mount(null, { onPlaying });
    await flush();
    await act(async () => sdk.last!.clientConnection.connectionState('connected'));
    await mount(req(1), { onPlaying, header: <span className="lp-who">박준호의 게임</span> });
    await flush();
    expect(api.livePlay).toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'e1', launchId: 'l1' });
    expect(container.querySelector('.lp-stage.is-on')).not.toBeNull();
    expect(container.querySelector('.lp-wait')).toBeNull(); // the stream is already connected
    expect(container.textContent).toContain('클릭하거나 아무 키나 누르면 시작해요');
    expect(container.querySelector('.lp-bar')!.textContent).toContain('박준호의 게임');
    expect(onPlaying).toHaveBeenLastCalledWith(true);
  });

  it('a click while the launcher is still starting waits for it and opens the game on it (round 14 run 2)', async () => {
    vi.useFakeTimers();
    const onWarm = vi.fn();
    api.startLauncher.mockResolvedValue({ launchId: 'l1', streamId: 's9', status: 'ACTIVATING' });
    api.pollLauncher.mockResolvedValueOnce({ streamId: 's9', status: 'ACTIVATING' })
      .mockResolvedValue({ streamId: 's9', status: 'ACTIVE', signalResponse: 'answer' });
    await mount(null, { onWarm });
    await flush();
    // the usual time on a server that is up; a cold one is told by the card itself once this is long past
    expect(onWarm).toHaveBeenLastCalledWith('warming', undefined, 20);
    await mount(req(1), { onWarm }); // clicked before it connected
    await advance(2000);
    await flush();
    expect(api.livePlay).not.toHaveBeenCalled();
    await advance(2000);
    await flush();
    expect(onWarm).toHaveBeenLastCalledWith('warming', undefined, 10); // placed: the connect is left
    await act(async () => sdk.last!.clientConnection.connectionState('connected'));
    await advance(500);
    await flush();
    expect(api.livePlay).toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'e1', launchId: 'l1' });
    expect(api.stopLauncher).not.toHaveBeenCalled(); // not dropped for a session of its own
    expect(api.startAdStream).not.toHaveBeenCalled();
    expect(container.querySelector('.lp-stage.is-on')).not.toBeNull();
  });

  it('with every seat taken the click waits in line (대기 n번째), then starts the game\'s own session', async () => {
    vi.useFakeTimers();
    const onQueue = vi.fn();
    api.livePlay.mockResolvedValueOnce({ mode: 'queued', adId: 'ad_1', position: 2, ticket: 'q_1' })
      .mockResolvedValueOnce({ mode: 'start', adId: 'ad_1', ticket: 'q_1', seconds: 30 });
    api.startAdStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVE', signalResponse: 'answer', seconds: 30 });
    await mount(req(1), { standby: false, onQueue });
    await flush();
    expect(api.livePlay).toHaveBeenLastCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'e1', ticket: undefined });
    expect(onQueue).toHaveBeenLastCalledWith(1, 2);
    expect(container.querySelector('.lp-stage.is-on')).toBeNull();
    await advance(QUEUE_POLL_MS);
    await flush();
    expect(api.livePlay).toHaveBeenLastCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'e1', ticket: 'q_1' });
    expect(onQueue).toHaveBeenLastCalledWith(1, null);
    expect(api.startAdStream).toHaveBeenCalledWith('ad_1', 'offer', false, undefined, 'q_1', START_ID);
    expect(container.querySelector('.lp-stage.is-on')).not.toBeNull();
  });

  it("a window closed while its click's own session start is in flight ends the session it asked for (round 18)", async () => {
    // the same for the session a click starts when its page has no warm launcher
    vi.useFakeTimers();
    api.livePlay.mockResolvedValue({ mode: 'start', adId: 'ad_1', ticket: 'q_1', seconds: 30 });
    api.startAdStream.mockReturnValue(new Promise(() => undefined)); // the answer never reaches a closed window
    await mount(req(1), { standby: false });
    await flush();
    expect(api.startAdStream).toHaveBeenCalledTimes(1);
    const named = api.startAdStream.mock.calls[0][5];
    expect(named).toMatch(/^st_[a-f0-9]{12}$/);
    expect(api.stopAdStream).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await flush();
    expect(api.stopAdStream.mock.calls).toEqual([['ad_1', named]]);
  });

  it("a click's own session whose start was answered is ended once, by its stream id (round 18)", async () => {
    vi.useFakeTimers();
    api.livePlay.mockResolvedValue({ mode: 'start', adId: 'ad_1', ticket: 'q_1', seconds: 30 });
    api.startAdStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVE', signalResponse: 'answer', seconds: 30 });
    await mount(req(1), { standby: false });
    await flush();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await flush();
    expect(api.stopAdStream.mock.calls).toEqual([['ad_1', 's1']]);
  });

  it("닫고 방송으로 while a click's own session is starting ends it by name, and by its stream id if the answer still comes (round 18)", async () => {
    vi.useFakeTimers();
    api.livePlay.mockResolvedValue({ mode: 'start', adId: 'ad_1', ticket: 'q_1', seconds: 30 });
    const start = deferred<{ streamId: string; status: string; seconds: number }>();
    api.startAdStream.mockReturnValue(start.promise);
    await mount(req(1), { standby: false });
    await flush();
    const named = api.startAdStream.mock.calls[0][5];
    await act(async () => button('닫고 방송으로')!.click());
    expect(api.stopAdStream.mock.calls).toEqual([['ad_1', named]]);
    await act(async () => start.resolve({ streamId: 's1', status: 'ACTIVATING', seconds: 30 })); // it had started already
    await flush();
    expect(api.stopAdStream.mock.calls).toEqual([['ad_1', named], ['ad_1', 's1']]);
    expect(api.pollAdStream).not.toHaveBeenCalled();
  });
});

describe('public playable ad page (#ad=)', () => {
  const ad = { adId: 'ad_6249', title: '사막 협곡 고속도로', seconds: 30, trailerUrl: null, ctaUrl: 'https://cdn/games/gm_1/index.html' };

  it('allocating shows a spinner (no empty grey box); the trial clock starts on the first input', async () => {
    vi.useFakeTimers();
    api.getPlayableAd.mockResolvedValue(ad);
    const start = deferred<{ streamId: string; status: string; signalResponse: string; seconds: number; waitsForInput: boolean }>();
    api.startAdStream.mockReturnValue(start.promise);
    await act(async () => root.render(<PlayableAdPage adId="ad_6249" />));
    await flush();
    await act(async () => button('무료 체험 시작')!.click());
    await flush();
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('.ad-wait .spinner')).not.toBeNull();

    await act(async () => start.resolve({ streamId: 's1', status: 'ACTIVE', signalResponse: 'answer', seconds: 30, waitsForInput: true }));
    await flush();
    expect(container.textContent).toContain('클릭하거나 아무 키나 누르면 시작해요');
    await advance(10_000); // the viewer looks first: the game waits, and so does the hard stop
    const stage = container.querySelector<HTMLElement>('.playable-ad-stage')!;
    await act(async () => { stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(container.textContent).not.toContain('클릭하거나 아무 키나 누르면 시작해요');
    await advance(ad.seconds * 1000 + 19_000);
    expect(container.textContent).not.toContain('체험이 끝났어요');
    await advance(2000);
    expect(container.textContent).toContain('체험이 끝났어요');
  });

  // The page says what it is, one trial length, and the wait before the click; its button sits under the stage.
  it('says before the press what opens, how long the wait can be and how long the trial is (R20-33, C-05)', async () => {
    api.getPlayableAd.mockResolvedValue({ ...ad, title: '사구의 유적: 30초 생존', seconds: 90, trailerUrl: 'https://cdn/t.mp4' });
    await act(async () => root.render(<PlayableAdPage adId="ad_6249" />));
    await flush();
    expect(container.querySelector('.playable-ad-head .badge')!.textContent).toBe('설치 없이 바로 체험');
    const go = container.querySelector('.playable-ad-go')!;
    expect(go.querySelector('button')!.textContent).toBe('▶ 90초 무료 체험 시작');
    expect(go.textContent).toContain('게임이 클라우드에서 실행돼 이 화면으로 바로 보여요');
    expect(go.textContent).toContain('처음 켤 때는 4–6분, 서버가 켜져 있으면 10–20초 걸려요');
    expect(go.textContent).toContain('체험은 90초');
    expect(go.textContent).toContain('키보드와 마우스');
    // under the stage, not over the trailer's own title; the trailer says what it is
    expect(container.querySelector('.playable-ad-stage')!.contains(go)).toBe(false);
    expect(container.querySelector('.playable-ad-stage figcaption')!.textContent).toBe('세계관 트레일러 · 체험은 사구의 유적: 30초 생존');
    expect(container.textContent).not.toMatch(/GameLift|Amazon/);
    expect(document.title).toBe('사구의 유적: 30초 생존 · 체험판');
  });

  it('the wait says which step it is at and how long each can take', async () => {
    vi.useFakeTimers();
    api.getPlayableAd.mockResolvedValue(ad);
    api.startAdStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVATING', seconds: 30, waitsForInput: true });
    api.pollAdStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVATING' });
    let linked: () => void = () => undefined;
    sdk.link = new Promise<void>((r) => { linked = r; });
    await act(async () => root.render(<PlayableAdPage adId="ad_6249" />));
    await flush();
    await act(async () => button('무료 체험 시작')!.click());
    await advance(2500);
    const wait = () => container.querySelector('.ad-wait')!.textContent ?? '';
    expect(wait()).toContain('1/2 · 게임 서버를 켜는 중이에요');
    expect(container.querySelector('.ad-wait [aria-hidden="true"]:not(.spinner)')?.textContent).toMatch(/^ · \d+초$/); // as in the studio
    expect(wait()).toContain('처음 켤 때는 4–6분, 서버가 켜져 있으면 10–20초 걸려요');
    expect(wait()).not.toContain('1–2분');
    expect(container.querySelector('.playable-ad-go')).toBeNull(); // one thing at a time: the wait, with 취소
    api.pollAdStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVE', signalResponse: 'answer' });
    await advance(2500);
    expect(wait()).toContain('2/2 · 게임 화면을 연결하는 중이에요');
    await act(async () => { linked(); });
    await flush();
    expect(container.querySelector('.ad-wait')).toBeNull();
  });

  it('a game whose runtime cannot wait starts its round on load: no hint, the clock runs from the connect', async () => {
    vi.useFakeTimers();
    api.getPlayableAd.mockResolvedValue(ad);
    api.startAdStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVE', signalResponse: 'answer', seconds: 30, waitsForInput: false });
    await act(async () => root.render(<PlayableAdPage adId="ad_6249" />));
    await flush();
    await act(async () => button('무료 체험 시작')!.click());
    await flush();
    expect(container.textContent).not.toContain('클릭하거나 아무 키나 누르면 시작해요');
    await advance(ad.seconds * 1000 + 21_000);
    expect(container.textContent).toContain('체험이 끝났어요');
  });

  it('취소 while the start request is in flight ends the session it returns', async () => {
    api.getPlayableAd.mockResolvedValue(ad);
    const start = deferred<{ streamId: string; status: string; seconds: number }>();
    api.startAdStream.mockReturnValue(start.promise);
    await act(async () => root.render(<PlayableAdPage adId="ad_6249" />));
    await flush();
    await act(async () => button('무료 체험 시작')!.click());
    await flush();
    await act(async () => button('취소')!.click());
    await act(async () => start.resolve({ streamId: 's9', status: 'ACTIVATING', seconds: 30 }));
    await flush();
    expect(api.stopAdStream).toHaveBeenCalledWith('ad_6249', 's9');
  });
});

describe('control room ad tabs (GameModal)', () => {
  const trailer = { assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'https://cdn/t.mp4', contentType: 'video/mp4', meta: {},
    createdAt: '2026-11-05T00:00:00Z' } as Asset;
  const onAir = (job: Partial<NonNullable<LiveState['job']>> = {}): LiveState => ({
    active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: '',
    job: { gameId: 'gm_1', everyRounds: 20, adSeconds: 10, startedAt: '2026-11-05T00:00:00Z', adType: 'trailer', ...job },
    stream: { state: 'live', rounds: 2, breaks: [], updatedAt: '2026-11-05T00:00:00Z' } });
  const off: StandbyState = { on: false, state: 'off', idle: 0, allocated: 0, max: 2, mode: 'auto', hourlyUsd: 1.5 };
  const selected = () => container.querySelector('[role="tab"][aria-selected="true"][id^="adtype-tab-"]')!.id;

  it('a status poll sent before 변경 적용 but answered after it does not flip the tab back to 트레일러', async () => {
    vi.useFakeTimers();
    api.liveStandby.mockResolvedValue(off);
    api.liveStatus.mockResolvedValue(onAir());
    await act(async () => root.render(<GameModal sessionId="ses_1" game={game} url="blob:game" assets={[trailer]}
      onClose={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />));
    await flush();
    expect(selected()).toBe('adtype-tab-trailer');

    const stale = deferred<LiveState>();
    api.liveStatus.mockReturnValueOnce(stale.promise); // the poll in flight while 변경 적용 runs
    await advance(4000);
    await act(async () => container.querySelector<HTMLButtonElement>('#adtype-tab-playable')!.click());
    const playable = onAir({ adType: 'playable', everyRounds: 1, playableSeconds: 30 });
    api.liveAdSettings.mockResolvedValue(playable);
    await act(async () => button('변경 적용')!.click());
    await flush();
    expect(selected()).toBe('adtype-tab-playable');

    await act(async () => stale.resolve(onAir())); // the old answer arrives late
    await flush();
    expect(selected()).toBe('adtype-tab-playable');
    api.liveStatus.mockResolvedValue(playable);
    await advance(8000); // the next polls
    expect(selected()).toBe('adtype-tab-playable');
    expect(new URLSearchParams(location.hash.slice(1)).get('adtype')).toBe('playable');
    expect(container.querySelector('.game-modal-bar .badge')!.textContent).toContain('플레이어블 광고');
  });

  // the tab alone starts nothing; its 미리 켜기, with the price on it, is what pre-warms
  it('미리 켜기 on the 플레이어블 tab before a broadcast pre-warms the playable server (the tab alone does not)', async () => {
    vi.useFakeTimers();
    api.liveStandby.mockResolvedValue(off);
    api.setLiveStandby.mockResolvedValue({ ...off, on: true, state: 'warming', mode: 'on', prewarm: true });
    api.liveStatus.mockResolvedValue({ ...onAir(), active: false, job: null });
    await act(async () => root.render(<GameModal sessionId="ses_1" game={game} url="blob:game" assets={[trailer]}
      onClose={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />));
    await flush();
    expect(api.setLiveStandby).not.toHaveBeenCalled(); // the trailer tab needs no GPU
    await act(async () => container.querySelector<HTMLButtonElement>('#adtype-tab-playable')!.click());
    await flush();
    expect(api.setLiveStandby).not.toHaveBeenCalled(); // nor does picking the tab start one
    await act(async () => button('미리 켜기')!.click());
    await flush();
    expect(api.setLiveStandby).toHaveBeenCalledWith('ses_1', true, true);
  });

  it('a broadcast that ends with the 플레이어블 tab open does not pre-warm the playable server again (round 18)', async () => {
    // a pre-warm posted just after the broadcast ended would hold an idle GPU host
    vi.useFakeTimers();
    const idle = { ...onAir(), active: false, job: null };
    api.liveStandby.mockResolvedValue(off);
    api.setLiveStandby.mockResolvedValue({ ...off, on: true, state: 'warming', mode: 'on', prewarm: true });
    api.liveStatus.mockResolvedValue(idle);
    await act(async () => root.render(<GameModal sessionId="ses_1" game={game} url="blob:game" assets={[trailer]}
      onClose={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />));
    await flush();
    // the pre-warm is the user's own press of 미리 켜기, never the tab by itself
    await act(async () => container.querySelector<HTMLButtonElement>('#adtype-tab-playable')!.click());
    await flush();
    await act(async () => button('미리 켜기')!.click());
    await flush();
    expect(api.setLiveStandby).toHaveBeenCalledTimes(1); // before the broadcast: the intended pre-warm
    api.liveStatus.mockResolvedValue(onAir({ adType: 'playable', playableSeconds: 90 }));
    await advance(4000); // on air
    expect(button('■ 라이브 끄기')).toBeTruthy();
    api.liveStatus.mockResolvedValue(idle); // 방송 끄기
    await advance(4000);
    expect(button('● 라이브 켜기')).toBeTruthy();
    expect(selected()).toBe('adtype-tab-playable');
    expect(api.setLiveStandby).toHaveBeenCalledTimes(1); // the stop does not re-arm it
    // opening the tab again starts nothing either; pressing 미리 켜기 again pre-warms, as before a first broadcast
    api.liveStandby.mockResolvedValue(off);
    await act(async () => container.querySelector<HTMLButtonElement>('#adtype-tab-trailer')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('#adtype-tab-playable')!.click());
    await advance(6000);
    expect(api.setLiveStandby).toHaveBeenCalledTimes(1);
    await act(async () => button('미리 켜기')!.click());
    await flush();
    expect(api.setLiveStandby).toHaveBeenCalledTimes(2);
  });

  it('a console opened on the 플레이어블 tab waits for the first status answer: no pre-warm under a running broadcast (round 18)', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/#adtype=playable');
    const first = deferred<LiveState>();
    api.liveStandby.mockResolvedValue(off);
    api.liveStatus.mockReturnValue(first.promise);
    await act(async () => root.render(<GameModal sessionId="ses_1" game={game} url="blob:game" assets={[trailer]}
      onClose={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />));
    await flush();
    expect(api.setLiveStandby).not.toHaveBeenCalled(); // nothing is known yet
    await act(async () => first.resolve(onAir({ adType: 'corner' }))); // a corner broadcast is on air
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('#adtype-tab-playable')!.click());
    await flush();
    expect(api.setLiveStandby).not.toHaveBeenCalled();
  });

  it('shows the time left before the 45-minute cap and warns 5 minutes and 1 minute before', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    api.liveStandby.mockResolvedValue(off);
    // the server's own count: secondsLeft falls with the clock (the polls re-anchor the countdown to it)
    api.liveStatus.mockImplementation(async () => onAir({ maxMinutes: 45, secondsLeft: Math.round(302 - (Date.now() - t0) / 1000) } as never));
    const onNotice = vi.fn();
    await act(async () => root.render(<GameModal sessionId="ses_1" game={game} url="blob:game" assets={[trailer]}
      onClose={vi.fn()} onError={vi.fn()} onNotice={onNotice} />));
    await flush();
    const left = () => container.querySelector('.live-limit')!.textContent;
    expect(left()).toContain('5:02');
    expect(onNotice).not.toHaveBeenCalled();
    await advance(3000);
    expect(left()).toContain('4:59');
    expect(container.querySelector('.live-limit.is-warn')).not.toBeNull();
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0][0]).toContain('5분 뒤');
    await advance(60_000);
    expect(onNotice).toHaveBeenCalledTimes(1); // once
    await advance(181_000);
    expect(onNotice).toHaveBeenCalledTimes(2);
    expect(onNotice.mock.calls[1][0]).toContain('1분 뒤');
    expect(left()).toContain('0:58');
  });
});

describe('live playable ad trial clock (LivePlayable)', () => {
  it('shows the promised seconds at the first input; the end-screen margin stays hidden', async () => {
    vi.useFakeTimers();
    const render = (request: ReturnType<typeof req> | null) => act(async () => root.render(
      <LivePlayable sessionId="ses_1" request={request} standby standbyToken="tok" />));
    await render(null);
    await flush();
    await act(async () => sdk.last!.clientConnection.connectionState('connected'));
    await render(req(1));
    await flush();
    const stage = container.querySelector<HTMLElement>('.lp-stage')!;
    await act(async () => { stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    const bar = () => container.querySelector('.lp-bar span')!.textContent;
    expect(bar()).toContain('남은 30초'); // the trial only, not the game's own end screen
    await advance(29_000);
    expect(bar()).toContain('남은 1초');
    await advance(1000);
    expect(bar()).not.toContain('남은'); // the game shows its end screen now
    expect(container.textContent).not.toContain('체험이 끝났어요');
    await advance(8000);
    expect(container.textContent).toContain('체험이 끝났어요');
  });

  it('each card starts fresh at the promised seconds on its first input, not at the last card\'s value', async () => {
    // the bar must not show the previous card's last value for a frame at the first input
    vi.useFakeTimers();
    // the page drops a request once its play is done (onDone), as WatchWindow does
    let request: ReturnType<typeof req> | null = null;
    const render = () => act(async () => root.render(
      <LivePlayable sessionId="ses_1" request={request} standby standbyToken="tok" onDone={() => { request = null; }} />));
    const play = async (key: number) => { // the launcher connects, a card click
      await flush();
      await act(async () => sdk.last!.clientConnection.connectionState('connected'));
      request = req(key);
      await render();
      await flush();
    };
    const input = async () => {
      const stage = container.querySelector<HTMLElement>('.lp-stage')!;
      const seen: string[] = []; // every text the bar showed, also for a single render before the effects ran
      const note = (records: MutationRecord[]) => records.forEach((r) => {
        if (r.type === 'characterData') seen.push(r.oldValue ?? '', r.target.textContent ?? '');
        r.addedNodes.forEach((n) => seen.push(n.textContent ?? ''));
      });
      const watch = new MutationObserver(note);
      watch.observe(stage, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      await act(async () => { stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
      note(watch.takeRecords());
      watch.disconnect();
      seen.push(container.querySelector('.lp-bar span')!.textContent ?? '');
      return seen.join(' | ').match(/남은 \d+초/g) ?? [];
    };
    await render();
    await play(1);
    expect(new Set(await input())).toEqual(new Set(['남은 30초']));
    await advance(7000); // card 1: closed early
    await act(async () => button('닫고 방송으로')!.click());
    await render(); // the page dropped the played request
    await advance(13_000); // the end card goes; a fresh hidden launcher warms
    await flush();
    await play(2);
    const shown = await input();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((t) => t === '남은 30초')).toBe(true);
  });
});
