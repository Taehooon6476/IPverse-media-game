import { useCallback, useEffect, useRef, useState } from 'react';
import { getSession, highlightCreate, liveRound, liveRoundEta, liveStart, liveBeat, liveStatus, liveStop, type LiveAdType, type LiveState,
  type RoundAnswer } from '../api';
import type { Game, Snapshot } from '../types';
import { said, t, tn } from '../i18n';
import { ActionButton } from './ActionButton';
import { LiveLimit } from './LiveLimit';
import { clockText } from '../liveDelay';
import { DEFAULT_SETTINGS, LIVE_LIMIT_LINE, LIVE_MAX_MINUTES, STYLE_NAME, errorText, lastBroadcast, loginExpired, playableServerLine, type ConsoleHandle, type LiveSettings } from '../liveSettings';
import { FLOOR_RESTART_MS, NO_RESTARTS, SEND_ISSUE_TEXT, breakInFlight, capAtFloor, dropText, heldIssue, lowFigure, peerConnectionOf,
  qualityText, restartDue, sendIssue, useSendQuality, type SendIssue } from '../liveQuality';
import { CALLED_OFF, TOOK_OVER, needsTakeover, useCalledOff, useTakeoverQuestion } from './TakeoverDialog';
import { Toasts, type Toast } from './Toasts';

interface Props {
  sessionId: string;
  gameId: string;
}

type Client = { startBroadcast: (key: string) => Promise<void>; stopBroadcast: () => void;
  addVideoInputDevice: (s: MediaStream, name: string, o: { index: number; x?: number; y?: number; width?: number; height?: number }) => Promise<void>;
  removeVideoInputDevice: (name: string) => void;
  getVideoInputDevice: (name: string) => { element: unknown } | undefined;
  addAudioInputDevice: (s: MediaStream, name: string) => Promise<void>;
  on: (event: string, cb: (value: string) => void) => void;
  addImageSource: (img: HTMLCanvasElement, name: string, o: { index: number; x?: number; y?: number; width?: number; height?: number }) => Promise<void> };
/** A field of the server's job that LiveState leaves out: an IVS ad break holds the VAST file until breakUntil (epoch s). */
type JobBreak = { breakUntil?: number };
/** A round report's cue shows in the status a poll (4 s) later: the report counts as in flight until then. */
const REPORT_SETTLE_MS = 10_000;
/** A restart waits this long at most for IVS to end the old stream session, then for the new one to be live. */
const CHANNEL_WAIT_MS = 20_000;

/** An estimated round end (a race's last stretch): the server sends its break this long before the end it was told
 * (server/live.py: the lead less PRECUE_EST_MARGIN_SEC), and an estimate that moved by more than ETA_SLIP_SEC before
 * that is taken back: the round's ad then goes out at its report, late but never over the race's last metres. */
const ETA_CALL_SEC = 1;
const ETA_SLIP_SEC = 0.5;
/** An ad round whose end was not told ahead is held at its end for this long (ms), until the report's answer says
 * how long (holdSec): the built-in player starts the next round 4 s after the end. */
const PROVISIONAL_HOLD_MS = 6000;

/** The server's clock against this PC's, from the status polls (LiveState.now). An answer's way back is taken as
 * half the round trip, CLOCK_BACK_MAX_MS at most (too long a way back would name a round's end late); the sample
 * with the shortest round trip of the last 8 counts. */
type ClockSample = { rtt: number; offset: number };
const CLOCK_BACK_MAX_MS = 150;
function serverClock(samples: ClockSample[], now: number | undefined, t0: number, t1: number): ClockSample[] {
  if (typeof now !== 'number') return samples;
  return [...samples, { rtt: t1 - t0, offset: now * 1000 + Math.min((t1 - t0) / 2, CLOCK_BACK_MAX_MS) - t1 }].slice(-8);
}
/** Server clock minus this PC's clock (ms), or null before the first poll that told it. */
const clockOffset = (samples: ClockSample[]) => (samples.length ? samples.reduce((a, b) => (b.rtt <= a.rtt ? b : a)).offset : null);

/** The session's newest trailer: the broadcast's default ad. */
const newestTrailer = (s: Snapshot | null) => s?.assets.filter((a) => a.kind === 'trailer').at(-1);
/** A trailer or corner broadcast with no trailer in the session: where one is made (the 영상 tab's own button). */
const NO_TRAILER = t('이 세션에 트레일러가 아직 없어요. 영상 탭의 ‘연출해서 만들기’로 트레일러를 만들거나, 스튜디오의 라이브 방송 창에서 ‘플레이어블 광고’를 골라 주세요.');
const LINK_LOST = t('방송 연결이 끊겨서 방송을 껐어요. ‘라이브 켜기’를 다시 눌러 주세요.');
/** The game's briefing while it waits for 임무 시작 (game3d/runtime3d.js): shown, and not the one shown again between
 * rounds. */
const BRIEFING_WAITS = '.briefing:not([hidden]):not(.again)';
const errorMessage = errorText;

