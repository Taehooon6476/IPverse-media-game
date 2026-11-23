import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from './api';
import { PlayWindow } from './components/PlayWindow';
import type { Snapshot } from './types';

const api = vi.hoisted(() => ({
  getSession: vi.fn(), liveStart: vi.fn(), liveStatus: vi.fn(), liveStop: vi.fn(), liveBeat: vi.fn(), liveRound: vi.fn(),
  highlightCreate: vi.fn(), liveRoundEta: vi.fn(),
}));
vi.mock('./api', () => api);

type Picture = { width: number; height: number; reason: string; bytes: number };
/** The IVS Web Broadcast client stand-in. Its WebRTC sender reports `picture(t)` (t = seconds since on air) under its
 * own cap (setParameters maxBitrate): a bitrate under what the picture needs steps the size down to the 320x180 floor,
 * "bandwidth"-limited. startBroadcast makes a new peer connection (in `peers`); stopBroadcast closes the current one.
 * `channel` is IVS's side: a published connection is a new stream session (start time in `sessions`); a stopped one's
 * session ends 6 s later, and a connection published before that end loses its session with it and gets one more 2 s
 * later. `mixer` is the SDK's: each video input plays in the SDK's own <video>, drawn into the canvas the connection
 * encodes; freeze() is a frozen page, which pauses those elements until something plays them. */
const ivs = vi.hoisted(() => {
  const channel = { sessions: [] as number[], live: false, publishing: false };
  type Sender = { track: { kind: string }; getParameters: () => RTCRtpSendParameters;
    setParameters: (p: RTCRtpSendParameters) => Promise<void> };
  type Peer = { closed: boolean; getStats: () => Promise<unknown>; getSenders: () => Sender[]; sender: Sender };
  type Input = { source: { getVideoTracks?: () => { stop: () => void }[] }; paused: boolean;
    element: HTMLVideoElement & { play: ReturnType<typeof vi.fn> } };
  const mixer = new Map<string, Input>();
  const s = {
    onAirAt: 0,
    picture: (_t: number): Picture => ({ width: 1280, height: 720, reason: 'none', bytes: 575_000 }),
    hold: false, // the next start stays pending until release()
    release: () => {},
    channel,
    peers: [] as Peer[],
    mixer,
    freeze: () => mixer.forEach((input) => { input.paused = true; }),
  };
  const publish = () => { channel.publishing = true; channel.live = true; channel.sessions.push(Date.now()); };
  const peerClient: { peerConnection: Peer | null } = { peerConnection: null };
  const steps = [[960, 540], [640, 360], [480, 270], [320, 180]];
  const peer = () => {
    let bytes = 0;
    let encoding: RTCRtpEncodingParameters = { active: true };
    let cappedAt = 0;
    const sender: Sender = {
      track: { kind: 'video' },
      getParameters: () => ({ transactionId: `t${s.peers.length}`, encodings: [{ ...encoding }] }) as unknown as RTCRtpSendParameters,
      setParameters: vi.fn(async (p: RTCRtpSendParameters) => { encoding = { ...p.encodings[0] }; cappedAt = Date.now(); }),
    };
    const pc: Peer = {
      closed: false,
      sender,
      getSenders: () => [{ track: { kind: 'audio' } } as Sender, sender],
      getStats: async () => {
        if (pc.closed) throw new Error('InvalidStateError');
        let p = s.picture((Date.now() - s.onAirAt) / 1000);
        const cap = encoding.maxBitrate ? encoding.maxBitrate / 4 : Infinity; // bytes in a 2 s read
        if (cap < p.bytes) {
          const [width, height] = steps[Math.min(steps.length - 1, Math.floor((Date.now() - cappedAt) / 4000))];
          p = { width, height, reason: 'bandwidth', bytes: cap };
        }
        bytes += p.bytes;
        return new Map([['OT01V', { type: 'outbound-rtp', kind: 'video', timestamp: Date.now(), bytesSent: bytes,
          frameWidth: p.width, frameHeight: p.height, framesPerSecond: 24, qualityLimitationReason: p.reason }],
          ['CP01', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: p.bytes * 4 }]]);
      },
    };
    s.peers.push(pc);
    return pc;
  };
  const client = {
    peerClient,
    on: vi.fn(), addImageSource: vi.fn(async () => {}),
    // as the SDK's: one input a name, a new <video> for each; removing one stops its stream's video track
    addVideoInputDevice: vi.fn(async (source: Input['source'], name: string) => {
      if (mixer.has(name)) throw new Error(`a video input named ${name} exists`);
      const input = { source, paused: false } as Input;
      input.element = Object.defineProperties(document.createElement('video'), {
        paused: { get: () => input.paused },
        play: { value: vi.fn(async () => { input.paused = false; }) },
      }) as Input['element'];
      mixer.set(name, input);
    }),
    getVideoInputDevice: vi.fn((name: string) => (mixer.has(name) ? { name, element: mixer.get(name)!.element } : undefined)),
    removeVideoInputDevice: vi.fn((name: string) => {
      const input = mixer.get(name);
      if (!input) throw new Error(`no video input named ${name}`);
      mixer.delete(name);
      input.source.getVideoTracks?.().forEach((t) => t.stop());
    }),
    addAudioInputDevice: vi.fn(async () => {}), delete: vi.fn(),
    startBroadcast: vi.fn((_key: string) => {
      peerClient.peerConnection = peer();
      if (s.hold) return new Promise<void>((r) => { s.release = () => { publish(); r(); }; });
      publish();
      return Promise.resolve();
    }),
    stopBroadcast: vi.fn(() => {
      if (peerClient.peerConnection) peerClient.peerConnection.closed = true;
      if (!channel.publishing) return;
      channel.publishing = false;
      setTimeout(() => {
        channel.live = false;
        if (channel.publishing) setTimeout(publish, 2000);
      }, 6000);
    }),
  };
  return Object.assign(s, { client }); // the test sets s's fields: the fakes above read them
});
vi.mock('amazon-ivs-web-broadcast', () => ({ default: { create: () => { ivs.mixer.clear(); return ivs.client; } } }));
/** canvas.captureStream stand-in: a new stream with its own video track on every call */
const captureOf = () => {
  const track = { kind: 'video', readyState: 'live', stop: vi.fn(() => { track.readyState = 'ended'; }) };
  return { getTracks: () => [track], getVideoTracks: () => [track] };
};

const HD: Picture = { width: 1280, height: 720, reason: 'none', bytes: 575_000 }; // 2.3 Mbps
const FLOOR: Picture = { width: 320, height: 180, reason: 'bandwidth', bytes: 7_500 }; // a collapsed send, 0.03 Mbps

const job = { gameId: 'gm_7a41fcae9e', everyRounds: 1, adSeconds: 35, startedAt: '2026-11-05T14:27:37Z', adType: 'trailer' as const,
  highlightGen: false };
const ingest = { endpoint: 'rtmps://x.global-contribute.live-video.net:443/app/', streamKey: 'sk_us-west-2_test' };
const running: LiveState = { active: true, mode: 'player', ingest, channelState: 'RUNNING', playbackUrl: 'https://x/ch.m3u8',
  adInsertion: 'ivs', health: 'HEALTHY', job, stream: { state: 'streaming', rounds: 1, breaks: [], updatedAt: '2026-11-05T14:27:49Z' } };
const snap = { games: [{ gameId: 'gm_7a41fcae9e', title: '네온 시티', genre: 'action', specKey: 'k', previewUrl: 'https://cdn/games/gm_7a41fcae9e/index.html',
  createdAt: '2026-11-05T00:00:00Z' }],
  assets: [{ assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'https://cdn/t.mp4', contentType: 'video/mp4', meta: {}, createdAt: '2026-11-05T00:00:00Z' }],
} as unknown as Snapshot;

/** GET /live: the job `over` running, its channel RUNNING while IVS has a live stream session (server/live.py asks
 * GetStream), else STARTING. */
const status = (over: Partial<LiveState> = {}) =>
  api.liveStatus.mockImplementation(async () => ({ ...running, ...over, channelState: ivs.channel.live ? 'RUNNING' : 'STARTING' }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  ivs.hold = false;
  ivs.peers = [];
  ivs.mixer.clear();
  Object.assign(ivs.channel, { sessions: [], live: false, publishing: false });
  ivs.picture = (t) => (t < 30 ? HD : FLOOR);
  api.getSession.mockResolvedValue(snap);
  api.liveStart.mockResolvedValue({ ...running, channelState: 'STARTING' });
  status();
  api.liveBeat.mockResolvedValue({ ok: true });
  // DELETE /live: off air (a window unmounted on air ends its broadcast, as one that closes does)
  api.liveStop.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null });
  api.liveRound.mockResolvedValue({ cued: false, rounds: 2 });
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

