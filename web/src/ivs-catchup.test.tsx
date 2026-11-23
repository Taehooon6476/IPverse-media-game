// Each stitched full-screen break leaves a tile further behind the play window: the player takes the delay back, or
// corners and ads come later and later. The real IvsPlayer over an SDK stand-in (the watch suites mock the component).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IvsPlayer } from './components/IvsPlayer';

/** The Amazon IVS Player stand-in. `live` is the broadcast as this player plays it: `latency` s behind live with
 * `buffer` s loaded ahead of the playhead (`position`, MSE seconds). Playing faster than 1× spends the buffer and wins
 * the delay back at (rate − 1) s a second, and getLiveLatency steps once a 2 s segment (`read`), as the real player does. */
const ivs = vi.hoisted(() => {
  const on = new Map<string, ((payload?: unknown) => void)[]>();
  const live = { latency: 4.4, buffer: 2.5, position: 100, rate: 1, at: 0, paused: true, read: 4.4, segment: 50, steps: [0] };
  const run = () => {
    const dt = (Date.now() - live.at) / 1000;
    live.at = Date.now();
    if (live.paused) return;
    live.position += dt * live.rate;
    live.latency -= dt * (live.rate - 1);
    live.buffer -= dt * (live.rate - 1);
    const segment = Math.floor(live.position / 2);
    // `steps`: how far off the reading is from one segment to the next
    if (segment !== live.segment) Object.assign(live, { segment, read: live.latency + live.steps[segment % live.steps.length] });
  };
  const player = {
    isPaused: () => live.paused,
    attachHTMLVideoElement(el: HTMLVideoElement) {
      el.getVideoPlaybackQuality = () => ({ totalVideoFrames: Math.floor(Date.now() / 33) }) as VideoPlaybackQuality;
    },
    addEventListener(type: string, f: (payload?: unknown) => void) { on.set(type, [...(on.get(type) ?? []), f]); },
    setAutoplay() {}, setMuted() {}, delete() {},
    load: vi.fn(() => { run(); live.rate = 1; }),
    play() { run(); live.paused = false; },
    getPosition: () => { run(); return live.position; },
    getLiveLatency: () => { run(); return live.read; },
    getBufferDuration: () => { run(); return live.buffer; },
    getSyncTime: () => Date.now() - 4000,
    getPlaybackRate: () => live.rate,
    setPlaybackRate: vi.fn((rate: number) => { run(); live.rate = rate; }),
  };
  return { on, live, player, fire: (type: string, payload?: unknown) => on.get(type)?.forEach((f) => f(payload)) };
});
vi.mock('amazon-ivs-player/dist/assets/amazon-ivs-wasmworker.min.js?url', () => ({ default: 'worker.js' }));
vi.mock('amazon-ivs-player/dist/assets/amazon-ivs-wasmworker.min.wasm?url', () => ({ default: 'worker.wasm' }));
vi.mock('amazon-ivs-player', () => ({
  isPlayerSupported: true, create: () => ivs.player,
  PlayerEventType: { TEXT_METADATA_CUE: 'TextMetadataCue', AD_BREAK_STARTED: 'AdBreakStarted', AD_BREAK_ENDED: 'AdBreakEnded',
    QUALITY_CHANGED: 'QualityChanged', ERROR: 'Error' },
  PlayerState: { PLAYING: 'Playing', IDLE: 'Idle', BUFFERING: 'Buffering', ENDED: 'Ended' },
}));

