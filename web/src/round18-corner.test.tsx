// Corner trailers on the watch page: a corner cued while a tile is inside its full-screen ad still shows there,
// corner cues with wait 0 show, and a tapped corner in a grid tile keeps its caption inside the stage.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, Viewer } from './api';
import { CUE_LATE_MS } from './components/ViewerTiles';
import { WatchWindow } from './components/WatchWindow';

// vitest stubs CSS imports, so the stylesheet is read from disk (the specifier is a string: no node types needed)
const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const css = fs.readFileSync(['src/origin.css', 'web/src/origin.css'].find((p) => fs.existsSync(p))!, 'utf8');

const api = vi.hoisted(() => ({ liveStatus: vi.fn(), liveViewer: vi.fn(), liveViewers: vi.fn(), liveToken: vi.fn(), liveAdEvent: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('./components/LiveClock', () => ({ LiveClock: () => null }));
vi.mock('./components/LivePlayable', () => ({ LivePlayable: () => null }));
type Players = Map<string, { onMetadata?: (t: string) => void; onAd?: (a: { on: boolean }) => void }>;
const players = vi.hoisted(() => new Map() as Players);
vi.mock('./components/IvsPlayer', () => ({
  IvsPlayer: (p: { ariaLabel?: string; onMetadata?: (t: string) => void; onAd?: (a: { on: boolean }) => void }) => {
    players.set(p.ariaLabel ?? '라이브 방송', { onMetadata: p.onMetadata, onAd: p.onAd });
    return null;
  },
}));

const BASE = 'https://x.live-video.net/api/video/v1/ch.m3u8';
const viewer = (viewerId: string, name: string, genre: string): Viewer => ({
  viewerId, name, initials: name.slice(1), color: '#333', profile: { ageBand: '25-34', region: '서울', device: 'pc', genres: [genre] },
  recent: [], events: 30, features: { g1: genre, g2: 'none', skill: 'hi', dev: 'pc', age: '25-34' }, provider: 'ipverse',
});
const VIEWERS = [viewer('v-minji', '김민지', 'arpg'), viewer('v-junho', '박준호', 'racing'),
  viewer('v-seoyeon', '이서연', 'explore'), viewer('v-hyunwoo', '최현우', 'shooter')];
const T0 = Date.parse('2026-11-11T04:41:53.000Z'); // when the corner was cued
/** The corner break as the break log has it: each viewer's own trailer, and how long a tile may hold it behind an ad. */
const corner = (wait: number | undefined, eventId = 'c1'): AdBreak => ({ round: 6, eventId, at: new Date(T0).toISOString(), seconds: 12,
  kind: 'corner', ...(wait === undefined ? {} : { wait }),
  picks: Object.fromEntries(['', ...VIEWERS.map((v) => v.viewerId)].map((v, i) => [v, { title: `트레일러 ${i}`, creative: `cr_${i}`,
    seconds: 20, url: `https://cdn/c${i}.mp4`, gameUrl: `https://cdn/games/gm_${i}/index.html`, reason: `이유 ${i}` }])) });
const onAir = (breaks: AdBreak[], adType = 'trailer'): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: `${BASE}?token=default`, adInsertion: 'ivs', health: 'HEALTHY',
  highlights: [], job: { jobId: 'job1', gameId: 'gm_1', everyRounds: 2, adSeconds: 30, startedAt: '2026-11-11T04:39:00Z',
    adType: adType as 'trailer', corner: adType === 'trailer' },
  stream: { state: 'live', rounds: 6, breaks, updatedAt: '2026-11-11T04:41:54Z' },
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 1500); // the status poll brings the break 1.5 s after its cue
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  players.clear();
  history.replaceState(null, '', '/#watch=ses_1');
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  api.liveStatus.mockResolvedValue(onAir([corner(20)]));
  api.liveViewer.mockResolvedValue({ warmed: false });
  api.liveViewers.mockResolvedValue({ viewers: VIEWERS });
  api.liveAdEvent.mockResolvedValue({ recorded: true });
  api.liveToken.mockImplementation(async (id: string) => ({ playbackUrl: `${BASE}?token=${id}`, expiresAt: Math.floor(Date.now() / 1000) + 1200,
    persona: id, personaName: id, provider: 'ipverse' }));
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
const tile = (name: string) => container.querySelector<HTMLElement>(`article[aria-label="가상 시청자 ${name}"]`)!;
const player = (name: string) => players.get(name === '1명 보기' ? '라이브 방송' : `${name}의 방송 화면`)!;
const cue = (name: string, m: object) => act(async () => player(name).onMetadata!(JSON.stringify(m)));
const adOn = (name: string, on: boolean) => act(async () => player(name).onAd!({ on }));
const pip = (name: string) => (name === '1명 보기' ? container.querySelector('.watch-stage') : tile(name))!.querySelector('.corner-ad');
const src = (name: string) => pip(name)?.querySelector('video')?.getAttribute('src') ?? null;
// a browser starts each corner's muted autoplay, and the impression goes out then; jsdom plays nothing, so
// every corner on the page is told it started before its impressions are counted
const started = () => container.querySelectorAll('.corner-ad video').forEach((v) => v.dispatchEvent(new Event('playing')));
const impressions = (viewerId: string) => (started(), api.liveAdEvent.mock.calls
  .filter((c) => c[1].viewerId === viewerId && c[1].kind === 'corner' && c[1].action === 'impression').length);
async function render() {
  await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
  await wait(0);
}

describe("a corner whose cue fell under a tile's full-screen ad (run C X2: shown on 1 of 4 tiles)", () => {
  it('shows from the break log when that ad ends, for its full time; a tile outside its ad shows it from the cue', async () => {
    await render();
    await adOn('이서연', true); // her stitched ad replaced the broadcast's segments: her player never fires the cue
    await cue('김민지', { type: 'corner', e: 'c1', seconds: 12, wait: 20 }); // her ad had ended: she gets it in band
    expect(src('김민지')).toBe('https://cdn/c1.mp4');
    await wait(10_000);
    expect(pip('이서연')).toBeNull(); // never over the ad
    expect(impressions('v-seoyeon')).toBe(0);
    await adOn('이서연', false); // 11.5 s after the cue's moment, inside its wait of 20 s
    expect(src('이서연')).toBe('https://cdn/c3.mp4');
    expect(impressions('v-seoyeon')).toBe(1);
    await wait(11_500);
    expect(pip('이서연')).not.toBeNull(); // its own 12 s from when it showed
    await wait(600);
    expect(pip('이서연')).toBeNull();
  });

  it('an ad that ended a moment after the cue: the corner comes once the cue is late for sure, not before', async () => {
    await render();
    await adOn('최현우', true);
    await wait(1_000);
    await adOn('최현우', false); // 2.5 s after the break's time: his video may still be on its way to the cue's frame
    expect(pip('최현우')).toBeNull();
    await wait(CUE_LATE_MS - 2_500 - 100);
    expect(pip('최현우')).toBeNull();
    await wait(200);
    expect(src('최현우')).toBe('https://cdn/c4.mp4');
  });

  it('a tile whose ad ended before its video reached the cue shows the corner from the cue, once', async () => {
    await render();
    await adOn('박준호', true);
    await wait(2_000);
    await adOn('박준호', false); // 3.5 s after the break's time: the ad of the round before, over just in time
    await wait(2_000);
    await cue('박준호', { type: 'corner', e: 'c1', seconds: 12, wait: 20 }); // his video reaches the round's end
    expect(src('박준호')).toBe('https://cdn/c2.mp4');
    started();
    await wait(4_000); // past the moment the log would have stood in
    expect(pip('박준호')).not.toBeNull();
    await wait(7_900);
    expect(pip('박준호')).not.toBeNull(); // 12 s from its cue, not from the log's moment
    await wait(200);
    expect(pip('박준호')).toBeNull();
    expect(impressions('v-junho')).toBe(1);
  });

  it('is dropped when the ad ends later than its wait allows (the next round is close), and never comes back', async () => {
    api.liveStatus.mockResolvedValue(onAir([corner(5)]));
    await render();
    await adOn('박준호', true);
    await wait(14_500); // the ad ends 16 s after the cue's time: past the 9 s the cue may be late plus the wait of 5 s
    await adOn('박준호', false);
    expect(pip('박준호')).toBeNull();
    await wait(30_000);
    expect(pip('박준호')).toBeNull();
    expect(impressions('v-junho')).toBe(0);
  });

  it('a tile that was in no ad keeps to its cue: the log alone never shows a corner (it would come before the round ends there)', async () => {
    await render();
    await wait(20_000);
    expect(VIEWERS.map((v) => pip(v.name))).toEqual([null, null, null, null]);
    expect(api.liveAdEvent).not.toHaveBeenCalled();
  });

  it('a tile whose ad ended before the corner was cued waits for its cue too', async () => {
    vi.setSystemTime(T0 - 8_000);
    api.liveStatus.mockResolvedValue(onAir([]));
    await render();
    await adOn('김민지', true);
    await wait(4_000);
    await adOn('김민지', false); // 4 s before the corner's cue
    api.liveStatus.mockResolvedValue(onAir([corner(20)]));
    await wait(30_000); // the status polls bring the break; her video never reaches the cue (a stall, say)
    expect(pip('김민지')).toBeNull();
  });

  it('the cue arriving after the log stood in for it does not start the corner again; nor does a replayed cue', async () => {
    await render();
    await adOn('이서연', true);
    await wait(10_000);
    await adOn('이서연', false);
    expect(pip('이서연')).not.toBeNull();
    started();
    await wait(6_000);
    await cue('이서연', { type: 'corner', e: 'c1', seconds: 12, wait: 20 }); // her player got it after all
    await wait(5_900);
    expect(pip('이서연')).not.toBeNull();
    await wait(200); // 12 s after it first showed
    expect(pip('이서연')).toBeNull();
    await cue('이서연', { type: 'corner', e: 'c1', seconds: 12, wait: 20 }); // a reload replays the playlist's tail
    expect(pip('이서연')).toBeNull();
    expect(impressions('v-seoyeon')).toBe(1);
  });

  it('a log without a wait (an older server) holds it the default 10 s', async () => {
    api.liveStatus.mockResolvedValue(onAir([corner(undefined)]));
    await render();
    await adOn('박준호', true);
    await adOn('최현우', true);
    await wait(16_000);
    await adOn('박준호', false); // 17.5 s after the cue's time: inside 9 + 10 s
    expect(src('박준호')).toBe('https://cdn/c2.mp4');
    await wait(3_000);
    await adOn('최현우', false); // 20.5 s: past it
    expect(pip('최현우')).toBeNull();
  });

  it('1명 보기 shows its viewer the corner after the ad the same way', async () => {
    history.replaceState(null, '', '/#watch=ses_1&view=one&persona=v-minji');
    await render();
    await adOn('1명 보기', true);
    await wait(12_000);
    expect(pip('1명 보기')).toBeNull();
    await adOn('1명 보기', false);
    expect(src('1명 보기')).toBe('https://cdn/c1.mp4');
    expect(impressions('v-minji')).toBe(1);
  });
});

describe('a wait of 0 only says "do not hold this corner behind an ad" (run B: 3 breaks × 4 tiles never shown)', () => {
  beforeEach(() => { api.liveStatus.mockResolvedValue(onAir([corner(0)], 'corner')); });

  it('with no full-screen ad on, the corner shows at its cue whatever the wait says', async () => {
    await render();
    await act(async () => {
      player('박준호').onMetadata!(JSON.stringify({ type: 'corner', e: 'c1', seconds: 12, wait: 0 }));
      vi.advanceTimersByTime(3); // the render comes a few ms after the player's cue timer
    });
    expect(src('박준호')).toBe('https://cdn/c2.mp4');
    expect(impressions('v-junho')).toBe(1);
    await wait(11_900);
    expect(pip('박준호')).not.toBeNull();
    await wait(200);
    expect(pip('박준호')).toBeNull();
  });

  it('an impression goes out only for a corner that stays up (run B: 6 impressions for corners no tile showed)', async () => {
    await render();
    // the beacon takes a moment: the clock moves between the corner's first render and the hook's own effect
    api.liveAdEvent.mockImplementation(async () => { vi.setSystemTime(Date.now() + 5); return { recorded: true }; });
    await cue('박준호', { type: 'corner', e: 'c1', seconds: 12, wait: 0 });
    expect({ impressions: impressions('v-junho'), up: !!pip('박준호') }).toEqual({ impressions: 1, up: true });
    await wait(1_000);
    expect(pip('박준호')).not.toBeNull();
  });

  it('behind a full-screen ad it is not held: gone when the ad ends', async () => {
    await render();
    await adOn('최현우', true);
    await cue('최현우', { type: 'corner', e: 'c1', seconds: 12, wait: 0 });
    await wait(3_000);
    await adOn('최현우', false);
    expect(pip('최현우')).toBeNull();
    expect(impressions('v-hyunwoo')).toBe(0);
  });
});

describe('a tapped (big) corner in a grid tile keeps its caption inside the stage', () => {
  // jsdom lays nothing out: the rule is pinned here
  it('the caption has a column of its own beside the picture, which gives way (the figure is pinned to the stage)', () => {
    const big = css.match(/\n\.vt-stage \.corner-ad\.is-big\s*\{([^}]*)\}/)![1];
    expect(big).toMatch(/bottom:\s*6px/); // so its height is the stage's, not its content's
    expect(big).toMatch(/grid-template:\s*minmax\(0,\s*1fr\)\s*\/\s*minmax\(0,\s*1fr\)\s+\d+px/);
    const video = css.match(/\n\.vt-stage \.corner-ad\.is-big \.corner-ad-media video\s*\{([^}]*)\}/)![1];
    // a % of an auto row resolves to the clip's own 16:9 height, taller than the box, and pushes the caption below it
    expect(video).not.toMatch(/max-height:\s*calc\(100% - \d+px\)/);
    expect(video).toMatch(/height:\s*100%/);
    expect(video).toMatch(/object-fit:\s*contain/); // the whole picture in its cell, not a crop of it
  });
});

// A tile's stage is wide and short (164 px high) and the corner's height is its picture's 16:9 plus an 82-px
// caption: a width in % of the tile reaches past the stage's edge, over the tile's own text.
describe('an untapped corner in a grid tile stays inside the tile\'s stage (R20-48)', () => {
  it('has a small fixed width, not a share of the tile\'s', () => {
    const small = css.match(/\n\.vt-stage \.corner-ad\s*\{([^}]*)\}/)![1];
    expect(small).not.toMatch(/width:\s*[\d.]+%/);
    const width = Number(small.match(/width:\s*(\d+)px/)?.[1]);
    expect(width).toBeGreaterThanOrEqual(118); // its caption row: 게임 보기 70 + 6 + × 22, in 8-px paddings and a 2-px border
    expect(6 + (width - 4) * 9 / 16 + 82).toBeLessThanOrEqual(164 - 6); // the stage at 1366x768 and 1024x768, 6 px off both edges
  });
});