/** Fake time in 2 s steps, each its own act(): every send sample renders, as in a browser (one act() would batch them). */
const wait = async (ms: number) => {
  for (let left = ms; left > 0 || ms === 0; left -= 2000) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(2000, Math.max(0, left))); });
    if (ms === 0) break;
  }
};
const pill = () => container.querySelector('.status-pill')!.textContent;
/** The stage's send diagnostics (data-send-diag, read by the E2E monitor) */
const diag = () => JSON.parse(container.querySelector('.popup-stage')!.getAttribute('data-send-diag') ?? 'null');
const toasts = () => [...container.querySelectorAll('.toast-text')].map((t) => t.textContent);
const game = () => container.querySelector('iframe')!.contentWindow as Window & { ipverseCapture?: () => HTMLCanvasElement };
/** Opens the play window and goes on air (the game page's capture surface, then 방송 시작). → the surface */
async function onAir() {
  await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
  await wait(0);
  const surface = Object.assign(document.createElement('canvas'), { captureStream: vi.fn(captureOf) });
  game().ipverseCapture = () => surface;
  const w = window as unknown as { __ipverse: { start: (n?: number, adType?: string) => Promise<void> } };
  ivs.onAirAt = Date.now(); // the start takes no (fake) time
  await act(async () => { await w.__ipverse.start(1, 'trailer'); });
  await wait(0);
  return surface;
}
const round = (n: number) => act(async () => {
  const win = game() as Window & { CustomEvent: typeof CustomEvent };
  win.dispatchEvent(new win.CustomEvent('ipverse:round', { detail: { rounds: n } }));
});

describe('the play window restarts a send stuck at the WebRTC floor (E2E D24: 320x180 for 27 min)', () => {
  it('a minute at 320x180 restarts the IVS connection once, with the same stream; the pill says so; not again within 5 min', async () => {
    await onAir();
    expect(ivs.client.startBroadcast.mock.calls).toEqual([[ingest.streamKey]]);
    await wait(88_000); // 720p for 30 s, then the floor: flagged at once, a minute at it at 90 s
    expect(pill()).toBe('● 방송 중 · 화질 저하 320×180');
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();

    ivs.hold = true; // the new connection takes a moment
    await wait(4_000);
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
    expect(ivs.client.startBroadcast).toHaveBeenCalledTimes(1); // not yet: IVS is still ending the old stream session
    expect(pill()).toBe('● 방송 다시 연결 중 · 화질 회복 시도');
    expect(toasts().at(-1)).toContain('320×180');
    await wait(6_000); // the old session is over (6 s after the stop): the new connection
    expect(ivs.client.startBroadcast.mock.calls).toEqual([[ingest.streamKey], [ingest.streamKey]]); // the same client and stream
    expect(pill()).toBe('● 방송 다시 연결 중 · 화질 회복 시도');

    ivs.hold = false;
    await act(async () => ivs.release());
    await wait(4_000);
    expect(pill()).toBe('● 방송 중 · 화질 저하 320×180'); // the new connection is still at the floor: still said
    expect(toasts().filter((t) => t?.includes('돌아왔어요'))).toEqual([]); // its ramp-up is not a recovery

    await wait(4 * 60_000); // still at the floor, but a restart a few minutes ago: no loop
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
  });

  it('never while a round report is in flight, nor until a status poll after it can show its cue', async () => {
    await onAir();
    let reported: (r: { cued: boolean; rounds: number }) => void = () => {};
    api.liveRound.mockImplementationOnce(() => new Promise((r) => { reported = r; }));
    await wait(80_000);
    await round(2); // its report is slow
    await wait(30_000); // 110 s: a minute at the floor long ago
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();
    await act(async () => reported({ cued: false, rounds: 2 }));
    await wait(8_000);
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();
    await wait(4_000);
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
  });

  it('never while the ad break a round cued is on its way to the viewers: after it', async () => {
    await onAir();
    await wait(80_000);
    // the round cued a trailer: IVS places the break 11 s later, 35 s long; the VAST is the break's until 15 s after it
    const now = Date.now();
    api.liveRound.mockResolvedValueOnce({ cued: true, rounds: 2 });
    status({
      job: { ...job, breakUntil: now / 1000 + 61 } as LiveState['job'],
      stream: { ...running.stream!, rounds: 2, breaks: [{ round: 2, eventId: 'ZBUXlwPRD2xx', at: new Date(now + 11_000).toISOString(), seconds: 35, kind: 'trailer' }] } });
    await round(2);
    await wait(58_000); // 138 s: the break holds the VAST file (until 11 + 35 + 15 s after the cue)
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();
    await wait(4_000);
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain('2판 종료 · 전체 화면 트레일러가 약 10초 뒤 시작돼요');
  });

  it('an overlay highlight, a playable card or a trailer cue still waiting is no IVS ad break: no hold (E2E reverify7: 151 s)', async () => {
    await onAir();
    await wait(50_000);
    const now = Date.now();
    // timed metadata only (the watch window draws them); the trailer cue waits for MediaTailor, a status poll sends it later
    status({ job: { ...job, pendingCue: { at: now / 1000, round: 3 } } as LiveState['job'],
      stream: { ...running.stream!, rounds: 3, breaks: [
        { round: 2, eventId: 'p1', at: new Date(now).toISOString(), seconds: 90, kind: 'playable', playable: true },
        { round: 3, eventId: 'o1', at: new Date(now + 2_000).toISOString(), seconds: 5, kind: 'overlay', title: '문 앞 도착!' }] } });
    await wait(42_000); // 92 s: a minute at the floor (from 30 s), the report settled long ago
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
  });

  it('one restart makes one new IVS stream session: it publishes once IVS has ended the old one (E2E R7: two, 4-6 s apart)', async () => {
    await onAir();
    expect(ivs.channel.sessions).toHaveLength(1);
    await wait(88_000);
    const pills: string[] = [];
    const step = async () => { await wait(2_000); pills.push(pill()!); };
    await step(); // 90 s: a minute at the floor
    await step();
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
    let reportedAt = 0;
    api.liveRound.mockImplementationOnce(async () => { reportedAt = Date.now(); return { cued: false, rounds: 2 }; });
    await round(2); // a round ends in the restart: its cue would be lost in the gap
    for (let s = 0; s < 36; s += 2) await step();
    expect(ivs.client.startBroadcast).toHaveBeenCalledTimes(2); // the first start and the restart's: no other
    expect(ivs.channel.sessions).toHaveLength(2); // one new session: viewers blink once
    expect(ivs.channel.live).toBe(true);
    expect(reportedAt).toBeGreaterThanOrEqual(ivs.channel.sessions[1]); // reported once IVS is live again
    // the pill tells the restart until IVS is live again, then the send (the new connection is still at the floor)
    expect(pills).toContain('● 방송 다시 연결 중 · 화질 회복 시도');
    expect(pills).not.toContain('방송 연결 중…');
    expect(pills.at(-1)).toBe('● 방송 중 · 화질 저하 320×180');
  });

  it('a round\'s highlight records and uploads nothing: the window tells the server the round, which cuts it from the IVS recording (E2E reverify7 B4)', async () => {
    status({ job: { ...job, highlightGen: true } });
    const recorder = vi.fn();
    vi.stubGlobal('MediaRecorder', Object.assign(class { constructor() { recorder(); } }, { isTypeSupported: () => true }));
    const put = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', put);
    api.highlightCreate.mockResolvedValue({ id: 'hl_1', state: 'analyzing' });
    await onAir();
    await wait(4_000);
    const startedAt = Date.now();
    await act(async () => {
      const win = game() as Window & { CustomEvent: typeof CustomEvent };
      win.dispatchEvent(new win.CustomEvent('ipverse:roundstart', { detail: { rounds: 1 } }));
    });
    await wait(20_000);
    const endedAt = Date.now();
    await round(2);
    await wait(0);
    expect(api.highlightCreate).toHaveBeenCalledWith('ses_f0b01b0d50', { round: 2, startedAt, endedAt, sentAt: endedAt });
    expect(recorder).not.toHaveBeenCalled(); // no second encoder of the canvas
    expect(put).not.toHaveBeenCalled(); // and no clip on the broadcast's uplink
    expect(toasts()).toContain('2판 하이라이트 쇼츠를 만드는 중이에요 (명장면을 골라 자르는 중)');
    // the next round starts where this one ended when the game sends no ipverse:roundstart (older runtimes)
    await wait(30_000);
    await round(3);
    await wait(0);
    expect(api.highlightCreate).toHaveBeenLastCalledWith('ses_f0b01b0d50', expect.objectContaining({ round: 3, startedAt: endedAt }));
    expect(diag()).toMatchObject({ restarts: 0 });
    expect(diag()).not.toHaveProperty('up');
  });

  it('no highlight request while generation is off', async () => {
    await onAir();
    await wait(10_000);
    await round(2);
    await wait(0);
    expect(api.highlightCreate).not.toHaveBeenCalled();
  });

  it('a CPU-limited send is never restarted (a new connection would not help)', async () => {
    ivs.picture = (t) => (t < 30 ? HD : { ...FLOOR, reason: 'cpu' });
    await onAir();
    await wait(10 * 60_000);
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();
    expect(pill()).toBe('● 방송 중 · 화질 저하 320×180');
  });
});

