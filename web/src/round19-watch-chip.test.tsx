// The watch page's side chip names IVS SSAI + MediaTailor only for a broadcast whose ads go through them, not a
// corner-only one.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAdType, LiveState } from './api';
import { WatchWindow, adInsertionHow, adInsertionText } from './components/WatchWindow';

const api = vi.hoisted(() => ({ liveStatus: vi.fn(), liveViewer: vi.fn(), liveViewers: vi.fn(), liveToken: vi.fn(), liveAdEvent: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('./components/LiveClock', () => ({ LiveClock: () => null }));
vi.mock('./components/IvsPlayer', () => ({ IvsPlayer: () => null }));
vi.mock('./components/LivePlayable', () => ({ LivePlayable: () => null }));

const BASE = 'https://x.live-video.net/api/video/v1/ch.m3u8';
const onAir = (adType: LiveAdType | undefined, corner?: boolean): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: `${BASE}?token=default`, adInsertion: 'ivs', health: 'HEALTHY',
  highlights: [], job: { jobId: 'job1', gameId: 'gm_1', everyRounds: 1, adSeconds: 30, startedAt: '2026-11-12T03:40:00Z', adType, corner },
  stream: { state: 'live', rounds: 2, breaks: [], updatedAt: '2026-11-12T03:43:00Z' },
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  history.replaceState(null, '', '/#watch=ses_1');
  api.liveViewer.mockResolvedValue({ warmed: false });
  api.liveViewers.mockResolvedValue({ viewers: [] });
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

async function chip(live: LiveState) {
  api.liveStatus.mockResolvedValue(live);
  await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const row = [...container.querySelectorAll('.live-chips > div')].find((d) => d.querySelector('dt')?.textContent === '광고 방식');
  return row?.querySelector('dd')?.textContent;
}

describe("the watch page's 광고 삽입 chip", () => {
  it('says what the broadcast uses', async () => {
    expect(await chip(onAir('corner'))).toBe('코너 트레일러'); // live: "IVS SSAI + MediaTailor"
  });

  it('names each style of the console', () => {
    // the styles by the names the console uses; how each reaches the viewer is the chip's tooltip
    expect(adInsertionText(onAir('trailer'))).toBe('전체 화면 트레일러');
    expect(adInsertionText(onAir(undefined))).toBe('전체 화면 트레일러'); // a job from before the styles: a trailer
    expect(adInsertionText(onAir('trailer', true))).toBe('전체 화면 트레일러 + 코너 트레일러');
    expect(adInsertionText(onAir('playable'))).toBe('플레이어블 광고');
    expect(adInsertionText(onAir('playable', true))).toBe('플레이어블 광고 + 코너 트레일러');
    expect(adInsertionText(onAir('corner', true))).toBe('코너 트레일러');
    expect(adInsertionHow(onAir('trailer', true))).toBe('IVS 서버 측 광고 삽입 (SSAI) + MediaTailor · 코너 트레일러는 플레이어에서 표시');
    expect(adInsertionHow(onAir('playable'))).toBe('GameLift Streams');
    expect(adInsertionHow(onAir('corner'))).toBe('플레이어에서 표시');
    // off air: no broadcast, no style; a channel with no ad insertion set up still says so
    expect(adInsertionText({ ...onAir('corner'), active: false, job: null })).toBe('–');
    expect(adInsertionText({ ...onAir('trailer'), adInsertion: null })).toBe('설정 안 됨');
    expect(adInsertionText(null)).toBe('설정 안 됨');
  });

  // Only a full-screen trailer goes through IVS ad insertion: the player draws a corner trailer and a playable card itself.
  it('a corner or playable broadcast needs no ad insertion on the channel: its style is named', async () => {
    const bare = (adType: LiveAdType, corner?: boolean): LiveState => ({ ...onAir(adType, corner), adInsertion: null });
    expect(adInsertionText(bare('corner'))).toBe('코너 트레일러');
    expect(adInsertionText(bare('playable'))).toBe('플레이어블 광고');
    expect(adInsertionText(bare('playable', true))).toBe('플레이어블 광고 + 코너 트레일러');
    expect(adInsertionHow(bare('playable', true))).toBe('GameLift Streams · 코너 트레일러는 플레이어에서 표시');
    expect(adInsertionHow(bare('corner'))).toBe('플레이어에서 표시');
    // a full-screen trailer has no way to the viewer there, and no service is named as bringing it
    expect(adInsertionText(bare('trailer', true))).toBe('설정 안 됨');
    expect(adInsertionHow(bare('trailer', true))).toBe('');
    expect(adInsertionText({ ...bare('corner'), active: false, job: null })).toBe('설정 안 됨'); // off air: the channel's own word
    expect(await chip(bare('corner'))).toBe('코너 트레일러');
  });
});
