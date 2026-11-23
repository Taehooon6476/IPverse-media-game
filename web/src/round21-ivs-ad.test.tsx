// A tile's ad line and its report must not hang on one player event (AD_BREAK_STARTED, @beta in the SDK): the SDK
// tells of an ad in two more ways, a creative's start and the ad's progress, and either one is an ad on the picture.
// The real IvsPlayer over an SDK stand-in, as ivs-catchup.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IvsPlayer, type IvsAd } from './components/IvsPlayer';

const ivs = vi.hoisted(() => {
  const on = new Map<string, ((payload?: unknown) => void)[]>();
  const player = {
    isPaused: () => false,
    attachHTMLVideoElement(el: HTMLVideoElement) {
      el.getVideoPlaybackQuality = () => ({ totalVideoFrames: Math.floor(Date.now() / 33) }) as VideoPlaybackQuality;
    },
    addEventListener(type: string, f: (payload?: unknown) => void) { on.set(type, [...(on.get(type) ?? []), f]); },
    setAutoplay() {}, setMuted() {}, delete() {}, load() {}, play() {},
    getPosition: () => 100, getLiveLatency: () => 4, getBufferDuration: () => 2.5, getSyncTime: () => Date.now() - 4000,
    getPlaybackRate: () => 1, setPlaybackRate() {},
  };
  return { on, player, fire: (type: string, payload?: unknown) => on.get(type)?.forEach((f) => f(payload)) };
});
vi.mock('amazon-ivs-player/dist/assets/amazon-ivs-wasmworker.min.js?url', () => ({ default: 'worker.js' }));
vi.mock('amazon-ivs-player/dist/assets/amazon-ivs-wasmworker.min.wasm?url', () => ({ default: 'worker.wasm' }));
vi.mock('amazon-ivs-player', () => ({
  isPlayerSupported: true, create: () => ivs.player,
  PlayerEventType: { TEXT_METADATA_CUE: 'TextMetadataCue', AD_BREAK_STARTED: 'AdBreakStarted', AD_CREATIVE_STARTED: 'AdCreativeStarted',
    AD_TIME_UPDATE: 'AdTimeUpdate', AD_BREAK_ENDED: 'AdBreakEnded', QUALITY_CHANGED: 'QualityChanged', ERROR: 'Error' },
  PlayerState: { PLAYING: 'Playing', IDLE: 'Idle', BUFFERING: 'Buffering', ENDED: 'Ended' },
}));

let container: HTMLDivElement;
let root: Root;
const ads: IvsAd[] = []; // what the player told its page, in order
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ivs.on.clear();
  ads.length = 0;
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
async function playing() {
  await act(async () => root.render(<IvsPlayer src="https://x.live-video.net/api/video/v1/ch.m3u8?token=v-minji" onAd={(ad) => ads.push(ad)} />));
  await wait(0);
  await fire('Playing');
  await wait(4000);
}
const progress = (elapsed: number, id = 'b_1') => ({ adBreakId: id, assetId: 'a', breakElapsed: elapsed, breakDuration: 16, creativeElapsed: elapsed, creativeDuration: 16, podIndex: 1, podLength: 1 });

describe("an ad on the picture is told to the page by whichever of the player's ad events comes first (new finding 19)", () => {
  it('the break\'s own start, as before: on once, with its length; its progress adds nothing', async () => {
    await playing();
    await fire('AdBreakStarted', { adBreakId: 'b_1', duration: 16 });
    await fire('AdCreativeStarted', { adBreakId: 'b_1', assetId: 'a', podIndex: 1, duration: 16 });
    await fire('AdTimeUpdate', progress(1));
    await fire('AdTimeUpdate', progress(2));
    expect(ads).toEqual([{ on: true, seconds: 16 }]);
    await fire('AdBreakEnded', { adBreakId: 'b_1', duration: 16 });
    expect(ads.at(-1)).toEqual({ on: false });
  });

  it("no break start: the creative's start says the ad is on", async () => {
    await playing();
    await fire('AdCreativeStarted', { adBreakId: 'b_1', assetId: 'a', podIndex: 1, duration: 16 });
    expect(ads).toEqual([{ on: true, seconds: 16 }]);
    await fire('AdTimeUpdate', progress(1));
    expect(ads).toHaveLength(1);
  });

  it('neither start: the ad\'s progress says it is on, late, with what is left of it', async () => {
    await playing();
    await fire('AdTimeUpdate', progress(3));
    expect(ads).toEqual([{ on: true, seconds: 13, late: true }]);
    await fire('AdTimeUpdate', progress(4));
    expect(ads).toHaveLength(1);
    await fire('AdBreakEnded', { adBreakId: 'b_1', duration: 16 });
    expect(ads.at(-1)).toEqual({ on: false });
  });

  it('progress that arrives after its break ended does not start the ad again', async () => {
    await playing();
    await fire('AdBreakStarted', { adBreakId: 'b_1', duration: 16 });
    await fire('AdBreakEnded', { adBreakId: 'b_1', duration: 16 });
    await fire('AdTimeUpdate', progress(16));
    await fire('AdCreativeStarted', { adBreakId: 'b_1', assetId: 'a', podIndex: 1, duration: 16 });
    expect(ads).toEqual([{ on: true, seconds: 16 }, { on: false }]);
    // the next break is its own
    await fire('AdTimeUpdate', progress(2, 'b_2'));
    expect(ads.at(-1)).toEqual({ on: true, seconds: 14, late: true });
  });

  it('an ad whose end the player never tells ends on the page a moment after its length: the line does not stay', async () => {
    await playing();
    await fire('AdTimeUpdate', progress(6));
    expect(ads.at(-1)).toEqual({ on: true, seconds: 10, late: true });
    await wait(9000);
    expect(ads.at(-1)?.on).toBe(true); // still inside the ad
    await wait(8000);
    expect(ads.at(-1)).toEqual({ on: false });
    await fire('AdBreakEnded', { adBreakId: 'b_1', duration: 16 }); // the end, should it come after all, changes nothing
    expect(ads.filter((a) => !a.on)).toHaveLength(1);
  });
});
