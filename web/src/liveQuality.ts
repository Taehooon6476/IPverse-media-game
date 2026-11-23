import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

/** Live picture quality, measured where it happens: what the play window's WebRTC encoder sends to Amazon IVS, and
 * what a viewer's IVS Player decodes. IVS stream health stays HEALTHY while the picture collapses, so the windows
 * judge the picture themselves. */
export interface VideoQuality {
  width: number; // pixels; 0 = unknown (not playing yet)
  height: number;
  bitrate: number | null; // video bits per second
  fps: number | null;
}

/** Why the encoder sends less than it could (WebRTC qualityLimitationReason). */
export type Limitation = 'none' | 'cpu' | 'bandwidth' | 'other';

export interface SendQuality extends VideoQuality {
  limitation: Limitation;
  targetBitrate: number | null; // what the bandwidth estimate lets the encoder use, bps
  encoder: string | null; // e.g. OpenH264 (software) or a hardware encoder
  hidden: boolean; // the play window is hidden: the game draws no frames and the broadcast freezes
}

export interface PlaybackQuality extends VideoQuality {
  /** The rendition the playlist advertises (a BASIC channel keeps saying 1280x720 while it carries 320x180). */
  advertised: { width: number; height: number; bitrate: number } | null;
}

/** A low picture is under 360p: WebRTC shrinks the 720p game first when the CPU or the network cannot keep up. A low
 * bitrate alone is not a drop: a still scene needs little, and a 2 s reading of decoded bytes is bursty. */
export const LOW_HEIGHT = 360;
export const LOW_BITRATE = 300_000; // the broadcast sends ~2.3 Mbps at 720p

export const isLowQuality = (q: VideoQuality) => q.height > 0 && q.height < LOW_HEIGHT;

/** A drop is flagged after DROP_SAMPLES low samples in a row (2 s apart) and cleared after as many good ones. */
export const DROP_SAMPLES = 3;
/** A new WebRTC connection starts small and ramps up over ~8 s: samples this soon after a (re)connect or a stream
 * start do not count as a drop. */
export const WARMUP_MS = 20_000;
export interface DropState { dropped: boolean; run: number }
export const NO_DROP: DropState = { dropped: false, run: 0 };
export function trackDrop(d: DropState, low: boolean): DropState {
  if (low === d.dropped) return { dropped: d.dropped, run: 0 };
  const run = d.run + 1;
  return run >= DROP_SAMPLES ? { dropped: low, run: 0 } : { dropped: d.dropped, run };
}

export type SendIssue = 'hidden' | 'cpu' | 'bandwidth' | 'low';
/** What is wrong with the broadcast right now, or null: a hidden window, a low picture, or an encoder that the CPU or
 * the network holds under 0.3 Mbps (a still scene is low on bits too, but not "limited"). */
export function sendIssue(q: SendQuality): SendIssue | null {
  if (q.hidden) return 'hidden';
  const starved = q.limitation !== 'none' && q.bitrate != null && q.bitrate < LOW_BITRATE;
  if (!isLowQuality(q) && !starved) return null;
  return q.limitation === 'cpu' || q.limitation === 'bandwidth' ? q.limitation : 'low';
}
/** The issue to show while a send drop is flagged. A good sample can arrive before the drop clears: keep the cause
 * that raised the flag instead of falling back to 'low'. → [issue or null when not dropped, the cause to remember] */
export function heldIssue(dropped: boolean, q: SendQuality | null, last: SendIssue): [SendIssue | null, SendIssue] {
  if (!dropped || !q) return [null, last];
  const cause = sendIssue(q);
  return [cause ?? last, cause ?? last];
}
export const SEND_ISSUE_TEXT: Record<SendIssue, string> = {
  hidden: t('플레이 창이 가려지거나 최소화돼 게임 화면이 멈췄어요. 플레이 창을 화면에 띄워 두세요.'),
  cpu: t('이 PC의 CPU가 부족해 송출 화질이 떨어졌어요. 다른 창이나 탭을 닫아 보세요.'),
  // WebRTC says "bandwidth" for a starved sender too: its estimate falls when packets leave late
  bandwidth: t('송출 대역폭이 부족해 화질이 떨어졌어요. 네트워크가 느리거나 이 PC의 CPU가 부족할 수 있어요.'),
  low: t('송출 화질이 떨어졌어요.'),
};

/** "1280×720 · 2.3 Mbps · 30fps" */
export function qualityText(q: VideoQuality): string {
  return [q.width && q.height ? `${q.width}×${q.height}` : '',
    q.bitrate != null ? `${(q.bitrate / 1e6).toFixed(q.bitrate < 1e6 ? 2 : 1)} Mbps` : '',
    q.fps != null ? `${Math.round(q.fps)}fps` : ''].filter(Boolean).join(' · ');
}