describe('the play window restarts a send starved one step above the floor too (E2E N2: 9 min at 480x270, 0.03 Mbps)', () => {
  const N2: Picture = { width: 480, height: 270, reason: 'bandwidth', bytes: 7_500 }; // 0.03 Mbps
  const BITS: Picture = { width: 960, height: 540, reason: 'bandwidth', bytes: 7_500 }; // a good size starved of bits

  it('90 s starved restarts the IVS connection once, with the floor restart\'s pill and backoff: no loop', async () => {
    // 720p, then 480x270 at 0.03 Mbps with a 960x540 stretch at the same bitrate (still starved), on every connection
    ivs.picture = (t) => (t < 30 ? HD : t >= 60 && t < 80 ? BITS : N2);
    await onAir();
    await wait(118_000); // 88 s starved
    expect(pill()).toBe('● 방송 중 · 화질 저하 480×270');
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled(); // never at the floor: the floor restart alone left it there
    await wait(2_000);
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
    expect(pill()).toBe('● 방송 다시 연결 중 · 화질 회복 시도');
    expect(toasts().at(-1)).toBe('송출 화질이 1분 30초 넘게 480×270에 머물러 방송을 다시 연결해요. 시청 창이 잠깐 멈출 수 있어요.');
    await wait(20_000);
    expect(ivs.client.startBroadcast.mock.calls).toEqual([[ingest.streamKey], [ingest.streamKey]]);
    expect(ivs.channel.sessions).toHaveLength(2); // one new IVS stream session
    expect(pill()).toBe('● 방송 중 · 화질 저하 480×270'); // the new connection is starved as well

    ivs.picture = () => BITS; // starved of bits at 960x540 from here
    await wait(4 * 60_000); // still starved, but a restart under 5 minutes ago: no loop
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
    await wait(40_000); // 5 minutes after the first restart: the second
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(2);
    expect(toasts()).toContain('송출 화질이 1분 30초 넘게 0.03 Mbps에 머물러 방송을 다시 연결해요. 시청 창이 잠깐 멈출 수 있어요.');
    ivs.picture = () => FLOOR; // then at the floor: its rule's toast, the same backoff
    await wait(5 * 60_000);
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(3);
    expect(toasts()).toContain('송출 화질이 1분 넘게 320×180에 머물러 방송을 다시 연결해요. 시청 창이 잠깐 멈출 수 있어요.');
    await wait(3600_000 - 720_000 - 30_000); // ~59 min on air (restarts at 2, 7, 12, 17, 22, 27 min): 6 an hour
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(6);
    await wait(180_000); // 62.5 min: the first one (2 min) is an hour old, the budget comes back
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(7);
    expect(ivs.channel.sessions).toHaveLength(8); // one new IVS stream session each
  }, 60_000); // an hour of 2 s samples

  it('a starved send that climbs back by itself is left alone (E2E round 3: 54 s starved, 32 s of it at the floor)', async () => {
    // 2 s apart from 30 s, all bandwidth-limited: 960x540 at 0.04 Mbps down to 320x180, back up to 640x360 at 0.89 Mbps
    const mbps = [0.04, 0.07, 0.05, 0.08, 0.07, 0.07, 0.07, 0.07, 0.09, 0.08, 0.03, 0.06, 0.08, 0.12, 0.08, 0.10, 0.14, 0.18, 0.17,
      0.18, 0.25, 0.31, 0.33, 0.43, 0.48, 0.59, 0.60, 0.73];
    const size = (i: number) => (i < 3 ? [960, 540] : i < 5 ? [640, 360] : i < 8 || i > 24 ? [480, 270] : [320, 180]);
    ivs.picture = (t) => {
      const i = (t - 30) / 2;
      return t < 30 || i >= mbps.length ? HD : { width: size(i)[0], height: size(i)[1], reason: 'bandwidth', bytes: mbps[i] * 250_000 };
    };
    await onAir();
    await wait(60_000);
    expect(pill()).toBe('● 방송 중 · 화질 저하 320×180');
    await wait(3 * 60_000);
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toBe('송출 화질이 돌아왔어요.');
  });
});

describe('a frozen page\'s still picture: the game input plays again (E2E N2, N12)', () => {
  // A frozen play tab pauses the SDK's <video>: the broadcast stays on one still frame (480x270 at 0.03 Mbps,
  // "bandwidth") on the old connection and on each restarted one; only a new capture input brings 720p back.
  const STILL: Picture = { width: 480, height: 270, reason: 'bandwidth', bytes: 7_500 }; // 0.03 Mbps
  beforeEach(() => { ivs.picture = () => (ivs.mixer.get('game')?.paused ? STILL : HD); }); // what the SDK's canvas shows
  /** The play tab frozen 40 s: hidden, the SDK's <video> paused; then shown again (`resume`: the page's resume event). */
  async function freeze40(resume: boolean) {
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    ivs.freeze();
    await wait(40_000);
    expect(pill()).toBe('● 방송 중 · 게임 화면 멈춤');
    if (resume) await act(async () => { document.dispatchEvent(new Event('resume')); });
    hidden.mockRestore();
  }

  it('the page\'s resume event plays the SDK\'s paused game element again: the send climbs back by itself, no restart', async () => {
    await onAir();
    await wait(30_000);
    await freeze40(true);
    await wait(10_000);
    expect(ivs.mixer.get('game')!.element.play).toHaveBeenCalledTimes(1);
    expect(pill()).toBe('● 방송 중');
    expect(toasts().at(-1)).toBe('송출 화질이 돌아왔어요.');
    await wait(5 * 60_000);
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();
    expect(ivs.channel.sessions).toHaveLength(1);
  });

  it('a restart swaps a still-paused game input for a new capture while IVS is offline: the send climbs back, one restart', async () => {
    const surface = await onAir();
    const first = surface.captureStream.mock.results[0].value;
    expect(ivs.client.addVideoInputDevice.mock.calls).toEqual([[first, 'game', { index: 0 }]]);
    await wait(30_000);
    await freeze40(false); // whatever kept the input paused, the restart replaces it
    await wait(10_000);
    expect(pill()).toBe('● 방송 중 · 화질 저하 480×270');

    const pills: string[] = [];
    for (let s = 0; s < 120; s += 2) { await wait(2_000); pills.push(pill()!); }
    // 90 s starved: the restart, one new IVS session, its pill until IVS is live, then the send climbs back
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain('송출 화질이 1분 30초 넘게 480×270에 머물러 방송을 다시 연결해요. 시청 창이 잠깐 멈출 수 있어요.');
    expect(ivs.channel.sessions).toHaveLength(2);
    expect(pills).toContain('● 방송 다시 연결 중 · 화질 회복 시도');
    expect(pills).not.toContain('방송 연결 중…');
    expect(pills.at(-1)).toBe('● 방송 중');
    expect(toasts().at(-1)).toBe('송출 화질이 돌아왔어요.');
    // the restart gave the SDK a new capture of the same surface as its 'game' input, once the old session was over
    expect(surface.captureStream).toHaveBeenCalledTimes(2);
    const second = surface.captureStream.mock.results[1].value;
    expect(ivs.client.removeVideoInputDevice.mock.calls).toEqual([['game']]);
    expect(ivs.client.addVideoInputDevice.mock.calls[1]).toEqual([second, 'game', { index: 0 }]);
    expect(first.getVideoTracks()[0].stop).toHaveBeenCalled(); // the old capture ends
    expect(second.getVideoTracks()[0].stop).not.toHaveBeenCalled();
    const order = (f: { mock: { invocationCallOrder: number[] } }, i: number) => f.mock.invocationCallOrder[i];
    expect(order(ivs.client.removeVideoInputDevice, 0)).toBeGreaterThan(order(ivs.client.stopBroadcast, 0));
    expect(order(ivs.client.addVideoInputDevice, 1)).toBeLessThan(order(ivs.client.startBroadcast, 1));
    expect(ivs.client.startBroadcast.mock.calls).toEqual([[ingest.streamKey], [ingest.streamKey]]); // the same client and stream
    await wait(10 * 60_000);
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1); // no second restart
    expect(ivs.channel.sessions).toHaveLength(2);
  });
});

