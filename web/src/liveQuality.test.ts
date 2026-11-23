import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  heldIssue,
  DROP_SAMPLES, NO_DROP, NO_RESTARTS, SEND_ISSUE_TEXT, atFloor, capAtFloor, breakInFlight, dropText, isLowQuality, peerConnectionOf,
  playbackSample, qualityText, readSendDiag, readSendStats, restartDue, sendIssue, starved, trackDrop, useSendQuality, type Limitation, type SendQuality,
} from './liveQuality';
import gapsLog from './fixtures/b4-gaps-send.json';

/** An RTCStatsReport as Chrome builds it for the IVS Web Broadcast sender (only the fields we read). */
function report(at: number, bytesSent: number, video: Record<string, unknown> = {}) {
  return new Map<string, Record<string, unknown>>([
    ['OT01V', { type: 'outbound-rtp', kind: 'video', timestamp: at, bytesSent, frameWidth: 1280, frameHeight: 720,
      framesPerSecond: 30, qualityLimitationReason: 'none', targetBitrate: 2_500_000, encoderImplementation: 'OpenH264', ...video }],
    ['OT01A', { type: 'outbound-rtp', kind: 'audio', timestamp: at, bytesSent: bytesSent / 20 }],
    ['CP01', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 2_700_000 }],
  ]);
}

describe('the send diagnostics for the re-verification (B4: why a new connection falls again 25-110 s in)', () => {
  test('the estimate, RTT, losses, NACK/PLI, the limit, frames and the encoder target from one report', () => {
    const r = report(10_000, 1_000_000, { qualityLimitationReason: 'bandwidth', framesEncoded: 900, framesSent: 898, nackCount: 12,
      pliCount: 1, targetBitrate: 640_000 });
    r.set('RI01V', { type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.084, packetsLost: 37, fractionLost: 0.02 });
    r.set('CP01', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 700_000, currentRoundTripTime: 0.09 });
    r.set('CP02', { type: 'candidate-pair', state: 'failed', nominated: false, availableOutgoingBitrate: 9 });
    expect(readSendDiag(r)).toEqual({ avail: 700_000, rtt: 84, lost: 37, fracLost: 0.02, nack: 12, pli: 1, reason: 'bandwidth',
      encoded: 900, sent: 898, target: 640_000 });
  });
  test('what a report lacks is null (no remote report yet: the pair\'s RTT); no video sender: null', () => {
    expect(readSendDiag(report(10_000, 0))).toEqual({ avail: 2_700_000, rtt: null, lost: null, fracLost: null, nack: null, pli: null,
      reason: 'none', encoded: null, sent: null, target: 2_500_000 });
    const pairRtt = report(10_000, 0);
    pairRtt.set('CP01', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.05 });
    expect(readSendDiag(pairRtt)).toMatchObject({ avail: null, rtt: 50 });
    expect(readSendDiag(new Map())).toBeNull();
  });
});

