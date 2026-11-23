import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, getPlayableAd, hintLauncher, livePlay, pollAdStream, pollLauncher, startAdStream, startLauncher, stopAdStream, stopLauncher, type AdPick } from '../api';
import { t } from '../i18n';
import type { StreamState } from '../types';
import { readHash } from './Tabs';

type Sdk = import('../vendor/gameliftstreams/gameliftstreams-1.3.0.mjs').GameLiftStreams;
export type WarmState = 'warming' | 'ready' | 'error';

/** A playable card was clicked: whose card (viewerId, '' = 기본), which break, and the game's playable ad (pick: the
 * clicked card's pick, which the card keeps showing until it plays or is called off). */
export interface PlayRequest { key: number; viewerId: string; eventId: string; adId: string; title: string; seconds: number;
  ctaUrl?: string; pick?: AdPick }

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const BACKOFF_MS = [5000, 15000, 60000, 180000]; // re-warm waits after consecutive losses (no play in between)
// a start the server refused (every seat taken, or a card waits in line) made no session: it asks again this soon
// at most
const REFUSED_MS = 30000;
/** The page shows every viewer's tile (시청자 4명: the watch window keeps its view in the hash, view=one for 1명 보기),
 * so any of their cards can be clicked here. */
const gridView = () => readHash('view') !== 'one';
/** The id a page gives its launcher before the server has heard of it (12 hex, the server's own format). */
const newLaunchId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
/** The name a page gives a click's own session before it asks for it (never a stream id: stopAdStream takes either). */
const newStartId = () => `st_${newLaunchId()}`;
export const QUEUE_POLL_MS = 3000; // a waiting card asks again this often (the server keeps its place for 15 s)
// the game's own end screen shows this long after its trial clock runs out: the window closes after it, but the
// bar counts only the trial seconds the card promised
const END_SCREEN_SEC = 8;
// How long a launcher still starting should take (onWarm's etaSec). A broadcast's launcher starts on a server that
// is up (the broadcast holds one), so that is the first estimate; then the last launcher's own time once one
// connected on this page; and WARM_ACTIVE_SEC once its session is ACTIVE (the WebRTC connect is left). A host
// that really is cold takes minutes: the card says so itself (prepText).
export const WARM_UP_SEC = 20;
export const WARM_ACTIVE_SEC = 10;
// a click waits this long for the page's launcher that is still starting (dropping it for the game's own session
// waits for the same host) before it asks for a seat of its own
export const LAUNCHER_WAIT_MS = 150_000;

interface Props {
  sessionId: string;
  /** The card click to serve now (the page plays one at a time); null: nothing (a wait in line is called off). */
  request: PlayRequest | null;
  /** Keep the page's warm launcher (the broadcast allows hidden sessions); else a session starts on the click. */
  standby: boolean;
  /** The broadcast owner's token: only it gets a hidden session. */
  standbyToken?: string;
  /** Whose card this page will most likely play (1명 보기's viewer, a grid's first): the launcher loads their next
   * card's game ahead of its cue. Told to the launcher at its start, and again when it changes. */
  viewerId?: string;
  /** A card is up (its viewer and break): the launcher loads that game ahead, so the click only reveals it. */
  hint?: { viewerId: string; eventId: string } | null;
  /** Over the stream while it plays: whose game this is (the expanded tile's viewer). */
  header?: ReactNode;
  /** The launcher: warming (etaSec: about how long it should still take), ready (tookSec), error. */
  onWarm?: (state: WarmState, tookSec?: number, etaSec?: number) => void;
  onPlaying?: (playing: boolean) => void;
  /** Every seat is taken: the request waits in line at this position (null: no longer waiting). */
  onQueue?: (key: number, position: number | null) => void;
  /** The play ended, with the seconds played (0: it never got an input). */
  onDone?: (req: PlayRequest, playedSec: number) => void;
  onEnded?: (shown: boolean) => void;
}

/** The page's playable ad slot over GameLift Streams, game-agnostic: while a playable broadcast runs, one session of
 * the IPverse launcher is started, connected and kept hidden (server/playable.py). A card click hands it the clicked
 * viewer's game (a signed, single-use instruction the launcher fetches), and the stream is revealed at once. Without
 * a warm launcher the click asks for a seat, waits in line when every seat is taken, and starts the game's own
 * session. Afterwards a fresh launcher warms up. Closing the window ends the session (pagehide), also one whose
 * start is still in flight. */