describe('the floor test switch (#play=…&demo=1&floortest=1) holds the send at the floor for real (E2E R7 re-verification)', () => {
  const hash = '#play=ses_f0b01b0d50&g=gm_7a41fcae9e';

  it('caps the connection at 0.03 Mbps until the floor restart: one new IVS session, the pill through the gap, the new connection free', async () => {
    location.hash = `${hash}&demo=1&floortest=1`;
    ivs.picture = () => HD; // a healthy link: only the switch holds the send down
    await onAir();
    await wait(2_000);
    expect(ivs.peers[0].sender.setParameters).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 30_000 })] }));
    expect(container.querySelector('.popup-stage')!.getAttribute('data-send')).toBe('960×540 · 0.03 Mbps · 24fps');
    await wait(68_000); // the encoder reached the floor at 12 s
    expect(pill()).toBe('● 방송 중 · 화질 저하 320×180');
    expect(container.querySelector('.popup-stage')!.getAttribute('data-send')).toBe('320×180 · 0.03 Mbps · 24fps');
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();

    const pills: string[] = [];
    for (let s = 0; s < 30; s += 2) { await wait(2_000); pills.push(pill()!); }
    // a minute at the floor (from 12 s): the restart, as a real floor makes it
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain('송출 화질이 1분 넘게 320×180에 머물러 방송을 다시 연결해요. 시청 창이 잠깐 멈출 수 있어요.');
    expect(ivs.client.startBroadcast.mock.calls).toEqual([[ingest.streamKey], [ingest.streamKey]]);
    expect(ivs.channel.sessions).toHaveLength(2); // one new stream session for the restart
    expect(pills).toContain('● 방송 다시 연결 중 · 화질 회복 시도');
    expect(pills).not.toContain('방송 연결 중…');
    // the restart's connection is left free, as a stuck estimate's new connection is
    expect(ivs.peers).toHaveLength(2);
    expect(ivs.peers[1].sender.setParameters).not.toHaveBeenCalled();
    expect(container.querySelector('.popup-stage')!.getAttribute('data-send')).toBe('1280×720 · 2.3 Mbps · 24fps');
    expect(pills.at(-1)).toBe('● 방송 중');
    expect(toasts().at(-1)).toBe('송출 화질이 돌아왔어요.');
    await wait(10 * 60_000);
    expect(ivs.client.stopBroadcast).toHaveBeenCalledTimes(1);
  });

  it('is off by default and anywhere but the demo window', async () => {
    location.hash = `${hash}&floortest=1`; // not a demo window
    ivs.picture = () => HD;
    await onAir();
    await wait(3 * 60_000);
    expect(ivs.peers[0].sender.setParameters).not.toHaveBeenCalled();
    expect(pill()).toBe('● 방송 중');
    expect(ivs.client.stopBroadcast).not.toHaveBeenCalled();
  });
});

describe('the pill never puts a good size under "화질 저하" (E2E R8: "화질 저하 960×540" as the drop cleared)', () => {
  it('a drop that clears says "화질 회복 중" over the good samples it needs; a starved or hidden send names what is wrong', async () => {
    const CPU: Picture = { width: 480, height: 270, reason: 'cpu', bytes: 50_000 };
    const QHD: Picture = { width: 960, height: 540, reason: 'none', bytes: 575_000 };
    ivs.picture = (t) => (t < 30 ? HD : t < 50 ? CPU : QHD);
    await onAir();
    await wait(48_000);
    expect(pill()).toBe('● 방송 중 · 화질 저하 480×270');
    const pills: string[] = [];
    for (let s = 0; s < 8; s += 2) {
      await wait(2_000);
      pills.push(pill()!);
    }
    // three good samples in a row clear the drop: until then the latest one is good, the drop is not over
    expect(pills.filter((p) => p.includes('960×540'))).toEqual([]);
    expect(pills).toContain('● 방송 중 · 화질 회복 중');
    expect(pills.at(-1)).toBe('● 방송 중');
    expect(toasts().at(-1)).toBe('송출 화질이 돌아왔어요.');

    // starved at 960x540 (0.05 Mbps, bandwidth-limited): the low figure is the bitrate, not the size
    ivs.picture = () => ({ ...QHD, reason: 'bandwidth', bytes: 12_500 });
    await wait(8_000);
    expect(pill()).toBe('● 방송 중 · 화질 저하 0.05 Mbps');
    // the play window hidden: the game stops drawing, whatever size the encoder last sent
    ivs.picture = () => QHD;
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await wait(8_000);
    expect(pill()).toBe('● 방송 중 · 게임 화면 멈춤');
    hidden.mockRestore();
  });
});

describe('player mode on air: the play window says when the game waits at its briefing (E2E A1: no round ended, no ad)', () => {
  const briefing = () => {
    const doc = container.querySelector('iframe')!.contentDocument!;
    const el = Object.assign(doc.createElement('section'), { className: 'briefing' });
    (doc.body ?? doc.documentElement ?? doc.appendChild(doc.createElement('html'))).append(el); // jsdom loads no page
    return el;
  };
  const notice = () => container.querySelector('.popup-wait')?.textContent ?? null;

  it('names 임무 시작 while the briefing shows, and drops it once the round has started', async () => {
    location.hash = '#play=ses_f0b01b0d50&g=gm_7a41fcae9e';
    ivs.picture = () => HD;
    await onAir();
    const el = briefing();
    await wait(4000);
    expect(notice()).toBe('임무 시작을 눌러야 판이 시작되고 광고가 나가요');
    el.hidden = true;
    await wait(4000);
    expect(notice()).toBeNull();
  });

  it('is never shown in the demo window, whose built-in player starts each round itself', async () => {
    location.hash = '#play=ses_f0b01b0d50&g=gm_7a41fcae9e&demo=1';
    ivs.picture = () => HD;
    await onAir();
    briefing();
    await wait(4000);
    expect(notice()).toBeNull();
  });

  // Between a person's rounds the game shows its briefing element again (class "again": game3d/runtime3d.js
  // nextRound) and starts the next round by itself 0.3 s later: that is not a game waiting for 임무 시작.
  it('a briefing shown again between rounds (class "again") is no wait: no line, and the console is told the game is not waiting', async () => {
    location.hash = '#play=ses_f0b01b0d50&g=gm_7a41fcae9e';
    ivs.picture = () => HD;
    await onAir();
    const handle = () => (window as unknown as { __ipverse: { state: () => { waiting?: boolean } } }).__ipverse.state();
    const el = briefing();
    await wait(4000);
    expect(handle().waiting).toBe(true); // the first round: 임무 시작 is still to be pressed
    el.hidden = true; // pressed: the round runs
    await wait(4000);
    await round(1);
    el.classList.add('again'); // 다시 시작: the next round is being built behind the card
    el.hidden = false;
    await wait(4000);
    expect(notice()).toBeNull();
    expect(handle().waiting).toBe(false);
  });
});

// A person plays on air in this window: Esc or P must not stop the round. The game takes ?nopause=1 for a
// surface that must not pause; cloud play keeps its pause.
describe("the play window's game never pauses: it is a broadcast surface", () => {
  const src = () => container.querySelector('iframe')!.getAttribute('src');

  it('a person at the keys: ?noads=1&nopause=1', async () => {
    location.hash = '#play=ses_f0b01b0d50&g=gm_7a41fcae9e';
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    expect(src()).toBe('https://cdn/games/gm_7a41fcae9e/index.html?noads=1&nopause=1');
  });

  it('the built-in player (&demo=1) too', async () => {
    location.hash = '#play=ses_f0b01b0d50&g=gm_7a41fcae9e&demo=1';
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    expect(src()).toBe('https://cdn/games/gm_7a41fcae9e/index.html?noads=1&nopause=1&autoplay=1');
  });
});

