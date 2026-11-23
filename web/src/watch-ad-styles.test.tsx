// The per-viewer ad styles on the watch page's four tiles: each tile's own playable card from its own player's timed
// metadata, the click that expands it to play on the page's one slot, "대기 n번째", and the corner trailer.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, Viewer } from './api';
import type { PlayRequest } from './components/LivePlayable';
import { STALL_MAX_MS } from './components/ViewerTiles';
import { WatchWindow } from './components/WatchWindow';

// vitest stubs CSS imports, so the stylesheet is read from disk (the specifier is a string: no node types needed)
const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const css = fs.readFileSync(['src/origin.css', 'web/src/origin.css'].find((p) => fs.existsSync(p))!, 'utf8');

const api = vi.hoisted(() => ({ liveStatus: vi.fn(), liveViewer: vi.fn(), liveViewers: vi.fn(), liveToken: vi.fn(), liveAdEvent: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('./components/LiveClock', () => ({ LiveClock: () => null }));
type Players = Map<string, { onMetadata?: (t: string) => void; onAd?: (a: { on: boolean }) => void; onPlaying?: (on: boolean) => void }>;
const players = vi.hoisted(() => new Map() as Players);
vi.mock('./components/IvsPlayer', () => ({
  IvsPlayer: (p: { ariaLabel?: string; onMetadata?: (t: string) => void; onAd?: (a: { on: boolean }) => void; onPlaying?: (on: boolean) => void }) => {
    players.set(p.ariaLabel ?? '라이브 방송', { onMetadata: p.onMetadata, onAd: p.onAd, onPlaying: p.onPlaying });
    return null;
  },
}));
/** The page's playable slot stand-in: what it was asked to play, and its callbacks. */
type Slot = { request: PlayRequest | null; header?: ReactNode; onPlaying?: (p: boolean) => void;
  onQueue?: (key: number, pos: number | null) => void; onDone?: (r: PlayRequest, s: number) => void;
  onWarm?: (state: 'warming' | 'ready' | 'error', took?: number, eta?: number) => void; mounts: number };
const slot = vi.hoisted(() => ({ cur: null as null | Slot }));
vi.mock('./components/LivePlayable', async () => {
  const { useEffect } = await import('react');
  return {
    LivePlayable: (p: Omit<Slot, 'mounts'>) => {
      slot.cur = { ...p, mounts: slot.cur?.mounts ?? 0 };
      useEffect(() => { slot.cur!.mounts++; }, []);
      return p.request && p.header ? <div className="lp-bar-test">{p.header}</div> : null;
    },
  };
});

const BASE = 'https://x.live-video.net/api/video/v1/ch.m3u8';
const viewer = (viewerId: string, name: string, genre: string): Viewer => ({
  viewerId, name, initials: name.slice(1), color: '#333', profile: { ageBand: '25-34', region: '서울', device: 'pc', genres: [genre] },
  recent: [], events: 30, features: { g1: genre, g2: 'none', skill: 'hi', dev: 'pc', age: '25-34' }, provider: 'ipverse',
});
const VIEWERS = [viewer('v-minji', '김민지', 'arpg'), viewer('v-junho', '박준호', 'racing'),
  viewer('v-seoyeon', '이서연', 'explore'), viewer('v-hyunwoo', '최현우', 'shooter')];
const GAMES: Record<string, [string, string]> = {
  '': ['좀비 생존 30', '기본 플레이어블 (시청자 정보 없음)'],
  'v-minji': ['강철 기사: 보스 레이드', '최근 7일 액션 RPG 9시간 · 관심 장르 액션 RPG'],
  'v-junho': ['드리프트 레이스', '최근 7일 레이싱 3시간 · 레이싱 광고 클릭 2회'],
  'v-seoyeon': ['구름섬 보물 수집', "최근 7일 탐험·수집 2시간 · '수집' 좋아함"],
  'v-hyunwoo': ['스타 워든', '최근 7일 SF 슈터 5시간 · 아직 안 해 본 게임'],
};
const PLAYABLE: AdBreak = { round: 2, eventId: 'p1', at: '2026-11-10T00:01:00Z', seconds: 60, kind: 'playable', playable: true, adId: 'ad_own',
  picks: Object.fromEntries(Object.entries(GAMES).map(([v, [title, reason]], i) => [v, { title, reason, reasons: reason.split(' · '),
    creative: `pg_${i}`, seconds: 60, adId: `ad_${i}`, gameId: `gm_${i}`, ctaUrl: `https://cdn/games/gm_${i}/index.html`,
    trailerUrl: `https://cdn/t${i}.mp4` }])) };
const CORNER: AdBreak = { round: 3, eventId: 'c1', at: '2026-11-10T00:02:00Z', seconds: 12, kind: 'corner',
  picks: Object.fromEntries(['', ...VIEWERS.map((v) => v.viewerId)].map((v, i) => [v, { title: `트레일러 ${i}`, creative: `cr_${i}`,
    seconds: 20, url: `https://cdn/c${i}.mp4`, gameUrl: `https://cdn/games/gm_${i}/index.html`, reason: `이유 ${i}` }])) };
const onAir = (breaks: AdBreak[] = [], adType = 'playable'): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: `${BASE}?token=default`, adInsertion: 'ivs', health: 'HEALTHY',
  highlights: [], job: { jobId: 'job1', gameId: 'gm_1', everyRounds: 2, adSeconds: 30, startedAt: '2026-11-10T00:00:00Z',
    adType: adType as 'playable', playableAdId: 'ad_own', playableSeconds: 60, standbyToken: 'tok' },
  stream: { state: 'live', rounds: 2, breaks, updatedAt: '2026-11-10T00:00:00Z' },
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
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
const text = (el: Element | null | undefined) => el?.textContent ?? '';
const cue = (name: string, m: object) => act(async () => players.get(`${name}의 방송 화면`)!.onMetadata!(JSON.stringify(m)));
const button = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
async function render() {
  await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
  await wait(0);
}
const cueAll = async (m: object) => { for (const v of VIEWERS) await cue(v.name, m); };

describe('the playable card: each tile its own game, from its own player', () => {
  it("each tile shows its viewer's game and why when its own video reaches the round's end", async () => {
    await render();
    expect(tile('김민지').querySelector('.play-card')).toBeNull();
    await cue('박준호', { type: 'playable', e: 'p1', adId: 'ad_own', seconds: 60, round: 2 });
    expect(tile('김민지').querySelector('.play-card')).toBeNull(); // only the tile whose video got there
    await cueAll({ type: 'playable', e: 'p1' });
    const cards = VIEWERS.map((v) => text(tile(v.name).querySelector('.play-card .hl-overlay-title')));
    expect(cards).toEqual(['강철 기사: 보스 레이드 · 지금 바로', '드리프트 레이스 · 지금 바로', '구름섬 보물 수집 · 지금 바로', '스타 워든 · 지금 바로']);
    expect(text(tile('박준호').querySelector('.play-card-why'))).toBe('이유: 최근 7일 레이싱 3시간 · 레이싱 광고 클릭 2회');
    expect(button(tile('최현우'), '지금 플레이')!.textContent).toBe('▶ 지금 플레이 (60초)');
    // the beacon: one impression per tile and break, into that viewer's activity log
    expect(api.liveAdEvent.mock.calls.map((c) => c[1].viewerId).sort()).toEqual(['v-hyunwoo', 'v-junho', 'v-minji', 'v-seoyeon']);
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'p1', kind: 'playable', action: 'impression' });
    await wait(20_100);
    expect(tile('박준호').querySelector('.play-card')).toBeNull(); // not clicked: it goes
  });

  it('a cue for a break the status has not brought yet asks for it now, then shows', async () => {
    api.liveStatus.mockResolvedValue(onAir([]));
    await render();
    const polls = api.liveStatus.mock.calls.length;
    api.liveStatus.mockResolvedValue(onAir([PLAYABLE]));
    await cue('이서연', { type: 'playable', e: 'p1' });
    await wait(0);
    expect(api.liveStatus.mock.calls.length).toBe(polls + 1);
    expect(text(tile('이서연').querySelector('.play-card .hl-overlay-title'))).toBe('구름섬 보물 수집 · 지금 바로');
  });
});

describe('a click expands that tile to play; one game at a time per page', () => {
  it("the click hands the page's slot that viewer's game; while it plays the slot covers the grid with whose game it is", async () => {
    await render();
    await cueAll({ type: 'playable', e: 'p1' });
    expect(slot.cur!.request).toBeNull();
    await act(async () => button(tile('박준호'), '지금 플레이')!.click());
    expect(slot.cur!.request).toMatchObject({ viewerId: 'v-junho', eventId: 'p1', adId: 'ad_2', title: '드리프트 레이스', seconds: 60 });
    expect(button(tile('박준호'), '게임을 여는 중')).toBeTruthy();
    await act(async () => slot.cur!.onPlaying!(true));
    expect(container.querySelector('.watch-main.is-playing')).not.toBeNull();
    expect(text(container.querySelector('.lp-bar-test'))).toBe('준호박준호의 게임 · 드리프트 레이스');
    expect(tile('박준호').querySelector('.play-card')).toBeNull(); // the game is up, not its card
    await act(async () => { slot.cur!.onPlaying!(false); slot.cur!.onDone!(slot.cur!.request!, 41); });
    expect(api.liveAdEvent).toHaveBeenLastCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'p1', kind: 'playable', action: 'end', seconds: 41 });
    expect(slot.cur!.request).toBeNull();
    expect(container.querySelector('.watch-main.is-playing')).toBeNull();
    expect(slot.cur!.mounts).toBe(1); // the one slot of the page stays (its warm launcher too)
  });

  it('a second card waits its turn (대기 n번째) and plays when the first is done; the server line counts too', async () => {
    await render();
    await cueAll({ type: 'playable', e: 'p1' });
    await act(async () => button(tile('박준호'), '지금 플레이')!.click());
    await act(async () => slot.cur!.onQueue!(slot.cur!.request!.key, 2)); // every seat taken: second in the server's line
    expect(text(tile('박준호').querySelector('.play-card-wait strong'))).toBe('대기 2번째');
    await act(async () => button(tile('김민지'), '지금 플레이')!.click());
    expect(text(tile('김민지').querySelector('.play-card-wait strong'))).toBe('대기 3번째');
    expect(slot.cur!.request!.viewerId).toBe('v-junho'); // one at a time
    await act(async () => { slot.cur!.onQueue!(slot.cur!.request!.key, null); slot.cur!.onPlaying!(true); });
    expect(text(tile('김민지').querySelector('.play-card-wait strong'))).toBe('대기 1번째');
    await act(async () => { slot.cur!.onPlaying!(false); slot.cur!.onDone!(slot.cur!.request!, 30); });
    expect(slot.cur!.request!.viewerId).toBe('v-minji');
    await act(async () => button(tile('이서연'), '지금 플레이')!.click());
    await act(async () => button(tile('이서연'), '취소')!.click()); // leaves the line
    expect(tile('이서연').querySelector('.play-card-wait')).toBeNull();
  });

  it('waiting, 트레일러 보기 plays that game\'s trailer big in the tile instead', async () => {
    await render();
    await cueAll({ type: 'playable', e: 'p1' });
    await act(async () => button(tile('박준호'), '지금 플레이')!.click());
    await act(async () => button(tile('최현우'), '지금 플레이')!.click());
    await act(async () => button(tile('최현우'), '트레일러 보기')!.click());
    const pip = tile('최현우').querySelector('.corner-ad')!;
    expect(pip.classList.contains('is-big')).toBe(true);
    expect(pip.querySelector('video')!.getAttribute('src')).toBe('https://cdn/t4.mp4');
    expect(slot.cur!.request!.viewerId).toBe('v-junho'); // left the line
  });

  it('a card in line keeps the game it was clicked for through the next cue (round 14 run 2)', async () => {
    const NEXT: AdBreak = { ...PLAYABLE, round: 4, eventId: 'p2', picks: Object.fromEntries(Object.entries(PLAYABLE.picks!)
      .map(([v, p]) => [v, { ...p, title: `다음 ${p.title}`, adId: `${p.adId}_next`, reason: '다음 이유' }])) };
    api.liveStatus.mockResolvedValue(onAir([PLAYABLE, NEXT]));
    await render();
    await cueAll({ type: 'playable', e: 'p1' });
    await act(async () => button(tile('김민지'), '지금 플레이')!.click()); // plays
    await act(async () => button(tile('이서연'), '지금 플레이')!.click()); // waits
    expect(text(tile('이서연').querySelector('.play-card-wait strong'))).toBe('대기 1번째');
    await cueAll({ type: 'playable', e: 'p2' }); // the next card's cue while she waits
    expect(text(tile('이서연').querySelector('.hl-overlay-title'))).toBe('구름섬 보물 수집 · 지금 바로');
    expect(text(tile('이서연').querySelector('.play-card-why'))).toContain("'수집' 좋아함");
    expect(text(tile('이서연').querySelector('.play-card-wait strong'))).toBe('대기 1번째');
    expect(text(tile('박준호').querySelector('.hl-overlay-title'))).toBe('다음 드리프트 레이스 · 지금 바로'); // not clicked: the new one
    await act(async () => { slot.cur!.onDone!(slot.cur!.request!, 20); });
    expect(slot.cur!.request).toMatchObject({ viewerId: 'v-seoyeon', eventId: 'p1', adId: 'ad_3', title: '구름섬 보물 수집' });
    expect(text(tile('이서연').querySelector('.hl-overlay-title'))).toBe('구름섬 보물 수집 · 지금 바로'); // opening: still hers
    await act(async () => { slot.cur!.onDone!(slot.cur!.request!, 0); }); // done: the lock goes, the new card shows
    expect(text(tile('이서연').querySelector('.hl-overlay-title'))).toBe('다음 구름섬 보물 수집 · 지금 바로');
  });

  it('while the launcher is still starting the card says 준비 중 · 약 n초, and so does a click (no long spinner)', async () => {
    await render();
    await act(async () => slot.cur!.onWarm!('warming', undefined, 120));
    await cueAll({ type: 'playable', e: 'p1' });
    expect(text(tile('박준호').querySelector('.play-card-prep'))).toBe('준비 중 · 약 120초');
    // a countdown is no live region (it would be read out every second): it is what its button is described by
    const prep = tile('박준호').querySelector('.play-card-prep')!;
    expect([prep.getAttribute('role'), prep.getAttribute('aria-live')]).toEqual([null, null]);
    expect(button(tile('박준호'), '지금 플레이')!.getAttribute('aria-describedby')).toBe(prep.id);
    expect(button(tile('박준호'), '지금 플레이')!.disabled).toBe(false); // a click waits for it
    await wait(3000);
    expect(text(tile('박준호').querySelector('.play-card-prep'))).toBe('준비 중 · 약 117초');
    await act(async () => button(tile('박준호'), '지금 플레이')!.click());
    expect(button(tile('박준호'), '준비 중 · 약 117초')!.disabled).toBe(true);
    await act(async () => slot.cur!.onWarm!('warming', undefined, 10)); // placed: the connect is left
    expect(button(tile('박준호'), '준비 중 · 약 10초')).toBeTruthy();
    await act(async () => slot.cur!.onWarm!('ready', 30));
    expect(button(tile('박준호'), '게임을 여는 중')).toBeTruthy();
    expect(tile('김민지').querySelector('.play-card-prep')).toBeNull();
  });
});