let container: HTMLDivElement;
let root: Root;
const cues: { text: string; position: number }[] = []; // each cue handed to the page, and where the playhead was then
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ivs.on.clear();
  ivs.player.load.mockClear();
  ivs.player.setPlaybackRate.mockClear();
  Object.assign(ivs.live, { latency: 4.4, buffer: 2.5, position: 100, rate: 1, at: Date.now(), paused: true, read: 4.4, segment: 50, steps: [0] });
  cues.length = 0;
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
const rates = () => ivs.player.setPlaybackRate.mock.calls.map((c) => c[0]);
/** The player on the page, playing for 20 s. */
async function playing() {
  await act(async () => root.render(<IvsPlayer src="https://x.live-video.net/api/video/v1/ch.m3u8?token=v-minji"
    onMetadata={(text) => cues.push({ text, position: ivs.player.getPosition() })} />));
  await wait(0);
  await fire('Playing');
  await wait(20_000);
}
/** A stitched ad of `ad` s that replaced `replaced` s of the broadcast: the viewer comes back that much further behind,
 * with that much more of the broadcast loaded ahead. */
async function adBreak(ad: number, replaced: number) {
  await fire('AdBreakStarted', { adBreakId: 'b', duration: Math.ceil(ad) });
  await wait(ad * 1000);
  ivs.live.latency += ad - replaced;
  ivs.live.buffer += ad - replaced;
  await fire('AdBreakEnded', { adBreakId: 'b', duration: Math.ceil(ad) });
}