describe('the play window reads its own send quality from the WebRTC sender', () => {
  test('outgoing bitrate is the bytes sent between two reports', () => {
    const first = readSendStats(report(10_000, 1_000_000), null)!;
    expect(first.quality).toMatchObject({ width: 1280, height: 720, fps: 30, bitrate: null, limitation: 'none' });
    // 2 s later 575 kB more: 2.3 Mbps
    const next = readSendStats(report(12_000, 1_575_000), first.sample)!;
    expect(next.quality).toEqual({ width: 1280, height: 720, fps: 30, bitrate: 2_300_000, limitation: 'none',
      targetBitrate: 2_500_000, encoder: 'OpenH264', hidden: false });
    expect(isLowQuality(next.quality)).toBe(false);
  });

  test('the E2E collapse (320x180, 0.03 Mbps, bandwidth-limited) is low and says why', () => {
    const prev = readSendStats(report(10_000, 5_000_000), null)!.sample;
    const low = readSendStats(report(12_000, 5_007_500, { frameWidth: 320, frameHeight: 180, framesPerSecond: 17,
      qualityLimitationReason: 'bandwidth', targetBitrate: 30_000 }), prev)!.quality;
    expect(low).toMatchObject({ width: 320, height: 180, bitrate: 30_000, fps: 17, limitation: 'bandwidth', targetBitrate: 30_000 });
    expect(isLowQuality(low)).toBe(true);
    expect(sendIssue(low)).toBe('bandwidth');
    expect(sendIssue({ ...low, limitation: 'cpu' })).toBe('cpu');
    expect(sendIssue({ ...low, limitation: 'none' })).toBe('low');
    // a hidden play window freezes the game (no animation frames) even at full quality
    const full = readSendStats(report(1, 1), null)!.quality;
    expect(sendIssue({ ...full, hidden: true })).toBe('hidden');
    expect(sendIssue(full)).toBeNull();
    // few bits at 720p: a still scene (no limit) is fine, a starved encoder is not
    expect(sendIssue({ ...full, bitrate: 100_000 })).toBeNull();
    expect(sendIssue({ ...full, bitrate: 100_000, limitation: 'bandwidth' })).toBe('bandwidth');
    expect(isLowQuality({ ...full, bitrate: 100_000 })).toBe(false);
  });

  test('"bandwidth" names both causes: a starved sender also reads as bandwidth-limited', () => {
    // WebRTC says "bandwidth" for a loaded CPU too (its estimate falls when packets leave late), so the message must
    // not blame the network alone
    expect(SEND_ISSUE_TEXT.bandwidth).toContain('네트워크');
    expect(SEND_ISSUE_TEXT.bandwidth).toContain('CPU');
  });

  test('no video sender yet, a counter reset or an odd reason are handled', () => {
    expect(readSendStats(new Map([['x', { type: 'candidate-pair' }]]), null)).toBeNull();
    const prev = readSendStats(report(10_000, 9_000_000), null)!.sample;
    expect(readSendStats(report(12_000, 100), prev)!.quality.bitrate).toBeNull(); // a new peer connection restarts at 0
    expect(readSendStats(report(12_000, 1, { qualityLimitationReason: 'thermal' }), null)!.quality.limitation).toBe('other');
  });

  test('the peer connection is found on the IVS client, or not at all', () => {
    const pc = { getStats: async () => new Map() };
    expect(peerConnectionOf({ peerClient: { peerConnection: pc } })).toBe(pc);
    expect(peerConnectionOf({ peerClient: {} })).toBeNull();
    expect(peerConnectionOf(null)).toBeNull();
  });
});

describe('the watch window reads the picture the IVS Player really decodes', () => {
  const player = (over: Record<string, unknown> = {}) => ({
    getQuality: () => ({ name: '720p', width: 1280, height: 720, bitrate: 2_034_373 }), // what the playlist advertises
    getVideoBitRate: () => 2_034_373, getVideoFrameRate: () => 30, ...over,
  });

  test('size comes from the decoded frames, bitrate from the decoded bytes', () => {
    const first = playbackSample(player(), { videoWidth: 320, videoHeight: 180, webkitVideoDecodedByteCount: 1_000 }, null, 0);
    expect(first.quality).toEqual({ width: 320, height: 180, bitrate: 2_034_373, fps: 30,
      advertised: { width: 1280, height: 720, bitrate: 2_034_373 } }); // no byte delta yet: the player's own number
    const next = playbackSample(player(), { videoWidth: 320, videoHeight: 180, webkitVideoDecodedByteCount: 8_500 }, first.tick, 2000);
    expect(next.quality.bitrate).toBe(30_000); // 7.5 kB in 2 s, while the playlist still says 2 Mbps at 720p
    expect(isLowQuality(next.quality)).toBe(true);
  });

  test('a browser without decoded-byte counters or player stats reports what it knows', () => {
    const q = playbackSample({ getQuality: () => ({ width: 0, height: 0, bitrate: 0 }) }, { videoWidth: 1280, videoHeight: 720 }, null, 0).quality;
    expect(q).toEqual({ width: 1280, height: 720, bitrate: null, fps: null, advertised: null });
    expect(isLowQuality(q)).toBe(false);
    expect(isLowQuality({ width: 0, height: 0, bitrate: null, fps: null })).toBe(false); // not playing yet: unknown, not low
  });
});