/** What is low in a sample: its size under 360p, else its bitrate ("480×270", "0.03 Mbps"; '' when unknown). */
export const lowFigure = (q: VideoQuality) =>
  isLowQuality(q) ? `${q.width}×${q.height}` : qualityText({ width: 0, height: 0, bitrate: q.bitrate, fps: null });

/** The state chip's words for a flagged drop: what is low in the latest sample, or "화질 회복 중" when that sample
 * is good (`low` false): the flag clears only after DROP_SAMPLES good samples in a row. */
export function dropText(q: VideoQuality, low: boolean): string {
  if (!low) return t('화질 회복 중');
  const figure = lowFigure(q);
  return figure ? t('화질 저하 {figure}', { figure }) : t('화질 저하');
}

// ── the play window: the IVS Web Broadcast sender's WebRTC stats ──

type Stats = { forEach: (cb: (s: Record<string, unknown>) => void) => void };
export interface SendSample { bytes: number; at: number }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** An RTCStatsReport → the outgoing video, with its bitrate from the bytes sent since `prev` (null on the first report
 * or after a counter reset, e.g. a reconnect's new peer connection). null: no video sender yet. */
export function readSendStats(report: Stats, prev: SendSample | null, hidden = false): { quality: SendQuality; sample: SendSample } | null {
  const video: Record<string, unknown>[] = [];
  report.forEach((s) => { if (s.type === 'outbound-rtp' && (s.kind ?? s.mediaType) === 'video') video.push(s); });
  if (!video.length) return null;
  const sum = (k: string) => video.reduce((t, s) => t + (num(s[k]) ?? 0), 0);
  const max = (k: string) => Math.max(0, ...video.map((s) => num(s[k]) ?? 0));
  const bytes = sum('bytesSent');
  const at = max('timestamp');
  const reason = video.map((s) => s.qualityLimitationReason).find((r) => r && r !== 'none');
  const fps = video.map((s) => num(s.framesPerSecond)).find((v) => v != null) ?? null;
  const target = video.some((s) => num(s.targetBitrate) != null) ? sum('targetBitrate') : null;
  const dt = prev ? (at - prev.at) / 1000 : 0;
  return {
    quality: {
      width: max('frameWidth'), height: max('frameHeight'), fps,
      bitrate: prev && dt > 0 && bytes >= prev.bytes ? Math.round((8 * (bytes - prev.bytes)) / dt) : null,
      limitation: !reason ? 'none' : reason === 'cpu' || reason === 'bandwidth' ? reason : 'other',
      targetBitrate: target, encoder: typeof video[0].encoderImplementation === 'string' ? video[0].encoderImplementation : null, hidden,
    },
    sample: { bytes, at },
  };
}

/** Diagnostics of the send: the bandwidth estimate (avail, bps), the RTT (ms, from the ingest's report, else the ICE
 * pair's), packets lost and the fraction of the last report, NACKs and PLIs received, the limit, frames encoded and
 * sent (counters: compare two samples), and the encoder's target (bps). null fields: not in this report. */
export interface SendDiag {
  avail: number | null; rtt: number | null; lost: number | null; fracLost: number | null; nack: number | null; pli: number | null;
  reason: string | null; encoded: number | null; sent: number | null; target: number | null;
}
export function readSendDiag(report: Stats): SendDiag | null {
  let video: Record<string, unknown> | null = null;
  let remote: Record<string, unknown> | null = null;
  let pair: Record<string, unknown> | null = null;
  report.forEach((s) => {
    const kind = s.kind ?? s.mediaType;
    if (s.type === 'outbound-rtp' && kind === 'video') video ??= s;
    else if (s.type === 'remote-inbound-rtp' && kind === 'video') remote ??= s;
    else if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair ??= s;
  });
  if (!video) return null;
  const v: Record<string, unknown> = video;
  const rem: Record<string, unknown> = remote ?? {};
  const p: Record<string, unknown> = pair ?? {};
  const ms = (sec: number | null) => (sec === null ? null : Math.round(sec * 1000));
  return {
    avail: num(p.availableOutgoingBitrate), rtt: ms(num(rem.roundTripTime) ?? num(p.currentRoundTripTime)),
    lost: num(rem.packetsLost), fracLost: num(rem.fractionLost), nack: num(v.nackCount), pli: num(v.pliCount),
    reason: typeof v.qualityLimitationReason === 'string' ? v.qualityLimitationReason : null,
    encoded: num(v.framesEncoded), sent: num(v.framesSent), target: num(v.targetBitrate),
  };
}

/** The IVS Web Broadcast client (1.41) keeps its RTCPeerConnection on an internal `peerClient`; it has no public stats
 * API. If a later SDK moves it, this returns null and the send quality is unknown (never "healthy"). */
export function peerConnectionOf(client: unknown): RTCPeerConnection | null {
  const pc = (client as { peerClient?: { peerConnection?: unknown } } | null)?.peerClient?.peerConnection;
  return pc && typeof (pc as RTCPeerConnection).getStats === 'function' ? (pc as RTCPeerConnection) : null;
}

/** WebRTC never scales the 720p broadcast below 320x180. A send held there by the bandwidth estimate does not climb
 * back by itself, while a new connection starts a new estimate. Only "bandwidth" or "none" count: a CPU limit or a
 * hidden window stays the same on a new connection. */
export const FLOOR_PIXELS = 320 * 180;
export const atFloor = (q: SendQuality) => !q.hidden && q.height > 0 && q.width * q.height <= FLOOR_PIXELS
  && (q.limitation === 'bandwidth' || q.limitation === 'none');

/** The same stuck estimate can hold the send a step above the floor. Starved: a picture under 360p held by the
 * estimate or by nothing (as at the floor), or a bitrate under 0.2 Mbps the estimate holds ("bandwidth": a still
 * scene needs few bits but is not held). 0.2 Mbps sits between stuck sends (0.13 Mbps at most) and sends that
 * climb back by themselves (0.27 Mbps or more). */
export const STARVED_BITRATE = 200_000;
export const starved = (q: SendQuality) => !q.hidden && q.height > 0 && (q.limitation === 'bandwidth'
  ? isLowQuality(q) || (q.bitrate != null && q.bitrate < STARVED_BITRATE)
  : q.limitation === 'none' && isLowQuality(q));

/** The broadcast's own send quality, read every 2 s while `on`: { send: the latest sample, dropped: a sustained
 * problem (trackDrop over sendIssue, after the warm-up), diag: the same report as diagnostics (readSendDiag),
 * floorSince / starvedSince: since when this connection's send has sat at the floor / been starved, else null }.
 * The peer connection is looked up on every read: a reconnect makes a new one, which ramps up again. */
export function useSendQuality(peer: () => RTCPeerConnection | null, on: boolean, everyMs = 2000, warmupMs = WARMUP_MS) {
  const [state, setState] = useState<{ send: SendQuality | null; dropped: boolean; diag: SendDiag | null } & Stuck>(
    { send: null, dropped: false, diag: null, floorSince: null, starvedSince: null });
  const getPeer = useRef(peer);
  getPeer.current = peer;
  useEffect(() => {
    if (!on) { setState({ send: null, dropped: false, diag: null, floorSince: null, starvedSince: null }); return; }
    let alive = true;
    let prev: SendSample | null = null;
    let pc: RTCPeerConnection | null = null;
    let since = 0;
    let drop = NO_DROP;
    let floorSince: number | null = null;
    let starvedSince: number | null = null;
    const read = async () => {
      const now = getPeer.current();
      if (now !== pc) { pc = now; prev = null; since = Date.now(); floorSince = null; starvedSince = null; }
      if (!pc) return;
      try {
        const report = await pc.getStats();
        const got = readSendStats(report, prev, document.visibilityState === 'hidden');
        if (!alive || !got) return;
        prev = got.sample;
        const issue = sendIssue(got.quality);
        const ramp = issue !== null && issue !== 'hidden' && Date.now() - since < warmupMs;
        if (!ramp) drop = trackDrop(drop, issue !== null);
        floorSince = atFloor(got.quality) ? floorSince ?? Date.now() : null;
        starvedSince = starved(got.quality) ? starvedSince ?? Date.now() : null;
        setState({ send: got.quality, dropped: drop.dropped, diag: readSendDiag(report), floorSince, starvedSince });
      } catch { /* closed meanwhile: the next read finds the new one */ }
    };
    void read();
    const t = window.setInterval(read, everyMs);
    return () => { alive = false; window.clearInterval(t); };
  }, [on, everyMs, warmupMs]);
  return state;
}

/** A minute at the floor restarts the IVS connection, rarely: a link that really is this slow would only drop again,
 * and each restart blinks the broadcast for its viewers. */
export const FLOOR_RESTART_MS = 60_000;
/** 90 s starved restarts it too: drops that climb back by themselves were starved under a minute. */
export const STARVED_RESTART_MS = 90_000;
export const RESTART_GAP_MS = 5 * 60_000;
/** A budget per hour, not a cap per broadcast: a viewer blink every 5 minutes beats a broadcast stuck at the floor. */
export const RESTARTS_AN_HOUR = 6;
const HOUR_MS = 3_600_000;
/** This broadcast's restarts (epoch ms, oldest first). */
export interface Restarts { at: number[] }
export const NO_RESTARTS: Restarts = { at: [] };
/** Since when this connection's send has sat at the floor / been starved, else null (useSendQuality). */
export interface Stuck { floorSince: number | null; starvedSince: number | null }
/** Restart the send now? A minute at the floor or 90 s starved (from useSendQuality), nothing in flight (busy: an ad
 * cue or a round report would be lost in the restart), the last restart 5 minutes ago or more, and fewer than 6 in
 * the last hour. */
export function restartDue(r: Restarts, stuck: Stuck, now: number, busy: boolean): boolean {
  const long = (stuck.floorSince !== null && now - stuck.floorSince >= FLOOR_RESTART_MS)
    || (stuck.starvedSince !== null && now - stuck.starvedSince >= STARVED_RESTART_MS);
  const last = r.at.at(-1);
  return long && !busy && (last === undefined || now - last >= RESTART_GAP_MS)
    && r.at.filter((t) => now - t < HOUR_MS).length < RESTARTS_AN_HOUR;
}

/** Test switch: #play=…&demo=1&floortest=1 (the demo play window only). A send cannot be held at the floor from
 * outside (DevTools network emulation does not reach WebRTC), so the play window caps its own video sender at
 * 0.03 Mbps (RTCRtpSender.setParameters maxBitrate) and Chrome's encoder takes the picture down to the floor.
 * scaleResolutionDownBy is left alone: the encoder's own scaling stacks on it.
 * → whether the cap is on (false: no video sender or no negotiated encodings yet, the next sample tries again). */
export const FLOOR_TEST_BITRATE = 30_000;
export async function capAtFloor(pc: RTCPeerConnection): Promise<boolean> {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  const params = sender?.getParameters();
  if (!sender || !params?.encodings?.length) return false;
  if (params.encodings.every((e) => e.maxBitrate === FLOOR_TEST_BITRATE)) return true;
  params.encodings = params.encodings.map((e) => ({ ...e, maxBitrate: FLOOR_TEST_BITRATE }));
  await sender.setParameters(params);
  return true;
}

/** An IVS ad break is being inserted, so a restart of the send now could lose it: the server holds the VAST file for
 * it (job.breakUntil, epoch seconds) from its InsertAdBreak to its place in the stream + its length + 15 s. Nothing
 * else holds a restart: overlays and playable cards are timed metadata, and a trailer cue still waiting is sent by
 * a status poll once IVS is live again. */
export function breakInFlight(job: { breakUntil?: number } | null | undefined, now: number): boolean {
  return (job?.breakUntil ?? 0) * 1000 > now;
}

// ── the watch window: what the Amazon IVS Player decodes ──

type PlayerLike = { getQuality?: () => { width: number; height: number; bitrate: number } | undefined;
  getVideoBitRate?: () => number; getVideoFrameRate?: () => number };
type VideoLike = { videoWidth: number; videoHeight: number; webkitVideoDecodedByteCount?: number };
export interface PlaybackTick { bytes: number; at: number }

/** The picture the viewer gets: the decoded frame size (the video element), the bitrate from the video bytes decoded
 * since `prev` (Chromium/WebKit count them), else the player's own figure, and the advertised rendition beside it.
 * getVideoBitRate/getVideoFrameRate are on the IVS Player 1.58 object but not in its typings: used when present. */
export function playbackSample(p: PlayerLike, el: VideoLike, prev: PlaybackTick | null, at = performance.now()):
  { quality: PlaybackQuality; tick: PlaybackTick | null } {
  const positive = (v: unknown) => { const n = num(v); return n != null && n > 0 ? n : null; };
  const bytes = num(el.webkitVideoDecodedByteCount);
  const dt = prev && bytes != null ? (at - prev.at) / 1000 : 0;
  const measured = prev && bytes != null && dt > 0 && bytes >= prev.bytes ? Math.round((8 * (bytes - prev.bytes)) / dt) : null;
  const q = p.getQuality?.();
  return {
    quality: { width: el.videoWidth || 0, height: el.videoHeight || 0, bitrate: measured ?? positive(p.getVideoBitRate?.()),
      fps: positive(p.getVideoFrameRate?.()), advertised: q && q.height > 0 ? { width: q.width, height: q.height, bitrate: q.bitrate } : null },
    tick: bytes != null ? { bytes, at } : null,
  };
}
