import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, StandbyState } from './api';
import { GameModal, consoleAd } from './components/GameModal';
import type { Asset, Game } from './types';

// The mirror is the play window's picture and the 라이브 방송 tab's player draws stitched ads only: a corner trailer
// and a playable card are drawn by the watch page's tiles from timed metadata, so the console shows them itself.
const api = vi.hoisted(() => ({
  liveStatus: vi.fn(), liveStandby: vi.fn(), setLiveStandby: vi.fn(), liveAdSettings: vi.fn(),
  highlightSettings: vi.fn(), liveStop: vi.fn(), liveViewer: vi.fn(), liveAdEvent: vi.fn(async () => ({})), liveToken: vi.fn(),
}));
vi.mock('./api', () => api);
const player = vi.hoisted(() => ({ onMetadata: null as null | ((text: string) => void) }));
vi.mock('./components/IvsPlayer', () => ({
  IvsPlayer: (p: { onMetadata?: (text: string) => void }) => { player.onMetadata = p.onMetadata ?? null; return null; },
}));

const game = { gameId: 'gm_1', title: '용광로 심장부', genre: 'sf-shooter', specKey: 'k', previewUrl: 'blob:game', createdAt: '2026-11-05T00:00:00Z' } as Game;
const trailer = { assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'https://cdn/t.mp4', contentType: 'video/mp4', meta: {}, createdAt: '2026-11-05T00:00:00Z' } as Asset;
const off: StandbyState = { on: false, state: 'off', idle: 0, allocated: 0, max: 2, mode: 'auto', hourlyUsd: 0.52 };
const corner = (at: string): AdBreak => ({ round: 2, eventId: 'c_f68651ae4e', at, kind: 'corner', seconds: 12, wait: 61,
  picks: { '': { title: '사구의 유적', creative: 'cr_1', seconds: 15.67, url: 'https://cdn/corner.mp4', gameUrl: 'https://cdn/g/' } } });
const onAir = (breaks: AdBreak[]): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: 'https://ivs/x.m3u8',
  job: { gameId: 'gm_1', everyRounds: 2, adSeconds: 15.67, startedAt: '2026-11-12T07:44:23Z', adType: 'corner' },
  stream: { state: 'streaming', rounds: 2, breaks, updatedAt: '2026-11-12T07:45:44Z' } } as LiveState);

describe('what the console says about an ad that just went out', () => {
  const now = Date.parse('2026-11-12T07:45:50Z');
  it('names the ad for 20 s after its break, by style', () => {
    expect(consoleAd([corner('2026-11-12T07:45:45Z')], now)).toBe('코너 트레일러 · 사구의 유적');
    expect(consoleAd([{ ...corner('2026-11-12T07:45:45Z'), kind: 'trailer' }], now)).toBe('전체 화면 트레일러 · 사구의 유적');
    expect(consoleAd([{ ...corner('2026-11-12T07:45:45Z'), kind: 'trailer', playable: true } as AdBreak], now)).toBe('플레이어블 광고 · 사구의 유적');
  });
  it('says nothing for an old break, a skipped one or one that never aired', () => {
    expect(consoleAd([corner('2026-11-12T07:45:20Z')], now)).toBeNull();
    expect(consoleAd([{ ...corner('2026-11-12T07:45:45Z'), kind: 'skip' }], now)).toBeNull();
    expect(consoleAd([{ ...corner('2026-11-12T07:45:45Z'), kind: 'trailer', lost: true }], now)).toBeNull();
    expect(consoleAd([], now)).toBeNull();
  });
});

describe('the console shows the ad the viewers get', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    history.replaceState(null, '', '/');
    api.liveStandby.mockResolvedValue(off);
    api.setLiveStandby.mockResolvedValue(off);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () => root.render(<GameModal sessionId="ses_1" game={game} url="blob:game" assets={[trailer]}
      onClose={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />));
    await act(async () => undefined);
  }

  it('on the 플레이 화면 tab, with no cue from the stream: the banner names the ad and the corner trailer is drawn', async () => {
    api.liveStatus.mockResolvedValue(onAir([corner(new Date().toISOString())]));
    await render();
    const banner = container.querySelector('.console-ad')!;
    expect(banner.textContent).toContain('광고 송출 · 코너 트레일러 · 사구의 유적');
    const ad = container.querySelector('.corner-ad')!;
    expect(ad.getAttribute('aria-label')).toBe('코너 광고: 사구의 유적');
    expect(ad.querySelector('video')!.getAttribute('src')).toBe('https://cdn/corner.mp4');
    // the click switches tabs after the cue's frame has passed: the corner is still drawn
    await act(async () => banner.querySelector('button')!.click());
    expect(container.querySelector('#game-view-live')!.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.corner-ad')).not.toBeNull();
  });

  it('a full-screen trailer plays as a preview over the mirror, and a playable break shows its card', async () => {
    api.liveStatus.mockResolvedValue(onAir([{ ...corner(new Date().toISOString()), kind: 'trailer' }]));
    await render();
    expect(container.querySelector('.console-trailer video')!.getAttribute('src')).toBe('https://cdn/corner.mp4');
    expect(container.querySelector('.corner-ad')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.console-trailer button')!.click());
    expect(container.querySelector('.console-trailer')).toBeNull();
    expect(container.querySelector('.console-ad')).toBeNull();
  });

  it('an old break draws nothing', async () => {
    api.liveStatus.mockResolvedValue(onAir([corner('2026-11-12T07:45:45Z')]));
    await render();
    expect(container.querySelector('.console-ad')).toBeNull();
    expect(container.querySelector('.corner-ad')).toBeNull();
  });
});