test('the label for a quality chip', () => {
  expect(qualityText({ width: 1280, height: 720, bitrate: 2_300_000, fps: 30 })).toBe('1280×720 · 2.3 Mbps · 30fps');
  expect(qualityText({ width: 320, height: 180, bitrate: 30_000, fps: 17.4 })).toBe('320×180 · 0.03 Mbps · 17fps');
  expect(qualityText({ width: 0, height: 0, bitrate: null, fps: null })).toBe('');
});

test('a flagged drop names what is low in the latest sample, or "화질 회복 중" once it is good again (E2E R8)', () => {
  const q = (width: number, height: number, bitrate: number | null) => ({ width, height, bitrate, fps: 30 });
  expect(dropText(q(320, 180, 30_000), true)).toBe('화질 저하 320×180');
  expect(dropText(q(960, 540, 50_000), true)).toBe('화질 저하 0.05 Mbps'); // a starved encoder at a good size
  expect(dropText(q(960, 540, null), true)).toBe('화질 저하');
  // the flag clears only after a run of good samples: until then the latest one is good and the drop not over
  expect(dropText(q(1280, 720, 2_300_000), false)).toBe('화질 회복 중');
});

test(`a drop is flagged after ${DROP_SAMPLES} low samples in a row and cleared after ${DROP_SAMPLES} good ones`, () => {
  let d = NO_DROP;
  const seq = (lows: boolean[]) => lows.map((low) => (d = trackDrop(d, low)).dropped);
  expect(seq([true, true, false, true, true])).toEqual([false, false, false, false, false]); // blips are not drops
  expect(seq([true])).toEqual([true]);
  expect(seq([false, false, true, false, false, false])).toEqual([true, true, true, true, true, false]);
});