export function LivePlayable({ sessionId, request, standby, standbyToken, viewerId, hint, header, onWarm, onPlaying, onQueue, onDone, onEnded }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const sdk = useRef<Sdk | null>(null);
  const session = useRef<{ kind: 'launcher' | 'ad'; id: string; adId?: string } | null>(null);
  const run = useRef(0); // the click's run (and the ad session's callbacks)
  // the launcher's own run: a click keeps it going while it still starts, and uses it once it connects
  const warmRun = useRef(0);
  const warming = useRef(false); // a launcher is being started (until its signal is answered)
  // the session whose start is in flight (the launcher, or a click's own): the page named it, so it can end it before
  // the answer comes (else a window closed mid-start leaves a session holding a seat)
  const pending = useRef<{ kind: 'launcher' | 'ad'; id: string; adId?: string } | null>(null);
  const named = useRef(''); // the page's viewers as its launcher was last told (launcher | viewer | grid)
  const losses = useRef(0); // consecutive sessions lost before a play: the re-warm backs off
  const lastTook = useRef(0); // how long this page's last launcher took to connect (s), for the next one's estimate
  const [linked, setLinked] = useState(false); // the stream is connected (the game may still be loading)
  const linkedRef = useRef(false);
  linkedRef.current = linked;
  const [gen, setGen] = useState(0); // bumps to warm a new launcher (after a play, or when one is lost)
  const [current, setCurrent] = useState<PlayRequest | null>(null); // the request being played
  const playing = !!current;
  const playingRef = useRef<PlayRequest | null>(null);
  playingRef.current = current;
  const [go, setGo] = useState(false); // the close timer runs (from the first input, or 30 s after the reveal)
  const [real, setReal] = useState(false); // the viewer gave the first real input (the game starts its round then)
  const realRef = useRef(false);
  realRef.current = real;
  const startedAt = useRef(0); // when the trial started (the first input)
  const [left, setLeft] = useState(0);
  const [ended, setEnded] = useState<PlayRequest | null>(null); // the end card: the full game, or back to the broadcast
  const [cta, setCta] = useState('');
  const backoff = useRef(0); // the pending re-warm timer
  const standbyOk = useRef(true); // the server granted a hidden launcher (else: a session on the click)
  const cb = useRef({ onWarm, onPlaying, onQueue, onDone, onEnded });
  cb.current = { onWarm, onPlaying, onQueue, onDone, onEnded };

  const teardown = () => {
    sdk.current?.close();
    sdk.current = null;
    const s = session.current;
    const starting = pending.current;
    session.current = null;
    pending.current = null;
    warming.current = false;
    setLinked(false);
    for (const x of [starting, s]) {
      if (x?.kind === 'launcher') stopLauncher(sessionId, x.id).catch(() => undefined);
      else if (x?.kind === 'ad' && x.adId) stopAdStream(x.adId, x.id).catch(() => undefined); // keepalive: also on unload
    }
  };
  const rewarm = (wait: number) => {
    run.current += 1; // the old session's callbacks stop counting
    warmRun.current += 1;
    teardown();
    window.clearTimeout(backoff.current);
    backoff.current = window.setTimeout(() => { backoff.current = 0; setGen((g) => g + 1); }, wait);
  };
  const finish = (played: boolean) => {
    const req = playingRef.current;
    const secs = played && startedAt.current ? Math.min(req?.seconds ?? 0, Math.round((Date.now() - startedAt.current) / 1000)) : 0;
    setCurrent(null);
    setGo(false);
    setReal(false);
    setLeft(0); // the next card counts from its own start, never from this one's last value
    startedAt.current = 0;
    if (audio.current) audio.current.muted = true;
    losses.current = 0;
    if (req) cb.current.onDone?.(req, secs);
    if (played && req) setEnded(req);
    rewarm(0);
  };

  useEffect(() => {
    if (!ended) return;
    if (ended.ctaUrl) setCta(ended.ctaUrl);
    else void getPlayableAd(ended.adId).then((a) => setCta(a.ctaUrl), () => undefined);
    const t = window.setTimeout(() => setEnded(null), 12000);
    return () => window.clearTimeout(t);
  }, [ended]);
  useEffect(() => () => { window.clearTimeout(backoff.current); cb.current.onPlaying?.(false); cb.current.onEnded?.(false); }, []);
  useEffect(() => {
    const bye = () => { run.current += 1; warmRun.current += 1; teardown(); };
    addEventListener('pagehide', bye);
    return () => removeEventListener('pagehide', bye);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { cb.current.onPlaying?.(playing); }, [playing]);
  useEffect(() => { cb.current.onEnded?.(!!ended); }, [ended]);

  /** A GameLift Streams client on this component's video; mine() false once a newer run took over. */
  const connect = async (mine: () => boolean, open: (signal: string) => Promise<StreamState & { launchId?: string }>,
    poll: (id: string) => Promise<StreamState>, kind: 'launcher' | 'ad', adId?: string) => {
    let connected = false;
    const t0 = Date.now();
    const lost = () => {
      if (!mine()) return;
      if (playingRef.current) { finish(connected && realRef.current); return; } // the game ended or the connection dropped
      const n = losses.current++;
      setLinked(false);
      cb.current.onWarm?.('error');
      rewarm(BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]);
    };
    const { GameLiftStreams } = await import('../vendor/gameliftstreams/gameliftstreams-1.3.0.mjs');
    if (!mine()) return;
    const client = new GameLiftStreams({
      videoElement: video.current!,
      audioElement: audio.current!,
      inputConfiguration: { autoMouse: true, autoKeyboard: true, autoGamepad: true, autoPointerLock: true, setCursor: 'visibility' },
      clientConnection: {
        // connected only once media flows: a signalled session whose WebRTC path never connects is not
        connectionState: (s) => {
          if (s === 'connected' && mine() && !connected) {
            connected = true;
            setLinked(true);
            const took = Math.round((Date.now() - t0) / 1000);
            if (kind === 'launcher') lastTook.current = Math.min(30, Math.max(WARM_ACTIVE_SEC, took));
            if (kind === 'launcher' && !playingRef.current) cb.current.onWarm?.('ready', took);
          } else if (s === 'failed') lost();
        },
        channelError: () => lost(),
        serverDisconnect: () => lost(),
      },
    });
    sdk.current = client;
    const signal = await client.generateSignalRequest();
    if (!mine()) return; // cancelled while the SDK prepared: start nothing
    const started = await open(signal);
    const id = kind === 'launcher' ? started.launchId! : started.streamId;
    if (!mine()) {
      if (kind === 'launcher') stopLauncher(sessionId, id).catch(() => undefined);
      else stopAdStream(adId!, id).catch(() => undefined);
      return;
    }
    session.current = { kind, id, adId };
    let state: StreamState = started;
    while (mine() && !(state.status === 'ACTIVE' && state.signalResponse)) {
      if (state.status === 'ERROR' || state.status === 'TERMINATED' || state.status === 'TERMINATING') {
        throw new Error(state.statusReason || state.status);
      }
      await sleep(2000);
      state = await poll(id);
    }
    if (!mine()) return;
    if (kind === 'launcher' && !playingRef.current) cb.current.onWarm?.('warming', undefined, WARM_ACTIVE_SEC); // placed: the connect is left
    await client.processSignalResponse(state.signalResponse!);
    window.setTimeout(() => { if (mine() && !connected) lost(); }, 30000); // never connected
    return lost;
  };

  // keep one launcher connected and hidden while the broadcast allows it (and nothing plays or waits). A click's
  // render keeps it going for the click to use, connected or still starting (requestRef is set before the effects
  // run), and a click called off finds it still there; anything else ends it
  const requestRef = useRef(request);
  requestRef.current = request;
  const viewerIdRef = useRef(viewerId);
  viewerIdRef.current = viewerId;
  const warmable = standby && standbyOk.current && !playing && !request;
  useEffect(() => {
    if (!warmable) return;
    if (!warming.current && session.current?.kind !== 'launcher') {
      const mine = ++warmRun.current;
      const alive = () => warmRun.current === mine;
      warming.current = true;
      cb.current.onWarm?.('warming', undefined, lastTook.current || WARM_UP_SEC);
      void (async () => {
        try {
          await connect(alive, (signal) => {
            const id = newLaunchId();
            const who = viewerIdRef.current;
            const grid = gridView();
            pending.current = { kind: 'launcher', id };
            return startLauncher(sessionId, signal, standbyToken, who, { launchId: id, grid })
              .then((started) => { named.current = `${started.launchId}|${who}|${grid}`; return started; })
              .finally(() => { if (pending.current?.id === id) pending.current = null; });
          }, (id) => pollLauncher(sessionId, id), 'launcher');
          if (alive()) warming.current = false;
        } catch (e) {
          if (!alive()) return;
          warming.current = false;
          if (e instanceof ApiError && e.status === 409) { // refused (not this owner's, or the switch is OFF): on the click
            standbyOk.current = false;
            warmRun.current += 1;
            teardown();
            cb.current.onWarm?.('error');
            return;
          }
          const n = losses.current++; // the group is full or someone waits: try again later
          cb.current.onWarm?.('error');
          const wait = BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];
          rewarm(e instanceof ApiError && e.status === 503 ? Math.min(wait, REFUSED_MS) : wait);
        }
      })();
    }
    const mine = warmRun.current;
    return () => {
      if (warmRun.current !== mine || requestRef.current) return;
      warmRun.current += 1;
      teardown();
    };
  }, [sessionId, gen, warmable]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { run.current += 1; warmRun.current += 1; teardown(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // a card is up: the page's launcher (once its session exists) loads that viewer's game ahead, once per launcher and card
  const hinted = useRef('');
  const grid = gridView();
  useEffect(() => {
    const s = session.current;
    if (!hint || s?.kind !== 'launcher' || playingRef.current) return;
    const key = `${s.id}|${hint.viewerId}|${hint.eventId}`;
    if (hinted.current === key) return;
    hinted.current = key;
    void hintLauncher(sessionId, s.id, { ...hint, grid }).catch(() => undefined);
  }, [hint?.viewerId, hint?.eventId, linked, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // the page's viewers are not the ones its launcher started with (the viewer list loaded after it, the view or the
  // persona changed): the launcher is told, so the next card's games it holds are theirs
  useEffect(() => {
    const s = session.current;
    if (viewerId === undefined || s?.kind !== 'launcher' || playingRef.current) return;
    const key = `${s.id}|${viewerId}|${grid}`;
    if (named.current === key) return;
    named.current = key;
    void hintLauncher(sessionId, s.id, { viewerId, grid }).catch(() => undefined);
  }, [viewerId, grid, linked, sessionId]);

  // a click: the warm launcher opens the viewer's game now; else a seat (in line if need be) and the game's own session
  useEffect(() => {
    if (!request || playingRef.current) return;
    const req = request;
    const mine = ++run.current;
    const alive = () => run.current === mine;
    window.clearTimeout(backoff.current);
    backoff.current = 0;
    void (async () => {
      // the page's launcher is still starting: the click waits for it (the card says 준비 중 · 약 n초)
      const t0 = Date.now();
      while (alive() && (warming.current || (session.current?.kind === 'launcher' && !linkedRef.current))
        && Date.now() - t0 < LAUNCHER_WAIT_MS) await sleep(500);
      if (!alive()) return;
      const launcher = session.current?.kind === 'launcher' && linkedRef.current ? session.current : null;
      if (launcher) {
        try {
          await livePlay(sessionId, { viewerId: req.viewerId, eventId: req.eventId, launchId: launcher.id });
          if (!alive()) return;
          reveal(req);
          return;
        } catch { /* the launcher is gone or taken: a session of the game itself */ }
      }
      if (!alive()) return;
      // the launcher (if any) is not used: its seat goes back before this one asks for one
      warmRun.current += 1;
      warming.current = false;
      sdk.current?.close();
      sdk.current = null;
      const old = session.current;
      session.current = null;
      setLinked(false);
      if (old?.kind === 'launcher') await stopLauncher(sessionId, old.id).catch(() => undefined);
      let ticket: string | undefined;
      while (alive()) {
        let a;
        try { a = await livePlay(sessionId, { viewerId: req.viewerId, eventId: req.eventId, ticket }); } catch { await sleep(QUEUE_POLL_MS); continue; }
        if (!alive()) return;
        ticket = a.ticket;
        if (a.mode !== 'start') { cb.current.onQueue?.(req.key, a.position ?? 1); await sleep(QUEUE_POLL_MS); continue; }
        cb.current.onQueue?.(req.key, null);
        reveal(req);
        try {
          await connect(alive, (signal) => {
            const id = newStartId();
            pending.current = { kind: 'ad', id, adId: a.adId };
            return startAdStream(a.adId, signal, false, undefined, ticket, id)
              .finally(() => { if (pending.current?.id === id) pending.current = null; });
          }, (id) => pollAdStream(a.adId, id), 'ad', a.adId);
          return;
        } catch (e) {
          if (!alive()) return;
          if (e instanceof ApiError && e.status === 503) { setCurrent(null); continue; } // a seat went meanwhile: back in line
          finish(false);
          return;
        }
      }
    })();
    return () => { if (run.current === mine && !playingRef.current) { run.current += 1; cb.current.onQueue?.(req.key, null); } };
  }, [request?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // revealed and connected: the input goes to the game, which starts its round (and its own timer) on the first
  // input; the close timer starts then too (or after 30 s without any)
  useEffect(() => {
    if (!playing || !linked) return;
    sdk.current?.attachInput();
    video.current?.focus();
    const idle = window.setTimeout(() => { // no input yet: the close timer runs anyway (an input restarts it)
      if (realRef.current) return;
      startedAt.current = Date.now();
      setLeft((playingRef.current?.seconds ?? 0) + END_SCREEN_SEC);
      setGo(true);
    }, 30000);
    return () => window.clearTimeout(idle);
  }, [playing, linked]);
  // the first real input starts the count, set in the same render that shows it, so no earlier card's value shows
  // for a frame; the game's own end screen then shows for END_SCREEN_SEC after the trial (hidden from the bar)
  const firstInput = (e: { target: EventTarget }) => {
    if (!playing || !linked || (e.target as Element).closest('.lp-bar')) return;
    if (!realRef.current) { setLeft((current?.seconds ?? 0) + END_SCREEN_SEC); startedAt.current = Date.now(); }
    setReal(true);
    setGo(true);
  };
  useEffect(() => {
    if (!go) return;
    const t = window.setInterval(() => setLeft((n) => {
      if (n <= 1) { finish(realRef.current); return 0; }
      return n - 1;
    }), 1000);
    return () => window.clearInterval(t);
  }, [go]); // eslint-disable-line react-hooks/exhaustive-deps

  function reveal(req: PlayRequest) {
    setEnded(null);
    setCurrent(req);
    // inside the click's turn: the browser allows playback and sound now (autoplay in a fresh popup was refused)
    void video.current?.play().catch(() => undefined);
    if (audio.current) { audio.current.muted = false; void audio.current.play().catch(() => undefined); }
  }

  return (
    <>
      <div className={`lp-stage${playing ? ' is-on' : ''}`} aria-hidden={!playing}
        onPointerDownCapture={firstInput} onKeyDownCapture={firstInput}
        onClick={() => playing && linked && sdk.current?.attachInput()}>
        <video ref={video} className="lp-video" autoPlay muted playsInline disablePictureInPicture tabIndex={playing ? 0 : -1}
          aria-label={t('{title} 플레이어블 광고', { title: current?.title ?? t('게임') })} />
        <audio ref={audio} autoPlay muted />
        {playing && !linked && (
          <div className="lp-wait" role="status"><div className="spinner" aria-hidden="true" />{t('클라우드에서 게임을 여는 중이에요…')}</div>
        )}
        {playing && !real && linked && <p className="lp-hint">{t('게임이 뜨면 클릭하거나 아무 키나 누르면 시작해요')}</p>}
        {playing && (
          <div className="lp-bar">
            <span>{header}{t('플레이어블 광고')}{linked && go && left > END_SCREEN_SEC ? ` · ${t('남은 {n}초', { n: left - END_SCREEN_SEC })}` : ''}</span>
            <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); finish(real); }}>{t('닫고 방송으로')}</button>
          </div>
        )}
      </div>
      {ended && !playing && (
        <figure className="hl-overlay hl-overlay--card lp-card" role="status">
          <p className="hl-overlay-title">{t('{title} · 체험이 끝났어요', { title: ended.title })}</p>
          <figcaption>{t('플레이어블 광고')}</figcaption>
          {cta && <a className="btn btn-primary btn-sm hl-overlay-play" href={cta} target="_blank" rel="noopener noreferrer">{t('전체 게임 하러 가기')}</a>}
          <button type="button" className="btn btn-sm" onClick={() => setEnded(null)}>{t('방송으로 돌아가기')}</button>
        </figure>
      )}
    </>
  );
}