describe('the play window counts down to the server\'s 45-minute stop (round 7: the stop came with no warning)', () => {
  it('shows the time left from the status job and warns once 5 minutes before', async () => {
    location.hash = '#play=ses_f0b01b0d50&g=gm_7a41fcae9e&demo=1';
    ivs.picture = () => HD;
    status({ job: { ...job, secondsLeft: 298, maxMinutes: 45 } as LiveState['job'] }); // each poll re-anchors it
    await onAir();
    await wait(4000);
    const text = [...container.querySelectorAll('.popup-meta')].map((e) => e.textContent).join(' | ');
    expect(text).toMatch(/자동 종료까지 4:5\d/);
    expect(toasts().filter((t) => t?.includes('5분 뒤 자동으로 꺼져요'))).toHaveLength(1);
  });
});

describe('the round toast names the ad that went out (round 17 verify: an IVS ad break and MediaTailor at every round of a corner-only broadcast, nothing on pre-cued rounds)', () => {
  /** On air with this job (the server's answer to the start and to every status poll). */
  const start = async (j: object) => {
    api.liveStart.mockResolvedValue({ ...running, channelState: 'STARTING', job: j });
    status({ job: j as LiveState['job'] });
    await onAir();
  };
  const said = (n: number) => toasts().filter((t) => t?.startsWith(`${n}판 종료`));
  const at = '2026-11-11T04:40:08.000Z';

  // no trailer was ready to air at a trailer round, so the corner trailers went out in its place, and the break's
  // log entry says why
  it('a corner sent in a full-screen trailer\'s place: the toast is the server\'s reason', async () => {
    await start({ ...job, adType: 'trailer', corner: true });
    api.liveRound.mockResolvedValueOnce({ cued: false, deferred: false, preCued: false, corner: true, rounds: 2,
      breaks: [{ round: 2, eventId: 'c2', at, seconds: 12, kind: 'corner', instead: 'trailer', note: '전체 화면 트레일러를 준비하고 있어요(1–2분). 이번 판은 코너 트레일러를 보냈어요.' }] });
    await round(2);
    await wait(0);
    expect(said(2)).toEqual(['2판 종료 · 전체 화면 트레일러를 준비하고 있어요(1–2분). 이번 판은 코너 트레일러를 보냈어요.']);
  });

  it('a corner-only broadcast says a corner trailer, never an IVS ad break or MediaTailor', async () => {
    await start({ ...job, adType: 'corner' });
    api.liveRound.mockResolvedValueOnce({ cued: true, deferred: false, preCued: false, corner: false, rounds: 2 });
    await round(2);
    await wait(0);
    expect(said(2)).toHaveLength(1);
    expect(said(2)[0]).toContain('코너 트레일러');
    expect(said(2)[0]).not.toMatch(/IVS 광고 구간|MediaTailor/);
  });

  it('the default style: a corner round says the corner trailer, a pre-cued round that its ad went out ahead', async () => {
    await start({ ...job, everyRounds: 2, corner: true });
    api.liveRound.mockResolvedValueOnce({ cued: false, deferred: false, preCued: false, corner: true, rounds: 2 });
    await round(2);
    await wait(0);
    expect(said(2)).toHaveLength(1);
    expect(said(2)[0]).toContain('코너 트레일러');
    expect(said(2)[0]).not.toMatch(/IVS 광고 구간|MediaTailor/);
    api.liveRound.mockResolvedValueOnce({ cued: false, deferred: false, preCued: true, corner: false, rounds: 3,
      breaks: [{ round: 3, eventId: 'brk3', at, seconds: 24.63, kind: 'trailer', preCue: true, leadSec: 4.5 }] });
    await round(3);
    await wait(0);
    expect(said(3)).toHaveLength(1);
    expect(said(3)[0]).toMatch(/미리.*트레일러|트레일러.*미리/);
  });

  it('a full-screen trailer that was skipped is not said to have gone out: pre-cued or not', async () => {
    await start({ ...job, everyRounds: 1 });
    api.liveRound.mockResolvedValueOnce({ cued: false, deferred: false, preCued: true, corner: false, rounds: 2, // its pre-cue found the last ad on air
      breaks: [{ round: 2, eventId: 's_1', at, seconds: 0, kind: 'skip', of: 'trailer', reason: 'overlap' }] });
    await round(2);
    await wait(0);
    expect(said(2)).toEqual(['2판 종료 · 이번 판은 전체 화면 트레일러를 건너뛰었어요 (앞 광고가 아직 방송 중)']);
    api.liveRound.mockResolvedValueOnce({ cued: false, deferred: false, preCued: false, corner: false, rounds: 3,
      breaks: [{ round: 2, eventId: 's_1', at, seconds: 0, kind: 'skip', of: 'trailer', reason: 'overlap' },
        { round: 3, eventId: 's_2', at, seconds: 0, kind: 'skip', of: 'trailer', reason: 'no_room' }] });
    await round(3);
    await wait(0);
    expect(said(3)).toEqual(['3판 종료 · 이번 판은 전체 화면 트레일러를 건너뛰었어요 (다음 광고까지 시간 부족)']);
  });

  it('a playable card held for its launcher is not a trailer waiting for MediaTailor; a round with no ad says nothing', async () => {
    await start({ ...job, adType: 'playable' });
    api.liveRound.mockResolvedValueOnce({ cued: false, deferred: true, preCued: false, corner: true, rounds: 2,
      breaks: [{ round: 2, eventId: 's_3', at, seconds: 0, kind: 'skip', of: 'playable', reason: 'launcher_warming' }] });
    await round(2);
    await wait(0);
    expect(said(2)).toHaveLength(1);
    expect(said(2)[0]).toContain('플레이어블');
    expect(said(2)[0]).toContain('코너 트레일러');
    expect(said(2)[0]).not.toMatch(/트레일러 광고 대기 중|MediaTailor/);
    api.liveRound.mockResolvedValueOnce({ cued: false, deferred: false, preCued: false, corner: false, rounds: 3 });
    await round(3);
    await wait(0);
    expect(said(3)).toEqual([]);
  });
});

describe("the pre-cue leaves when the broadcast's lead of a round is left (round 17: the server's lead, 4.5 s by default)", () => {
  type Game = Window & { ipverseRoundEndsIn?: () => number | null };
  it('once a round, for a trailer broadcast only, and never earlier than the lead', async () => {
    api.liveRoundEta.mockResolvedValue({ preCued: true });
    const lead = { ...job, everyRounds: 1, preCueLeadSec: 4.5 };
    api.liveStart.mockResolvedValue({ ...running, channelState: 'STARTING', job: lead });
    status({ job: lead as LiveState['job'] });
    await onAir();
    let left: number | null = 30;
    (game() as Game).ipverseRoundEndsIn = () => left;
    await wait(2_000);
    left = 4.6;
    await wait(2_000);
    expect(api.liveRoundEta).not.toHaveBeenCalled(); // 30 s, then 4.6 s left: not yet
    left = 4.4;
    await wait(2_000);
    expect(api.liveRoundEta.mock.calls).toEqual([['ses_f0b01b0d50', 1, 4400]]);
    left = 1;
    await wait(2_000);
    expect(api.liveRoundEta).toHaveBeenCalledTimes(1); // once a round
  });
});

