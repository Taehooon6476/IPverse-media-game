import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, Viewer } from './api';
import { WatchWindow } from './components/WatchWindow';

const api = vi.hoisted(() => ({ liveStatus: vi.fn(), liveViewer: vi.fn(), liveViewers: vi.fn(), liveToken: vi.fn(), liveAdEvent: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('./components/LiveClock', () => ({ LiveClock: () => null }));
vi.mock('./components/LivePlayable', () => ({ LivePlayable: () => null }));
/** The IVS player stand-in: one record per mounted player (its label tells whose), what it plays, its callbacks. */
type Fake = { label: string; src: string; maxSize?: [number, number]; onAd?: (a: { on: boolean }) => void;
  onPlaying?: (p: boolean) => void; mounts: number };
const players = vi.hoisted(() => new Map<string, Fake>());
vi.mock('./components/IvsPlayer', async () => {
  const { useEffect } = await import('react');
  return {
    IvsPlayer: (p: Omit<Fake, 'label' | 'mounts'> & { ariaLabel?: string }) => {
      const label = p.ariaLabel ?? '라이브 방송';
      const rec = players.get(label) ?? { label, src: '', mounts: 0 };
      Object.assign(rec, { src: p.src, maxSize: p.maxSize, onAd: p.onAd, onPlaying: p.onPlaying });
      players.set(label, rec);
      useEffect(() => { rec.mounts++; }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    },
  };
});

const BASE = 'https://x.live-video.net/api/video/v1/ch.m3u8';
const onAir = (breaks: AdBreak[] = []): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: `${BASE}?token=default-1`,
  adInsertion: 'ivs', health: 'HEALTHY', highlights: [],
  job: { gameId: 'gm_1', everyRounds: 1, adSeconds: 30, startedAt: '2026-11-08T00:00:00Z', adType: 'trailer' },
  stream: { state: 'live', rounds: 1, breaks, updatedAt: '2026-11-08T00:00:00Z' },
});
const viewer = (viewerId: string, name: string, genre: string, device: string, recent: string[]): Viewer => ({
  viewerId, name, initials: name.slice(1), color: '#333', bio: `${name}의 소개`,
  profile: { ageBand: '25-34', region: '서울', device, genres: [genre] },
  recent: recent.map((text, i) => ({ type: i ? 'play' : 'ad_click', at: new Date(Date.now() - (i + 1) * 3600_000).toISOString(), text,
    ...(i ? {} : { simulated: true }) })),
  events: 30 + recent.length, features: { g1: genre, g2: 'none', skill: 'hi', dev: device, age: '25-34' }, provider: 'ipverse',
});
const VIEWERS = [
  viewer('v-minji', '김민지', 'arpg', 'pc', ['광고 클릭 · 보스 레이드 (액션 RPG)', '액션 RPG · 그림자 군주 90분 플레이 (승리)', '구매 · 심연의 던전 (액션 RPG)']),
  viewer('v-junho', '박준호', 'racing', 'console', ['레이싱 · 서킷 레전드 42분 플레이 (패배)', '찜 · 네온 드리프트 X (레이싱)', '광고 스킵 · 은하 침공 (SF 슈터)']),
  viewer('v-seoyeon', '이서연', 'explore', 'mobile', ['탐험·수집 · 구름섬 수집가 12분 플레이 (승리)', '트레일러 시청 · 보물 정원 (탐험·수집)', '플레이어블 광고 2분 · 골목 탐험 일기']),
  viewer('v-hyunwoo', '최현우', 'shooter', 'pc', ['SF 슈터 · 스타 레인저 60분 플레이 (승리)', '광고 클릭 · 메카 프론트라인 (SF 슈터)', '방송 시청 12분 · 좀비 생존 30']),
];
const pick = (title: string, reason: string, extra = {}) => ({ title, creative: `cr_${title}`, seconds: 20, reason, reasons: reason.split(' · '), ...extra });
const BREAK: AdBreak = { round: 2, eventId: 'ivs7', at: '2026-11-08T00:01:00Z', seconds: 30, kind: 'trailer', breakId: 'b_1', picks: {
  '': pick('좀비 생존 30', '기본 광고 (시청자 정보 없음)'),
  'v-minji': pick('보스 레이드', '최근 7일 액션 RPG 9시간 · 액션 RPG 광고 클릭 2회'),
  'v-junho': pick('네온 드리프트', '최근 7일 레이싱 3시간 · 레이싱 광고 클릭 2회'),
  'v-seoyeon': pick('구름섬 이야기', "최근 7일 탐험·수집 2시간 · '수집' 좋아함"),
  'v-hyunwoo': pick('스타 워든', "준비된 광고 중 최선 ('은하 침공' 준비 중) · 최근 7일 SF 슈터 5시간", { fallback: true }),
  racer: pick('네온 드리프트', '최근 7일 레이싱 3시간 · 레이싱 광고 클릭 2회'),
} };

let container: HTMLDivElement;
let root: Root;
let issued = 0;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  players.clear();
  history.replaceState(null, '', '/#watch=ses_1');
  issued = 0;
  api.liveStatus.mockResolvedValue(onAir());
  api.liveViewer.mockReset();
  api.liveViewer.mockResolvedValue({ warmed: false });
  api.liveAdEvent.mockResolvedValue({ recorded: true }); // a tile reports its full-screen ad's start
  api.liveViewers.mockResolvedValue({ viewers: VIEWERS });
  api.liveToken.mockReset();
  api.liveToken.mockImplementation(async (id: string) => ({
    playbackUrl: `${BASE}?token=${id}-${++issued}`, expiresAt: Math.floor(Date.now() / 1000) + 20 * 60,
    persona: id, personaName: VIEWERS.find((v) => v.viewerId === id)?.name ?? '기본', provider: 'ipverse' }));
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
const tilePlayer = (name: string) => players.get(`${name}의 방송 화면`)!;
const text = (el: Element | null) => el?.textContent ?? '';
async function render() {
  await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
  await wait(0);
}

describe('시청자 4명: four viewers, each its own player, profile, activity and ads', () => {
  it('opens as the 2×2 grid: one small player per viewer, each with its own viewer token', async () => {
    await render();
    expect([...container.querySelectorAll('.vt')].map((t) => t.getAttribute('data-viewer'))).toEqual(['v-minji', 'v-junho', 'v-seoyeon', 'v-hyunwoo']);
    expect(api.liveToken.mock.calls.map((c) => c[0]).sort()).toEqual(['v-hyunwoo', 'v-junho', 'v-minji', 'v-seoyeon']);
    for (const v of VIEWERS) {
      const p = tilePlayer(v.name);
      expect(p.src).toMatch(new RegExp(`token=${v.viewerId}-\\d$`));
      expect(p.maxSize).toEqual([480, 270]);
    }
    expect(players.has('라이브 방송')).toBe(false); // no big player in the grid
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('가상 시청자 4명');
  });

  it('each tile shows the name, profile chips and the latest activity', async () => {
    await render();
    const t = tile('박준호');
    expect(text(t.querySelector('.vt-who strong'))).toBe('박준호');
    expect([...t.querySelectorAll('.vt-chips li')].map((li) => li.textContent)).toEqual(['25-34', '서울', '콘솔', '레이싱']);
    const feed = [...t.querySelectorAll('.vt-feed li span')].map((s) => s.textContent);
    expect(feed).toEqual(['레이싱 · 서킷 레전드 42분 플레이 (패배)', '찜 · 네온 드리프트 X (레이싱)', '광고 스킵 · 은하 침공 (SF 슈터)']);
    expect(text(t.querySelector('.vt-feed time'))).toBe('1시간 전');
    expect(tile('김민지').querySelector('.vt-feed li')?.className).toBe('is-sim'); // a simulated click from the broadcast
  });

  it("during a break each tile shows its own ad and why; the history keeps every viewer's ads", async () => {
    api.liveStatus.mockResolvedValue(onAir([BREAK]));
    await render();
    await act(async () => { for (const v of VIEWERS) tilePlayer(v.name).onAd?.({ on: true }); });
    expect(text(tile('박준호').querySelector('.vt-ad'))).toBe('광고: 네온 드리프트 · 이유: 최근 7일 레이싱 3시간 · 레이싱 광고 클릭 2회');
    expect(text(tile('김민지').querySelector('.vt-ad'))).toBe('광고: 보스 레이드 · 이유: 최근 7일 액션 RPG 9시간 · 액션 RPG 광고 클릭 2회');
    expect(text(tile('이서연').querySelector('.vt-ad'))).toContain('광고: 구름섬 이야기');
    expect(new Set(VIEWERS.map((v) => text(tile(v.name).querySelector('.vt-ad')).split(' · ')[0])).size).toBe(4);
    await act(async () => tilePlayer('박준호').onAd?.({ on: false }));
    expect(tile('박준호').querySelector('.vt-ad')).toBeNull(); // the break ended for this viewer only
    expect(tile('김민지').querySelector('.vt-ad')).not.toBeNull();
    const hist = [...tile('최현우').querySelectorAll('.vt-ads li')];
    expect(text(hist[0].querySelector('strong'))).toBe('2판 · 스타 워든 (대체)');
    expect(text(hist[0].querySelector('span'))).toContain('준비된 광고 중 최선');
  });

  it('a highlight break is the same for every tile', async () => {
    api.liveStatus.mockResolvedValue(onAir([{ round: 1, eventId: 'ivs1', at: '2026-11-08T00:01:00Z', seconds: 5, kind: 'linear', title: '역전승' }]));
    await render();
    await act(async () => tilePlayer('이서연').onAd?.({ on: true }));
    expect(text(tile('이서연').querySelector('.vt-ad'))).toBe('광고: 하이라이트 · 역전승 · 이유: 모든 시청자에게 같은 장면');
  });

  it('the heartbeat names the tiles that are playing', async () => {
    await render();
    expect(api.liveViewer).not.toHaveBeenCalled(); // nothing plays yet
    await act(async () => { tilePlayer('김민지').onPlaying?.(true); tilePlayer('최현우').onPlaying?.(true); });
    expect(api.liveViewer).toHaveBeenLastCalledWith('ses_1', ['v-hyunwoo', 'v-minji'], true);
    await wait(15_000);
    expect(api.liveViewer).toHaveBeenCalledTimes(2);
  });

  it('activity refreshes as the logs grow', async () => {
    await render();
    api.liveViewers.mockResolvedValue({ viewers: VIEWERS.map((v) => v.viewerId === 'v-junho'
      ? { ...v, recent: [{ type: 'ad_click', at: new Date().toISOString(), text: '광고 클릭 · 네온 드리프트 (레이싱)', simulated: true }, ...v.recent] } : v) });
    await wait(15_000);
    expect(text(tile('박준호').querySelector('.vt-feed li span'))).toBe('광고 클릭 · 네온 드리프트 (레이싱)');
  });
});

describe('1명 보기: one big player as one viewer', () => {
  const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="가상 시청자"]')!;
  async function choose(value: string) {
    await act(async () => { const el = select(); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await wait(0);
  }

  it('the switch opens it; 기본 plays the status URL, a viewer its own token, renewed without a new player', async () => {
    await render();
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click());
    await wait(0);
    expect(location.hash).toContain('view=one');
    expect([...select().options].map((o) => o.textContent)).toEqual(['기본 (시청자 정보 없음)', '김민지 · 액션 RPG', '박준호 · 레이싱', '이서연 · 탐험·수집', '최현우 · SF 슈터']);
    expect(players.get('라이브 방송')?.src).toBe(`${BASE}?token=default-1`);
    await choose('v-junho');
    expect(players.get('라이브 방송')?.src).toMatch(/token=v-junho-\d+$/);
    const mounts = players.get('라이브 방송')!.mounts;
    const first = players.get('라이브 방송')!.src;
    await wait(17 * 60 * 1000 + 1000);
    expect(players.get('라이브 방송')!.src).not.toBe(first);
    expect(players.get('라이브 방송')!.mounts).toBe(mounts);
  });

  it('an old persona link opens its viewer, and the badge names the viewer, the trailer and why', async () => {
    api.liveStatus.mockResolvedValue(onAir([BREAK]));
    history.replaceState(null, '', '/#watch=ses_1&view=one&persona=racer');
    await render();
    expect(select().value).toBe('v-junho');
    await act(async () => players.get('라이브 방송')?.onAd?.({ on: true }));
    expect(text(container.querySelector('.live-ad'))).toBe('광고 · 박준호 맞춤 · 네온 드리프트이유: 최근 7일 레이싱 3시간 · 레이싱 광고 클릭 2회');
    expect(text(container.querySelector('.live-ad-why'))).toBe('이유: 최근 7일 레이싱 3시간 · 레이싱 광고 클릭 2회');
    await choose('');
    await act(async () => players.get('라이브 방송')?.onAd?.({ on: true }));
    expect(text(container.querySelector('.live-ad'))).toBe('광고 · 기본 · 좀비 생존 30');
  });

  it("the heartbeat names this window's viewer while it plays", async () => {
    history.replaceState(null, '', '/#watch=ses_1&view=one&persona=v-seoyeon');
    await render();
    await act(async () => players.get('라이브 방송')?.onPlaying?.(true));
    expect(api.liveViewer).toHaveBeenLastCalledWith('ses_1', ['v-seoyeon'], true);
  });
});

// With every tile's playback blocked through a break, the list must not keep "판 끝 → 광고 … (예상)".
describe('the ad list does not claim an ad no tile could confirm', () => {
  it('says 확인 안 됨 instead of an expected time', async () => {
    api.liveStatus.mockResolvedValue(onAir([{ ...BREAK, endToAdSec: 2.3, preCue: true, leadSec: 2, unseen: true }]));
    history.replaceState(null, '', '/#watch=ses_1');
    await render();
    const list = text(container.querySelector('.watch-breaks'));
    expect(list).toContain('광고 시작 확인 안 됨');
    expect(list).not.toMatch(/판 끝 → 광고|예상/);
  });
});
