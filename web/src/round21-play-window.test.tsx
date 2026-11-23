// The play window, mounted over a fake API and a stand-in for the broadcast SDK, as play-window.test.tsx does.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState } from './api';
import { PlayWindow } from './components/PlayWindow';
import type { Snapshot } from './types';

const api = vi.hoisted(() => ({
  getSession: vi.fn(), liveStart: vi.fn(), liveStatus: vi.fn(), liveStop: vi.fn(), liveBeat: vi.fn(), liveRound: vi.fn(),
  highlightCreate: vi.fn(), liveRoundEta: vi.fn(), listSessions: vi.fn(),
}));
vi.mock('./api', () => api);
// the broadcast SDK: a client that goes on air at once and sends nothing
vi.mock('amazon-ivs-web-broadcast', () => {
  const ok = async () => undefined;
  return { default: { create: () => ({ on: () => undefined, addVideoInputDevice: ok, addImageSource: ok, addAudioInputDevice: ok, startBroadcast: ok,
    stopBroadcast: () => undefined, removeVideoInputDevice: () => undefined, getVideoInputDevice: () => undefined, delete: () => undefined }) } };
});

const SID = 'ses_f0b01b0d50';
const GID = 'gm_7a41fcae9e';
const job = { jobId: 'job_1', gameId: GID, adTitle: '네온 시티', everyRounds: 2, adSeconds: 16, startedAt: '2026-11-05T14:27:37Z', adType: 'trailer' as const, roundBase: 0 };
const running: LiveState = { active: true, mode: 'player', ingest: { endpoint: 'rtmps://x/app/', streamKey: 'sk_test' }, channelState: 'RUNNING',
  playbackUrl: 'https://x/ch.m3u8', adInsertion: 'ivs', job, stream: { state: 'streaming', rounds: 0, breaks: [], updatedAt: '2026-11-05T14:27:49Z' } };
const idle: LiveState = { active: false, mode: null, ingest: null, channelState: 'IDLE', playbackUrl: '', adInsertion: 'ivs', job: null, stream: null };
const snap = { games: [{ gameId: GID, title: '네온 시티', genre: 'action', specKey: 'k', previewUrl: 'https://cdn/games/gm_7a41fcae9e/index.html', createdAt: '2026-11-05T00:00:00Z' }],
  assets: [{ assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'https://cdn/t.mp4', contentType: 'video/mp4', meta: {}, createdAt: '2026-11-05T00:00:00Z' }],
} as unknown as Snapshot;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  api.getSession.mockResolvedValue(snap);
  api.liveStart.mockResolvedValue({ ...running, channelState: 'STARTING' });
  api.liveStatus.mockResolvedValue(idle);
  api.liveStop.mockResolvedValue(idle);
  api.liveBeat.mockResolvedValue({ ok: true });
  api.liveRound.mockResolvedValue({ cued: false, rounds: 1 });
  api.listSessions.mockResolvedValue({ sessions: [] });
  // the stamp canvas (2D) and the silent audio track: jsdom has neither
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect() {}, fillText() {} } as never);
  vi.stubGlobal('AudioContext', class {
    createMediaStreamDestination() { return { stream: {} }; }
    createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n }; }
    createOscillator() { return { connect: (n: unknown) => n }; }
    close() { return Promise.resolve(); }
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  location.hash = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const toggle = () => container.querySelector<HTMLButtonElement>('.popup-bar .live-toggle')!;
const toasts = () => [...container.querySelectorAll('.toast-text')].map((t) => t.textContent);
const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (text: string) => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === text);
/** The play window, open on its game with the game page's capture surface there. */
async function open() {
  await act(async () => root.render(<PlayWindow sessionId={SID} gameId={GID} />));
  await tick();
  const track = { kind: 'video', readyState: 'live', stop: () => undefined };
  const surface = Object.assign(document.createElement('canvas'), { captureStream: () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) });
  (container.querySelector('iframe')!.contentWindow as Window & { ipverseCapture?: () => HTMLCanvasElement }).ipverseCapture = () => surface;
}
const press = (el: HTMLElement | undefined) => act(async () => { el!.click(); await vi.advanceTimersByTimeAsync(0); });