// The pre-cue report must reach the server well before the round's end; a race's end is told too, and a break
// that never aired must not stay "미리 넣었어요".
describe('the pre-cue is reported early enough for the server to time its call (round 19)', () => {
  type End = { seconds: number; estimated: boolean } | null;
  type Game = Window & { ipverseRoundEnd?: () => End; ipverseHoldEnd?: (ms: number) => void };
  const lead = { ...job, everyRounds: 1, preCueLeadSec: 2, preCueSendSec: 4.5 };
  async function start() {
    api.liveRoundEta.mockResolvedValue({ preCued: true });
    api.liveStart.mockResolvedValue({ ...running, channelState: 'STARTING', job: lead });
    status({ job: lead as LiveState['job'] });
    await onAir();
  }

  it("a clock's end goes out when the lead and the time the picks take are left", async () => {
    await start();
    let end: End = { seconds: 30, estimated: false };
    (game() as Game).ipverseRoundEnd = () => end;
    await wait(2_000);
    end = { seconds: 4.6, estimated: false };
    await wait(2_000);
    expect(api.liveRoundEta).not.toHaveBeenCalled();
    end = { seconds: 4.4, estimated: false };
    await wait(2_000);
    expect(api.liveRoundEta.mock.calls).toEqual([['ses_f0b01b0d50', 1, 4400]]);
  });

  it("a race's estimated end is sent as one, and taken back when the car slows before the call leaves", async () => {
    await start();
    let end: End = { seconds: 4.4, estimated: true };
    (game() as Game).ipverseRoundEnd = () => end;
    await wait(500);
    expect(api.liveRoundEta.mock.calls).toEqual([['ses_f0b01b0d50', 1, 4400, { estimated: true }]]);
    end = null; // 0.5 s later the estimate is gone (the car hit something): the server's call has not left yet
    await wait(500);
    expect(api.liveRoundEta).toHaveBeenLastCalledWith('ses_f0b01b0d50', 1, 0, { cancel: true });
    expect(api.liveRoundEta).toHaveBeenCalledTimes(2);
    end = { seconds: 4.2, estimated: true }; // steady again: sent again
    await wait(500);
    expect(api.liveRoundEta).toHaveBeenLastCalledWith('ses_f0b01b0d50', 1, 4200, { estimated: true });
  });

  it('an estimate that holds until the call has left is not taken back', async () => {
    await start();
    let end: End = { seconds: 4.4, estimated: true };
    (game() as Game).ipverseRoundEnd = () => end;
    await wait(250);
    for (let left = 4.15; left > 0; left -= 0.25) { end = { seconds: left, estimated: true }; await wait(250); }
    end = null; // the race is over
    await wait(1_000);
    expect(api.liveRoundEta).toHaveBeenCalledTimes(1);
  });

  it("a round whose ad goes out at its report keeps the built-in player's end screen up for it", async () => {
    await start();
    const held: number[] = [];
    (game() as Game).ipverseHoldEnd = (ms) => { held.push(ms); };
    // The built-in player starts the next round 4 s after the end and the report's answer can take as long: an ad
    // round with no pre-cue sent is held at its end already, until the answer says how long.
    let answer: (r: unknown) => void = () => undefined;
    api.liveRound.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    await round(1);
    await wait(0);
    expect(held).toEqual([6000]);
    await act(async () => answer({ cued: true, preCued: false, corner: false, rounds: 1, holdSec: 8 }));
    await wait(0);
    expect(held).toEqual([6000, 8000]);
    expect(toasts().some((t) => t?.includes('결과 화면 유지'))).toBe(false); // a person plays: nothing is held
    // round 2's end was told and its break sent ahead: its ad starts on the end screen as it is
    (game() as Game).ipverseRoundEnd = () => ({ seconds: 1, estimated: false });
    await wait(500);
    expect(api.liveRoundEta).toHaveBeenCalledTimes(1);
    api.liveRound.mockResolvedValueOnce({ cued: false, preCued: true, corner: false, rounds: 2 });
    await round(2);
    await wait(0);
    expect(held).toEqual([6000, 8000]);
    // a pre-cued round that ended before the end it had told: the server says how long
    (game() as Game).ipverseRoundEnd = () => ({ seconds: 3, estimated: false });
    await wait(500);
    api.liveRound.mockResolvedValueOnce({ cued: false, preCued: true, corner: false, rounds: 3, holdSec: 8.4 });
    await round(3);
    await wait(0);
    expect(held).toEqual([6000, 8000, 8400]);
  });

  it('says the end screen stays only when the built-in player plays', async () => {
    location.hash = '#demo=1';
    await start();
    api.liveRound.mockResolvedValueOnce({ cued: true, preCued: false, corner: false, rounds: 1, holdSec: 8 });
    await round(1);
    await wait(0);
    expect(toasts().some((t) => t?.startsWith('1판 종료') && t.includes('그동안 결과 화면 유지'))).toBe(true);
  });

  it('a round that is not an ad round is not held', async () => {
    api.liveRoundEta.mockResolvedValue({ preCued: false });
    const two = { ...lead, everyRounds: 2, roundBase: 0 };
    api.liveStart.mockResolvedValue({ ...running, channelState: 'STARTING', job: two });
    status({ job: two as LiveState['job'] });
    await onAir();
    const held: number[] = [];
    (game() as Game).ipverseHoldEnd = (ms) => { held.push(ms); };
    api.liveRound.mockResolvedValue({ cued: false, preCued: false, corner: true, rounds: 1 });
    await round(1);
    await wait(0);
    expect(held).toEqual([]);
    await round(2);
    await wait(0);
    expect(held).toEqual([6000]);
  });

  it('says so when a break it announced never aired', async () => {
    await start();
    const brk = { round: 1, eventId: 'CO9rZjtD6iLN', at: '2026-11-12T01:40:21.000Z', seconds: 16, kind: 'trailer' as const, preCue: true };
    status({ job: lead as LiveState['job'], stream: { state: 'streaming', rounds: 1, breaks: [brk], updatedAt: '' } });
    await wait(4_000);
    expect(toasts().some((t) => t?.includes('방송에 나가지 않았어요'))).toBe(false);
    status({ job: lead as LiveState['job'], stream: { state: 'streaming', rounds: 1, breaks: [{ ...brk, lost: true }], updatedAt: '' } });
    await wait(4_000);
    expect(toasts().filter((t) => t?.includes('1판 전체 화면 광고가 방송에 나가지 않았어요'))).toHaveLength(1);
    await wait(8_000);
    expect(toasts().filter((t) => t?.includes('방송에 나가지 않았어요')).length).toBeLessThanOrEqual(1); // once
  });

  // The server must not count a round's seconds left from when the request reaches its handler (about 1 s late):
  // the end is named as an instant of the server's clock.
  it("learns the server's clock from the status polls and names the round's end on it", async () => {
    await start();
    const base = api.liveStatus.getMockImplementation()!;
    // the server's clock is 5 s ahead of this PC's
    api.liveStatus.mockImplementation(async () => ({ ...(await base()), now: (Date.now() + 5000) / 1000 }));
    await wait(4_000);
    (game() as Game).ipverseRoundEnd = () => ({ seconds: 4.4, estimated: false });
    await wait(250);
    const [, n, ms, extra] = api.liveRoundEta.mock.calls[0];
    expect([n, ms]).toEqual([1, 4400]);
    expect(Math.abs(extra.endsAtMs - (Date.now() + 4400 + 5000))).toBeLessThan(300);
    expect(extra.estimated).toBeUndefined();
  });
});

// The two buttons share one place in the tree: one's done state must not show with the other's labels.
describe("the play window's own start/stop button never shows the other button's state (R20-07)", () => {
  const toggle = () => container.querySelector<HTMLButtonElement>('.popup-bar .live-toggle')!;
  const watch = async (ms: number) => {
    const seen: string[] = [];
    for (let t = 0; t <= ms; t += 500) { seen.push(toggle().textContent ?? ''); await act(async () => { await vi.advanceTimersByTimeAsync(500); }); }
    return seen;
  };

  it('is the stop button once on air and the start button once off', async () => {
    ivs.picture = () => HD;
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    const surface = Object.assign(document.createElement('canvas'), { captureStream: vi.fn(captureOf) });
    game().ipverseCapture = () => surface;
    ivs.onAirAt = Date.now();
    await act(async () => { toggle().click(); await vi.advanceTimersByTimeAsync(0); });
    const afterStart = await watch(3000);
    expect(afterStart.filter((t) => t.includes('꺼짐'))).toEqual([]);
    expect(toggle().textContent).toMatch(/^■ /); // the stop button, idle
    expect(toggle().disabled).toBe(false);

    api.liveStop.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null });
    api.liveStatus.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null });
    await act(async () => { toggle().click(); await vi.advanceTimersByTimeAsync(0); });
    const afterStop = await watch(3000);
    expect(afterStop.filter((t) => t.includes('송출 중'))).toEqual([]);
    expect(toggle().textContent).toMatch(/^● /); // the start button, idle
  });
});