/** What round n's report did, in plain words, for the toast ('' = no ad this round). */
function roundToast(n: number, r: RoundAnswer, style: LiveAdType = 'trailer', demo = false): string {
  const corner = t('시청 창 구석에 코너 트레일러가 떠요 (방송은 끊기지 않아요)');
  const skip = [...(r.breaks ?? [])].reverse().find((b) => b.round === n && b.kind === 'skip' && b.of !== 'playable');
  // a corner that went out in a full-screen trailer's place (none was ready to air): the server's sentence on why
  const why = r.corner ? [...(r.breaks ?? [])].reverse().find((b) => b.round === n && b.kind === 'corner' && b.note)?.note : '';
  const text = why ? why
    : r.deferred ? `${t('플레이어블 카드는 서버가 준비되면 다음 판 끝에 나가요')}${r.corner ? ` · ${t('이번 판은 코너 트레일러가 떠요')}` : ''}`
    // a pre-cue that found the last ad still on air (or no room) keeps its round: no ad went out
    : skip ? t('이번 판은 전체 화면 트레일러를 건너뛰었어요 ({why})', { why: skip.reason === 'no_room' ? t('다음 광고까지 시간 부족') : t('앞 광고가 아직 방송 중') })
    : r.preCued ? t('전체 화면 트레일러를 미리 보냈어요 · 판이 끝난 직후 시작돼요')
    : r.corner || (r.cued && style === 'corner') ? corner
    : !r.cued ? ''
    : style === 'playable' ? t('시청 창에 플레이어블 광고 카드가 떠요')
    : `${t('전체 화면 트레일러가 약 {n}초 뒤 시작돼요', { n: 10 })}${r.holdSec && demo ? ` · ${t('그동안 결과 화면 유지')}` : ''}`;
  return text && `${t('{n}판 종료', { n })} · ${text}`;
}

/** Separate window: the user plays the game here; 라이브 켜기 publishes this window's game canvas to IVS (WebRTC),
 * viewers play the IVS channel; every N finished rounds the server inserts the ad (IVS ad break with MediaTailor,
 * or the playable card as timed metadata). On air with highlights on, each round's start and end go to the
 * server, which cuts the round out of the channel's IVS recording into a highlight short. Nothing is recorded or
 * uploaded here: a clip upload sinks this window's WebRTC send to 320x180. */
export function PlayWindow({ sessionId, gameId }: Props) {
  // one window a game: the console sends a play window left on another game to its own (a new #play=…&g=… in the
  // same page), and that one starts over instead of keeping the old game's rounds and state
  return <PlayGame key={`${sessionId}:${gameId}`} sessionId={sessionId} gameId={gameId} />;
}