describe("the play window's own takeover question (new findings 16, 17)", () => {
  const refusal = () => Object.assign(new Error('내 다른 세션에서 방송 중이에요. 그 방송을 먼저 꺼 주세요.'), { name: 'ApiError', status: 409, code: 'live_other_session' });
  function account() {
    api.listSessions.mockResolvedValue({ sessions: [{ sessionId: SID, title: '네온 도시' }, { sessionId: 'ses_other', title: '모래 유적' }]
      .map((s) => ({ ...s, genre: 'sf-shooter', createdAt: '2026-11-05T00:00:00Z' })) });
    api.liveStatus.mockImplementation(async (id: string) => (id === 'ses_other' ? { ...running, job: { ...job, gameId: 'gm_x', adTitle: '사구의 유적: 30초 생존' } } : idle));
  }

  it('취소 is not a failed press: no shake, no 실패, no toast, and the button is at rest with the focus it had', async () => {
    account();
    await open();
    api.liveStart.mockRejectedValueOnce(refusal());
    toggle().focus();
    await press(toggle());
    await tick(500);
    expect(dialog()).not.toBeNull();
    await press(button('취소'));
    expect(dialog()).toBeNull();
    expect(toggle().textContent).toBe('● 라이브 켜기');
    expect(toggle().className).not.toMatch(/is-error|is-done|is-busy/);
    expect(toggle().querySelector('[role="status"]')!.textContent).toBe('');
    expect(document.activeElement).toBe(toggle());
    expect(toasts()).toEqual([]);
    await tick(3000);
    expect(toggle().textContent).toBe('● 라이브 켜기');
    expect(api.liveStart).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.status-pill')!.textContent).toBe('방송 꺼짐');
  });

  it('names the session on air by its title and its game, says its watch page stops, and gives the 45-minute limit', async () => {
    account();
    await open();
    api.liveStart.mockRejectedValueOnce(refusal());
    await press(toggle());
    await tick(500);
    expect(dialog()!.querySelector('.dialog-lead')!.textContent).toBe('‘모래 유적’ 세션에서 ‘사구의 유적: 30초 생존’ 방송 중이에요. '
      + '그 방송을 끄면 보고 있던 시청 창도 멈춰요. 새 방송은 최대 45분 뒤 자동으로 꺼져요. 그 방송을 끄고 이 게임을 방송할까요?');
    await press(button('끄고 방송하기'));
    await tick(2000);
    expect(api.liveStart.mock.calls[1][1]).toMatchObject({ takeover: true });
    expect(container.querySelector('.status-pill')!.textContent).not.toBe('방송 꺼짐');
  });

  it("a playable plan (the console's tab) puts the playable server's price in the question", async () => {
    account();
    vi.stubGlobal('opener', { __ipverseConsole: { settings: () => ({ everyRounds: 3, adType: 'playable', playableSeconds: 60, corner: false }) } });
    await open();
    await tick(1000);
    api.liveStart.mockRejectedValueOnce(refusal());
    await press(toggle());
    await tick(500);
    expect(dialog()!.querySelector('.dialog-lead')!.textContent).toContain('플레이어블 서버가 켜져요 (켜져 있는 동안 시간당 약 $1.51).');
  });
});

// The rounds are the window's own count, but the status of a stopped broadcast has no stream: its ads must not read
// as none.
describe("the bar keeps the last broadcast's ads after 라이브 끄기 (new finding 21)", () => {
  const trailerBreak = (round: number): AdBreak => ({ round, eventId: `t_${round}`, at: '2026-11-05T14:30:00Z', kind: 'trailer', seconds: 16,
    picks: { '': { title: '사구의 유적', creative: 'cr_1', seconds: 16 } } });
  const meta = () => container.querySelector('.popup-bar .popup-meta')!.textContent;
  const withAds = (n: number): LiveState => ({ ...running, stream: { ...running.stream!, rounds: 6, breaks: Array.from({ length: n }, (_, i) => trailerBreak(2 * i + 2)) } });
  async function onAirWithThreeAds() {
    await open();
    expect(meta()).toBe('끝난 판 0 · 광고 0회');
    api.liveStatus.mockResolvedValue(withAds(3));
    await press(toggle());
    await tick(2000);
    const win = container.querySelector('iframe')!.contentWindow as Window & { CustomEvent: typeof CustomEvent };
    await act(async () => { win.dispatchEvent(new win.CustomEvent('ipverse:round', { detail: { rounds: 6 } })); });
    await tick(4000);
    expect(meta()).toBe('끝난 판 6 · 광고 3회');
  }

  it('a status that drops the stream at the stop: the count it last saw stays, named as the last broadcast\'s', async () => {
    await onAirWithThreeAds();
    api.liveStatus.mockResolvedValue(idle);
    await press(toggle()); // ■ 라이브 끄기: the server's answer has no stream
    await tick(4000);
    expect(container.querySelector('.status-pill')!.textContent).toBe('방송 꺼짐');
    expect(meta()).toBe('끝난 판 6 · 지난 방송 광고 3회');
  });

  // (server/live.py _status lastBroadcast: what the session's ended broadcast sent, while it is the channel's last)
  it("the status's own count of the broadcast that ended is the one shown, also in a window opened after the stop", async () => {
    const ended = { ...idle, lastBroadcast: { rounds: 6, ads: 4 } } as LiveState;
    await onAirWithThreeAds();
    api.liveStop.mockResolvedValue(ended);
    api.liveStatus.mockResolvedValue(ended);
    await press(toggle());
    await tick(4000);
    expect(meta()).toBe('끝난 판 6 · 지난 방송 광고 4회');
    await act(async () => root.unmount());
    root = createRoot(container);
    await open();
    await tick(4000);
    expect(meta()).toBe('끝난 판 0 · 지난 방송 광고 4회');
  });

  it('the next broadcast counts its own from its start', async () => {
    await onAirWithThreeAds();
    api.liveStatus.mockResolvedValue(idle);
    await press(toggle());
    await tick(4000);
    api.liveStatus.mockResolvedValue(running);
    await press(toggle()); // ● 라이브 켜기 again
    await tick(4000);
    expect(meta()).toBe('끝난 판 6 · 광고 0회');
  });

  // (a broadcast that ends before its first status has no stream of its own: the count kept is never an older one's)
  it('a next broadcast that ended before it had a count leaves none of the one before it', async () => {
    await onAirWithThreeAds();
    api.liveStatus.mockResolvedValue(idle);
    await press(toggle());
    await tick(4000);
    api.liveStart.mockResolvedValueOnce({ ...running, channelState: 'STARTING', stream: null });
    api.liveStatus.mockResolvedValue({ ...running, stream: null });
    await press(toggle()); // ● 라이브 켜기 again
    await tick(4000);
    api.liveStatus.mockResolvedValue(idle);
    await press(toggle()); // ■ 라이브 끄기 before a status of its own
    await tick(4000);
    expect(container.querySelector('.status-pill')!.textContent).toBe('방송 꺼짐');
    expect(meta()).toBe('끝난 판 6 · 광고 0회');
  });
});