// The window must not read the session only once, when it opens: a trailer finished after that has to be known
// to a start, and the newest trailer is the one sent.
describe('the play window reads the session again at a start (C-04)', () => {
  const noTrailer = { ...snap, assets: [] } as unknown as Snapshot;
  const handle = () => (window as unknown as { __ipverse: { start: (n?: number, adType?: string) => Promise<void> } }).__ipverse;
  async function open(first: Snapshot) {
    api.getSession.mockResolvedValue(first);
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    game().ipverseCapture = () => Object.assign(document.createElement('canvas'), { captureStream: vi.fn(captureOf) });
    ivs.onAirAt = Date.now();
  }

  it('a trailer finished after the window opened is found, and the newest one is the ad it sends', async () => {
    ivs.picture = () => HD;
    await open(noTrailer);
    const made = { ...snap.assets[0], assetId: 'ast_t2', createdAt: '2026-11-05T00:12:00Z' };
    api.getSession.mockResolvedValue({ ...snap, assets: [...snap.assets, made] });
    await act(async () => { await handle().start(2, 'trailer'); });
    expect(api.liveStart).toHaveBeenCalledWith('ses_f0b01b0d50', expect.objectContaining({ adAssetId: 'ast_t2', adType: 'trailer' }));
    expect(pill()).not.toBe('방송 꺼짐');
  });

  it('with no trailer it says where one is made, in a sentence of its own; a playable broadcast needs none', async () => {
    ivs.picture = () => HD;
    await open(noTrailer);
    let said = '';
    await act(async () => { await handle().start(2, 'trailer').catch((e: Error) => { said = e.message; }); });
    expect(said).toBe('이 세션에 트레일러가 아직 없어요. 영상 탭의 ‘연출해서 만들기’로 트레일러를 만들거나, 스튜디오의 라이브 방송 창에서 ‘플레이어블 광고’를 골라 주세요.');
    expect(api.liveStart).not.toHaveBeenCalled();
    await act(async () => { await handle().start(2, 'playable'); });
    expect(api.liveStart).toHaveBeenCalledWith('ses_f0b01b0d50', expect.objectContaining({ adType: 'playable' }));
  });

  it('a session that cannot be read still starts with the trailer the window knows', async () => {
    ivs.picture = () => HD;
    await open(snap);
    api.getSession.mockRejectedValue(new Error('서버에 연결할 수 없습니다.'));
    await act(async () => { await handle().start(2, 'trailer'); });
    expect(api.liveStart).toHaveBeenCalledWith('ses_f0b01b0d50', expect.objectContaining({ adAssetId: 'ast_t' }));
  });

  it('says why the session did not load without the error\'s class name', async () => {
    api.getSession.mockRejectedValue(Object.assign(new Error('서버에 연결할 수 없습니다.'), { name: 'ApiError' }));
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    // the reason stays in the stage with 다시 시도, not in a toast
    expect(container.querySelector('.popup-stage [role="alert"] p')!.textContent).toBe('게임을 불러오지 못했어요. 서버에 연결할 수 없습니다.');
    expect(toasts()).toEqual([]);
  });
});

// The play window's "● 방송 시작" starts the broadcast the console's ● 라이브 켜기 would (tab, corner, N), labels
// its N field, and never starts a playable broadcast (a paid GPU host) nobody picked.
describe("the play window's own button starts what the console would (R20-34)", () => {
  const toggle = () => container.querySelector<HTMLButtonElement>('.popup-bar .live-toggle')!;
  const every = () => container.querySelector<HTMLInputElement>('.popup-every input')!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(every(), value);
    every().dispatchEvent(new Event('input', { bubbles: true }));
  });
  /** The studio's console as this window finds it on window.opener. */
  const consoleOpen = (s: object | null) => vi.stubGlobal('opener', { __ipverseConsole: {
    settings: (sid: string, gid: string) => (sid === 'ses_f0b01b0d50' && gid === 'gm_7a41fcae9e' ? s : null) } });
  async function open(session: Snapshot = snap) {
    ivs.picture = () => HD;
    api.getSession.mockResolvedValue(session);
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    game().ipverseCapture = () => Object.assign(document.createElement('canvas'), { captureStream: vi.fn(captureOf) });
    ivs.onAirAt = Date.now();
  }
  const press = () => act(async () => { toggle().click(); await vi.advanceTimersByTimeAsync(0); });

  it('is called ● 라이브 켜기 / ■ 라이브 끄기, and its number has a label in sight', async () => {
    await open();
    expect(toggle().textContent).toBe('● 라이브 켜기');
    expect(container.querySelector('.popup-every')!.textContent).toBe('광고 간격판마다'); // 광고 간격 [2] 판마다
    expect(container.querySelector('.popup-every .sr-only')).toBeNull();
    await press();
    await wait(2000);
    expect(toggle().textContent).toBe('■ 라이브 끄기');
  });

  it("starts the console's tab and values when the studio has the console open on this game", async () => {
    consoleOpen({ everyRounds: 3, adType: 'corner', playableSeconds: 60, corner: false });
    await open();
    await wait(1000);
    expect(every().value).toBe('3'); // what will start is what it shows
    await press();
    expect(api.liveStart).toHaveBeenCalledWith('ses_f0b01b0d50', { gameId: 'gm_7a41fcae9e', adAssetId: 'ast_t', everyRounds: 3, mode: 'player',
      adType: 'corner', playableSeconds: 60 });
  });

  it("with no console open it starts the console's defaults: a full-screen trailer every 2 rounds, a corner trailer at the others", async () => {
    await open();
    await press();
    expect(api.liveStart).toHaveBeenCalledWith('ses_f0b01b0d50', { gameId: 'gm_7a41fcae9e', adAssetId: 'ast_t', everyRounds: 2, mode: 'player',
      adType: 'trailer', playableSeconds: 90, corner: true });
  });

  it('a number typed here is the one it starts with', async () => {
    consoleOpen({ everyRounds: 3, adType: 'trailer', playableSeconds: 90, corner: true });
    await open();
    await wait(1000);
    await type('5');
    await wait(1000); // the console's 3 does not take the field back
    expect(every().value).toBe('5');
    await press();
    expect(api.liveStart).toHaveBeenCalledWith('ses_f0b01b0d50', expect.objectContaining({ everyRounds: 5, adType: 'trailer', corner: true }));
  });

  it('with no trailer it starts no playable broadcast of its own: it says where a trailer is made', async () => {
    await open({ ...snap, assets: [] } as unknown as Snapshot);
    expect(toggle().textContent).toBe('● 라이브 켜기');
    await press();
    expect(api.liveStart).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toContain('이 세션에 트레일러가 아직 없어요');
    expect(toasts().at(-1)).toContain('플레이어블 광고');
  });

  // Nothing costs money without its price first: this button starts a broadcast and, with the console on its
  // 플레이어블 tab, the paid playable server too, so the 45-minute limit and the price are said here as well.
  const does = () => container.querySelector('.popup-does')?.textContent ?? null;
  it('says beside the button what a start does: the broadcast ends by itself after 45 minutes', async () => {
    await open();
    expect(does()).toBe('최대 45분 뒤 자동으로 꺼져요');
    expect(container.querySelector('.popup-does')!.parentElement!.contains(toggle())).toBe(true); // one group with the button
    await press();
    await wait(2000);
    expect(does()).toBeNull(); // on air the bar counts the time left instead
  });

  it('a playable start from here says that the playable server starts, with its price', async () => {
    consoleOpen({ everyRounds: 2, adType: 'playable', playableSeconds: 90, corner: false });
    await open();
    await wait(1000);
    expect(does()).toBe('최대 45분 뒤 자동으로 꺼져요 · 플레이어블 서버가 켜져요 (켜져 있는 동안 시간당 약 $1.51)');
  });
});