function PlayGame({ sessionId, gameId }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [every, setEvery] = useState(DEFAULT_SETTINGS.everyRounds);
  const [everyTyped, setEveryTyped] = useState(false); // the number was typed here: it wins over the console's
  const [onAir, setOnAir] = useState(false);
  const [rounds, setRounds] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);
  const client = useRef<Client | null>(null);
  const roundStart = useRef(0); // when the round being played started (epoch ms)
  const onAirAt = useRef(0); // when this broadcast went on air (epoch ms)
  const liveRef = useRef<LiveState | null>(null); // the watch window's 자동 생성 toggle arrives with the status poll
  liveRef.current = live;
  const surface = useRef<HTMLCanvasElement | null>(null);
  const stampTimer = useRef(0);
  const seq = useRef(0);
  const toast = useCallback((level: Toast['level'], text: string) => setToasts((l) => [...l, { level, text, id: ++seq.current }].slice(-3)), []);
  // what this window really sends to IVS (the IVS client's WebRTC stats, every 2 s on air): sendQuality.send is the
  // latest sample, sendQuality.dropped a sustained problem, sendIssue(send) why (hidden window, cpu, bandwidth)
  const sendQuality = useSendQuality(() => peerConnectionOf(client.current), onAir);
  // Toast when the send quality drops (with the reason) and when it recovers; the status pill keeps the state
  const lastCause = useRef<SendIssue>('low');
  const [issue, cause] = heldIssue(onAir && sendQuality.dropped, sendQuality.send, lastCause.current);
  lastCause.current = cause;
  const issueShown = useRef<SendIssue | null>(null);
  useEffect(() => {
    if (issue === issueShown.current) return;
    const was = issueShown.current;
    issueShown.current = issue;
    if (issue) toast('error', SEND_ISSUE_TEXT[issue]);
    else if (was && onAir) toast('ok', t('송출 화질이 돌아왔어요.'));
  }, [issue, onAir, toast]);
  // A send stuck at the WebRTC floor (320x180), or starved a step above it, restarts the IVS connection:
  // stopBroadcast + startBroadcast on the same client and stream, so a new peer connection starts a new bandwidth
  // estimate. Rarely (restartDue), and never while an IVS ad break is being inserted or a round report is in flight:
  // the restart blinks the stream, and a break sent into it would be lost. IVS ends the stopped connection's stream
  // session 4-7 s later, and a connection published before that loses its new session with it: so the restart
  // publishes once the channel is offline, and ends (round reports wait for it) once it is live again. While
  // offline it also gives the SDK a new capture of the game: the SDK plays the capture in a <video> of its own,
  // and a frozen page pauses that element for good.
  const restarts = useRef(NO_RESTARTS); // this broadcast's
  const reports = useRef({ open: 0, at: 0 }); // round reports in flight, and when the last one came back
  const restart = useRef<Promise<void> | null>(null);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (!onAir) { restarts.current = NO_RESTARTS; return; }
    const now = Date.now();
    const job = live?.job as (NonNullable<LiveState['job']> & JobBreak) | null | undefined;
    const busy = !!restart.current || reports.current.open > 0 || now - reports.current.at < REPORT_SETTLE_MS
      || breakInFlight(job, now);
    const c = client.current;
    const key = liveRef.current?.ingest?.streamKey;
    const send = sendQuality.send;
    if (!restartDue(restarts.current, sendQuality, now, busy) || !c || !key || !send) return;
    restarts.current = { at: [...restarts.current.at, now] };
    const floor = sendQuality.floorSince !== null && now - sendQuality.floorSince >= FLOOR_RESTART_MS; // else 90 s starved
    toast('ok', t('송출 화질이 {time} 넘게 {figure}에 머물러 방송을 다시 연결해요. 시청 창이 잠깐 멈출 수 있어요.', { time: floor ? t('1분') : t('1분 30초'), figure: lowFigure(send) }));
    restart.current = restartSend(c, key).finally(() => { restart.current = null; });
  }, [onAir, sendQuality.send]); // eslint-disable-line react-hooks/exhaustive-deps

  async function restartSend(c: Client, key: string) {
    setRestarting(true);
    try {
      c.stopBroadcast();
      await untilChannel(c, false);
      if (client.current !== c) return; // the broadcast was stopped meanwhile
      c.removeVideoInputDevice('game'); // the SDK stops the old capture's track
      await addGame(c, surface.current!);
      await startOn(c, key);
      if (client.current !== c) { c.stopBroadcast(); return; }
      await untilChannel(c, true);
    } catch {
      if (client.current === c) {
        toast('error', LINK_LOST);
        void stop().catch(() => undefined);
      }
    } finally {
      setRestarting(false);
    }
  }
  /** Polls the status (its IVS GetStream answer is cached 3 s) every second until the channel is RUNNING (`running`)
   * or not, at most CHANNEL_WAIT_MS, while `c` is still the broadcast's client. */
  async function untilChannel(c: Client, running: boolean) {
    for (const end = Date.now() + CHANNEL_WAIT_MS; Date.now() < end && client.current === c;) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await liveStatus(sessionId).catch(() => null);
      if (!s) continue;
      setLive(s);
      if (!s.active || (s.channelState === 'RUNNING') === running) return;
    }
  }
  // That <video> is played again as the page resumes from a freeze: the broadcast moves on at once, and the send climbs
  // back by itself as after a minimize (measured in Chrome with the SDK: still paused after a DevTools freeze, playing
  // again from the resume event). A restart still replaces an input left paused.
  useEffect(() => {
    if (!onAir) return;
    const resume = () => {
      const v = client.current?.getVideoInputDevice('game')?.element;
      if (v instanceof HTMLVideoElement && v.paused) void v.play().catch(() => undefined);
    };
    document.addEventListener('resume', resume);
    return () => document.removeEventListener('resume', resume);
  }, [onAir]);

  // The session, read as the window opens. A read that fails is said in the stage, with a way on.
  const [loadError, setLoadError] = useState<{ text: string; login: boolean } | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    return getSession(sessionId).then(setSnap, (e) => setLoadError({ text: errorMessage(e), login: loginExpired(e) }));
  }, [sessionId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const t0 = Date.now();
        const s = await liveStatus(sessionId);
        clock.current = serverClock(clock.current, s.now, t0, Date.now());
        if (alive) setLive(s);
      } catch { /* next poll */ }
      if (alive) timer = window.setTimeout(poll, 4000);
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [sessionId]);

  // when the server ends this broadcast by itself (its cap, 45 minutes), on this PC's clock
  const capAt = useRef(0);
  useEffect(() => {
    const left = (live?.job as { secondsLeft?: number } | null | undefined)?.secondsLeft;
    if (live?.active && typeof left === 'number') capAt.current = Date.now() + left * 1000;
  }, [live]);
  useEffect(() => {
    if (!onAir || !live || live.active) return;
    release(); // the server stopped the job (45-minute cap, a takeover, or a stop elsewhere)
    serverJob.current = false;
    setOnAir(false);
    const capped = capAt.current > 0 && Date.now() >= capAt.current - 10_000;
    // why the broadcast ended, by who ended it
    toast('ok', live.endedBy === 'takeover' ? TOOK_OVER
      : capped ? t('방송 시간이 다 돼서 자동으로 꺼졌어요 (한 번에 최대 {n}분). 더 하려면 ‘라이브 켜기’를 다시 눌러 주세요.', { n: LIVE_MAX_MINUTES })
        : t('다른 창에서 방송을 껐거나 다른 방송이 시작돼서 이 방송이 꺼졌어요.'));
  }, [onAir, live?.active]); // eslint-disable-line react-hooks/exhaustive-deps
  // Closing or reloading this window ends the broadcast for every viewer (pagehide below): the browser asks first
  // while it is on air
  useEffect(() => {
    if (!onAir) return;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', ask);
    return () => removeEventListener('beforeunload', ask);
  }, [onAir]);

  // heartbeat: the server stops a player broadcast whose window has gone (server/live.py reap)
  useEffect(() => {
    if (!onAir) return;
    const t = window.setInterval(() => { void liveBeat(sessionId).catch(() => undefined); }, 20000);
    return () => window.clearInterval(t);
  }, [onAir, sessionId]);

  const game: Game | undefined = snap?.games.find((g) => g.gameId === gameId);
  // each window has its own tab title
  useEffect(() => { if (game) document.title = `${t('플레이 창')} · ${game.title}`; }, [game?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  // &demo=1 on the window: the game's built-in player plays (for recorded demos); otherwise you play
  const demo = new URLSearchParams(location.hash.slice(1)).get('demo') === '1';
  // nopause=1: this window is a broadcast surface, so its game never pauses (a paused round sends a standing picture
  // and never ends). The game's own rule (game3d pauseRules); cloud play, which also loads ?noads=1, keeps its pause.
  const src = game ? `${game.previewUrl}?noads=1&nopause=1${demo ? '&autoplay=1' : ''}` : '';
  // Test switch, off unless both are on the hash: #play=<session>&g=<game>&demo=1&floortest=1. On air, the send
  // really sinks to the WebRTC floor (capAtFloor: the video sender capped at 0.03 Mbps, re-applied with every
  // sample) until the floor restart a minute later, which then runs end to end against IVS; its new connection is
  // left free to climb back. Each broadcast holds it again.
  const floorTest = demo && new URLSearchParams(location.hash.slice(1)).get('floortest') === '1';
  useEffect(() => {
    const pc = floorTest && onAir && restarts.current.at.length === 0 ? peerConnectionOf(client.current) : null;
    if (pc) void capAtFloor(pc).catch(() => undefined); // not negotiated yet: the next sample tries again
  }, [floorTest, onAir, sendQuality.send]);

  // you play (no &demo=1): a round starts only once someone presses 임무 시작, so on air no round ends and no ad goes
  // out until then. The game page is same-origin: its briefing shows while it waits. Not a briefing shown again
  // between rounds (class "again": the game builds the next round behind it and starts it by itself).
  const [briefingWait, setBriefingWait] = useState(false);
  useEffect(() => {
    setBriefingWait(false);
    if (!onAir || demo) return;
    const id = setInterval(() => setBriefingWait(!!frame.current?.contentDocument?.querySelector(BRIEFING_WAITS)), 2000);
    return () => clearInterval(id);
  }, [onAir, demo]);

  // finished rounds come from the game page (same origin): report them while on air
  useEffect(() => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    const onRound = (e: Event) => {
      const n = (e as CustomEvent<{ rounds: number }>).detail.rounds;
      setRounds(n);
      if (!onAir) return;
      const hold = (ms: number) => (win as Window & { ipverseHoldEnd?: (ms: number) => void }).ipverseHoldEnd?.(ms);
      const job = liveRef.current?.job;
      // this broadcast's ad round (the server's count: from its first report) with no break sent ahead
      const adRound = job?.adType === 'trailer' && !!job.everyRounds && (n - (job.roundBase ?? n - 1)) % job.everyRounds === 0;
      if (adRound && etaSent.current?.round !== n) hold(PROVISIONAL_HOLD_MS);
      reports.current.open++;
      // after a restart of the send in progress: a cue sent into it would be lost
      // the end as the server's clock has it now (the report's way to the handler was about 0.5 s on air)
      const off = clockOffset(clock.current);
      const endedAt = off == null ? null : Math.round(Date.now() + off);
      void (restart.current ?? Promise.resolve()).then(() => (endedAt ? liveRound(sessionId, n, endedAt) : liveRound(sessionId, n))).then((r) => {
        // the ad was sent only now (the round's end was not known ahead) and takes the viewers' picture 3–9 s from
        // here: the built-in player keeps the end screen up for it instead of starting the next round under it
        if (r.holdSec) hold(r.holdSec * 1000);
        const text = roundToast(n, r, liveRef.current?.job?.adType, demo); // demo: only the built-in player's end screen is held
        if (text) toast('ok', text);
      }, () => undefined).finally(() => { reports.current.open--; reports.current.at = Date.now(); });
      const startedAt = Math.max(roundStart.current, onAirAt.current);
      roundStart.current = Date.now(); // older runtimes send no ipverse:roundstart: the next round starts here
      if (liveRef.current?.job?.highlightGen) {
        void highlightCreate(sessionId, { round: n, startedAt, endedAt: roundStart.current, sentAt: Date.now() }).then(
          () => toast('ok', t('{n}판 하이라이트 쇼츠를 만드는 중이에요 (명장면을 골라 자르는 중)', { n })),
          (err) => toast('error', t('{n}판 하이라이트를 만들지 못했어요: {why}', { n, why: errorMessage(err) })));
      }
    };
    const onStart = () => { roundStart.current = Date.now(); };
    win.addEventListener('ipverse:round', onRound);
    win.addEventListener('ipverse:roundstart', onStart);
    return () => { win.removeEventListener('ipverse:round', onRound); win.removeEventListener('ipverse:roundstart', onStart); };
  }, [onAir, sessionId, toast, src, snap]);

  // The pre-cue: a round whose end the game knows ahead (window.ipverseRoundEndsIn: a survive stage, a time limit) is
  // reported to the server preCueSendSec before the end (the lead and the time the server's picks take); the server
  // sends the break at the lead itself (IVS puts it ~6 s after the call in the stream), so a full-screen trailer
  // starts a moment after the round's end on each viewer's picture. Once per round; the server knows which rounds
  // are ad rounds. A game that tells estimates (ipverseRoundEnd: a race's last stretch) has them sent as such, and
  // taken back if the estimate goes or moves away by more than ETA_SLIP_SEC before the server's call has left.
  const etaSent = useRef<{ round: number; endsAt: number; estimated: boolean } | null>(null);
  const clock = useRef<ClockSample[]>([]);
  useEffect(() => {
    const lead = liveRef.current?.job?.preCueLeadSec ?? 0;
    const send = liveRef.current?.job?.preCueSendSec ?? lead; // (an older server: at the lead)
    if (!onAir || liveRef.current?.job?.adType !== 'trailer' || !lead) return;
    const id = window.setInterval(() => {
      type End = { seconds: number; estimated: boolean } | null;
      const win = frame.current?.contentWindow as (Window & { ipverseRoundEndsIn?: () => number | null; ipverseRoundEnd?: () => End }) | null;
      const told = win?.ipverseRoundEnd ? win.ipverseRoundEnd() : win?.ipverseRoundEndsIn?.();
      const end: End = typeof told === 'number' ? { seconds: told, estimated: false } : told ?? null;
      const round = rounds + 1, sent = etaSent.current?.round === round ? etaSent.current : null;
      if (sent) {
        // the server's call for an estimate leaves ETA_CALL_SEC before the end it was told: until then it listens
        const open = sent.estimated && Date.now() < sent.endsAt - ETA_CALL_SEC * 1000;
        if (open && (!end || Math.abs(Date.now() + end.seconds * 1000 - sent.endsAt) > ETA_SLIP_SEC * 1000)) {
          etaSent.current = null;
          void liveRoundEta(sessionId, round, 0, { cancel: true }).catch(() => undefined);
        }
        return;
      }
      if (!end || end.seconds > send) return;
      etaSent.current = { round, endsAt: Date.now() + end.seconds * 1000, estimated: end.estimated };
      // the end as an instant of the server's clock, once a status poll has told it: the seconds left alone are
      // counted from when the request reaches the handler (about 1.2 s later on air), and the ad came that much late
      const off = clockOffset(clock.current);
      const at = off == null ? null : { endsAtMs: Math.round(Date.now() + end.seconds * 1000 + off) };
      void (end.estimated ? liveRoundEta(sessionId, round, end.seconds * 1000, { estimated: true, ...at })
        : at ? liveRoundEta(sessionId, round, end.seconds * 1000, at) : liveRoundEta(sessionId, round, end.seconds * 1000))
        .catch(() => { etaSent.current = null; });
    }, 250);
    return () => window.clearInterval(id);
  }, [onAir, rounds, sessionId, live?.job?.adType, live?.job?.preCueLeadSec, live?.job?.preCueSendSec]);

  // a full-screen break this window announced that no viewer's tile showed (the server's check, 30 s after its call):
  // said once
  const lostSaid = useRef(new Set<string>());
  useEffect(() => {
    for (const b of live?.stream?.breaks ?? []) {
      if (!b.lost || lostSaid.current.has(b.eventId)) continue;
      lostSaid.current.add(b.eventId);
      toast('error', `${t('{n}판 전체 화면 광고가 방송에 나가지 않았어요', { n: b.round })}${b.makeup ? '' : ` · ${t('다음 판이 끝날 때 다시 보내요')}`}`);
    }
  }, [live?.stream?.breaks, toast]);

  // This window's own 라이브 켜기 starts what the console would: the tab and values of the live console the studio has
  // open on this game (read through the opener), else the console's defaults.
  const [fromConsole, setFromConsole] = useState<LiveSettings | null>(null);
  useEffect(() => {
    if (onAir) return;
    const read = () => {
      let next: LiveSettings | null = null;
      try { next = (window.opener as { __ipverseConsole?: ConsoleHandle } | null)?.__ipverseConsole?.settings(sessionId, gameId) ?? null; } catch { /* the opener went elsewhere */ }
      setFromConsole((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    read();
    const t = window.setInterval(read, 1000);
    return () => window.clearInterval(t);
  }, [onAir, sessionId, gameId]);
  const plan: LiveSettings = { ...(fromConsole ?? DEFAULT_SETTINGS), ...(everyTyped ? { everyRounds: every } : {}) };
  // This window says it is there to the console in its opener, every second, on air too: the console's handle on its
  // play window lives in the studio page, and a reload of the studio drops it.
  useEffect(() => {
    const hello = () => {
      try { (window.opener as { __ipverseConsole?: ConsoleHandle } | null)?.__ipverseConsole?.attach?.(window, sessionId, gameId); } catch { /* the opener went elsewhere */ }
    };
    hello();
    const t = window.setInterval(hello, 1000);
    return () => window.clearInterval(t);
  }, [sessionId, gameId]);

  const starting = useRef<Promise<void> | null>(null); // one start at a time (this window's button or the control room)
  const [startBusy, setStartBusy] = useState(false);
  /** takeover: the user said yes to ending the broadcast of their other session (the server refuses without it). */
  function start(everyRounds = every, adType: LiveAdType = 'trailer', playableSeconds = 90, corner = false, takeover = false): Promise<void> {
    if (starting.current) return starting.current;
    setStartBusy(true);
    starting.current = startOnce(everyRounds, adType, playableSeconds, corner, takeover).finally(() => { starting.current = null; setStartBusy(false); });
    return starting.current;
  }
  // this window's own button: the server's question (the same owner's other session is on air) is asked here
  const [askTakeover, takeoverDialog] = useTakeoverQuestion(sessionId);
  const [startNo, startCalledOff] = useCalledOff();
  async function startOwn() {
    const go = (takeover = false) => start(plan.everyRounds, plan.adType, plan.playableSeconds, plan.corner, takeover);
    try {
      await go().catch(async (e) => {
        if (!needsTakeover(e)) throw e;
        if (!(await askTakeover({ playable: plan.adType === 'playable' }))) throw CALLED_OFF;
        await go(true);
      });
    } catch (e) {
      // 취소 at the question: nothing failed, so nothing is said and the button is at rest again (useCalledOff)
      if (e === CALLED_OFF) { startCalledOff(); return; }
      toast('error', errorMessage(e));
      throw e;
    }
  }

  async function startOnce(everyRounds: number, adType: LiveAdType, playableSeconds: number, corner: boolean, takeover: boolean) {
    if (client.current) return; // already on air
    if (!game) throw said(t('게임을 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요.'));
    // the session as it is now, not as it was when this window opened: a trailer finished since then is the ad to
    // send. A read that fails leaves the trailer this window knows
    const now = await getSession(sessionId).catch(() => null);
    if (now) setSnap(now);
    const ad = newestTrailer(now ?? snap);
    if (adType !== 'playable' && !ad) throw said(NO_TRAILER);
    const s = await liveStart(sessionId, { gameId, adAssetId: ad?.assetId, everyRounds: Math.max(1, Math.round(everyRounds) || 2), mode: 'player',
      adType, playableSeconds, ...(corner && adType !== 'corner' ? { corner: true } : {}), ...(takeover ? { takeover: true } : {}) });
    serverJob.current = true;
    setLive(s);
    try {
      await publish(s);
    } catch (e) {
      // the server already holds the job (and, for a playable ad, an idle GameLift Streams host): end it now
      release();
      serverJob.current = false;
      void liveStop(sessionId).then(setLive, () => undefined);
      throw e;
    }
  }

  async function publish(s: LiveState) {
    const canvas = await waitForCapture(); // broadcast the HUD too, not just the 3D canvas
    if (!canvas || !s.ingest) throw said(t('게임 화면을 찾지 못했어요'));
    const { default: IVS } = await import('amazon-ivs-web-broadcast');
    const c = IVS.create({ streamConfig: { maxResolution: { width: 1280, height: 720 }, maxFramerate: 30, maxBitrate: 2500 },
      ingestEndpoint: s.ingest.endpoint, networkReconnectConfig: { reconnect: true, timeout: 30000 } } as never) as unknown as Client;
    c.on('connectionStateChange', (state: string) => {
      if (state === 'failed' && client.current === c) {
        toast('error', LINK_LOST);
        void stop().catch(() => undefined);
      }
    });
    client.current = c; // from here a failure is cleaned up by start()
    await addGame(c, canvas);
    // the send time burnt into the broadcast (bottom left): a viewer compares it with their own clock = the real
    // end-to-end delay of the IVS broadcast
    const stamp = document.createElement('canvas');
    stamp.width = 300; stamp.height = 40;
    const sx = stamp.getContext('2d')!;
    const tick = () => {
      sx.fillStyle = 'rgba(0,0,0,.72)'; sx.fillRect(0, 0, 300, 40);
      sx.fillStyle = '#d4f58a'; sx.font = 'bold 22px ui-monospace, Menlo, monospace'; sx.textBaseline = 'middle';
      sx.fillText(t('송출 {time}', { time: clockText(new Date()) }), 12, 21);
    };
    tick();
    stampTimer.current = window.setInterval(tick, 100);
    // an image source is re-sampled every frame (a captureStream of a detached canvas sent nothing)
    await c.addImageSource(stamp, 'clock', { index: 1, x: 12, y: 668, width: 300, height: 40 });
    const audio = new AudioContext(); // silent track: ad breaks stitch audio, so the content has a track too
    audioCtx.current = audio;
    const dest = audio.createMediaStreamDestination();
    const gain = audio.createGain();
    gain.gain.value = 0;
    audio.createOscillator().connect(gain).connect(dest);
    await c.addAudioInputDevice(dest.stream, 'silence');
    await startOn(c, s.ingest.streamKey);
    surface.current = canvas as HTMLCanvasElement;
    onAirAt.current = Date.now(); // a round under way is cut from here (the recording starts with the broadcast)
    setOnAir(true);
    toast('ok', t('라이브를 켰어요. 시청 창에서 10–20초 뒤부터 보여요.'));
  }

  // a 30 fps capture of the game's surface as the SDK's video input 'game' (a restart gives it a new one)
  async function addGame(c: Client, canvas: HTMLCanvasElement) {
    const capture = canvas.captureStream(30);
    tracks.current.push(...capture.getTracks());
    await c.addVideoInputDevice(capture, 'game', { index: 0 });
  }

  // IVS may refuse a start for a moment: a few tries, 3 s apart, while this client is still the broadcast's
  async function startOn(c: Client, key: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        await c.startBroadcast(key);
        return;
      } catch (e) {
        if (attempt >= 3 || client.current !== c) throw e;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // The game's capture surface (3D + HUD) appears once its runtime has booted, a moment after the bare 3D canvas;
  // games made before the capture surface existed only have the bare canvas.
  const captureSurface = () => {
    const win = frame.current?.contentWindow as (Window & { ipverseCapture?: () => HTMLCanvasElement }) | null;
    return win?.ipverseCapture?.() ?? (frame.current?.contentDocument?.querySelector('canvas') as HTMLCanvasElement | null) ?? null;
  };
  const waitForCapture = async () => {
    for (let i = 0; i < 30 && !(frame.current?.contentWindow as (Window & { ipverseCapture?: unknown }) | null)?.ipverseCapture; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return captureSurface();
  };

  // The expanded game in the main window (our opener) mirrors this canvas and drives start/stop through this
  // handle, so both show the same running game. `ready` = the game canvas exists.
  const handle = useRef({ start, stop, onAir, rounds, sendQuality, briefingWait });
  handle.current = { start, stop, onAir, rounds, sendQuality, briefingWait };
  useEffect(() => {
    const api = {
      // the game's capture surface (3D + HUD) when its runtime has one, else the bare 3D canvas (older games)
      canvas: () => captureSurface(),
      captured: () => !!(frame.current?.contentWindow as (Window & { ipverseCapture?: unknown }) | null)?.ipverseCapture,
      start: (n?: number, adType?: LiveAdType, seconds?: number, corner?: boolean, takeover?: boolean) => handle.current.start(n, adType, seconds, corner, takeover),
      stop: () => handle.current.stop(),
      // send / sendDropped: what this window really sends to IVS. waiting: on air, the game sits at its briefing until
      // 임무 시작 is pressed here; hidden: this window is covered or minimized, so the game draws no frames
      state: () => ({ onAir: handle.current.onAir, rounds: handle.current.rounds, starting: !!starting.current,
        waiting: handle.current.briefingWait, hidden: document.visibilityState === 'hidden',
        send: handle.current.sendQuality.send, sendDropped: handle.current.sendQuality.dropped }),
    };
    (window as unknown as { __ipverse?: typeof api }).__ipverse = api;
    return () => { delete (window as unknown as { __ipverse?: typeof api }).__ipverse; };
  }, []);

  // closing the play window ends the broadcast too (DELETE is sent with keepalive, see api.ts)
  const serverJob = useRef(false); // liveStart returned: the server holds a job until stop
  useEffect(() => {
    const bye = () => {
      if (!serverJob.current) return;
      try { client.current?.stopBroadcast(); } catch { /* not started */ }
      void liveStop(sessionId).catch(() => undefined);
    };
    addEventListener('pagehide', bye);
    return () => removeEventListener('pagehide', bye);
  }, [sessionId]);
  // left for another game while on air (this component is one game's): its broadcast ends with it, as at a close
  useEffect(() => () => {
    if (!serverJob.current) return;
    serverJob.current = false;
    release();
    void liveStop(sessionId).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the IVS client (its compositor keeps running until delete), its AudioContext, the stamp timer, the capture tracks
  const audioCtx = useRef<AudioContext | null>(null);
  const tracks = useRef<MediaStreamTrack[]>([]);
  const release = () => {
    window.clearInterval(stampTimer.current);
    const c = client.current as (Client & { delete?: () => void }) | null;
    client.current = null;
    try { c?.stopBroadcast(); } catch { /* not started */ }
    try { c?.delete?.(); } catch { /* already gone */ }
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    tracks.current.forEach((track) => track.stop());
    tracks.current = [];
  };

  async function stop() {
    serverJob.current = false;
    release(); // an unfinished round makes no highlight
    setOnAir(false);
    setLive(await liveStop(sessionId));
    toast('ok', t('라이브를 껐어요.'));
  }

  // what the E2E monitor logs every 2 s: the sender's report (readSendDiag) and this broadcast's restarts
  const sendDiag = () => ({ ...sendQuality.diag, restarts: restarts.current.at.length });
  const breaks = (live?.stream?.breaks ?? []).filter((b) => b.kind !== 'skip');
  // The ads that went out stay in the bar after the broadcast ends: the status's own count of the broadcast that
  // ended (lastBroadcast), else the last one this window saw.
  const adsSeen = useRef<number | null>(null);
  if (live?.stream) adsSeen.current = breaks.length;
  else if (live?.active) adsSeen.current = null; // (a broadcast with no status yet: the count kept is never an older one's)
  const endedAds = lastBroadcast(live)?.ads ?? (live?.active ? null : adsSeen.current);
  // a held drop with what is low in the latest sample (dropText); a hidden window freezes the game at any size
  const latest = sendQuality.send && sendIssue(sendQuality.send);
  const low = issue && sendQuality.send ? ` · ${latest === 'hidden' ? t('게임 화면 멈춤') : dropText(sendQuality.send, !!latest)}` : '';
  const status = !onAir ? t('방송 꺼짐') : restarting ? `● ${t('방송 다시 연결 중 · 화질 회복 시도')}`
    : live?.channelState === 'RUNNING' ? `● ${t('방송 중')}${low}` : t('방송 연결 중…');
  return (
    <div className="popup-window">
      <header className="popup-bar">
        <span className="brand-mark" aria-hidden="true" />
        <strong className="popup-title">{game?.title ?? t('게임')} <small>{t('플레이 창')}</small></strong>
        <span className={onAir ? 'status-pill is-busy' : 'status-pill'}><span className="status-dot" aria-hidden="true" />{status}</span>
        <span className="popup-meta">{t('끝난 판 {n}', { n: rounds })} · {endedAds === null ? tn('광고 {n}회', breaks.length) : tn('지난 방송 광고 {n}회', endedAds)}</span>
        {briefingWait && <span className="popup-meta popup-wait" role="status">{t('임무 시작을 눌러야 판이 시작되고 광고가 나가요')}</span>}
        {onAir && live?.active && <LiveLimit job={live.job} prefix={`${t('자동 종료까지')} `} className="popup-meta" onWarn={(text) => toast('ok', text)} />}
        {!onAir && (
          <label className="popup-every">
            <span>{t('광고 간격')}</span>
            <input type="number" min={1} max={20} value={Number.isNaN(plan.everyRounds) ? '' : plan.everyRounds}
              onChange={(e) => { setEvery(e.target.valueAsNumber); setEveryTyped(true); }} />
            <span>{tn('판마다', plan.everyRounds)}</span>
          </label>
        )}
        {/* each its own key: a new button mounts when the broadcast turns on or off, so none keeps its done state
            through the swap */}
        {onAir ? (
          <ActionButton key="stop" className="btn btn-outline live-toggle" label={`■ ${t('라이브 끄기')}`} busyLabel={t('끄는 중…')} doneLabel={t('꺼짐')} run={() => stop().catch((e) => { toast('error', errorMessage(e)); throw e; })} />
        ) : (
          <span key="start" className="popup-go" title={`${STYLE_NAME[plan.adType]}${plan.corner ? ` + ${t('다른 판에는 코너 트레일러')}` : ''} · ${t('광고 방식은 스튜디오의 라이브 방송 창에서 골라요')}`}>
            {/* what the press starts, beside the button and before it: the 45-minute limit and the playable server's price */}
            <small className="popup-meta popup-does">{LIVE_LIMIT_LINE}{plan.adType === 'playable' ? ` · ${playableServerLine()}` : ''}</small>
            <ActionButton key={startNo} className="btn btn-primary live-toggle" label={startBusy ? t('연결 중…') : `● ${t('라이브 켜기')}`} busyLabel={t('연결 중…')} doneLabel={t('켜짐')} disabled={!game || startBusy}
              disabledLabel={loadError ? t('불러오지 못함') : snap ? t('게임 없음') : t('불러오는 중')} run={startOwn} />
          </span>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => window.open(`${location.pathname}#watch=${encodeURIComponent(sessionId)}`, 'ipverse-watch', 'width=1280,height=760')}>{t('시청 창 열기')} ↗</button>
      </header>
      <main className="popup-stage" data-send={sendQuality.send ? qualityText(sendQuality.send) : undefined}
        data-send-diag={onAir && sendQuality.diag ? JSON.stringify(sendDiag()) : undefined}
        data-send-issue={sendQuality.dropped && sendQuality.send ? sendIssue(sendQuality.send) ?? undefined : undefined}>
        {src ? <iframe ref={frame} src={src} title={t('게임 플레이')} allow="autoplay; fullscreen" />
          : loadError ? (
            // the read failed: why, and the way on (an expired login: the login screen, then this same window)
            <div className="live-idle">
              <div className="load-error" role="alert">
                <p>{loadError.login ? loadError.text : <><strong>{t('게임을 불러오지 못했어요.')}</strong> {loadError.text}</>}</p>
                {loadError.login ? <button type="button" className="btn btn-sm" onClick={() => location.reload()}>{t('다시 로그인')}</button>
                  : <button type="button" className="btn btn-sm" onClick={() => void load()}>{t('다시 시도')}</button>}
              </div>
            </div>
          ) : snap ? (
            // the session is there and the game is not (deleted, or a link to another session's game)
            <div className="live-idle">
              <div className="load-error" role="alert">
                <p><strong>{t('이 게임을 찾지 못했어요.')}</strong> {t('지워졌거나 다른 세션의 게임일 수 있어요. 스튜디오에서 게임의 ‘라이브 방송’을 다시 열어 주세요.')}</p>
              </div>
            </div>
          ) : <p className="live-idle">{t('게임을 불러오는 중…')}</p>}
      </main>
      {takeoverDialog}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((l) => l.filter((x) => x.id !== id))} onAction={() => undefined} />
    </div>
  );
}
