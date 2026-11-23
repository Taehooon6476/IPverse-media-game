import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from './api';
import { WatchWindow } from './components/WatchWindow';

const api = vi.hoisted(() => ({ liveStatus: vi.fn(), liveViewer: vi.fn(), liveToken: vi.fn(),
  liveViewers: vi.fn(async () => ({ viewers: [] })),
  liveAdEvent: vi.fn(async () => ({})) })); // a tile reports its ad's start
vi.mock('./api', () => api);
vi.mock('./components/LiveClock', () => ({ LiveClock: () => null })); // a 100 ms clock, not under test
vi.mock('./components/LivePlayable', () => ({ LivePlayable: () => null }));

/** The Amazon IVS Player (wasm) stand-in: the test fires its events and sets the frames the <video> decodes: ~30 new
 * frames a second of the stream 4 s behind live unless `frame.frozen` (the frame count stops). Until `frame.replay` it
 * decodes frames again without newer moments of the stream (a reload replaying the tail of a playlist that stopped
 * growing). `frame.at` is the moment the shown frame is from (getSyncTime: UTC, 1 s steps); `media.paused` is the
 * player's own pause flag (play() clears it; a pause, an error or the end sets it). */
const ivs = vi.hoisted(() => {
  const on = new Map<string, ((payload?: unknown) => void)[]>();
  const frame = { width: 0, height: 0, bitrate: 0, fps: 0, frozen: false, count: 0, at: 0, replay: 0 };
  const decode = () => {
    if (Date.now() < frame.replay) frame.count = Math.floor(Date.now() / 33);
    else if (!frame.frozen) Object.assign(frame, { count: Math.floor(Date.now() / 33), at: Date.now() - 4000 });
  };
  const media = { paused: true };
  const player = {
    isPaused: () => media.paused,
    attachHTMLVideoElement(el: HTMLVideoElement) {
      Object.defineProperty(el, 'videoWidth', { configurable: true, get: () => frame.width });
      Object.defineProperty(el, 'videoHeight', { configurable: true, get: () => frame.height });
      el.getVideoPlaybackQuality = () => { decode(); return { totalVideoFrames: frame.count } as VideoPlaybackQuality; };
    },
    addEventListener(type: string, f: (payload?: unknown) => void) { on.set(type, [...(on.get(type) ?? []), f]); },
    setAutoplay() {}, setMuted() {}, load: vi.fn(), play() { media.paused = false; }, delete() {},
    getPosition: () => 0, getLiveLatency: () => 4, getSyncTime: () => { decode(); return frame.at - (frame.at % 1000); },
    getQuality: () => ({ name: '720p', codecs: '', width: 1280, height: 720, bitrate: 2_034_373 }), // the playlist keeps saying 720p
    getVideoBitRate: () => frame.bitrate, getVideoFrameRate: () => frame.fps,
  };
  return { on, frame, media, player, fire: (type: string, payload?: unknown) => on.get(type)?.forEach((f) => f(payload)) };
});
vi.mock('amazon-ivs-player/dist/assets/amazon-ivs-wasmworker.min.js?url', () => ({ default: 'worker.js' }));
vi.mock('amazon-ivs-player/dist/assets/amazon-ivs-wasmworker.min.wasm?url', () => ({ default: 'worker.wasm' }));
vi.mock('amazon-ivs-player', () => ({
  isPlayerSupported: true, create: () => ivs.player,
  PlayerEventType: { TEXT_METADATA_CUE: 'TextMetadataCue', AD_BREAK_STARTED: 'AdBreakStarted', AD_BREAK_ENDED: 'AdBreakEnded',
    QUALITY_CHANGED: 'QualityChanged', ERROR: 'Error' },
  PlayerState: { PLAYING: 'Playing', IDLE: 'Idle', BUFFERING: 'Buffering', ENDED: 'Ended' },
}));