describe('a stitched break leaves no extra delay behind', () => {
  it("each ad's extra delay is taken back: the tile is as far behind after the break as before it (run C, 김민지)", async () => {
    await playing();
    const start = ivs.live.latency;
    // three ads: +2.63 s, −0.42 s and +1.63 s against the broadcast they replaced
    for (const [ad, replaced] of [[24.633, 22], [11.567, 12], [11.567, 10]]) {
      const before = ivs.live.latency;
      await adBreak(ad, replaced);
      expect(ivs.live.rate).toBe(1); // the ad itself played at normal speed
      await wait(30_000);
      expect(ivs.live.latency).toBeLessThanOrEqual(before + 0.3);
      expect(ivs.live.rate).toBe(1);
    }
    expect(ivs.live.latency).toBeLessThanOrEqual(start + 0.3); // back to where it started
    expect(ivs.live.latency).toBeGreaterThan(start - 1); // and never ahead of where it was: the buffer is not spent
    expect(rates().filter((r) => r > 1)).toHaveLength(2); // the two ads that added delay
    expect(ivs.player.load).toHaveBeenCalledTimes(1); // by playing faster, never by a reload
  });

  it('the delay is back within 10 s of the ad, before the next round ends', async () => {
    await playing();
    await adBreak(24.633, 22);
    await wait(10_000);
    expect(ivs.live.latency).toBeCloseTo(4.4, 1);
    expect(ivs.live.rate).toBe(1);
  });

  it('only a break is caught up with: a delay the player grew by itself (a rebuffer) stays, and a thin buffer is never spent', async () => {
    await playing();
    await adBreak(15.667, 16); // an ad that fits its slot leaves nothing to take back
    await wait(30_000);
    expect(rates()).toEqual([]);
    await fire('Buffering'); // a rebuffer: the player comes back 2 s further behind and keeps the buffer it asked for
    ivs.live.latency += 2;
    ivs.live.buffer += 1;
    await fire('Playing');
    await wait(30_000);
    expect(rates()).toEqual([]);
    const own = ivs.live.latency;
    await adBreak(24.633, 22);
    await wait(30_000);
    expect(ivs.live.latency).toBeCloseTo(own, 1); // the break's 2.6 s, not the rebuffer's 2 s
    ivs.player.setPlaybackRate.mockClear();
    await adBreak(24.633, 22);
    ivs.live.buffer = 1.2; // nothing loaded ahead to spend
    await wait(30_000);
    expect(rates()).toEqual([]);
  });

  it('a break that starts while the player catches up plays at normal speed, and the rest is taken back after it', async () => {
    await playing();
    await adBreak(24.633, 22);
    await wait(5_000);
    expect(ivs.live.rate).toBeGreaterThan(1);
    await fire('AdBreakStarted', { adBreakId: 'c', duration: 12 });
    expect(ivs.live.rate).toBe(1);
    await wait(12_000);
    expect(ivs.live.rate).toBe(1);
    await fire('AdBreakEnded', { adBreakId: 'c', duration: 12 });
    await wait(30_000);
    expect(ivs.live.latency).toBeCloseTo(4.4, 1);
    expect(ivs.live.rate).toBe(1);
  });

  it("the reading's own steps never wear the buffer down: forty breaks later the player is where it started", async () => {
    ivs.live.steps = [-0.13, 0.02, 0.13, -0.02, 0.11, -0.06, 0.1, -0.11]; // the real player's, around a steady delay
    await playing();
    const { latency, buffer } = ivs.live;
    for (let n = 0; n < 40; n++) { // a 45-minute broadcast's worth
      await adBreak(11.567, 10); // +1.57 s each
      await wait(30_000);
      expect(ivs.live.rate).toBe(1);
    }
    expect(rates().filter((r) => r > 1)).toHaveLength(40);
    // following every lower reading down as the new "before" ends 1.5 s closer to live, on the last second of buffer
    expect(Math.abs(ivs.live.latency - latency)).toBeLessThan(0.4);
    expect(Math.abs(ivs.live.buffer - buffer)).toBeLessThan(0.4);
  });

  it("a rebuffer blip at an ad's own edge is not the player growing its delay: the break is still taken back", async () => {
    await playing();
    await fire('Buffering'); // the switch to the ad's segments
    await fire('Playing');
    await adBreak(24.633, 22);
    await fire('Buffering'); // and back to the broadcast's
    await fire('Playing');
    await wait(15_000);
    expect(ivs.live.latency).toBeCloseTo(4.4, 1);
    expect(ivs.live.rate).toBe(1);
  });

  it('a stall or a reload ends the catch-up; the reloaded playback keeps its own delay', async () => {
    await playing();
    await adBreak(24.633, 22);
    await wait(5_000);
    expect(ivs.live.rate).toBeGreaterThan(1);
    await fire('Buffering'); // the buffer ran dry after all
    expect(ivs.live.rate).toBe(1);
    await fire('Playing');
    await wait(30_000);
    expect(ivs.live.rate).toBe(1); // not again for this break
    await fire('Error'); // reloads after 3 s: a new playback, 6 s behind this time
    await wait(4_000);
    Object.assign(ivs.live, { latency: 6, buffer: 4 });
    await fire('Playing');
    await wait(20_000);
    await adBreak(11.567, 10);
    await wait(30_000);
    expect(ivs.live.latency).toBeCloseTo(6, 1); // back to its own 6 s, not to the first playback's 4.4 s
  });

  it('a hidden tab is not sped up (its timers are throttled); it catches up once it shows again', async () => {
    await playing();
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await adBreak(24.633, 22);
    await wait(6_000);
    expect(rates()).toEqual([]);
    hidden.mockRestore();
    await wait(10_000);
    expect(ivs.live.latency).toBeCloseTo(4.4, 1);
  });
});

describe('a cue rides on its frame at any speed', () => {
  const frames: Record<string, number> = {};
  /** The player parsed a cue whose frame is `ahead` s of the broadcast in front of the playhead. */
  const cue = (text: string, ahead: number) => {
    frames[text] = ivs.player.getPosition() + ahead;
    return fire('TextMetadataCue', { text, startTime: frames[text] });
  };

  it('a cue parsed before the catch-up, during it and across its end lands when its frame plays', async () => {
    await playing();
    await adBreak(24.633, 22);
    await cue('before', 6); // parsed at normal speed; the catch-up starts before its frame plays
    await wait(5_000);
    expect(ivs.live.rate).toBeGreaterThan(1);
    await cue('during', 3);
    await cue('across', 9); // the catch-up is over before its frame plays
    await wait(15_000);
    expect(ivs.live.rate).toBe(1);
    expect(cues.map((c) => c.text)).toEqual(['before', 'during', 'across']);
    for (const c of cues) expect(Math.abs(c.position - frames[c.text])).toBeLessThan(0.15); // of the playhead, in s
  });
});
