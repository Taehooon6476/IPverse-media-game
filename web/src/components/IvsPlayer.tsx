import { useEffect, useRef } from 'react';
import wasmWorker from 'amazon-ivs-player/dist/assets/amazon-ivs-wasmworker.min.js?url';
import wasmBinary from 'amazon-ivs-player/dist/assets/amazon-ivs-wasmworker.min.wasm?url';
import { t } from '../i18n';
import { playbackSample, type PlaybackQuality, type PlaybackTick } from '../liveQuality';

type Player = import('amazon-ivs-player').MediaPlayer;

/** A stitched ad on this player. seconds: how long it still runs. late: the player told of it after it had begun
 * (its start was never told: see AD_TIME_UPDATE below), so when it began on the picture is not known. */
export interface IvsAd { on: boolean; seconds?: number; late?: boolean }

interface Props {
  /** The playback URL, with ?token= on the private channel. A new token for the same channel does not restart
   * playback (IVS checks it at load only): the next reload uses it. Another persona = another player (a React key). */
  src: string;
  ariaLabel?: string;
  /** Timed metadata (ivs:PutMetadata), fired when playback reaches the frame it rides on. */
  onMetadata?: (text: string) => void;
  /** IVS stitched ad breaks (server-side ad insertion with MediaTailor) start and end. */
  onAd?: (ad: IvsAd) => void;
  /** Seconds behind the live edge, every 2 s. */
  onLatency?: (seconds: number) => void;
  /** The player is playing the stream (a real viewer MediaTailor can see), or not. */
  onPlaying?: (playing: boolean) => void;
  /** The broadcast's picture as this viewer really gets it, every 2 s while playing and on a rendition change: decoded
   * size, measured bitrate, and the rendition the playlist advertises (liveQuality.isLowQuality / trackDrop judge it).
   * Never sampled in a stitched ad break (the ad creative is not the broadcast). */
  onQuality?: (q: PlaybackQuality) => void;
  /** The picture is stuck (no new frame for STALL_MS while the player plays or buffers) and the player reloads, or it
   * moves again. */
  onStall?: (stuck: boolean) => void;
  /** The largest picture ABR may pick (a 2×2 grid of players): a channel with renditions then plays a small one. */
  maxSize?: [number, number];
}

/** No new video frame for this long while the player plays or buffers, outside an ad break: the picture is stuck
 * (after an ingest gap the player can buffer on one frame and never resume by itself). */
export const STALL_MS = 10_000;
/** A stuck picture reloads the player after 3 s, then twice as long each time nothing moves (60 s at most). */
const stallDelay = (reloads: number) => Math.min(60_000, 3000 * 2 ** reloads);
/** A stitched ad puts the viewer further behind: it plays its full length in place of a whole number of 2 s segments,
 * usually fewer, and the player never takes it back by itself (its own live catch-up is off for IVS). After a break
 * the player plays this much faster, off the extra it has loaded ahead, until it is as far behind as before the breaks. */
const CATCHUP_RATE = 1.5;
/** Less extra delay than this (s) is left alone. */
const CATCHUP_MIN_SEC = 0.5;
/** getLiveLatency steps once a 2 s segment and stays inside this (s) at a steady delay: two readings closer than
 * this are the same delay. */
const CATCHUP_STEP_SEC = 0.3;
/** The delay a break left is read from the player this long after the ad at the earliest (getLiveLatency shows it
 * by then), and no later than CATCHUP_WINDOW_MS after it. */
const CATCHUP_SETTLE_MS = 2000;
const CATCHUP_WINDOW_MS = 12_000;
/** A catch-up never spends the buffer below the player's own low-latency minimum (s). */
const CATCHUP_BUFFER_SEC = 1;
/** An ad whose end the player never tells is over this long after its length (the page's ad line must not stay). */
const AD_OVERRUN_MS = 5000;

/** The live channel with the Amazon IVS Player (low latency; the only player IVS documents its ad events and timed
 * metadata for). A stopped stream, an error or a stuck picture reloads it after a moment; after a stitched ad it
 * plays faster for a few seconds (CATCHUP_RATE). */