// Neither the grid nor a tile's stage is a stacking context, so a card (z-index 4) and the playing stage (z-index 3)
// are ordered against each other: the stage must win.
describe("the game being played is on top of the other viewers' cards (R20-35)", () => {
  // jsdom lays nothing out: the stacking is pinned from the stylesheet
  const z = (selector: string) => {
    const rule = css.match(new RegExp(`\\n${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`));
    return Number(rule?.[1].match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
  };

  it('the playing stage stacks above a tile\'s card and the end card', () => {
    expect(z('.lp-stage.is-on')).toBeGreaterThan(z('.vt-stage .play-card'));
    expect(z('.lp-stage.is-on')).toBeGreaterThan(z('.lp-card'));
  });

  it('while one game plays the grid behind it is out of reach, cards and all; it comes back when the play ends', async () => {
    await render();
    await cueAll({ type: 'playable', e: 'p1' });
    const grid = () => container.querySelector<HTMLElement>('main.watch-grid')!;
    expect(grid().hasAttribute('inert')).toBe(false);
    await act(async () => button(tile('박준호'), '지금 플레이')!.click());
    await act(async () => slot.cur!.onPlaying!(true));
    expect(tile('김민지').querySelector('.play-card')).not.toBeNull(); // her card keeps its 20 s: it is only covered
    expect(grid().hasAttribute('inert')).toBe(true); // no button of a covered card takes a click or the Tab key
    await act(async () => { slot.cur!.onPlaying!(false); slot.cur!.onDone!(slot.cur!.request!, 12); });
    expect(grid().hasAttribute('inert')).toBe(false);
    expect(button(tile('김민지'), '지금 플레이')).toBeTruthy(); // still fresh: it shows again
  });
});

describe("a card's 준비 중 line while the page's launcher starts (C-05)", () => {
  it('counts down the usual wait, says 곧 for a moment past it, then that a server is being started and how long that takes', async () => {
    const { prepText } = await import('./components/AdOverlays');
    const now = Date.parse('2026-11-16T04:00:00Z');
    expect(prepText(now + 20_000, now)).toBe('준비 중 · 약 20초');
    expect(prepText(now - 5_000, now)).toBe('준비 중 · 곧');
    // a cold host takes about five minutes: "곧" is no answer
    expect(prepText(now - 40_000, now)).toBe('서버를 켜는 중 · 처음에는 4–6분 걸려요');
  });
});

describe('the corner trailer: small, muted, the player draws it', () => {
  beforeEach(() => { api.liveStatus.mockResolvedValue(onAir([CORNER], 'corner')); });

  it("each tile shows its viewer's own trailer in its corner, muted, and it goes after 12 s", async () => {
    await render();
    await cueAll({ type: 'corner', e: 'c1', round: 3, seconds: 12 });
    const srcs = VIEWERS.map((v) => tile(v.name).querySelector('.corner-ad video')!.getAttribute('src'));
    expect(srcs).toEqual(['https://cdn/c1.mp4', 'https://cdn/c2.mp4', 'https://cdn/c3.mp4', 'https://cdn/c4.mp4']);
    const v = tile('박준호').querySelector<HTMLVideoElement>('.corner-ad video')!;
    expect(v.muted).toBe(true);
    expect(text(tile('박준호').querySelector('.corner-ad figcaption small'))).toBe('광고'); // no service name on the ad
    // the impression waits for the trailer to start playing: mounted alone, it has sent none
    expect(api.liveAdEvent).not.toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'c1', kind: 'corner', action: 'impression' });
    v.dispatchEvent(new Event('playing'));
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'c1', kind: 'corner', action: 'impression' });
    await wait(11_000);
    expect(tile('박준호').querySelector('.corner-ad')).not.toBeNull();
    await wait(1_100);
    expect(tile('박준호').querySelector('.corner-ad')).toBeNull();
  });

  it('a tap makes it big with sound (it stays until the trailer ends); 게임 보기 opens the published game', async () => {
    await render();
    await cue('이서연', { type: 'corner', e: 'c1', seconds: 12 });
    const pip = () => tile('이서연').querySelector<HTMLElement>('.corner-ad');
    await act(async () => pip()!.querySelector<HTMLButtonElement>('.corner-ad-media')!.click());
    expect(pip()!.classList.contains('is-big')).toBe(true);
    expect(pip()!.querySelector('video')!.muted).toBe(false);
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-seoyeon', eventId: 'c1', kind: 'corner', action: 'expand' });
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-seoyeon', eventId: 'c1', kind: 'corner', action: 'unmute' });
    await wait(15_000);
    expect(pip()).not.toBeNull(); // big: until the trailer's end
    const link = [...pip()!.querySelectorAll('a')].find((a) => a.textContent === '게임 보기')!;
    expect(link.getAttribute('href')).toBe('https://cdn/games/gm_3/index.html');
    link.addEventListener('click', (e) => e.preventDefault());
    await act(async () => link.click());
    expect(api.liveAdEvent).toHaveBeenLastCalledWith('ses_1', { viewerId: 'v-seoyeon', eventId: 'c1', kind: 'corner', action: 'click' });
    await act(async () => { pip()!.querySelector('video')!.dispatchEvent(new Event('ended')); });
    expect(pip()).toBeNull();
  });

  // a full-screen ad that comes late meets the corners: one already showing, one cued during the ad
  const adOn = (name: string, on: boolean) => act(async () => players.get(`${name}의 방송 화면`)!.onAd!({ on }));
  const pip = (name: string) => tile(name).querySelector('.corner-ad');
  // The impression goes out when the corner's video starts playing: jsdom plays nothing, so each corner on the page is
  // told it started before its impressions are counted.
  const started = () => container.querySelectorAll('.corner-ad video').forEach((v) => v.dispatchEvent(new Event('playing')));
  const impressions = (viewerId: string) => (started(), api.liveAdEvent.mock.calls
    .filter((c) => c[1].viewerId === viewerId && c[1].kind === 'corner' && c[1].action === 'impression').length);

  // Each tile reports its player's ad start and how long after the break's mark (timed metadata on the frame of the
  // call) it came; 1명 보기 forwards full-screen cues to its player too.
  it("1명 보기 measures from the break's mark too", async () => {
    history.replaceState(null, '', '/#watch=ses_1&view=one&persona=racer');
    try {
      await render();
      const one = players.get('라이브 방송')!;
      await act(async () => one.onMetadata!(JSON.stringify({ type: 'mark', e: 'b_1' })));
      await wait(3_000);
      await act(async () => one.onAd!({ on: true }));
      expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'b_1', kind: 'trailer', action: 'start', leadMs: 3000 });
    } finally { history.replaceState(null, '', '/'); }
  });

  // The number is wall-clock time on the tile, so a player that stood still between the mark and its ad has none to
  // give: it reports the start (the break aired) without it.
  it('a player that stalled between the mark and its ad reports the start without a number; a blink at the ad\'s edge is no stall', async () => {
    const playing = (name: string, on: boolean) => act(async () => players.get(`${name}의 방송 화면`)!.onPlaying!(on));
    await render();
    await cue('박준호', { type: 'mark', e: 'b_1' });
    await wait(1_000);
    await playing('박준호', false); // a rebuffer of 6 s
    await wait(6_000);
    await playing('박준호', true);
    await wait(2_000);
    await adOn('박준호', true);
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'b_1', kind: 'trailer', action: 'start' });
    await cue('이서연', { type: 'mark', e: 'b_1' });
    await wait(3_000);
    await playing('이서연', false); // the player blinks as it switches into the ad
    await wait(300);
    await adOn('이서연', true);
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-seoyeon', eventId: 'b_1', kind: 'trailer', action: 'start', leadMs: 3300 });
    // a stall before the mark is not counted against the break after it
    await playing('최현우', false);
    await wait(5_000);
    await playing('최현우', true);
    await cue('최현우', { type: 'mark', e: 'b_1' });
    await wait(3_000);
    await adOn('최현우', true);
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-hyunwoo', eventId: 'b_1', kind: 'trailer', action: 'start', leadMs: 3000 });
  });

  // The bar for "stood still" is 1 s: tiles that play through stand under 0.25 s, and at 2 s stalled tiles still sent
  // readings well over the usual.
  it('the bar is what the tiles of rounds 19 and 20 showed: a second, not two', async () => {
    const playing = (name: string, on: boolean) => act(async () => players.get(`${name}의 방송 화면`)!.onPlaying!(on));
    expect(STALL_MAX_MS).toBe(1000);
    await render();
    await cue('박준호', { type: 'mark', e: 'b_1' });
    await wait(2_000);
    await playing('박준호', false); // a rebuffer of 1.2 s: the reading would be 1.2 s long
    await wait(1_200);
    await playing('박준호', true);
    await wait(3_000);
    await adOn('박준호', true);
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'b_1', kind: 'trailer', action: 'start' });
    await cue('이서연', { type: 'mark', e: 'b_1' });
    await wait(2_000);
    await playing('이서연', false); // two blinks, 0.9 s in all: still a reading
    await wait(500);
    await playing('이서연', true);
    await wait(2_000);
    await playing('이서연', false);
    await wait(400);
    await playing('이서연', true);
    await wait(1_000);
    await adOn('이서연', true);
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-seoyeon', eventId: 'b_1', kind: 'trailer', action: 'start', leadMs: 5900 });
  });

  it("a tile reports its full-screen ad's start and how long after the break's mark it came", async () => {
    await render();
    await cue('박준호', { type: 'mark', e: 'b_373d50d370' });
    await wait(3_400);
    await adOn('박준호', true);
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-junho', eventId: 'b_373d50d370', kind: 'trailer', action: 'start', leadMs: 3400 });
    await adOn('김민지', true); // its mark never came (the tile had just reloaded): the start alone
    expect(api.liveAdEvent).toHaveBeenCalledWith('ses_1', { viewerId: 'v-minji', eventId: '', kind: 'trailer', action: 'start' });
    await adOn('박준호', false);
    await wait(40_000);
    await adOn('박준호', true); // the next break's mark is not this one's
    expect(api.liveAdEvent).toHaveBeenLastCalledWith('ses_1', { viewerId: 'v-junho', eventId: '', kind: 'trailer', action: 'start' });
  });

  it('a corner cued during the full-screen ad waits for its end, then shows for its full time', async () => {
    await render();
    await adOn('이서연', true);
    await cue('이서연', { type: 'corner', e: 'c1', seconds: 12, wait: 16 });
    expect(pip('이서연')).toBeNull();
    expect(impressions('v-seoyeon')).toBe(0); // not shown yet: no impression
    expect(pip('김민지')).toBeNull(); // the other tiles got no cue yet
    await wait(9_000);
    await adOn('이서연', false);
    expect(pip('이서연')!.querySelector('video')!.getAttribute('src')).toBe('https://cdn/c3.mp4');
    expect(impressions('v-seoyeon')).toBe(1);
    await wait(11_500);
    expect(pip('이서연')).not.toBeNull(); // its own 12 s from when it showed
    await wait(600);
    expect(pip('이서연')).toBeNull();
  });

  it('a corner whose ad ends after its wait is dropped (the next round is close)', async () => {
    await render();
    await adOn('박준호', true);
    await cue('박준호', { type: 'corner', e: 'c1', seconds: 12, wait: 5 });
    await wait(6_000);
    await adOn('박준호', false);
    expect(pip('박준호')).toBeNull();
    expect(impressions('v-junho')).toBe(0);
    await wait(30_000);
    expect(pip('박준호')).toBeNull(); // and it does not come back
  });

  it('a full-screen ad that starts while a corner is up ends that corner for good', async () => {
    await render();
    await cue('최현우', { type: 'corner', e: 'c1', seconds: 12, wait: 16 });
    expect(pip('최현우')).not.toBeNull();
    started();
    await wait(3_000);
    await adOn('최현우', true);
    expect(pip('최현우')).toBeNull();
    await adOn('최현우', false);
    expect(pip('최현우')).toBeNull(); // not shown again after the ad
    expect(impressions('v-hyunwoo')).toBe(1);
  });

  it('1명 보기 shows the same three styles for its viewer: the corner and the card', async () => {
    history.replaceState(null, '', '/#watch=ses_1&view=one&persona=v-minji');
    api.liveStatus.mockResolvedValue(onAir([CORNER, PLAYABLE]));
    await render();
    await act(async () => players.get('라이브 방송')!.onMetadata!(JSON.stringify({ type: 'corner', e: 'c1' })));
    expect(container.querySelector('.watch-stage .corner-ad video')!.getAttribute('src')).toBe('https://cdn/c1.mp4');
    await act(async () => players.get('라이브 방송')!.onMetadata!(JSON.stringify({ type: 'playable', e: 'p1' })));
    expect(text(container.querySelector('.watch-stage .play-card .hl-overlay-title'))).toBe('강철 기사: 보스 레이드 · 지금 바로');
    await act(async () => button(container.querySelector('.watch-stage')!, '지금 플레이')!.click());
    expect(slot.cur!.request).toMatchObject({ viewerId: 'v-minji', adId: 'ad_1' });
  });
});