// A load that failed, or a session that no longer has the game, must not leave the window on "게임을 불러오는 중…".
describe('a play window whose game does not load says so, with a way on (R20-43)', () => {
  const stage = () => container.querySelector('.popup-stage')!;
  const button = (text: string) => [...stage().querySelectorAll('button')].find((b) => b.textContent === text);
  async function open() {
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
  }

  it('a failed load: the reason and 다시 시도, which loads the game', async () => {
    api.getSession.mockRejectedValueOnce(Object.assign(new Error('인터넷 연결을 확인해 주세요.'), { name: 'ApiError', status: 0 }));
    await open();
    expect(stage().querySelector('[role="alert"]')!.textContent).toContain('게임을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
    expect(stage().textContent).not.toContain('게임을 불러오는 중');
    expect(container.querySelector('.popup-bar .live-toggle')!.textContent).not.toBe('불러오는 중');
    await act(async () => { button('다시 시도')!.click(); await vi.advanceTimersByTimeAsync(0); });
    expect(container.querySelector('iframe')!.getAttribute('src')).toContain('gm_7a41fcae9e');
    expect(stage().querySelector('[role="alert"]')).toBeNull();
  });

  it('an expired login is said as that, with 다시 로그인', async () => {
    api.getSession.mockRejectedValueOnce(Object.assign(new Error('로그인 시간이 지났어요. 다시 로그인하면 하던 작업으로 돌아가요.'), { name: 'AuthError' }));
    await open();
    expect(stage().querySelector('[role="alert"]')!.textContent).toContain('로그인 시간이 지났어요. 다시 로그인하면 하던 작업으로 돌아가요.');
    expect(button('다시 로그인')).toBeTruthy();
    expect(button('다시 시도')).toBeUndefined();
  });

  it('a session that no longer has this game says so: it is not still loading', async () => {
    api.getSession.mockResolvedValue({ ...snap, games: [] } as unknown as Snapshot);
    await open();
    expect(stage().querySelector('[role="alert"]')!.textContent).toContain('이 게임을 찾지 못했어요.');
    expect(stage().textContent).not.toContain('게임을 불러오는 중');
  });

  it('while it loads it says so, as before', async () => {
    api.getSession.mockReturnValue(new Promise(() => undefined));
    await open();
    expect(stage().textContent).toBe('게임을 불러오는 중…');
    expect(stage().querySelector('[role="alert"]')).toBeNull();
  });
});

// The console's handle on its play window lives in the studio page, so a studio reload drops it. The opener is
// still the studio's tab after its reload, and the play window says it is there.
describe('the play window hands itself to the console in its opener (a studio reload drops the handle)', () => {
  it('every second, on air too, with its session and game', async () => {
    const attach = vi.fn();
    vi.stubGlobal('opener', { __ipverseConsole: { settings: () => null, attach } });
    ivs.picture = () => HD;
    await onAir();
    expect(attach).toHaveBeenCalledWith(window, 'ses_f0b01b0d50', 'gm_7a41fcae9e');
    const before = attach.mock.calls.length;
    await wait(4000); // on air: a console opened after the reload is found within a second
    expect(attach.mock.calls.length).toBeGreaterThanOrEqual(before + 3);
  });

  it('a console from before this (no attach), a closed opener or one gone elsewhere is no error', async () => {
    vi.stubGlobal('opener', { __ipverseConsole: { settings: () => null } });
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(2000);
    vi.stubGlobal('opener', { get __ipverseConsole(): never { throw new Error('cross-origin'); } });
    await wait(2000);
    vi.stubGlobal('opener', null);
    await wait(2000);
    expect(toasts()).toEqual([]);
  });
});

// Cmd+W or a reload on air asks first; the console sends a play window left on another game to its own (a new
// hash in the same page), which must not keep the old game's state.
describe('the play window on air is not left by accident, and a new game is a new window (R20-19, R20-46)', () => {
  const leave = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };

  it('asks before the window closes or reloads while it is on air, and only then', async () => {
    ivs.picture = () => HD;
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    expect(leave()).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(container);
    await onAir();
    expect(leave()).toBe(true);
    api.liveStop.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null });
    await act(async () => { await (window as unknown as { __ipverse: { stop: () => Promise<void> } }).__ipverse.stop(); });
    expect(leave()).toBe(false);
  });

  it('sent to another game it starts over: no rounds or broadcast of the game before', async () => {
    const two = { ...snap, games: [...snap.games, { ...snap.games[0], gameId: 'gm_next', title: '네온 시티 2', previewUrl: 'https://cdn/games/gm_next/index.html' }] };
    api.getSession.mockResolvedValue(two);
    ivs.picture = () => HD;
    await onAir();
    await round(3);
    await wait(0);
    expect(container.querySelector('.popup-bar')!.textContent).toContain('끝난 판 3');
    api.liveStop.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null });
    api.liveStatus.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null });
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_next" />)); // #play=…&g=gm_next
    await wait(0);
    expect(container.querySelector('.popup-title')!.textContent).toContain('네온 시티 2');
    expect(container.querySelector('.popup-bar')!.textContent).toContain('끝난 판 0');
    expect(container.querySelector('iframe')!.getAttribute('src')).toContain('gm_next');
    expect(pill()).toBe('방송 꺼짐');
    // the broadcast of the game it left does not stay on the server without a window
    expect(api.liveStop).toHaveBeenCalledWith('ses_f0b01b0d50');
    expect(ivs.client.stopBroadcast).toHaveBeenCalled();
  });
});

// An end the window did not ask for is said in the user's words: the 45-minute cap, or a stop from elsewhere.
describe('a broadcast ended from outside says why, in plain words', () => {
  it('names the 45-minute cap when its time was up, else a stop or another start elsewhere', async () => {
    ivs.picture = () => HD;
    status({ job: { ...job, secondsLeft: 3, maxMinutes: 45 } as LiveState['job'] });
    await onAir();
    await wait(4000);
    api.liveStatus.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null });
    await wait(4000);
    expect(toasts().at(-1)).toBe('방송 시간이 다 돼서 자동으로 꺼졌어요 (한 번에 최대 45분). 더 하려면 ‘라이브 켜기’를 다시 눌러 주세요.');
    expect(pill()).toBe('방송 꺼짐');
  });

  it('a stop that was not the cap', async () => {
    ivs.picture = () => HD;
    status({ job: { ...job, secondsLeft: 1500, maxMinutes: 45 } as LiveState['job'] });
    await onAir();
    await wait(4000);
    api.liveStatus.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null });
    await wait(4000);
    expect(toasts().at(-1)).toBe('다른 창에서 방송을 껐거나 다른 방송이 시작돼서 이 방송이 꺼졌어요.');
    expect(toasts().some((t) => t?.includes('서버'))).toBe(false);
  });

  // the server names a broadcast its owner ended by starting another session's (status.endedBy)
  it("the owner's start in another session", async () => {
    ivs.picture = () => HD;
    status({ job: { ...job, secondsLeft: 1500, maxMinutes: 45 } as LiveState['job'] });
    await onAir();
    await wait(4000);
    api.liveStatus.mockResolvedValue({ ...running, active: false, channelState: 'IDLE', job: null, ingest: null, endedBy: 'takeover' });
    await wait(4000);
    expect(toasts().at(-1)).toBe('내 다른 세션에서 라이브를 켜서 이 방송이 꺼졌어요.');
  });
});

// The server wants the user's word (`takeover: true`) before a start ends a broadcast of the same owner's other session.
describe('the play window sends a takeover only when it was said (C-02)', () => {
  const handle = () => (window as unknown as { __ipverse: { start: (...a: unknown[]) => Promise<void> } }).__ipverse;
  // the server's own answer (server/live.py start)
  const refusal = Object.assign(new Error('내 다른 세션에서 방송 중이에요. 그 방송을 먼저 꺼 주세요.'), { name: 'ApiError', status: 409, code: 'live_other_session' });
  const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  async function open() {
    ivs.picture = () => HD;
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    game().ipverseCapture = () => Object.assign(document.createElement('canvas'), { captureStream: vi.fn(captureOf) });
    ivs.onAirAt = Date.now();
  }

  it("the console's start carries the flag through, and a start without it sends none", async () => {
    await open();
    api.liveStart.mockRejectedValueOnce(refusal);
    let said: unknown = null;
    await act(async () => { await handle().start(2, 'trailer', 90, true).catch((e: unknown) => { said = e; }); });
    expect(api.liveStart.mock.calls[0][1]).not.toHaveProperty('takeover');
    expect(said).toMatchObject({ status: 409, code: 'live_other_session' }); // the console reads these across the windows
    await act(async () => { await handle().start(2, 'trailer', 90, true, true); });
    expect(api.liveStart.mock.calls[1][1]).toMatchObject({ takeover: true, adType: 'trailer', corner: true });
  });

  it('its own button asks, and starts again with the flag after a yes', async () => {
    await open();
    api.liveStart.mockRejectedValueOnce(refusal);
    await act(async () => { container.querySelector<HTMLButtonElement>('.popup-bar .live-toggle')!.click(); await vi.advanceTimersByTimeAsync(0); });
    // (this fake API has no session list, so the question names no session; round21-play-window.test.tsx covers the name)
    expect(dialog()!.textContent).toContain('그 방송을 끄고 이 게임을 방송할까요?');
    expect(toasts().filter((t) => t?.includes('다른 세션'))).toEqual([]);
    await act(async () => { [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === '끄고 방송하기')!.click(); await vi.advanceTimersByTimeAsync(0); });
    await wait(2000);
    expect(api.liveStart).toHaveBeenCalledTimes(2);
    expect(api.liveStart.mock.calls[1][1]).toMatchObject({ takeover: true });
    expect(dialog()).toBeNull();
    expect(pill()).not.toBe('방송 꺼짐');
  });
});

// The studio, the play window and the watch page must not share one tab title: three tabs of one broadcast.
describe('the play window has its own tab title (R20-52)', () => {
  it('is titled 플레이 창 and its game once the session is read', async () => {
    document.title = 'IPverse Studio';
    await act(async () => root.render(<PlayWindow sessionId="ses_f0b01b0d50" gameId="gm_7a41fcae9e" />));
    await wait(0);
    expect(document.title).toBe('플레이 창 · 네온 시티');
  });
});
