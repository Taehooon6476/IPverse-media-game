// The watch page: a playable card whose cue was lost still shows, each tile's 광고 기록 fills in corner and playable
// broadcasts, a corner without a published game says so, and the page names the card its launcher should load ahead.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, Viewer } from './api';
import { CornerAd } from './components/AdOverlays';
import type { PlayRequest } from './components/LivePlayable';
import { CUE_LATE_MS, adHistory } from './components/ViewerTiles';
import { WatchWindow } from './components/WatchWindow';

const api = vi.hoisted(() => ({ liveStatus: vi.fn(), liveViewer: vi.fn(), liveViewers: vi.fn(), liveToken: vi.fn(), liveAdEvent: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('./components/LiveClock', () => ({ LiveClock: () => null }));
const players = vi.hoisted(() => new Map<string, { onMetadata?: (t: string) => void }>());
vi.mock('./components/IvsPlayer', () => ({
  IvsPlayer: (p: { ariaLabel?: string; onMetadata?: (t: string) => void }) => {
    players.set(p.ariaLabel ?? '라이브 방송', { onMetadata: p.onMetadata });
    return null;
  },
}));
type Slot = { request: PlayRequest | null; header?: ReactNode; viewerId?: string; hint?: { viewerId: string; eventId: string } | null };
const slot = vi.hoisted(() => ({ cur: null as null | Slot }));
vi.mock('./components/LivePlayable', () => ({ LivePlayable: (p: Slot) => { slot.cur = p; return null; } }));

const BASE = 'https://x.live-video.net/api/video/v1/ch.m3u8';
const viewer = (viewerId: string, name: string, genre: string): Viewer => ({
  viewerId, name, initials: name.slice(1), color: '#333', profile: { ageBand: '25-34', region: '서울', device: 'pc', genres: [genre] },
  recent: [], events: 30, features: { g1: genre, g2: 'none', skill: 'hi', dev: 'pc', age: '25-34' }, provider: 'ipverse',
});
const VIEWERS = [viewer('v-minji', '김민지', 'arpg'), viewer('v-junho', '박준호', 'racing'),
  viewer('v-seoyeon', '이서연', 'explore'), viewer('v-hyunwoo', '최현우', 'shooter')];
const T0 = Date.parse('2026-11-10T16:42:58.506Z'); // a break's time
const pick = (title: string, i: number) => ({ title, reason: `이유 ${i}`, creative: `pg_${i}`, seconds: 60, adId: `ad_${i}`,
  gameId: `gm_${i}`, ctaUrl: `https://cdn/games/gm_${i}/index.html` });
const PLAYABLE: AdBreak = { round: 4, eventId: 'p4', at: new Date(T0).toISOString(), seconds: 60, kind: 'playable', playable: true,
  adId: 'ad_own', picks: Object.fromEntries(['', ...VIEWERS.map((v) => v.viewerId)].map((v, i) => [v, pick(`게임 ${i}`, i)])) };
const onAir = (breaks: AdBreak[]): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: `${BASE}?token=default`, adInsertion: 'ivs', health: 'HEALTHY',
  highlights: [], job: { jobId: 'job1', gameId: 'gm_1', everyRounds: 2, adSeconds: 30, startedAt: '2026-11-10T16:40:00Z',
    adType: 'playable', playableAdId: 'ad_own', playableSeconds: 60, standbyToken: 'tok' },
  stream: { state: 'live', rounds: 4, breaks, updatedAt: '2026-11-10T16:43:00Z' },
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 1500); // the status poll brings the break 1.5 s after its cue
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  players.clear();
  slot.cur = null;
  history.replaceState(null, '', '/#watch=ses_1');
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  api.liveStatus.mockResolvedValue(onAir([PLAYABLE]));
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
const cardTitle = (name: string) => tile(name).querySelector('.play-card .hl-overlay-title')?.textContent ?? null;
async function render() {
  await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
  await wait(0);
}

describe('a playable card whose cue never reached the player', () => {
  it('shows from the break log once the cue is late, on every tile; a tile that got its cue shows it from the cue', async () => {
    await render();
    await act(async () => players.get('박준호의 방송 화면')!.onMetadata!(JSON.stringify({ type: 'playable', e: 'p4' })));
    expect(cardTitle('박준호')).toBe('게임 2 · 지금 바로');
    expect(cardTitle('김민지')).toBeNull(); // its video may still be on the way to the moment
    await wait(CUE_LATE_MS - 1500 - 100);
    expect(cardTitle('김민지')).toBeNull();
    await wait(200);
    expect(VIEWERS.map((v) => cardTitle(v.name))).toEqual(['게임 1 · 지금 바로', '게임 2 · 지금 바로', '게임 3 · 지금 바로', '게임 4 · 지금 바로']);
    await wait(20_100);
    expect(cardTitle('김민지')).toBeNull(); // its usual 20 s
  });

  it('a break long over shows nothing (a window opened later)', async () => {
    vi.setSystemTime(T0 + 60_000);
    await render();
    await wait(CUE_LATE_MS);
    expect(VIEWERS.map((v) => cardTitle(v.name))).toEqual([null, null, null, null]);
  });
});

describe("the page names its launcher's likely game", () => {
  it("a grid's first viewer and the fresh card's break; nothing once the card is over", async () => {
    await render();
    expect(slot.cur!.viewerId).toBe('v-minji');
    expect(slot.cur!.hint).toEqual({ viewerId: 'v-minji', eventId: 'p4' });
    await wait(40_000);
    await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
    expect(slot.cur!.hint).toBeNull();
  });

  it("1명 보기: its viewer's card", async () => {
    history.replaceState(null, '', '/#watch=ses_1&view=one&persona=v-seoyeon');
    await render();
    expect(slot.cur!.viewerId).toBe('v-seoyeon');
    expect(slot.cur!.hint).toEqual({ viewerId: 'v-seoyeon', eventId: 'p4' });
  });
});

describe('광고 기록 and the corner link', () => {
  const corner: AdBreak = { round: 3, eventId: 'c3', at: '2026-11-10T16:42:20Z', seconds: 12, kind: 'corner',
    picks: { 'v-junho': { title: '네온 레이싱', creative: 'cr_1', seconds: 12, url: 'https://cdn/c.mp4', reason: '레이싱' } } };
  const trailer: AdBreak = { round: 2, eventId: 't2', at: '2026-11-10T16:41:40Z', seconds: 20, kind: 'trailer',
    picks: { 'v-junho': { title: '테오', creative: 'cr_2', seconds: 10, url: 'https://cdn/t.mp4', reason: '기본' } } };
  const skip: AdBreak = { round: 5, eventId: 's5', at: '2026-11-10T16:43:20Z', seconds: 0, kind: 'skip' };

  it('counts corner trailers and playable cards too, newest first, each with its kind', async () => {
    expect(adHistory([trailer, corner, PLAYABLE, skip], 'v-junho').map((h) => [h.round, h.kind, h.pick.title]))
      .toEqual([[4, 'playable', '게임 2'], [3, 'corner', '네온 레이싱'], [2, 'trailer', '테오']]);
    api.liveStatus.mockResolvedValue(onAir([trailer, corner, PLAYABLE]));
    await render();
    const items = [...tile('박준호').querySelectorAll('.vt-ads li strong')].map((e) => e.textContent);
    expect(items).toEqual(['4판 · 플레이어블 · 게임 2', '3판 · 코너 · 네온 레이싱', '2판 · 테오']);
    expect(tile('김민지').textContent).not.toContain('아직 받은 광고가 없어요');
  });

  it('a corner without a published game says 게임 준비 중 instead of a link', async () => {
    await act(async () => root.render(<CornerAd url="https://cdn/c.mp4" title="아리" onDone={() => undefined} />));
    expect(container.querySelector('.corner-ad a')).toBeNull();
    expect(container.querySelector('.corner-ad-soon')?.textContent).toBe('게임 준비 중');
    await act(async () => root.render(<CornerAd url="https://cdn/c.mp4" title="사구의 유적" gameUrl="https://cdn/games/gm_dune/index.html"
      onDone={() => undefined} />));
    expect(container.querySelector<HTMLAnchorElement>('.corner-ad a')!.href).toBe('https://cdn/games/gm_dune/index.html');
  });
});