describe('useSendQuality polls the sender every 2 s while on air', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('the start ramp-up is not a drop; the E2E collapse later is, on its third low sample', async () => {
    // every 2 s: Chrome's ramp-up at the start (320x180 → 640x360, bandwidth-limited), healthy 720p at 2.3 Mbps,
    // then from 30 s a collapse (320x180 at 0.03 Mbps)
    let bytes = 0;
    const at = (s: number) => {
      const ramp = [[320, 180], [320, 180], [480, 270], [640, 360]][s / 2];
      if (ramp) return report(s * 1000, (bytes += 250_000), { frameWidth: ramp[0], frameHeight: ramp[1], qualityLimitationReason: 'bandwidth' });
      if (s < 30) return report(s * 1000, (bytes += 575_000));
      return report(s * 1000, (bytes += 7_500), { frameWidth: 320, frameHeight: 180, framesPerSecond: 17, qualityLimitationReason: 'cpu' });
    };
    let t = 0;
    const pc = { getStats: vi.fn(async () => at(t)) };
    const seen: { t: number; send: SendQuality | null; dropped: boolean }[] = [];
    function Probe() {
      seen.push({ t, ...useSendQuality(() => pc as unknown as RTCPeerConnection, true) });
      return null;
    }
    await act(async () => root.render(createElement(Probe))); // reads at once, then every 2 s
    for (t = 2; t <= 36; t += 2) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(pc.getStats).toHaveBeenCalledTimes(19);
    expect(seen.filter((s) => s.dropped).map((s) => s.t)[0]).toBe(34); // 30, 32, 34: three low samples
    expect(seen.find((s) => s.t === 4)?.send).toMatchObject({ width: 480, height: 270, limitation: 'bandwidth' }); // shown, not flagged
    expect(seen.find((s) => s.t === 20)?.send).toMatchObject({ width: 1280, height: 720, bitrate: 2_300_000, limitation: 'none' });
    expect(seen.at(-1)!.send).toMatchObject({ width: 320, height: 180, bitrate: 30_000, limitation: 'cpu' });
    expect(sendIssue(seen.at(-1)!.send!)).toBe('cpu');
  });

  test('a real recovery (back to 720p) clears the drop on its third good sample', async () => {
    let bytes = 0;
    let t = 0;
    const pc = { getStats: vi.fn(async () => (t < 10
      ? report(t * 1000, (bytes += 7_500), { frameWidth: 320, frameHeight: 180, framesPerSecond: 17, qualityLimitationReason: 'bandwidth' })
      : report(t * 1000, (bytes += 575_000)))) };
    const seen: { t: number; dropped: boolean }[] = [];
    function Probe() {
      seen.push({ t, dropped: useSendQuality(() => pc as unknown as RTCPeerConnection, true, 2000, 0).dropped });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    for (t = 2; t <= 20; t += 2) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(seen.filter((s, i) => i > 0 && s.dropped !== seen[i - 1].dropped).map((s) => [s.t, s.dropped]))
      .toEqual([[4, true], [14, false]]); // 0, 2, 4 low; 10, 12, 14 good
  });

  test('a hidden play window (frozen game) counts at once, warm-up or not', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    let bytes = 0;
    const pc = { getStats: vi.fn(async () => report(Date.now(), (bytes += 575_000))) };
    let last: { send: SendQuality | null; dropped: boolean } = { send: null, dropped: false };
    function Probe() {
      last = useSendQuality(() => pc as unknown as RTCPeerConnection, true);
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    for (let i = 0; i < 2; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(last.send).toMatchObject({ width: 1280, height: 720, hidden: true });
    expect(last.dropped).toBe(true);
    expect(sendIssue(last.send!)).toBe('hidden');
    vi.restoreAllMocks();
  });

  // After a collapse the play window restarts the connection, which ramps up from 320x180 again: a drop raised
  // before it stays until a good picture clears it (a ramp is not a recovery).
  async function reconnect(after: 'ramps up' | 'stays at the floor') {
    let bytes = 0;
    let t = 0;
    const floor = () => report(t * 1000, (bytes += 7_500), { frameWidth: 320, frameHeight: 180, framesPerSecond: 20, qualityLimitationReason: 'bandwidth' });
    const good = () => report(t * 1000, (bytes += 575_000));
    const old = { getStats: vi.fn(async () => (t < 30 ? good() : floor())) };
    const fresh = { getStats: vi.fn(async () => (after === 'ramps up' && t >= 70 ? good() : floor())) };
    let pc: unknown = old;
    const seen: { t: number; dropped: boolean }[] = [];
    function Probe() {
      seen.push({ t, dropped: useSendQuality(() => pc as RTCPeerConnection, true).dropped });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    for (t = 2; t <= 120; t += 2) {
      if (t === 60) pc = fresh; // the restart
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }
    return seen.filter((s, i) => i > 0 && s.dropped !== seen[i - 1].dropped).map((s) => [s.t, s.dropped]);
  }
  test('a reconnect that ramps up to 720p clears a standing drop only once the picture is good', async () => {
    expect(await reconnect('ramps up')).toEqual([[34, true], [74, false]]); // not at 64, in the middle of the 320x180 ramp
  });
  test('a reconnect that stays at the floor keeps the drop: no "돌아왔어요" then "떨어졌어요" again', async () => {
    expect(await reconnect('stays at the floor')).toEqual([[34, true]]);
  });

  test('floorSince: when the send got to the 320x180 floor; a better picture, a CPU limit or a new connection starts it again', async () => {
    let bytes = 0;
    let t = 0;
    const at = (w: number, h: number, reason = 'bandwidth') =>
      report(t * 1000, (bytes += 7_500), { frameWidth: w, frameHeight: h, qualityLimitationReason: reason });
    // the floor from 10 s; 480x270 at 30 s; the floor; a CPU limit at 50 s; the floor; a new connection at 70 s
    const picture = () => (t < 10 ? at(1280, 720, 'none') : t === 30 ? at(480, 270) : t === 50 ? at(320, 180, 'cpu') : at(320, 180));
    const one = { getStats: vi.fn(async () => picture()) };
    const two = { getStats: vi.fn(async () => picture()) };
    let pc: unknown = one;
    const start = Date.now();
    const since: Record<number, number | null> = {};
    function Probe() {
      const f = useSendQuality(() => pc as RTCPeerConnection, true).floorSince;
      since[t] = f === null ? null : (f - start) / 1000;
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    for (t = 2; t <= 90; t += 2) {
      if (t === 70) pc = two;
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }
    expect([since[8], since[10], since[28], since[30], since[32], since[48], since[50], since[52], since[68], since[70], since[90]])
      .toEqual([null, 10, 10, null, 32, 32, null, 52, 52, 70, 70]);
  });

  test('starvedSince: when the send got starved above the floor (E2E N2); a good sample, a CPU limit or a new connection starts it again', async () => {
    let bytes = 0;
    let t = 0;
    const at = (w: number, h: number, sent: number, reason = 'bandwidth') =>
      report(t * 1000, (bytes += sent), { frameWidth: w, frameHeight: h, qualityLimitationReason: reason });
    // 720p until 10 s; then 480x270 at 0.03 Mbps, 960x540 at 0.03 Mbps at 20 s (a good size starved of bits), back
    // at 640x360 with 0.5 Mbps at 30 s; starved again; a CPU limit at 50 s; starved; a new connection at 70 s
    const picture = () => (t < 10 ? at(1280, 720, 575_000, 'none') : t === 20 ? at(960, 540, 7_500) : t === 30 ? at(640, 360, 125_000)
      : t === 50 ? at(480, 270, 7_500, 'cpu') : at(480, 270, 7_500));
    const one = { getStats: vi.fn(async () => picture()) };
    const two = { getStats: vi.fn(async () => picture()) };
    let pc: unknown = one;
    const start = Date.now();
    const since: Record<number, [number | null, number | null]> = {};
    function Probe() {
      const { floorSince, starvedSince } = useSendQuality(() => pc as RTCPeerConnection, true);
      since[t] = [floorSince, starvedSince].map((f) => (f === null ? null : (f - start) / 1000)) as [number | null, number | null];
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    for (t = 2; t <= 90; t += 2) {
      if (t === 70) pc = two;
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    }
    expect([8, 10, 20, 28, 30, 32, 48, 50, 52, 68, 70, 90].map((s) => since[s][1]))
      .toEqual([null, 10, 10, 10, null, 32, 32, null, 52, 52, 70, 70]);
    expect(Object.values(since).every(([floor]) => floor === null)).toBe(true); // one step above the floor, all along
  });

  test('off air it reads nothing and reports nothing', async () => {
    const pc = { getStats: vi.fn(async () => report(0, 0)) };
    let last: unknown;
    function Probe() {
      last = useSendQuality(() => pc as unknown as RTCPeerConnection, false);
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(pc.getStats).not.toHaveBeenCalled();
    expect(last).toEqual({ send: null, dropped: false, diag: null, floorSince: null, starvedSince: null });
  });
});

describe('the play window keeps the cause of a send drop until it clears', () => {
  const q = (height: number, limitation: 'none' | 'cpu' | 'bandwidth' = 'none') =>
    ({ width: Math.round(height * 16 / 9), height, fps: 30, bitrate: height < 360 ? 30_000 : 2_300_000, limitation, targetBitrate: null, encoder: null, hidden: false });
  test('a good sample while still flagged keeps "cpu" instead of turning into "low"', () => {
    let last: ReturnType<typeof heldIssue>[1] = 'low';
    const step = (dropped: boolean, sample: ReturnType<typeof q> | null) => { const [issue, cause] = heldIssue(dropped, sample, last); last = cause; return issue; };
    expect(step(false, q(720))).toBeNull();
    expect(step(true, q(180, 'cpu'))).toBe('cpu');
    expect(step(true, q(720))).toBe('cpu'); // first good sample: the drop is still flagged, no new "떨어졌어요"
    expect(step(false, q(720))).toBeNull(); // cleared: the window toasts "돌아왔어요"
    expect(step(true, q(180, 'bandwidth'))).toBe('bandwidth');
  });
});

describe('a send stuck at the WebRTC floor restarts the IVS connection, rarely (E2E D24: 27 min at 320x180)', () => {
  // 720p for ~30 s, then 320x180 at 0.02-0.03 Mbps, "bandwidth", until the stop (IVS still says HEALTHY)
  const floor: SendQuality = { width: 320, height: 180, bitrate: 30_000, fps: 22, limitation: 'bandwidth', targetBitrate: 30_000, encoder: 'OpenH264', hidden: false };

  test('the floor: 320x180 or less, held there by the bandwidth estimate or by nothing', () => {
    expect(atFloor(floor)).toBe(true);
    expect(atFloor({ ...floor, limitation: 'none' })).toBe(true);
    expect(atFloor({ ...floor, width: 284, height: 160 })).toBe(true);
    expect(atFloor({ ...floor, width: 480, height: 270 })).toBe(false); // above it
    expect(atFloor({ ...floor, limitation: 'cpu' })).toBe(false); // a new connection would not help
    expect(atFloor({ ...floor, hidden: true })).toBe(false); // the game draws nothing
    expect(atFloor({ ...floor, width: 0, height: 0 })).toBe(false); // not sending yet
  });

  /** A check every 2 s for `seconds`, the send at the floor (so starved too), or only starved, from t = 0 (and again
   * from each restart's new connection) → the times (ms) a restart was due. */
  const restarts = (seconds: number, busy = (_ms: number) => false, where: 'floor' | 'starved' = 'floor') => {
    let r = NO_RESTARTS;
    const due: number[] = [];
    for (let ms = 0; ms <= seconds * 1000; ms += 2000) {
      const since = r.at.at(-1) ?? 0;
      if (!restartDue(r, { floorSince: where === 'floor' ? since : null, starvedSince: since }, ms, busy(ms))) continue;
      r = { at: [...r.at, ms] };
      due.push(ms);
    }
    return due;
  };
  test('a minute at the floor restarts it; no floor, no restart', () => {
    expect(restarts(58)).toEqual([]);
    expect(restarts(60)).toEqual([60_000]);
    expect(restartDue(NO_RESTARTS, { floorSince: null, starvedSince: null }, 3_600_000, false)).toBe(false);
  });
  test('never while an ad cue or a round report is in flight: after it', () => {
    expect(restarts(200, (ms) => ms < 100_000)).toEqual([100_000]);
    expect(restarts(200, (ms) => ms < 100_000, 'starved')).toEqual([100_000]);
  });
  test('at most one restart in 5 minutes while stuck, and 6 an hour: the budget comes back, no cap a broadcast', () => {
    expect(restarts(20 * 60)).toEqual([60_000, 360_000, 660_000, 960_000]); // 20 minutes at the floor
    expect(restarts(20 * 60, undefined, 'starved')).toEqual([90_000, 390_000, 690_000, 990_000]); // starved: the same
    // 2 hours at the floor: 6 in the first hour, the 7th once the first is an hour old, then every 5 minutes again
    const two = restarts(2 * 3600);
    expect(two.slice(0, 7)).toEqual([60_000, 360_000, 660_000, 960_000, 1_260_000, 1_560_000, 3_660_000]);
    expect(two.every((ms, i) => two.filter((t) => t > ms - 3_600_000 && t <= ms).length <= 6 && (i === 0 || ms - two[i - 1] >= 300_000)))
      .toBe(true);
    expect(two).toHaveLength(12);
  });
});

describe('a send starved one step above the floor restarts too (E2E N2: 9 min at 480x270 to 960x540, 0.03 Mbps)', () => {
  const q = (width: number, height: number, mbps: number | null, limitation: Limitation = 'bandwidth', hidden = false): SendQuality =>
    ({ width, height, bitrate: mbps === null ? null : mbps * 1e6, fps: 24, limitation, targetBitrate: null, encoder: null, hidden });

  test('starved: under 360p, or under 0.2 Mbps with the bandwidth estimate holding it there', () => {
    expect(starved(q(480, 270, 0.03))).toBe(true); // a small size starved of bits
    expect(starved(q(960, 540, 0.13))).toBe(true); // a good size starved of bits
    expect(starved(q(320, 180, 0.03))).toBe(true); // the floor is starved too
    expect(starved(q(480, 270, 0.59, 'none'))).toBe(true); // small for no reason: counted as at the floor
    expect(starved(q(640, 360, 0.27))).toBe(false); // back at 360p by itself, still bandwidth-limited
    expect(starved(q(1280, 720, 0.03, 'none'))).toBe(false); // a still result screen needs few bits: not held down
    expect(starved(q(480, 270, 0.03, 'cpu'))).toBe(false); // a new connection would not help
    expect(starved(q(480, 270, 0.03, 'other'))).toBe(false);
    expect(starved(q(480, 270, 0.03, 'bandwidth', true))).toBe(false); // hidden: the game draws nothing
    expect(starved(q(960, 540, null))).toBe(false); // a connection's first sample: no bitrate yet
    expect(starved(q(0, 0, null))).toBe(false); // not sending yet
    expect(atFloor(q(480, 270, 0.03))).toBe(false); // what the floor restart alone missed
  });

  // Recorded samples 2 s apart, all counted as bandwidth-limited (the worst case): a starved stretch that climbed
  // back by itself (a result screen and an ad break), then one that did not.
  const ROUND3 = [[960, 540, 0.04], [960, 540, 0.07], [960, 540, 0.05], [640, 360, 0.08], [640, 360, 0.07], [480, 270, 0.07],
    [480, 270, 0.07], [480, 270, 0.07], [320, 180, 0.09], [320, 180, 0.08], [320, 180, 0.03], [320, 180, 0.06], [320, 180, 0.08],
    [320, 180, 0.12], [320, 180, 0.08], [320, 180, 0.10], [320, 180, 0.14], [320, 180, 0.18], [320, 180, 0.17], [320, 180, 0.18],
    [320, 180, 0.25], [320, 180, 0.31], [320, 180, 0.33], [320, 180, 0.43], [320, 180, 0.48], [480, 270, 0.59], [480, 270, 0.60],
    [480, 270, 0.73], [640, 360, 0.89], [640, 360, 1.0], [960, 540, 1.2], [1280, 720, 2.1]] as const;
  const N2 = [...Array(30).fill([480, 270, 0.03]), ...Array(10).fill([640, 360, 0.06]), ...Array(5).fill([960, 540, 0.13]),
    ...Array(30).fill([480, 270, 0.03])] as (readonly [number, number, number])[];
  /** Each sample's floorSince and starvedSince as useSendQuality keeps them → the sample times (s) a restart was due. */
  const replay = (samples: readonly (readonly [number, number, number])[]) => {
    let r = NO_RESTARTS;
    let floorSince: number | null = null;
    let starvedSince: number | null = null;
    const due: number[] = [];
    samples.forEach(([w, h, mbps], i) => {
      const ms = i * 2000;
      floorSince = atFloor(q(w, h, mbps)) ? floorSince ?? ms : null;
      starvedSince = starved(q(w, h, mbps)) ? starvedSince ?? ms : null;
      if (!restartDue(r, { floorSince, starvedSince }, ms, false)) return;
      r = { at: [...r.at, ms] };
      due.push(ms / 1000);
    });
    return due;
  };
  test('a starved send that climbs back by itself (54 s, 32 s of it at the floor) is left alone', () => {
    expect(replay(ROUND3)).toEqual([]);
  });
  test('N2 restarts once, 90 s in, through its 640x360 and 960x540 stretches', () => {
    expect(replay(N2)).toEqual([90]);
  });
});

describe('the floor test switch caps the broadcast\'s video sender (RTCRtpSender.setParameters)', () => {
  const sender = (kind: string, encodings: RTCRtpEncodingParameters[]) => {
    const s = {
      track: { kind }, params: { transactionId: 't1', encodings } as unknown as RTCRtpSendParameters,
      getParameters: () => JSON.parse(JSON.stringify(s.params)) as RTCRtpSendParameters,
      setParameters: vi.fn(async (p: RTCRtpSendParameters) => { s.params = p; }),
    };
    return s;
  };
  const pcOf = (...senders: unknown[]) => ({ getSenders: () => senders }) as unknown as RTCPeerConnection;

  test('0.03 Mbps (where E2E D24\'s stuck estimate held the send), on the video sender only, once', async () => {
    const audio = sender('audio', [{ active: true }]);
    const video = sender('video', [{ active: true, maxBitrate: 2_500_000 }]);
    const pc = pcOf(audio, video);
    expect(await capAtFloor(pc)).toBe(true);
    // the size is left to the encoder, which scales down to its 320x180 floor (a scaleResolutionDownBy stacks under it)
    expect(video.setParameters).toHaveBeenCalledWith({ transactionId: 't1', encodings: [{ active: true, maxBitrate: 30_000 }] });
    expect(audio.setParameters).not.toHaveBeenCalled();
    expect(await capAtFloor(pc)).toBe(true);
    expect(video.setParameters).toHaveBeenCalledTimes(1); // already capped: nothing to change
  });
  test('no video sender, or no encodings negotiated yet: not capped (the next sample tries again)', async () => {
    expect(await capAtFloor(pcOf())).toBe(false);
    expect(await capAtFloor(pcOf(sender('video', [])))).toBe(false);
  });
});

describe('an IVS ad break in flight (a restart of the send now would lose it)', () => {
  const at = Date.parse('2026-11-05T14:29:00Z');
  test('a break being inserted holds the VAST file until its place + length + 15 s (breakUntil, epoch s; warm-ups too)', () => {
    expect(breakInFlight(null, at)).toBe(false);
    expect(breakInFlight({ breakUntil: at / 1000 + 5 }, at)).toBe(true);
    expect(breakInFlight({ breakUntil: at / 1000 - 1 }, at)).toBe(false);
  });
  test('nothing else holds a restart (E2E reverify7: held 151 s by an overlay highlight, not an IVS ad break)', () => {
    // a trailer cue waiting for MediaTailor is sent by a status poll once IVS is live again: a restart does not lose it
    expect(breakInFlight({ pendingCue: { at: at / 1000, round: 4 } } as { breakUntil?: number }, at)).toBe(false);
    expect(breakInFlight({ breakUntil: 0 }, at)).toBe(false);
  });
});

describe('E2E gaps R9 (B4): the last restart is kept for the floor, replayed from the play window monitor log', () => {
  // Recorded play-window samples of a 15-minute broadcast: [s since the start, width, height, Mbps, the issue shown].
  // Two starved restarts must not spend the budget so that the floor that follows is never restarted. Every issue
  // shown was "bandwidth", so every sample counts as bandwidth-limited.
  type Row = [number, number, number, number | null, string | null];
  const rows = gapsLog as Row[];
  const q = ([, w, h, mbps, issue]: Row): SendQuality => ({ width: w, height: h, bitrate: mbps === null ? null : mbps * 1e6, fps: null,
    limitation: 'bandwidth', targetBitrate: null, encoder: null, hidden: issue === 'hidden' });
  /** useSendQuality's timers over the samples (a blank sample: a restart's new connection) → the restart times (s). */
  const replay = () => {
    let r = NO_RESTARTS;
    let floorSince: number | null = null;
    let starvedSince: number | null = null;
    const due: number[] = [];
    for (const row of rows) {
      const ms = row[0] * 1000;
      if (!row[1]) { floorSince = null; starvedSince = null; continue; }
      floorSince = atFloor(q(row)) ? floorSince ?? ms : null;
      starvedSince = starved(q(row)) ? starvedSince ?? ms : null;
      if (!restartDue(r, { floorSince, starvedSince }, ms, false)) continue;
      r = { at: [...r.at, ms] };
      due.push(Math.round(row[0]));
    }
    return due;
  };
  test('both starved stretches restart, as they did (18:45:34, 18:50:34), and the floor 5 minutes after the second', () => {
    const due = replay();
    expect(due).toHaveLength(3);
    expect(due[0]).toBeGreaterThan(100);
    expect(due[0]).toBeLessThan(135);
    expect(due[1]).toBeGreaterThanOrEqual(due[0] + 300); // the second starved restart
    expect(due[1]).toBeLessThan(due[0] + 310);
    expect(due[2]).toBeGreaterThanOrEqual(due[1] + 300); // at the floor after them: no longer left there
    expect(due[2]).toBeLessThan(due[1] + 310);
  });
  test('the floor or a starved send restarts 5 minutes after the last, the 7th of an hour waits', () => {
    const starvedOnly = { floorSince: null, starvedSince: 0 };
    const atTheFloor = { floorSince: 0, starvedSince: 0 };
    const min = 60_000;
    expect(restartDue(NO_RESTARTS, starvedOnly, 90_000, false)).toBe(true);
    expect(restartDue({ at: [0] }, starvedOnly, 10 * min, false)).toBe(true);
    expect(restartDue({ at: [0] }, atTheFloor, 299_000, false)).toBe(false); // 5 minutes apart
    expect(restartDue({ at: [0, 5, 10, 15, 20, 25].map((m) => m * min) }, atTheFloor, 31 * min, false)).toBe(false); // 6 an hour
    expect(restartDue({ at: [0, 5, 10, 15, 20, 25].map((m) => m * min) }, atTheFloor, 60 * min, false)).toBe(true);
  });
});