export function IvsPlayer({ src, ariaLabel = t('라이브 방송'), onMetadata, onAd, onLatency, onPlaying, onQuality, onStall, maxSize }: Props) {
  const cap = useRef(maxSize);
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onMetadata, onAd, onLatency, onPlaying, onQuality, onStall });
  cb.current = { onMetadata, onAd, onLatency, onPlaying, onQuality, onStall };
  const latest = useRef(src);
  latest.current = src;
  const channel = src.split('?')[0];

  useEffect(() => {
    const el = video.current;
    if (!el || !channel) return;
    let player: Player | null = null;
    let cancelled = false;
    let retry = 0;
    let latency = 0;
    let fast = 0; // the timer that ends a catch-up
    const cues = new Map<number, { text: string; at: number }>(); // the cues held for their frames, by their timers
    void import('amazon-ivs-player').then((ivs) => {
      if (cancelled || !ivs.isPlayerSupported) return;
      const p = ivs.create({ wasmWorker, wasmBinary });
      player = p;
      p.attachHTMLVideoElement(el);
      p.setAutoplay(true);
      p.setMuted(true);
      if (cap.current) p.setAutoMaxVideoSize?.(cap.current[0], cap.current[1]);
      const { PlayerEventType: E, PlayerState: S } = ivs;
      // Quality is sampled while playing only (a stall decodes no bytes, which is not a low bitrate), and never in a
      // stitched ad break: the ad is MediaTailor's own transcode. A new picture size counts once the next sample shows
      // it too, so an ad frame decoded just outside AD_BREAK_STARTED/ENDED never passes for the broadcast's.
      let playing = false;
      let ad = false;
      let adUntil = 0; // the planned end of the ad break: a break stuck on one frame never sees its own end
      let tick: PlaybackTick | null = null;
      let size = ''; // the latest sample's picture size
      let shown = ''; // the size last reported
      // Stall watchdog (every 2 s): while the player means to play, new frames (else the playhead) must come. An ad
      // break, a hidden tab or a pending reload holds the clock; each reload while nothing moves waits longer. Once
      // stuck, frames count only from a moment of the stream newer than the last one shown: a reload during an ingest
      // gap replays the tail of a playlist that stopped growing.
      let mark = -1; // decoded frames (else the playhead) at the last check
      let newest = 0; // the newest moment of the stream shown (getSyncTime, UTC ms; 0 = unknown, frames alone count)
      let movedAt = Date.now();
      let reloads = 0; // stall reloads in a row
      let stuck = false;
      // The catch-up after a stitched break (CATCHUP_RATE). `delay` is the player's latest delay behind live at normal
      // speed outside an ad, `base` the one its breaks started at and `owed` when the last ad ended while what it added
      // is still to be read. One catch-up a break, never off a thin buffer. What a rebuffer of the broadcast added
      // (`stalled`) becomes the new base, and a reload starts over. getLiveLatency runs behind while the rate is not 1:
      // it is read at normal speed.
      let delay = 0;
      let base = 0;
      let owed = 0;
      let stalled = false;
      let rate = 1;
      // a cue's event comes when its segment is parsed, a few seconds before its frame plays: the cue is held until
      // the playhead reaches it
      const hold = (text: string, at: number) => {
        const d = at - p.getPosition();
        const ahead = d > 0 && d < 15 ? d : 0; // anything else is not this timeline: show it now
        const t = window.setTimeout(() => { cues.delete(t); if (!cancelled) cb.current.onMetadata?.(text); }, (ahead / rate) * 1000);
        cues.set(t, { text, at });
      };
      const speed = (to: number) => {
        if (to === rate) return;
        rate = to;
        p.setPlaybackRate(to);
        for (const [t, cue] of [...cues]) { window.clearTimeout(t); cues.delete(t); hold(cue.text, cue.at); }
      };
      const slow = () => { window.clearTimeout(fast); fast = 0; speed(1); };
      const catchUp = (l: number) => {
        const since = Date.now() - owed;
        if (!owed || since > CATCHUP_WINDOW_MS || !base) {
          if (stalled && base && l - base >= CATCHUP_MIN_SEC) base = l;
          owed = 0;
          stalled = false;
          delay = l;
          return;
        }
        // a hidden tab's timers are throttled (a catch-up would overrun): it is read once the tab shows again
        if (since < CATCHUP_SETTLE_MS || l - base < CATCHUP_MIN_SEC || document.visibilityState === 'hidden') return;
        const buffer = p.getBufferDuration();
        const extra = Math.min(l - base, Number.isFinite(buffer) ? buffer - CATCHUP_BUFFER_SEC : Infinity);
        if (extra < CATCHUP_MIN_SEC) return;
        owed = 0;
        speed(CATCHUP_RATE);
        fast = window.setTimeout(slow, (extra / (CATCHUP_RATE - 1)) * 1000);
      };
      const reload = (ms = 3000) => {
        window.clearTimeout(retry);
        ad = false;
        slow();
        delay = base = owed = 0;
        stalled = false;
        cb.current.onAd?.({ on: false }); // a reload mid-break never sees its end
        if (!cancelled) retry = window.setTimeout(() => { retry = 0; movedAt = Date.now(); p.load(latest.current); p.play(); }, ms);
      };
      const watch = () => {
        const now = Date.now();
        const at = el.getVideoPlaybackQuality?.().totalVideoFrames ?? el.currentTime;
        const sync = p.getSyncTime();
        const fresh = !newest || sync > newest;
        if (sync > newest) newest = sync;
        const moved = at > mark && (!stuck || fresh); // a reload starts the count again: not a move
        mark = at;
        if (moved) {
          movedAt = now;
          reloads = 0;
          if (stuck) { stuck = false; window.clearTimeout(retry); retry = 0; cb.current.onStall?.(false); }
        } else if (p.isPaused() || (ad && now < adUntil) || retry || document.visibilityState === 'hidden') {
          movedAt = now;
        } else if (now - movedAt >= STALL_MS) {
          if (!stuck) { stuck = true; cb.current.onStall?.(true); }
          reload(stallDelay(reloads++));
        }
      };
      p.addEventListener(E.TEXT_METADATA_CUE, (cue) => hold(cue.text, cue.startTime));
      // A stitched ad is on from whichever of the player's ad events comes first: AD_BREAK_STARTED is @beta and does not
      // always arrive, so a creative's start and the ad's progress count too. Progress alone is late (the ad has been
      // on for breakElapsed already), and the page takes no timing from it.
      let over = ''; // the break that ended last: what still comes of it starts nothing
      /** own: the break's own start (never held back). late: told after the ad had begun. */
      const adOn = (id: string, seconds: number, late: boolean, own = false) => {
        const until = Date.now() + (seconds > 0 ? seconds : 60) * 1000;
        if (ad) { if (late) adUntil = Math.max(adUntil, until); return; } // (its progress: the ad is still going)
        if (!own && id && id === over) return;
        ad = true;
        adUntil = until;
        slow(); // the ad plays at normal speed
        owed = 0;
        stalled = false; // a stall at the ad's edge is the ad's
        // lower only when an ad left the player closer to live (shorter than the segments it replaced); following the
        // reading's own steps down would wear the buffer away break by break
        if (delay && (!base || delay < base - CATCHUP_STEP_SEC)) base = delay;
        cb.current.onAd?.({ on: true, seconds, ...(late ? { late } : {}) });
      };
      const adOff = (id = '') => {
        over = id || over;
        const was = ad;
        ad = false;
        owed = Date.now();
        tick = null; // the decoded bytes since the last sample are the ad's
        size = '';
        if (was) cb.current.onAd?.({ on: false });
      };
      p.addEventListener(E.AD_BREAK_STARTED, (b) => adOn(b.adBreakId, b.duration, false, true));
      // (both @beta, and absent from an SDK older than the ad events' second batch: not listened for there)
      if (E.AD_CREATIVE_STARTED) p.addEventListener(E.AD_CREATIVE_STARTED, (c) => adOn(c.adBreakId, c.duration, c.podIndex > 1));
      if (E.AD_TIME_UPDATE) p.addEventListener(E.AD_TIME_UPDATE, (t) => { if (t.breakDuration > t.breakElapsed) adOn(t.adBreakId, t.breakDuration - t.breakElapsed, true); });
      p.addEventListener(E.AD_BREAK_ENDED, (b) => adOff(b?.adBreakId));
      const sample = () => {
        if (ad) return;
        const s = playbackSample(p, el, tick);
        tick = s.tick;
        const now = `${s.quality.width}x${s.quality.height}`;
        const steady = now === shown || now === size;
        size = now;
        if (!steady) return;
        shown = now;
        cb.current.onQuality?.(s.quality);
      };
      const paused = () => { playing = false; tick = null; slow(); cb.current.onPlaying?.(false); };
      p.addEventListener(E.QUALITY_CHANGED, () => { if (playing) sample(); });
      p.addEventListener(E.ERROR, () => { paused(); reload(); });
      p.addEventListener(S.ENDED, () => { paused(); reload(); });
      p.addEventListener(S.PLAYING, () => { playing = true; cb.current.onPlaying?.(true); });
      p.addEventListener(S.IDLE, paused);
      p.addEventListener(S.BUFFERING, () => { if (!ad) stalled = true; paused(); });
      p.load(latest.current);
      p.play();
      latency = window.setInterval(() => {
        // an ad whose end was never told (its progress has stopped and its length is over): not on for good
        if (ad && Date.now() >= adUntil + AD_OVERRUN_MS) adOff();
        const l = p.getLiveLatency();
        const known = Number.isFinite(l) && l > 0;
        if (known) cb.current.onLatency?.(l);
        if (known && playing && !ad && !fast) catchUp(l);
        if (playing) sample();
        watch();
      }, 2000);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      window.clearTimeout(fast);
      window.clearInterval(latency);
      cues.forEach((_, t) => window.clearTimeout(t));
      player?.delete();
      cb.current.onAd?.({ on: false });
      cb.current.onPlaying?.(false);
      cb.current.onStall?.(false);
    };
  }, [channel]);

  // no native controls: on a live, view-only stream they show a VOD elapsed time and a seek bar
  return <video ref={video} muted playsInline aria-label={ariaLabel} />;
}
