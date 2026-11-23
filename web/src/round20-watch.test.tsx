// The watch page speaks plainly: no AWS service names or internals, its four viewers are marked as examples, its idle
// text names a button that exists, and a break's row does not name one ad while the tiles play four.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, Viewer } from './api';
import { WatchWindow } from './components/WatchWindow';

const api = vi.hoisted(() => ({ liveStatus: vi.fn(), liveViewer: vi.fn(), liveViewers: vi.fn(), liveToken: vi.fn(), liveAdEvent: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('./components/LiveClock', () => ({ LiveClock: () => null }));
vi.mock('./components/IvsPlayer', () => ({ IvsPlayer: () => null }));
vi.mock('./components/LivePlayable', () => ({ LivePlayable: () => null }));

const BASE = 'https://x.live-video.net/api/video/v1/ch.m3u8';
const viewer = (viewerId: string, name: string, genre: string): Viewer => ({
  viewerId, name, initials: name.slice(1), color: '#333', bio: `${name}의 소개`, profile: { ageBand: '25-34', region: '서울', device: 'pc', genres: [genre] },
  recent: [], events: 30, features: { g1: genre, g2: 'none', skill: 'hi', dev: 'pc', age: '25-34' }, provider: 'ipverse',
});
const VIEWERS = [viewer('v-minji', '김민지', 'arpg'), viewer('v-junho', '박준호', 'racing'), viewer('v-seoyeon', '이서연', 'explore'), viewer('v-hyunwoo', '최현우', 'shooter')];
const pick = (title: string) => ({ title, creative: `cr_${title}`, seconds: 16, reason: '이유' });
const off: LiveState = { active: false, channelState: 'IDLE', playbackUrl: `${BASE}?token=default`, adInsertion: 'ivs', job: null, stream: null, highlights: [] };
const onAir = (breaks: AdBreak[] = [], over: Partial<LiveState> = {}): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: `${BASE}?token=default`, adInsertion: 'ivs', health: 'HEALTHY', highlights: [],
  job: { jobId: 'job1', gameId: 'gm_1', everyRounds: 2, adSeconds: 16, startedAt: '2026-11-16T03:40:00Z', adType: 'trailer', corner: true, roundBase: 0 },
  stream: { state: 'live', rounds: 3, breaks, updatedAt: '2026-11-16T03:43:00Z' }, ...over });
// a break whose tiles each play their own creative
const PERSONAL: AdBreak = { round: 2, eventId: 'BILX4UIm3CjF', at: '2026-11-16T03:42:00Z', seconds: 15.9, kind: 'trailer', title: '사구의 유적',
  preCue: true, leadSec: 2, endToAdSec: 2.8, measured: 4,
  picks: { '': pick('사구의 유적'), 'v-minji': pick('보스 레이드'), 'v-junho': pick('네온 드리프트'), 'v-seoyeon': pick('구름섬 이야기'), 'v-hyunwoo': pick('스타 워든') } };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
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
/** What the page says in sight: its text without what only a tooltip (title) carries. */
const said = () => container.textContent ?? '';
const NAMES = /IVS|MediaTailor|GameLift|SSAI|Pegasus|재생 토큰|타일 \d개 실측|미리 큐/;
const chip = (name: string) => [...container.querySelectorAll('.live-chips > div')].find((d) => d.querySelector('dt')?.textContent === name);

describe('the watch page calls its four viewers what they are (R20-20)', () => {
  it('가상 시청자, with one line that says they are made-up profiles used to show per-viewer ads', async () => {
    await render();
    expect(container.querySelector('.popup-title')!.textContent).toBe('라이브 시청 가상 시청자 4명이 같은 방송에서 저마다 다른 광고를 받아요');
    expect([...container.querySelectorAll('.view-switch [role="tab"]')].map((t) => t.textContent)).toEqual(['가상 시청자 4명', '1명 보기']);
    expect(container.querySelector('.watch-side')!.textContent).toContain('가상 시청자 4명은 실제 사람이 아니에요. 시청자마다 다른 광고가 나가는 걸 보여 주려고 만든 프로필이에요.');
    expect(container.querySelectorAll('article[aria-label^="가상 시청자 "]')).toHaveLength(4);
    expect(container.querySelector('main.watch-grid')!.getAttribute('aria-label')).toBe('가상 시청자 4명');
    expect(document.title).toBe('라이브 시청 · IPverse Studio'); // the three windows do not share one tab title
  });

  it('1명 보기 picks a 가상 시청자', async () => {
    history.replaceState(null, '', '/#watch=ses_1&view=one');
    await render();
    expect(container.querySelector('.watch-persona span')!.textContent).toBe('가상 시청자');
    expect(container.querySelector('.watch-persona small')!.textContent).toContain('가상 시청자를 고르면');
  });
});

describe('plain words on the watch page; the service names are tooltips at most (R20-20)', () => {
  it('on air: no service name or internal in sight, in either view', async () => {
    await render(onAir([PERSONAL]));
    expect(said()).not.toMatch(NAMES);
    expect(chip('방송 상태')!.querySelector('dd')!.textContent).toBe('LIVE');
    expect(chip('광고 방식')!.querySelector('dd')!.textContent).toBe('전체 화면 트레일러 + 코너 트레일러');
    // how the ads get there is still told, to whoever asks: the chip's tooltip
    expect(chip('광고 방식')!.getAttribute('title')).toContain('MediaTailor');
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.view-switch [role="tab"]')][1].click(); await vi.advanceTimersByTimeAsync(0); });
    expect(said()).not.toMatch(NAMES);
  });

  it('off air: it names the button there is (라이브 켜기), and where', async () => {
    await render(off);
    expect(said()).not.toMatch(NAMES);
    expect(said()).not.toContain('방송 시작');
    expect(container.querySelector('.watch-grid')!.textContent).toBe('방송이 꺼져 있어요. 스튜디오의 라이브 방송 창이나 플레이 창에서 ‘라이브 켜기’를 눌러 주세요.');
    expect(chip('광고 방식')!.querySelector('dd')!.textContent).toBe('–');
    expect(chip('방송 상태')!.querySelector('dd')!.textContent).toBe('꺼짐');
  });

  it('connecting: says so and how long, not that it waits for a stream', async () => {
    await render(onAir([], { channelState: 'STARTING' }));
    expect(container.querySelector('.watch-grid')!.textContent).toBe('방송에 연결하는 중이에요 (보통 10–20초). 연결되면 네 화면이 함께 켜져요.');
    expect(chip('방송 상태')!.querySelector('dd')!.textContent).toBe('연결 중');
  });
});

describe('나간 광고 기록: what went out, in the words of the console (R20-20, R20-48)', () => {
  const rows = () => [...container.querySelectorAll<HTMLElement>('.watch-breaks li')];

  it('a full-screen break names its style and when it began after the round, with the measuring detail and the id as its tooltip', async () => {
    await render(onAir([PERSONAL]));
    expect(rows()[0].querySelector('strong')!.textContent).toBe('2판 · 전체 화면 트레일러');
    expect(rows()[0].querySelector('span')!.textContent).toMatch(/· 시청자마다 다른 광고 4개 · 16초 · 판이 끝나고 2\.8초 뒤$/);
    expect(rows()[0].getAttribute('title')).toBe('화면 4개에서 잰 값 · 판이 끝나기 2초 전에 미리 보냄 · #BILX4UIm3CjF');
  });

  it('one ad for everyone is named; an estimate says it is one; a corner, a playable card and a lost break read plainly', async () => {
    const same: AdBreak = { ...PERSONAL, round: 4, eventId: 'e4', measured: undefined, preCue: false, endToAdSec: 6.2,
      picks: { '': pick('사구의 유적'), 'v-minji': pick('사구의 유적'), 'v-junho': pick('사구의 유적') } };
    const corner: AdBreak = { round: 5, eventId: 'c5', at: '2026-11-16T03:45:00Z', seconds: 12, kind: 'corner', picks: PERSONAL.picks };
    const card: AdBreak = { round: 6, eventId: 'p6', at: '2026-11-16T03:46:00Z', seconds: 90, kind: 'playable', playable: true, picks: PERSONAL.picks };
    const lost: AdBreak = { ...PERSONAL, round: 8, eventId: 'l8', lost: true };
    await render(onAir([same, corner, card, lost]));
    const text = rows().map((r) => [r.querySelector('strong')!.textContent, r.querySelector('span')!.textContent]);
    expect(text[3][0]).toBe('4판 · 전체 화면 트레일러');
    expect(text[3][1]).toMatch(/· 사구의 유적 · 16초 · 판이 끝나고 6\.2초 뒤 \(예상\)$/);
    expect(text[2]).toEqual(['5판 · 코너 트레일러', expect.stringMatching(/· 시청자마다 다른 광고 4개 · 12초$/)]);
    expect(text[1]).toEqual(['6판 · 플레이어블 광고', expect.stringMatching(/· 시청자마다 다른 광고 4개 · 90초$/)]);
    expect(text[0][0]).toBe('8판 · 전체 화면 트레일러 · 방송에 나가지 않음');
    expect(said()).not.toMatch(NAMES);
  });

  // A trailer round with no trailer ready to air sends each viewer's corner trailer in its place and puts the reason in
  // that break's log entry; the row says it.
  it('a corner sent in a full-screen trailer\'s place says why, in the server\'s sentence', async () => {
    const instead: AdBreak = { round: 2, eventId: 'c2', at: '2026-11-16T03:45:00Z', seconds: 12, kind: 'corner', picks: PERSONAL.picks,
      instead: 'trailer', note: '전체 화면 트레일러를 준비하고 있어요(1–2분). 이번 판은 코너 트레일러를 보냈어요.' };
    await render(onAir([instead]));
    expect(rows()[0].querySelector('strong')!.textContent).toBe('2판 · 코너 트레일러');
    expect(rows()[0].querySelector('.watch-break-note')!.textContent).toBe('전체 화면 트레일러를 준비하고 있어요(1–2분). 이번 판은 코너 트레일러를 보냈어요.');
    expect(rows()[0].querySelector('span')!.textContent).toMatch(/· 시청자마다 다른 광고 4개 · 12초$/); // the row itself as ever
  });

  it('before the first ad: what will come, by the style on air', async () => {
    await render(onAir([]));
    expect(container.querySelector('.watch-side')!.textContent).toContain('아직 광고가 나가지 않았어요. 2판이 끝나면 시청자마다 다른 트레일러가 화면 전체에 나와요.');
  });
});

// Before its first answer, when the status cannot be read, and when the login has expired, the page does not say 방송이 꺼져 있어요.
describe('loading, failed and off air are three different things on the watch page (R20-43)', () => {
  const stage = () => container.querySelector('.watch-main')!;
  const button = (text: string) => [...stage().querySelectorAll('button')].find((b) => b.textContent === text);
  async function open() {
    await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }

  it('before the first answer it says it is checking, not that the broadcast is off', async () => {
    api.liveStatus.mockReturnValue(new Promise(() => undefined));
    await open();
    expect(stage().textContent).toBe('방송 상태를 확인하는 중이에요…');
    expect(chip('방송 상태')!.querySelector('dd')!.textContent).toBe('확인 중');
    expect(chip('광고 방식')!.querySelector('dd')!.textContent).toBe('–'); // not "설정 안 됨": nothing is known yet
  });

  it('a status that cannot be read: the reason and 다시 시도, which asks again at once', async () => {
    api.liveStatus.mockRejectedValue(Object.assign(new Error('인터넷 연결을 확인해 주세요.'), { name: 'ApiError', status: 0 }));
    await open();
    expect(stage().querySelector('[role="alert"]')!.textContent).toContain('방송 상태를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
    expect(stage().textContent).not.toContain('방송이 꺼져 있어요');
    expect(chip('방송 상태')!.querySelector('dd')!.textContent).toBe('확인 안 됨');
    api.liveStatus.mockResolvedValue(off);
    const asked = api.liveStatus.mock.calls.length;
    await act(async () => { button('다시 시도')!.click(); await vi.advanceTimersByTimeAsync(0); });
    expect(api.liveStatus.mock.calls.length).toBe(asked + 1);
    expect(stage().querySelector('[role="alert"]')).toBeNull();
    expect(stage().textContent).toContain('방송이 꺼져 있어요.');
  });

  it('an expired login is said as that, with 다시 로그인: also on a page that was showing a broadcast', async () => {
    const expired = Object.assign(new Error('로그인 시간이 지났어요. 다시 로그인하면 하던 작업으로 돌아가요.'), { name: 'AuthError' });
    await render(onAir([PERSONAL]));
    expect(container.querySelectorAll('.vt')).toHaveLength(4);
    api.liveStatus.mockRejectedValue(expired);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(stage().querySelector('[role="alert"]')!.textContent).toContain('로그인 시간이 지났어요. 다시 로그인하면 하던 작업으로 돌아가요.');
    expect(button('다시 로그인')).toBeTruthy();
    expect(button('다시 시도')).toBeUndefined();
  });

  it('a status poll that fails on a page that has one keeps what it shows (the next poll may be fine)', async () => {
    await render(onAir([PERSONAL]));
    api.liveStatus.mockRejectedValue(Object.assign(new Error('서버가 응답하지 않아요.'), { name: 'ApiError', status: 503 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(container.querySelectorAll('.vt')).toHaveLength(4);
    expect(stage().querySelector('[role="alert"]')).toBeNull();
  });
});

// The view switch is marked up as tabs, so it takes a tab list's keys: arrows move, and only the selected tab is a Tab stop.
describe("the watch page's view switch is a tab list by keyboard too (R20-52)", () => {
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('.view-switch [role="tab"]')];
  const key = (el: Element, k: string) => act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('the arrow keys, Home and End move between 가상 시청자 4명 and 1명 보기; one Tab stop; the tabs name what they show', async () => {
    await render();
    expect(tabs().map((t) => [t.getAttribute('aria-selected'), t.tabIndex])).toEqual([['true', 0], ['false', -1]]);
    await key(tabs()[0], 'ArrowRight');
    expect(tabs().map((t) => [t.getAttribute('aria-selected'), t.tabIndex])).toEqual([['false', -1], ['true', 0]]);
    expect(document.activeElement).toBe(tabs()[1]);
    expect(container.querySelector('main.watch-stage')).not.toBeNull();
    await key(tabs()[1], 'ArrowRight'); // wraps around
    expect(document.activeElement).toBe(tabs()[0]);
    await key(tabs()[0], 'End');
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    await key(tabs()[1], 'Home');
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    const panel = document.getElementById(tabs()[0].getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[0].id);
    expect(panel.contains(container.querySelector('main.watch-grid'))).toBe(true);
  });
});

// With the playable server switched off on air, a card's ▶ 지금 플레이 starts a GPU server for that play: the price is said first.
describe('a card that starts the playable server says what it costs (round20 review, web note 12)', () => {
  const playable = (standbyOff: boolean) => onAir([], { job: { ...onAir().job!, adType: 'playable', corner: false, playableSeconds: 90, standbyOff } });

  it('the server off on air: the chip says a card click starts it, and the price while it is on', async () => {
    await render(playable(true));
    expect(chip('플레이어블 서버')!.querySelector('dd')!.textContent).toBe('꺼짐 · 카드를 누르면 그때 켜져요 (켜져 있는 동안 시간당 약 $1.51)');
  });

  it('a server the broadcast holds: a click starts nothing more, and the chip names no price', async () => {
    await render(playable(false));
    expect(chip('플레이어블 서버')!.querySelector('dd')!.textContent).toBe('준비 중');
  });
});
