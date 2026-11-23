// The watch page, mounted over a fake API with a stand-in for each tile's player, as watch-viewers.test.tsx does.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, Viewer } from './api';
import { WatchWindow } from './components/WatchWindow';

const api = vi.hoisted(() => ({ liveStatus: vi.fn(), liveViewer: vi.fn(), liveViewers: vi.fn(), liveToken: vi.fn(), liveAdEvent: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('./components/LiveClock', () => ({ LiveClock: () => null }));
vi.mock('./components/LivePlayable', () => ({ LivePlayable: () => null }));
/** The IVS player stand-in: one record per mounted player (its label tells whose) with the callbacks it was given. */
type Fake = { onAd?: (a: { on: boolean; seconds?: number; late?: boolean }) => void; onPlaying?: (p: boolean) => void; onMetadata?: (text: string) => void };
const players = vi.hoisted(() => new Map<string, Fake>());
vi.mock('./components/IvsPlayer', () => ({
  IvsPlayer: (p: Fake & { ariaLabel?: string }) => {
    players.set(p.ariaLabel ?? '라이브 방송', { onAd: p.onAd, onPlaying: p.onPlaying, onMetadata: p.onMetadata });
    return null;
  },
}));

const BASE = 'https://x.live-video.net/api/video/v1/ch.m3u8';
const viewer = (viewerId: string, name: string, genre: string): Viewer => ({
  viewerId, name, initials: name.slice(1), color: '#333', bio: `${name}의 소개`, profile: { ageBand: '25-34', region: '서울', device: 'pc', genres: [genre] },
  recent: [], events: 30, features: { g1: genre, g2: 'none', skill: 'hi', dev: 'pc', age: '25-34' }, provider: 'ipverse',
});
const VIEWERS = [viewer('v-minji', '김민지', 'arpg'), viewer('v-junho', '박준호', 'racing'), viewer('v-seoyeon', '이서연', 'explore'), viewer('v-hyunwoo', '최현우', 'shooter')];
const IDS = ['', ...VIEWERS.map((v) => v.viewerId)];
const picksOf = (titles: string[]) => Object.fromEntries(IDS.map((v, i) => [v, { title: titles[i % titles.length], creative: `cr_${i % titles.length}`, seconds: 16, reason: `이유 ${i}` }]));
const MANY = picksOf(['사구의 유적', '보스 레이드', '네온 드리프트', '구름섬 이야기', '스타 워든']);
const adBreak = (round: number, picks: AdBreak['picks'], over: Partial<AdBreak> = {}): AdBreak =>
  ({ round, eventId: `t_${round}`, breakId: `b_${round}`, at: '2026-11-16T03:42:00Z', kind: 'trailer', seconds: 16, picks, ...over });
const off: LiveState = { active: false, channelState: 'IDLE', playbackUrl: `${BASE}?token=default`, adInsertion: 'ivs', job: null, stream: null, highlights: [] };
const onAir = (breaks: AdBreak[] = [], job: Partial<NonNullable<LiveState['job']>> = {}, rounds = 3): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: `${BASE}?token=default`, adInsertion: 'ivs', health: 'HEALTHY', highlights: [],
  job: { jobId: 'job1', gameId: 'gm_1', everyRounds: 2, adSeconds: 16, startedAt: '2026-11-16T03:40:00Z', adType: 'trailer', corner: true, roundBase: 0, ...job },
  stream: { state: 'live', rounds, breaks, updatedAt: '2026-11-16T03:43:00Z' } });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  players.clear();
  history.replaceState(null, '', '/#watch=ses_1');
  api.liveStatus.mockResolvedValue(onAir());
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
  document.title = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(live: LiveState = onAir()) {
  api.liveStatus.mockResolvedValue(live);
  await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const side = () => container.querySelector('.watch-side')!;
const chip = (name: string) => [...container.querySelectorAll('.live-chips > div')].find((d) => d.querySelector('dt')?.textContent === name)?.querySelector('dd')?.textContent;
const rows = () => [...container.querySelectorAll<HTMLElement>('.watch-breaks li')];
const heading = () => [...side().querySelectorAll('.watch-h')].find((h) => h.textContent?.startsWith('나간 광고 기록'))!;

// The record of the ads that went out is not replaced by 아직 광고가 나가지 않았어요 as the broadcast ends.
describe('the record of the ads that went out stays after the broadcast ends, as the last broadcast\'s (new finding 21)', () => {
  const breaks = [2, 4, 6].map((n) => adBreak(n, MANY));

  it('a status that drops the stream at the stop: the page keeps the record and the rounds it last saw', async () => {
    await render(onAir(breaks, {}, 6));
    expect(rows()).toHaveLength(3);
    expect(heading().textContent).toBe('나간 광고 기록');
    api.liveStatus.mockResolvedValue(off);
    await tick(4000);
    expect(chip('방송 상태')).toBe('꺼짐');
    expect(rows()).toHaveLength(3);
    expect(heading().textContent).toBe('나간 광고 기록지난 방송');
    expect(chip('끝난 판')).toBe('6판');
    expect(side().textContent).not.toContain('아직 광고가 나가지 않았어요');
  });

  // (server/live.py _status lastBroadcast: what the session's ended broadcast sent, while it is the channel's last)
  it("a page opened after the stop has no list to show: it says how many ads the last broadcast sent, from the status's count", async () => {
    await render({ ...off, lastBroadcast: { rounds: 6, ads: 3 } } as LiveState);
    expect(rows()).toHaveLength(0);
    expect(heading().textContent).toBe('나간 광고 기록지난 방송');
    expect(side().textContent).toContain('지난 방송에서 광고가 3번 나갔어요.');
    expect(side().textContent).not.toContain('아직 광고가 나가지 않았어요');
    expect(chip('끝난 판')).toBe('6판');
  });

  it('a last broadcast that sent no ad is not said to have sent any', async () => {
    await render({ ...off, lastBroadcast: { rounds: 1, ads: 0 } } as LiveState);
    expect(side().textContent).toContain('아직 광고가 나가지 않았어요.');
    expect(heading().textContent).toBe('나간 광고 기록');
  });

  it('the next broadcast starts its own record', async () => {
    await render(onAir(breaks, {}, 6));
    api.liveStatus.mockResolvedValue(off);
    await tick(4000);
    api.liveStatus.mockResolvedValue(onAir([], { jobId: 'job2' }, 6));
    await tick(4000);
    expect(rows()).toHaveLength(0);
    expect(heading().textContent).toBe('나간 광고 기록');
    expect(side().textContent).toContain('아직 광고가 나가지 않았어요.');
  });

  // (a broadcast that ends before its first status has no stream of its own: the record kept is never an older one's)
  it('a next broadcast that ended before it had a record leaves none of the one before it', async () => {
    await render(onAir(breaks, {}, 6));
    api.liveStatus.mockResolvedValue({ ...onAir([], { jobId: 'job2' }), stream: null });
    await tick(4000);
    api.liveStatus.mockResolvedValue(off);
    await tick(4000);
    expect(chip('방송 상태')).toBe('꺼짐');
    expect(rows()).toHaveLength(0);
    expect(heading().textContent).toBe('나간 광고 기록');
    expect(side().textContent).toContain('아직 광고가 나가지 않았어요.');
  });
});

// The status carries how many ads the broadcast has to give at one break, by style (job.adChoices, server/live.py
// _ad_choices); with a status that carries none, the viewers' picks of the newest break say it.
describe('with one ad to give the watch page says why the four viewers get the same one, and how to change that (C-01)', () => {
  const ONE = picksOf(['사구의 유적']);
  const title = () => container.querySelector('.popup-title')!.textContent;
  const note = () => container.querySelector('.same-ad-note');
  /** The server's count for the broadcast's style: the account's trailers, or for a playable broadcast its games. */
  const counted = (n: number) => ({ adChoices: { trailer: n, playable: n } }) as Partial<NonNullable<LiveState['job']>>;
  const WHY = '지금은 광고로 나갈 트레일러가 1개뿐이라 가상 시청자 4명이 모두 같은 광고를 받아요. 트레일러를 더 만들면(다른 세션에서 만든 것도 함께 써요) 시청자마다 프로필에 맞는 광고가 나가요.';
  const DIFFERENT = '라이브 시청 가상 시청자 4명이 같은 방송에서 저마다 다른 광고를 받아요';
  const SAME = '라이브 시청 가상 시청자 4명이 같은 방송을 봐요 · 지금은 광고가 1개라 모두 같은 광고를 받아요';

  it("the server's count of 1: the header promises no different ads, and a note says why and how to change it, before any ad", async () => {
    await render(onAir([], counted(1)));
    expect(title()).toBe(SAME);
    expect(note()!.textContent).toBe(WHY);
    expect(note()!.getAttribute('role')).toBe('note');
    expect(side().contains(note())).toBe(true);
    // what will come is said without "different for each viewer"
    expect(side().textContent).toContain('아직 광고가 나가지 않았어요. 2판이 끝나면 트레일러가 화면 전체에 나와요.');
  });

  it('no count from the server: the newest break whose viewers all got one ad says it, and one with different picks takes it back', async () => {
    await render(onAir([]));
    expect([title(), note()]).toEqual([DIFFERENT, null]); // nothing went out yet: nothing is known
    api.liveStatus.mockResolvedValue(onAir([adBreak(2, ONE)]));
    await tick(4000);
    expect(title()).toBe(SAME);
    expect(note()!.textContent).toBe(WHY);
    expect(rows()[0].textContent).toContain('사구의 유적'); // the row names the one ad
    api.liveStatus.mockResolvedValue(onAir([adBreak(2, ONE), adBreak(4, MANY)]));
    await tick(4000);
    expect([title(), note()]).toEqual([DIFFERENT, null]);
  });

  it("the server's count wins over a break whose picks happen to be one", async () => {
    await render(onAir([adBreak(2, ONE)], counted(4)));
    expect([title(), note()]).toEqual([DIFFERENT, null]);
  });

  it('a playable broadcast says it of its games, and a corner one of its trailers', async () => {
    await render(onAir([], { adType: 'playable', corner: false, playableSeconds: 90, ...counted(1) }));
    expect(note()!.textContent).toBe('지금은 광고로 나갈 게임이 1개뿐이라 가상 시청자 4명이 모두 같은 게임 카드를 받아요. 게임을 더 게시하면(다른 세션에서 게시한 것도 함께 써요) 시청자마다 프로필에 맞는 게임이 나가요.');
    expect(side().textContent).toContain('2판이 끝나면 플레이어블 광고 카드가 떠요.');
    api.liveStatus.mockResolvedValue(onAir([], { adType: 'corner', corner: false, ...counted(1) }));
    await tick(4000);
    expect(note()!.textContent).toBe(WHY);
    expect(side().textContent).toContain('2판이 끝나면 코너 트레일러가 화면 구석에 떠요.');
  });

  it('1명 보기 says it too: whichever viewer is picked gets that ad', async () => {
    history.replaceState(null, '', '/#watch=ses_1&view=one');
    await render(onAir([], counted(1)));
    expect(note()!.textContent).toBe(WHY);
  });

  it('off air nothing is known of it', async () => {
    await render(off);
    expect([title(), note()]).toEqual([DIFFERENT, null]);
  });
});

// A player may play its ad without telling (no ad event): the tile's line then comes from the break log, not from its
// own player's word alone.
describe("a tile whose player plays its ad without telling still says so, from the break log (new finding 19)", () => {
  const tile = (id: string) => container.querySelector<HTMLElement>(`.vt[data-viewer="${id}"]`)!;
  const line = (id: string) => tile(id).querySelector('.vt-ad')?.textContent ?? null;
  const player = (name: string) => players.get(`${name}의 방송 화면`)!;
  const mark = (name: string, breakId: string) => act(async () => player(name).onMetadata!(JSON.stringify({ type: 'mark', e: breakId })));
  const starts = () => api.liveAdEvent.mock.calls.filter((c) => c[1].kind === 'trailer').map((c) => [c[1].viewerId, c[1].eventId, 'leadMs' in c[1]]);
  /** Round 4's break, cued a moment ago; `seen`: what the tiles that told have reported of it (server/live.py _ad_shown). */
  const round4 = (seen: Record<string, number> = {}): AdBreak => ({ ...adBreak(4, MANY), at: new Date().toISOString(),
    ...(Object.keys(seen).length ? { shown: seen, tileLead: seen } : {}) }) as AdBreak;
  /** On air, every tile playing, the break in the log and its mark on every tile's picture; then `told` say their ad. */
  async function marked(told: string[]) {
    await render(onAir([round4()], {}, 4));
    for (const v of VIEWERS) await act(async () => player(v.name).onPlaying!(true));
    for (const v of VIEWERS) await mark(v.name, 'b_4');
    await tick(6000); // where the break sits in the stream after its mark
    for (const name of told) await act(async () => player(name).onAd!({ on: true, seconds: 16 }));
  }

  it('two tiles tell, two do not: once the log says the break aired, the silent two draw their own line too, for their creative\'s length', async () => {
    await marked(['박준호', '최현우']);
    expect(line('v-junho')).toBe('광고: 네온 드리프트 · 이유: 이유 2');
    expect([line('v-minji'), line('v-seoyeon')]).toEqual([null, null]); // nothing says yet that the break aired
    expect(starts()).toEqual([['v-junho', 'b_4', true], ['v-hyunwoo', 'b_4', true]]);
    // the two reports are in the log at the next poll: 6.4 and 6.6 s from the mark to the ad
    api.liveStatus.mockResolvedValue(onAir([round4({ 'v-junho': 6.6, 'v-hyunwoo': 6.4 })], {}, 4));
    await tick(4000);
    expect(line('v-minji')).toBe('광고: 보스 레이드 · 이유: 이유 1');
    expect(line('v-seoyeon')).toBe('광고: 구름섬 이야기 · 이유: 이유 3');
    // it is this page's reading of the log, not a tile's word: nothing more is reported
    expect(starts()).toHaveLength(2);
    // and it goes when the creative is over on that tile: 16 s from 6.4 s after its mark
    await tick(8000);
    expect(line('v-minji')).not.toBeNull();
    await tick(6000);
    expect([line('v-minji'), line('v-seoyeon')]).toEqual([null, null]);
  });

  it('a break no tile told of (IVS took the call and never aired it) draws no line anywhere: the mark alone says nothing', async () => {
    await marked([]);
    await tick(12_000);
    expect(VIEWERS.map((v) => line(v.viewerId))).toEqual([null, null, null, null]);
    expect(starts()).toEqual([]);
    api.liveStatus.mockResolvedValue(onAir([{ ...round4(), lost: true }], {}, 4));
    await tick(4000);
    expect(VIEWERS.map((v) => line(v.viewerId))).toEqual([null, null, null, null]);
  });

  it("a tile whose player tells late (the ad's progress, no start) draws its line and reports the break without a number", async () => {
    await marked(['박준호']);
    await act(async () => player('김민지').onAd!({ on: true, seconds: 13, late: true }));
    expect(line('v-minji')).toBe('광고: 보스 레이드 · 이유: 이유 1');
    expect(starts()).toEqual([['v-junho', 'b_4', true], ['v-minji', 'b_4', false]]);
    // its own word ends it
    await act(async () => player('김민지').onAd!({ on: false }));
    expect(line('v-minji')).toBeNull();
  });

  it('a tile that never reached the mark (its picture is elsewhere) draws nothing from the log', async () => {
    await render(onAir([round4({ 'v-junho': 6.6 })], {}, 4));
    for (const v of VIEWERS) await act(async () => player(v.name).onPlaying!(true));
    await tick(12_000);
    expect(line('v-minji')).toBeNull();
  });
});

// Off air the page does not know the interval (it is chosen in the console), so it says what a broadcast does without a number.
describe('the watch page off air says what a broadcast will do without a literal N (new finding 32)', () => {
  it('off air: no number it does not know; on air: the broadcast\'s own', async () => {
    await render(off);
    expect(side().textContent).toContain('아직 광고가 나가지 않았어요. 라이브를 켜면 정한 판수가 끝날 때마다 시청자마다 다른 광고가 나가요.');
    expect(container.textContent).not.toMatch(/N판/);
    api.liveStatus.mockResolvedValue(onAir([], { everyRounds: 3 }));
    await tick(4000);
    expect(side().textContent).toContain('아직 광고가 나가지 않았어요. 3판이 끝나면 시청자마다 다른 트레일러가 화면 전체에 나와요.');
  });
});