const onAir: LiveState = {
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: 'https://x.live-video.net/api/video/v1/ch.m3u8',
  adInsertion: 'ivs', health: 'HEALTHY', highlights: [],
  job: { gameId: 'gm_7a41fcae9e', everyRounds: 1, adSeconds: 35, startedAt: '2026-11-04T18:00:00Z', adType: 'trailer' },
  stream: { state: 'live', rounds: 3, breaks: [], updatedAt: '2026-11-04T18:00:00Z' },
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  history.replaceState(null, '', '/#watch=ses_f0b01b0d50&view=one'); // the one big player (the grid does not judge quality)
  ivs.on.clear();
  Object.assign(ivs.frame, { frozen: false, replay: 0 });
  ivs.media.paused = true;
  ivs.player.load.mockReset();
  api.liveStatus.mockResolvedValue(onAir);
  api.liveViewer.mockResolvedValue({ warmed: false });
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

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const fire = (type: string, payload?: unknown) => act(async () => ivs.fire(type, payload));
const show = (width: number, height: number, bitrate: number, fps: number) => Object.assign(ivs.frame, { width, height, bitrate, fps });
const toasts = () => [...container.querySelectorAll('.toast-text')].map((t) => t.textContent);
const chip = () => [...container.querySelectorAll('.live-chips > div')]
  .find((d) => d.querySelector('dt')?.textContent === '방송 상태')!.querySelector('dd')!.textContent;
const playback = () => container.querySelector('.watch-stage')!.getAttribute('data-playback');

describe('the watch window judges the broadcast, never the stitched ad (E2E N8 / D24)', () => {
  it('a trailer break neither recovers nor re-drops a degraded broadcast, and the ad size is never quoted; a real recovery is', async () => {
    await act(async () => root.render(<WatchWindow sessionId="ses_f0b01b0d50" />));
    await wait(0); // GET /live, then the IVS Player loads
    expect(ivs.on.has('AdBreakStarted')).toBe(true);
    const drop = '방송 화질이 떨어졌어요 · 320×180 · 0.02 Mbps · 18fps. 플레이 창 PC의 CPU나 네트워크가 부족할 수 있어요.';

    show(320, 180, 20_000, 18); // the sender collapsed
    await fire('Playing');
    await wait(30_000); // the 20 s warm-up, then three low samples
    expect(chip()).toBe('LIVE · 화질 저하 320×180');
    expect(toasts()).toEqual([drop]);

    // a trailer break; MediaTailor transcoded the ad to 284x160. Its first frame is decoded a moment before the
    // player's AD_BREAK_STARTED, and its last one a moment after AD_BREAK_ENDED: those samples are not the broadcast's.
    show(284, 160, 70_000, 30);
    await wait(2_000);
    await fire('AdBreakStarted', { adBreakId: 'diUX8gZXp9mD', duration: 35 });
    for (let s = 0; s < 35; s += 5) {
      await wait(5_000);
      expect(chip()).toBe('LIVE · 화질 저하 320×180'); // the broadcast's picture, not the ad's
      expect(playback()).not.toContain('284×160');
    }
    await fire('AdBreakEnded', { adBreakId: 'diUX8gZXp9mD', duration: 35 });
    await wait(2_000);
    show(320, 180, 20_000, 17); // the broadcast again, still collapsed
    await wait(40_000);
    expect(toasts()).toEqual([drop]); // no '돌아왔어요' at the break, no new drop after it
    expect(chip()).toBe('LIVE · 화질 저하 320×180');
    expect(playback()).toBe('320×180 · 0.02 Mbps · 17fps');

    // the sender gets its bandwidth back: that recovery is real and is told
    show(1280, 720, 2_300_000, 30);
    await wait(10_000);
    expect(toasts()).toEqual([drop, '방송 화질이 돌아왔어요 · 1280×720 · 2.3 Mbps · 30fps']);
    expect(chip()).toBe('LIVE');

    // a healthy broadcast through a break (the ad transcoded to 720p as well) stays quiet too
    show(1280, 720, 1_900_000, 30);
    await fire('AdBreakStarted', { adBreakId: 'POKs0MPW90PC', duration: 35 });
    await wait(35_000);
    await fire('AdBreakEnded', { adBreakId: 'POKs0MPW90PC', duration: 35 });
    show(1280, 720, 2_300_000, 30);
    await wait(20_000);
    expect(toasts()).toHaveLength(2);
    expect(chip()).toBe('LIVE');
  });

  it('a drop that clears says "화질 회복 중" until its good samples clear it, never a good size under "화질 저하" (E2E R8)', async () => {
    await act(async () => root.render(<WatchWindow sessionId="ses_f0b01b0d50" />));
    await wait(0);
    show(320, 180, 20_000, 18);
    await fire('Playing');
    await wait(30_000);
    expect(chip()).toBe('LIVE · 화질 저하 320×180');
    show(1280, 720, 2_300_000, 30); // the sender is back at 720p: the flag clears on the third good sample
    const chips: string[] = [];
    for (let s = 0; s < 10; s += 2) {
      await wait(2_000);
      chips.push(chip());
    }
    expect(chips.filter((c) => c.includes('1280×720'))).toEqual([]);
    expect(chips).toContain('LIVE · 화질 회복 중');
    expect(chips.at(-1)).toBe('LIVE');
    expect(toasts().at(-1)).toBe('방송 화질이 돌아왔어요 · 1280×720 · 2.3 Mbps · 30fps');
  });

  it('a player reload in the middle of a break (it never sees the end) does not stop the sampling', async () => {
    await act(async () => root.render(<WatchWindow sessionId="ses_f0b01b0d50" />));
    await wait(0);
    show(1280, 720, 2_300_000, 30);
    await fire('Playing');
    await wait(24_000);
    await fire('AdBreakStarted', { adBreakId: 'tHJa7hAGBDWw', duration: 35 });
    expect(container.querySelector('.live-ad')).not.toBeNull();
    await fire('Error'); // reloads after 3 s
    expect(container.querySelector('.live-ad')).toBeNull();
    show(320, 180, 20_000, 18);
    await wait(4_000);
    await fire('Playing');
    await wait(10_000);
    expect(chip()).toBe('LIVE · 화질 저하 320×180');
  });
});

describe('a picture that stops moving is told and reloaded (E2E M5: one frame for 17 min after an ingest gap, chip LIVE)', () => {
  const stuck = 'LIVE · 영상 멈춤, 다시 연결 중';
  const start = async () => {
    await act(async () => root.render(<WatchWindow sessionId="ses_f0b01b0d50" />));
    await wait(0);
    show(1280, 720, 2_300_000, 30);
    await fire('Playing');
  };

  it('the player buffering on one frame: the chip says so after 10 s and the player reloads, waiting longer each time', async () => {
    const loads: number[] = [];
    ivs.player.load.mockImplementation(() => { loads.push(Date.now()); });
    await start();
    await wait(30_000);
    expect(chip()).toBe('LIVE');
    expect(loads).toHaveLength(1); // the first load: a moving picture is never reloaded

    // the ingest gap: the player buffers on one frame and never resumes by itself
    const frozenAt = Date.now();
    ivs.frame.frozen = true;
    await fire('Buffering');
    await wait(8_000);
    expect(chip()).toBe('LIVE'); // a short rebuffer is not a stall
    await wait(4_000);
    expect(chip()).toBe(stuck);
    await wait(60_000);
    expect(chip()).toBe(stuck); // still nothing moves: still said
    const gaps = loads.slice(1).map((t, i) => t - (i ? loads[i] : frozenAt));
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps[0]).toBeLessThanOrEqual(15_000);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]); // backoff, no reload storm

    // a reload plays again: LIVE, and the pending reload is called off
    ivs.frame.frozen = false;
    await fire('Playing');
    await wait(2_000);
    expect(chip()).toBe('LIVE');
    const n = loads.length;
    await wait(120_000);
    expect(loads).toHaveLength(n);
  });

  it('a reload replaying the tail of a playlist that stopped growing is not the picture moving again (E2E R9)', async () => {
    const loads: number[] = [];
    let paused = false; // the ingest (IVS stays LIVE, its playlist stops growing)
    ivs.player.load.mockImplementation(() => {
      loads.push(Date.now());
      // the reloaded player decodes the last 2 s before the gap again: frames advance, their moments are not newer
      if (paused) Object.assign(ivs.frame, { replay: Date.now() + 2_000, at: ivs.frame.at - 2_000 });
    });
    await start();
    await wait(20_000);
    paused = true;
    const pausedAt = Date.now();
    ivs.frame.frozen = true;
    await fire('Buffering');
    await wait(12_000);
    expect(chip()).toBe(stuck);
    for (let s = 0; s < 60; s += 2) {
      await wait(2_000);
      expect(chip()).toBe(stuck); // through each reload's replay
    }
    const gaps = loads.slice(1).map((t, i) => t - (i ? loads[i] : pausedAt));
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]); // a replay never resets the backoff

    // the ingest resumes: frames of moments newer than the stall
    paused = false;
    ivs.frame.frozen = false;
    await fire('Playing');
    await wait(2_000);
    expect(chip()).toBe('LIVE');
  });

  it('the player says PLAYING but decodes no new frame: stuck too', async () => {
    await start();
    await wait(20_000);
    ivs.frame.frozen = true; // the state stays PLAYING
    await wait(12_000);
    expect(chip()).toBe(stuck);
    await wait(4_000);
    expect(ivs.player.load).toHaveBeenCalledTimes(2);
  });

  it('a stitched ad without video, a paused player and a hidden tab are not stalls; a break whose end never comes is', async () => {
    await start();
    await wait(20_000);
    // a break whose creative has no video
    await fire('AdBreakStarted', { adBreakId: 'ZBUXlwPRD2xx', duration: 35 });
    ivs.frame.frozen = true;
    await wait(34_000);
    await fire('AdBreakEnded', { adBreakId: 'ZBUXlwPRD2xx', duration: 35 });
    ivs.frame.frozen = false;
    await wait(20_000);
    // paused with the video's own controls (the player goes IDLE), then played again
    ivs.media.paused = true;
    await fire('Idle');
    ivs.frame.frozen = true;
    await wait(60_000);
    ivs.frame.frozen = false;
    ivs.media.paused = false;
    await fire('Playing');
    await wait(4_000);
    // a hidden tab: the browser may stop decoding it
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    ivs.frame.frozen = true;
    await wait(60_000);
    hidden.mockRestore();
    ivs.frame.frozen = false;
    await wait(4_000);
    expect(ivs.player.load).toHaveBeenCalledTimes(1);
    expect(chip()).toBe('LIVE');

    // stuck inside a break: its end never comes, so the hold ends with its planned 35 s
    await fire('AdBreakStarted', { adBreakId: 'KGSHXzhPzDHT', duration: 35 });
    ivs.frame.frozen = true;
    await wait(40_000);
    expect(ivs.player.load).toHaveBeenCalledTimes(1);
    expect(chip()).toBe('LIVE');
    await wait(10_000);
    expect(chip()).toBe(stuck);
    await wait(4_000);
    expect(ivs.player.load).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.live-ad')).toBeNull(); // a reload mid-break ends its badge
  });
});

describe('the live stage shows no VOD controls (E2E R10 C9: pause, an elapsed 0:21 and a seek bar over the live picture)', () => {
  it('the player\'s video has no native controls; muted and inline as before', async () => {
    await act(async () => root.render(<WatchWindow sessionId="ses_f0b01b0d50" />));
    await wait(0);
    const v = container.querySelector<HTMLVideoElement>('.watch-stage video')!;
    expect(v.hasAttribute('controls')).toBe(false);
    expect([v.muted, v.hasAttribute('playsinline')]).toEqual([true, true]);
  });
});
