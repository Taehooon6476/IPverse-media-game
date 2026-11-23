import { Tabs, readHash, writeHash } from './Tabs';
import { useEffect, useRef, useState } from 'react';
import { highlightSettings, liveAdSettings, liveStandby, liveStatus, liveStop, liveViewer, setLiveStandby, type AdBreak, type HighlightAuto, type LiveAdType, type LiveState, type StandbyState } from '../api';
import { isSaid, lang, said, t, tn } from '../i18n';
import { fmtTime, type Asset, type Game } from '../types';
import { CLOUD_WAIT, DEFAULT_SETTINGS, GPU_HOURLY_USD, LIVE_LIMIT_LINE, PREWARM_MINUTES, STYLE_NAME, differentAds, lastBroadcast, playableServerLine,
  sameAdNote, type ConsoleHandle, type LiveSettings } from '../liveSettings';
import { ActionButton } from './ActionButton';
import { Fold } from './Fold';
import { LiveClock } from './LiveClock';
import { LiveLimit } from './LiveLimit';
import { IvsPlayer, type IvsAd } from './IvsPlayer';
import { CornerAd, PlayableCard } from './AdOverlays';
import { CALLED_OFF, TOOK_OVER, needsTakeover, useCalledOff, useTakeoverQuestion } from './TakeoverDialog';
import { useDialog } from './useDialog';

interface Props {
  sessionId: string;
  game: Game;
  url: string;
  assets: Asset[];
  onClose: () => void;
  onError: (e: unknown) => void;
  onNotice: (text: string, action?: { label: string; run: () => void }) => void;
}

type PlayApi = { canvas: () => HTMLCanvasElement | null; captured: () => boolean;
  start: (n?: number, adType?: LiveAdType, seconds?: number, corner?: boolean, takeover?: boolean) => Promise<void>; stop: () => Promise<void>;
  /** waiting: on air, the game sits at its briefing (임무 시작 not pressed); hidden: the play window is covered or
   * minimized. An older play window says neither. */
  state: () => { onAir: boolean; rounds: number; waiting?: boolean; hidden?: boolean; send?: { hidden?: boolean } | null } };

/** The streamer's ad styles: each picks per dummy viewer (server/adserver.py). The tabs carry the styles' names
 * alone; which service does it is told in 고급 설정. */
export const AD_STYLES: { id: LiveAdType; label: string }[] = (['trailer', 'playable', 'corner'] as const).map((id) => ({ id, label: STYLE_NAME[id] }));
/** What each style does. STYLE_WHAT adds, where it holds, that every viewer gets another ad; a broadcast with one ad
 * to give says in its place why they all get the same one (sameAdNote). */
const STYLE_DOES: Record<LiveAdType, string> = {
  trailer: t('판이 끝나면 시청자 화면 전체에 트레일러가 나와요.'),
  playable: t('판이 끝나면 시청자마다 게임 카드가 떠요. 누르면 설치 없이 바로 해 볼 수 있어요.'),
  corner: t('판이 끝나면 화면 구석에 작은 트레일러가 떠요. 방송은 끊기지 않아요.'),
};
const STYLE_WHAT: Record<LiveAdType, string> = { ...STYLE_DOES, trailer: `${STYLE_DOES.trailer} ${t('시청자마다 다른 트레일러를 받아요.')}` };
const adTypeOf = (v: string | null): LiveAdType => (v === 'playable' || v === 'corner' ? v : 'trailer');

/** An error thrown in the play window, as this window's own: an Error of another window's realm is not `instanceof
 * Error` here, and a toast would print it whole. Anything else is left as it is. */
const ownError = (e: unknown): unknown => (e instanceof Error || typeof (e as { message?: unknown } | null)?.message !== 'string'
  ? e : Object.assign(new Error((e as { message: string }).message), { ours: isSaid(e) }));

// The play window outlives this modal (closing the modal must not end the game or the broadcast).
let playWin: Window | null = null;
/** What a play window is on, off its #play=<session>&g=<game>: null for a closed one, a blank one (a new popup, still
 * loading) or one that went elsewhere. */
function playingIn(w: Window | null): { sessionId: string; gameId: string } | null {
  try {
    if (!w || w.closed) return null;
    const q = new URLSearchParams(w.location.hash.slice(1));
    const sessionId = q.get('play');
    return sessionId ? { sessionId, gameId: q.get('g') ?? '' } : null;
  } catch { return null; }
}
const handleOf = (w: Window | null): PlayApi | null => {
  try { return w && !w.closed ? ((w as unknown as { __ipverse?: PlayApi }).__ipverse ?? null) : null; } catch { return null; }
};
const POPUP_BLOCKED = {
  play: t('팝업이 차단돼서 플레이 창을 열지 못했어요. 주소창 오른쪽의 팝업 차단 아이콘을 눌러 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.'),
  watch: t('팝업이 차단돼서 시청 창을 열지 못했어요. 주소창 오른쪽의 팝업 차단 아이콘을 눌러 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.'),
};
const OTHER_ON_AIR = t('플레이 창이 다른 게임을 방송하고 있어요. 그 방송을 끈 뒤 다시 눌러 주세요.');
const PLAY_CLOSED = t('플레이 창이 닫혀서 방송을 켜지 못했어요. ‘라이브 켜기’를 다시 눌러 주세요.');
/** A clock time as the page's language writes it ("오후 02:05", "02:05 PM"). */
const clockTime = (epochSec: number) => new Date(epochSec * 1000).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
/** `task`, unless the play window closes first: a promise of a window that is gone never settles. */
function whileOpen<T>(task: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setInterval(() => { if (!playWin || playWin.closed) { window.clearInterval(timer); reject(said(PLAY_CLOSED)); } }, 500);
    task.then((v) => { window.clearInterval(timer); resolve(v); }, (e) => { window.clearInterval(timer); reject(e); });
  });
}

/** Tells the console which ad style's tab is open (Tabs keeps that to itself and the hash): each tab's panel mounts
 * its own. Renders nothing. */
function TabSeen({ tab, onSeen }: { tab: string; onSeen: (tab: LiveAdType) => void }) {
  const cb = useRef(onSeen);
  cb.current = onSeen;
  useEffect(() => { cb.current(adTypeOf(tab)); }, [tab]);
  return null;
}

/** The playable server in one line, for the 플레이어블 tab and the pre-warm's toast: what it is doing, how long that
 * takes, what it costs while it is up and when it goes by itself. airing: a broadcast holds it. other: the broadcast
 * on air has another style, so 변경 적용 on this tab is what starts the server (server/live.py ad_settings). */
function standbyLine(s: StandbyState | null, airing: boolean, other = false): string {
  const price = t('켜져 있는 동안 시간당 약 ${usd}', { usd: (s?.hourlyUsd ?? GPU_HOURLY_USD).toFixed(2) });
  const wait = CLOUD_WAIT.cold;
  if (airing && other) {
    return s?.on ? t('‘변경 적용’을 누르면 플레이어블 광고로 바뀌어요 · 플레이어블 서버는 이미 켜져 있어요 · {price}', { price })
      : t('‘변경 적용’을 누르면 플레이어블 서버가 켜져요 · 보통 {wait} 뒤부터 카드가 열려요 · 라이브를 끄면 자동으로 내려가요 · {price}', { wait, price });
  }
  if (!s) return t('플레이어블 서버 상태를 확인하는 중이에요…');
  if (airing) {
    return s.state === 'ready' ? t('플레이어블 서버 준비 완료 · 카드를 누르면 바로 열려요 · 라이브를 끄면 자동으로 내려가요 · {price}', { price })
      : s.state === 'warming' ? t('플레이어블 서버를 켜는 중이에요 · 보통 {wait} · 첫 카드는 준비된 뒤 판이 끝날 때 나가요 · 라이브를 끄면 자동으로 내려가요 · {price}', { wait, price })
        : t('플레이어블 서버가 꺼져 있어요 · 카드를 누르면 그때 켜져서 오래 걸려요 (고급 설정에서 켤 수 있어요) · {price}', { price });
  }
  // When a server started ahead goes by itself, said before the press; the server's own figure where its answer
  // carries one (prewarmSec, server/live.py standby_status).
  const held = Math.round(((s as { prewarmSec?: number }).prewarmSec ?? PREWARM_MINUTES * 60) / 60);
  if (!s.on) return t('플레이어블 서버가 꺼져 있어요 · 미리 켜 두면 첫 카드부터 바로 열리고, 꺼 둔 채 라이브를 켜면 그때 켜져서 {wait} 뒤부터 열려요 · 미리 켠 서버는 {n}분 안에 라이브를 켜지 않으면 자동으로 내려가요 · {price}', { wait, n: held, price });
  const goes = s.mode === 'on' && s.until
    ? ` · ${t('방송을 시작하지 않으면 {time}에 자동으로 내려가요', { time: clockTime(s.until) })}` : '';
  return `${s.state === 'ready' ? t('준비 완료 · 지금 라이브를 켜면 카드가 바로 열려요') : t('플레이어블 서버를 미리 켜는 중이에요 · 보통 {wait}', { wait })}${goes} · ${price}`;
}

const CHANNEL: Record<string, string> = { IDLE: t('대기 중#방송'), STARTING: t('연결 중'), RUNNING: t('방송 중') };
/** How long the console's banner names an ad after its break. */
const CONSOLE_AD_MS = 20_000;
/** "코너 트레일러 · <title>" for the newest break while it is fresh, else null. A skipped break and one no tile showed
 * (lost) are not ads that went out. varied: the break's viewers got different ads, so the one named here (the
 * default pick, which the console shows) is an example of them, not "the ad going out". */
export interface ConsoleBreak { eventId: string; style: LiveAdType; title: string; seconds: number; url?: string; gameUrl?: string; reason?: string;
  varied: boolean }
export function consoleBreak(breaks: AdBreak[], now = Date.now()): ConsoleBreak | null {
  const b = breaks.at(-1);
  if (!b || b.kind === 'skip' || b.lost || now - Date.parse(b.at) > CONSOLE_AD_MS) return null;
  const pick = b.picks?.[''] ?? Object.values(b.picks ?? {})[0];
  return { eventId: b.eventId, style: b.playable ? 'playable' : b.kind === 'corner' ? 'corner' : 'trailer', title: pick?.title ?? b.title ?? '',
    seconds: pick?.seconds ?? b.seconds, url: pick?.url, gameUrl: pick?.gameUrl, reason: pick?.reason, varied: differentAds(b) > 1 };
}
export function consoleAd(breaks: AdBreak[], now = Date.now()): string | null {
  const b = consoleBreak(breaks, now);
  return b && `${STYLE_NAME[b.style]}${b.title ? ` · ${b.title}` : ''}`;
}

const HIGHLIGHT_AUTO: Record<HighlightAuto, string> = { off: t('보관만'), overlay: t('오버레이로 송출'), linear: t('Linear 광고로 송출') };

/** Control room for one running game: it mirrors the play window's canvas (the same game, no copy), shows the
 * live broadcast (the IVS channel), and turns it on/off — opening the play window first when it is not open yet. */
export function GameModal({ sessionId, game, assets, onClose, onError, onNotice }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose, '.game-modal-close');
  const hasTrailer = assets.some((a) => a.kind === 'trailer');
  const [every, setEvery] = useState(DEFAULT_SETTINGS.everyRounds);
  const [playSec, setPlaySec] = useState(String(DEFAULT_SETTINGS.playableSeconds));
  // 코너 매 판 + 전체 화면 N판마다 (the default): a corner trailer at every round that is not an N-th
  const [cornerToo, setCornerToo] = useState(DEFAULT_SETTINGS.corner);
  const [live, setLive] = useState<LiveState | null>(null);
  // The ad style whose tab is open, kept in state from the click on: read off the hash at render it lagged a second.
  const [adTab, setAdTab] = useState<LiveAdType>(() => adTypeOf(readHash('adtype')));
  const [view, setView] = useState<'play' | 'live'>('play');
  const [mirrored, setMirrored] = useState(false);
  const [local, setLocal] = useState<{ open: boolean; onAir: boolean; rounds: number; waiting?: boolean; hidden?: boolean }>({ open: false, onAir: false, rounds: 0 });
  const mirror = useRef<HTMLVideoElement>(null);
  // A status poll sent before 변경 적용 (or 라이브 끄기) can be answered after it, carrying the old ad type: only a
  // poll sent after the last change finished, with no change in flight, may replace what the change returned.
  const epoch = useRef(0);
  const changing = useRef(0);
  const change = async (req: () => Promise<LiveState>) => {
    changing.current += 1;
    epoch.current += 1;
    try {
      const s = await req();
      setLive(s);
      return s;
    } finally {
      changing.current -= 1;
      epoch.current += 1;
    }
  };

  // This console's play window is the one open on this session's game. The window is found by its name, so a window
  // still running another version or session must not be taken for it.
  const mine = () => { const at = playingIn(playWin); return at?.sessionId === sessionId && at.gameId === game.gameId; };
  const playApi = (): PlayApi | null => (mine() ? handleOf(playWin) : null);
  // Re-attach to this game's play window when it is already open (same name), else open it; a window left on another
  // game is sent to this one unless it is on air. Throws what to say when there is no window to use. &demo=1 on the
  // app passes the game's built-in player to the play window (recorded demos).
  const openPlay = () => {
    const demo = new URLSearchParams(location.hash.slice(1)).get('demo') === '1' ? '&demo=1' : '';
    const url = `${location.pathname}#play=${encodeURIComponent(sessionId)}&g=${encodeURIComponent(game.gameId)}${demo}`;
    const w = window.open('', 'ipverse-play', 'width=1280,height=800');
    // a blocked popup is said at once
    if (!w) throw said(POPUP_BLOCKED.play);
    const at = playingIn(w);
    const here = at?.sessionId === sessionId && at.gameId === game.gameId;
    if (at && !here && handleOf(w)?.state().onAir) throw said(OTHER_ON_AIR);
    if (!here) w.location.href = url; // a new (blank) window, or one left on another game: the play window remounts on the new one
    playWin = w;
    return w;
  };
  /** A button's way to a window: what went wrong is said, never thrown into the page. */
  const tryOpen = (open: () => unknown) => { try { open(); } catch (e) { onError(e); } };

  // a play window this page saw close before the console was opened is not this console's: forgotten, so a broadcast
  // that ends later is not put down to it
  useEffect(() => { if (playWin?.closed) playWin = null; }, []);
  // poll the play window (open? canvas? on air?) and the live status
  const wasOpen = useRef(false);
  useEffect(() => {
    let alive = true;
    let tick = 0;
    const look = () => {
      const api = playApi();
      const open = mine();
      // the window just went (closed, or sent to another game): its broadcast ends with it, so ask now, not a poll later
      if (wasOpen.current && !open) poll();
      wasOpen.current = open;
      const at = api?.state();
      // (hidden: an older play window says it only in its send sample, every 2 s on air)
      setLocal({ open, onAir: at?.onAir ?? false, rounds: at?.rounds ?? 0, waiting: at?.waiting, hidden: at?.hidden ?? at?.send?.hidden });
      const el = mirror.current;
      const canvas = api?.canvas();
      // the same surface the play window broadcasts (3D + HUD), so the same frames; upgrade from the bare 3D
      // canvas as soon as the game's capture surface exists
      if (el && canvas && (!el.srcObject || el.dataset.src !== (api!.captured() ? 'capture' : 'bare'))) {
        el.srcObject = canvas.captureStream(30);
        el.dataset.src = api!.captured() ? 'capture' : 'bare';
        void el.play().catch(() => undefined);
        setMirrored(true);
      }
      if (el && !canvas && el.srcObject) { el.srcObject = null; setMirrored(false); }
    };
    const timer = window.setInterval(() => { look(); if (++tick % 4 === 0) poll(); }, 1000);
    const poll = () => {
      const sent = epoch.current;
      void liveStatus(sessionId).then((s) => { if (alive && sent === epoch.current && !changing.current) setLive(s); }, () => undefined);
    };
    poll();
    // the play window this page already knows is looked at as the console opens, not a second later: until then the
    // console had no play window, which on air now reads 연결 안 됨 (below)
    look();
    return () => { alive = false; window.clearInterval(timer); };
  }, [sessionId, game.gameId, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const on = !!live?.active;
  const running = on && live?.channelState === 'RUNNING';
  // The broadcast ended under the console (the play window was closed, the 45-minute cap, a start elsewhere): said
  // once, and the 라이브 방송 tab is left. Its own 라이브 끄기 says so itself. The play window's close is named only
  // when this page saw it: a studio reload drops the handle while the play window stays open.
  const wasOn = useRef(false);
  useEffect(() => {
    if (on) { wasOn.current = true; return; }
    if (!wasOn.current) return;
    wasOn.current = false;
    setView('play');
    onNotice(live?.endedBy === 'takeover' ? TOOK_OVER
      : playWin?.closed ? t('플레이 창이 닫혀서 방송이 꺼졌어요. 다시 하려면 ‘라이브 켜기’를 눌러 주세요.') : t('방송이 꺼졌어요. 다시 하려면 ‘라이브 켜기’를 눌러 주세요.'));
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ad, setAd] = useState<IvsAd>({ on: false });
  const [watching, setWatching] = useState(false); // the console's player is actually playing
  // The ad a break just sent, drawn on the console itself from the break log, on both tabs: the 플레이 화면 tab's
  // player mounts after the cue's frame has passed, so the stream's cue alone would show nothing there.
  const fresh = consoleBreak(live?.stream?.breaks ?? []);
  const [adUp, setAdUp] = useState<ConsoleBreak | null>(null);
  const adSeen = useRef('');
  useEffect(() => {
    if (!fresh || adSeen.current === fresh.eventId) return;
    adSeen.current = fresh.eventId;
    setAdUp(fresh);
  }, [fresh?.eventId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!adUp) return;
    const t = window.setTimeout(() => setAdUp(null), (Math.max(adUp.seconds, 12) + 3) * 1000);
    return () => window.clearTimeout(t);
  }, [adUp]);
  const watchOpen = () => {
    if (!window.open(`${location.pathname}#watch=${encodeURIComponent(sessionId)}`, 'ipverse-watch', 'width=1280,height=760')) throw said(POPUP_BLOCKED.watch);
  };
  // The console's player is a viewer on both tabs, from the moment the channel is up: the server sends a new
  // creative's 1-second warm-up break only while some player is playing, and the creative is usable 90 s after it.
  useEffect(() => {
    if (!running || !watching) return;
    const beat = () => void liveViewer(sessionId).catch(() => undefined);
    beat();
    const t = window.setInterval(beat, 15000);
    return () => window.clearInterval(t);
  }, [running, watching, sessionId]);

  // on air: the controls show the broadcast's own spec (also after reopening this modal)
  const job = on ? live?.job : null;
  // the tabs below remount when the broadcast's ad type changes and read their tab from the hash, so the hash
  // follows it before they render (an effect would run after their remount and leave them on the old tab)
  const shownAdType = useRef<string | null>(null);
  if (job && shownAdType.current !== (job.adType ?? 'trailer')) {
    shownAdType.current = job.adType ?? 'trailer';
    writeHash('adtype', shownAdType.current);
  }
  useEffect(() => {
    if (!job) return;
    setEvery(job.everyRounds);
    if (job.playableSeconds) setPlaySec(String(job.playableSeconds));
    setCornerToo(!!job.corner);
  }, [job?.adType, job?.everyRounds, job?.playableSeconds, job?.corner]); // eslint-disable-line react-hooks/exhaustive-deps

  const [standby, setStandby] = useState<StandbyState | null>(null);
  const [standbyBusy, setStandbyBusy] = useState(false);
  const wasReady = useRef<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    let t = 0;
    const poll = async () => {
      try { const s = await liveStandby(sessionId); if (alive) setStandby(s); } catch { /* next poll */ }
      if (alive) t = window.setTimeout(poll, 5000);
    };
    void poll();
    return () => { alive = false; window.clearTimeout(t); };
  }, [sessionId]);
  useEffect(() => {
    const ready = standby?.state === 'ready';
    if (wasReady.current === false && ready) onNotice(t('플레이어블 서버가 준비됐어요. 카드를 누르면 기다림 없이 바로 시작해요.'));
    if (standby) wasReady.current = ready;
  }, [standby?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // The playable server before a broadcast. A cold host takes about five minutes, so it can be started ahead of a
  // broadcast (held 10 minutes; never over the switch set by hand) by 미리 켜기 on the 플레이어블 tab, which carries
  // the price. The tab itself starts nothing (a paid GPU host only on a press), nor does a broadcast that ends
  // with the tab open.
  const tabsKey = job?.adType ?? 'off';
  // What the line and the button say after a press is the server's answer, never the press. An answer that started
  // nothing (200 with the server still off), like a refusal, is a press that failed: said in a toast (the server's
  // own sentence when it gave one), and the button stays 미리 켜기.
  async function prewarm() {
    setStandbyBusy(true);
    try {
      const s = await setLiveStandby(sessionId, true, true);
      setStandby(s);
      if (!s.on) {
        throw said(s.mode === 'off' ? t('플레이어블 서버를 꺼 둔 상태라 미리 켜지 못했어요. 고급 설정의 ‘플레이어블 서버’ 스위치로 켤 수 있어요.')
          : t('플레이어블 서버를 켜지 못했어요. 잠시 뒤 다시 눌러 주세요.'));
      }
      if (s.prewarm && s.state !== 'ready') onNotice(standbyLine(s, false));
    } catch (e) {
      onError(e);
      throw e;
    } finally {
      setStandbyBusy(false);
    }
  }

  async function toggleStandby(on: boolean) {
    setStandbyBusy(true);
    try {
      setStandby(await setLiveStandby(sessionId, on));
      if (on) onNotice(t('플레이어블 서버를 준비하고 있어요. 클라우드 GPU 할당에 보통 {wait} 걸려요.', { wait: CLOUD_WAIT.cold }));
      // no 되돌리기 on this toast: it would start the paid server again with no price on it. The way back is where it
      // was taken down: 미리 켜기 on the tab's line and the switch in 고급 설정, each with its price
      else onNotice(t('플레이어블 서버를 내렸어요. 대기 GPU 0대 · 시청 창의 미리 연결한 세션도 정리해요.'));
    } catch (e) {
      onError(e);
      throw e;
    } finally {
      setStandbyBusy(false);
    }
  }

  async function applyAd(adType: LiveAdType) {
    try {
      const corner = adType === 'trailer' && cornerToo;
      await change(() => liveAdSettings(sessionId, { adType, everyRounds: Math.max(1, Math.round(every) || 2), playableSeconds: Number(playSec), corner }));
      const now = { n: Math.max(1, Math.round(every) || 2), style: STYLE_NAME[adType] };
      onNotice(corner ? tn('광고 설정을 바꿨어요. 지금부터 {n}판마다 {style}가 나가요 (다른 판에는 코너 트레일러).', now.n, now)
        : tn('광고 설정을 바꿨어요. 지금부터 {n}판마다 {style}가 나가요.', now.n, now));
    } catch (e) {
      onError(e);
      throw e;
    }
  }
  async function setHighlights(body: { generate?: boolean; auto?: HighlightAuto }) {
    try {
      await change(async () => { await highlightSettings(sessionId, body); return liveStatus(sessionId); });
    } catch (e) {
      onError(e);
    }
  }

  // what a start sends: the chosen tab and its values. The play window's own 라이브 켜기 asks for the same through
  // window.opener
  const settings = (): LiveSettings => {
    const adType = adTypeOf(readHash('adtype'));
    return { everyRounds: Math.max(1, Math.round(every) || 2), adType, playableSeconds: Number(playSec), corner: adType === 'trailer' && cornerToo };
  };
  const settingsNow = useRef(settings);
  settingsNow.current = settings;
  useEffect(() => {
    const handle: ConsoleHandle = {
      settings: (sid, gid) => (sid === sessionId && gid === game.gameId ? settingsNow.current() : null),
      // this game's play window says it is there (PlayWindow, every second): after a reload of the studio this page
      // has no handle on it. One the console already holds is kept
      attach: (w, sid, gid) => { if (sid === sessionId && gid === game.gameId && (!playWin || playWin.closed)) playWin = w; },
    };
    const host = window as unknown as { __ipverseConsole?: ConsoleHandle };
    host.__ipverseConsole = handle;
    return () => { if (host.__ipverseConsole === handle) delete host.__ipverseConsole; };
  }, [sessionId, game.gameId]);

  // 라이브 켜기 stays up, busy, until its start is through: the server's job and the play window say on air seconds
  // before that, and a button swapped then would show the stop button's labels over the start's state
  const [starting, setStarting] = useState(false);
  const [askTakeover, takeoverDialog] = useTakeoverQuestion(sessionId);
  const [startNo, startCalledOff] = useCalledOff();
  async function startLive() {
    setStarting(true);
    try {
      if (!playApi()) openPlay();
      // wait for the play window's game canvas (the first load of the game takes a few seconds)
      for (let i = 0; i < 60 && !playApi()?.canvas(); i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (!playWin || playWin.closed) throw said(PLAY_CLOSED);
      }
      const api = playApi();
      if (!api?.canvas()) throw said(t('플레이 창의 게임이 아직 준비되지 않았어요. 잠시 뒤 다시 눌러 주세요.'));
      const { everyRounds, adType, playableSeconds, corner } = settings();
      await whileOpen(api.start(everyRounds, adType, playableSeconds, corner)).catch(async (e) => {
        // the same owner's other session is on air: its broadcast is ended only on the user's word
        if (!needsTakeover(e)) throw e;
        // (what the yes starts is said in the question: the limit, and the playable server's price on that tab)
        if (!(await askTakeover({ playable: adType === 'playable', hourlyUsd: standby?.hourlyUsd }))) throw CALLED_OFF;
        await whileOpen(api.start(everyRounds, adType, playableSeconds, corner, true));
      });
      await change(() => liveStatus(sessionId)).catch(() => undefined); // the console's own state follows at once, not a poll later
      onNotice(t('라이브를 켰어요. 10–20초 뒤부터 ‘라이브 방송’ 탭과 시청 창에서 보여요.'));
    } catch (e) {
      // 취소 at the question: nothing failed, so nothing is said and the button is at rest again (useCalledOff)
      if (e === CALLED_OFF) { startCalledOff(); return; }
      onError(ownError(e));
      throw e;
    } finally {
      setStarting(false);
    }
  }
  async function stopLive() {
    wasOn.current = false; // this stop says so itself (below): not "the broadcast went off"
    try {
      const api = playApi();
      // a play window that closes under its stop has ended the broadcast with its own last request: the server's word
      const stopped = !!api && await whileOpen(api.stop()).then(() => true, (e) => { if (playWin && !playWin.closed) throw e; return false; });
      if (stopped) {
        setLocal((l) => ({ ...l, onAir: false }));
        await change(() => liveStatus(sessionId)).catch(() => undefined); // off air here too before the button says so
      } else await change(() => liveStop(sessionId)); // the play window is gone (or another tab's): end it on the server
      onNotice(t('라이브를 껐어요.'));
      setView('play');
    } catch (e) {
      wasOn.current = on;
      onError(ownError(e));
      throw e;
    }
  }

  const airing = local.onAir || on;
  // The ads that went out stay counted after the broadcast ends, as the last broadcast's (the status of a stopped
  // broadcast has no stream). The status's own word on the broadcast that ended is the count (lastBroadcast); with
  // a status that names none, the last stream this console saw stands in until the next broadcast brings its own.
  const seenStream = useRef<LiveState['stream']>(null);
  if (live?.stream) seenStream.current = live.stream;
  else if (live?.active) seenStream.current = null; // (a broadcast with no status yet: the count kept is never an older one's)
  const stream = live?.stream ?? (airing ? null : seenStream.current);
  const ended = airing ? null : lastBroadcast(live);
  const past = !airing && (!!stream || !!ended);
  const breaks = (stream?.breaks ?? []).filter((b) => b.kind !== 'skip');
  const adsOut = ended?.ads ?? breaks.length;
  const last = breaks.length === adsOut ? breaks.at(-1) : undefined; // (the last ad's time, when the list here is the whole of it)
  // With one ad to give, every viewer gets the same one: why, and how to change that, in the line of the style on air
  const sameAd = sameAdNote(live);
  // what the 라이브 방송 tab's badge says of the stitched ad on its player: the newest full-screen break's picks
  const variedTrailer = differentAds([...(live?.stream?.breaks ?? [])].reverse().find((b) => b.kind === 'trailer' && !b.lost)) > 1;
  // the session is on air with another of its games (an older version whose play window stayed open)
  const otherGame = on && !!live?.job && live.job.gameId !== game.gameId;
  const onAirName = live?.job?.adTitle && live.job.adTitle !== game.title ? `“${live.job.adTitle}”` : t('이 게임의 다른 버전');
  // What to do next. On air, no round starts and no ad goes out until 임무 시작 is pressed in the play window (Enter
  // does nothing here). The play window says whether its game waits; one that does not say (an older one, or another
  // tab's) is taken to wait until the broadcast's first round is in. &demo=1: the built-in player starts every round.
  const demo = new URLSearchParams(location.hash.slice(1)).get('demo') === '1';
  const roundsIn = live?.stream?.rounds ?? 0;
  const everyOn = live?.job?.everyRounds ?? 0;
  // The play window is covered or minimized on air: its game draws no frames, so the mirror, the rounds, the ads and
  // the broadcast all stand still. It comes before the 임무 시작 notice: nothing can be pressed in a window that is
  // not seen.
  const covered = airing && local.open && !!local.hidden;
  // On air, and this page has no play window of this game: one is open somewhere, or the broadcast would be off (the
  // server ends one whose window is gone). A reload of the studio leaves the console like this until the play window
  // says it is there (a second), and a play window of another tab stays unknown. It is not called closed unless
  // this page saw its own play window close.
  const lostPlay = on && !otherGame && !local.open && !playWin?.closed;
  const waitingStart = !covered && airing && !otherGame && !demo && (local.waiting ?? roundsIn === 0);
  const step = !airing ? 1 : waitingStart || roundsIn === 0 ? 2 : 3;
  // rounds left to the next ad round, as the server counts them (from the broadcast's first report)
  const nextAd = on && everyOn ? everyOn - ((roundsIn - (live?.job?.roundBase ?? roundsIn)) % everyOn) : null;
  const focusPlay = () => { try { playWin?.focus(); } catch { /* gone meanwhile */ } };
  // 고급 설정 keeps its state in the header while folded: the playable server (GPU time while on) and the shorts
  const standbyMeta = standby ? `${t('플레이어블 서버')} ${standby.state === 'warming' ? t('준비 중') : standby.on ? 'ON' : 'OFF'}` : '';
  const shortsMeta = job && live?.mode === 'player' ? `${t('쇼츠')} ${job.highlightGen ? HIGHLIGHT_AUTO[job.highlightAuto ?? 'off'] : t('끔')}` : '';

  return (
    <div className="modal-root game-modal-root">
      <div className="modal-backdrop" onClick={onClose} />
      <div ref={panel} className="modal game-modal" role="dialog" aria-modal="true" aria-labelledby="game-modal-title" aria-describedby="game-modal-hint">
        <div className="dialog-head game-modal-head">
          <div>
            {/* LIVE only while the stream is up */}
            {/* (under another game's title the picture is not this game's: the game on air is named) */}
            <p className="eyebrow">{!airing ? t('라이브 방송') : !running ? t('방송 연결 중 · 보통 10–20초')
              : view === 'live' ? `● LIVE · ${t('시청자가 보는 방송 화면')}` : otherGame ? `● ${t('방송 중')} · ${onAirName}` : `● ${t('방송 중')} · ${t('내 플레이 화면')}`}</p>
            <h2 id="game-modal-title">{game.title}</h2>
          </div>
          <div className="view-switch-wrap">
          <div className="view-switch" role="tablist" aria-label={t('화면')} onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            const next = on && (e.key === 'End' || (e.key !== 'Home' && view === 'play')) ? 'live' : 'play';
            setView(next);
            e.currentTarget.querySelector<HTMLButtonElement>(`#game-view-${next}`)?.focus();
          }}>
            <button id="game-view-play" type="button" role="tab" className="genre-tab" aria-controls="game-modal-stage" aria-selected={view === 'play'} tabIndex={view === 'play' ? 0 : -1} onClick={() => setView('play')}>{t('플레이 화면')}</button>
            <button id="game-view-live" type="button" role="tab" className="genre-tab" aria-controls="game-modal-stage" aria-selected={view === 'live'} tabIndex={view === 'live' ? 0 : -1} onClick={() => setView('live')} disabled={!on} aria-describedby={!on ? 'game-view-live-why' : undefined}>{t('라이브 방송')}</button>
          </div>
          {/* why the tab is off, in sight (it was a hover title) */}
          {!on && <small id="game-view-live-why" className="view-switch-why">{t('‘라이브 방송’ 탭은 라이브를 켜면 열려요')}</small>}
          </div>
          <button type="button" className="icon-btn game-modal-close" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>

        {/* the three steps, with the one the user is at marked */}
        <ol className="live-steps" aria-label={t('라이브 방송 순서')}>
          <li aria-current={step === 1 ? 'step' : undefined}><b>①</b> {t('라이브 켜기')} <small>{t('(플레이 창이 열려요)')}</small></li>
          <li aria-current={step === 2 ? 'step' : undefined}><b>②</b> {t('플레이 창에서 ‘임무 시작’을 눌러 플레이')}</li>
          <li aria-current={step === 3 ? 'step' : undefined}><b>③</b> {t('시청 창에서 가상 시청자 4명이 받는 광고 보기')}</li>
        </ol>
        {/* a broadcast needs the play window beside this one, and a phone opens it as a tab: said where the pointer is
            a finger (the stylesheet shows it there). A note, not a lock: a tablet with a keyboard may do */}
        <p className="live-pc-note" role="note">{t('라이브 방송은 창 두 개를 나란히 띄워야 해서 PC 브라우저에서만 켤 수 있어요.')}</p>

        <div id="game-modal-stage" className={airing ? 'game-modal-stage' : 'game-modal-stage game-modal-stage--setup'} role="tabpanel" aria-labelledby={`game-view-${view}`}>
          {/* one muted player for both tabs, out of sight on 플레이 화면: it is there before the first ad (see the
              heartbeat above), and the 라이브 방송 tab shows the picture at once instead of starting a player */}
          {running && (
            <div className={view === 'live' ? 'stage-live' : 'stage-live is-off'} aria-hidden={view === 'live' ? undefined : true}>
              <IvsPlayer src={live!.playbackUrl} onAd={setAd} onPlaying={setWatching} />
            </div>
          )}
          {view === 'play' ? (
            <>
              <video ref={mirror} muted playsInline aria-label={t('플레이 창 게임 화면')} hidden={!mirrored} />
              {!mirrored && (otherGame ? (
                // the session's broadcast is another of its games (an older version, left on air): no second play window
                <div className="live-idle">
                  <p>{t('지금 방송 중인 게임은 따로 있어요 ({name}). 이 게임을 방송하려면 먼저 ‘라이브 끄기’를 눌러 주세요.', { name: onAirName })}</p>
                </div>
              ) : (
                <div className="live-idle">
                  <p>{lostPlay ? t('방송 중이에요. 이 창이 플레이 창과 연결되어 있지 않아서 게임 화면을 보여 드리지 못해요. ‘플레이 창 열기’를 누르면 다시 연결해요.')
                    : t('플레이 창에서 게임을 해요. 창을 열면 여기에 같은 화면이 그대로 보여요.')}</p>
                  {/* a plain button: 라이브 켜기 opens the play window by itself (step ①) and is the one lit action here */}
                  <button type="button" className="btn" onClick={() => tryOpen(openPlay)}>▶ {t('플레이 창 열기')}</button>
                  <small>{t('플레이 창이 가려지면 게임과 방송이 멈춰요. 이 창 옆에 나란히 두세요.')}</small>
                </div>
              ))}
              {mirrored && <span className="mirror-badge">{t('내 플레이 화면 (방송은 몇 초 늦게 나가요)')}</span>}
            </>
          ) : !running && (
            <p className="live-idle">{t('방송에 연결하는 중이에요 (보통 10–20초). 연결되면 여기에 바로 보여요.')}</p>
          )}
          {covered && (
            <div className="stage-notice stage-notice--alert" role="alert">
              <p>{t('플레이 창이 가려져서 게임과 방송이 멈췄어요. 플레이 창을 이 창 옆에 나란히 두세요.')}</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={focusPlay}>{t('플레이 창 보기')}</button>
            </div>
          )}
          {waitingStart && (
            <div className="stage-notice" role="status">
              <p>{tn('플레이 창에서 ‘임무 시작’을 눌러야 판이 시작돼요. 광고는 {n}판이 끝날 때마다 나가요.', everyOn || Math.max(1, Math.round(every) || 2))}</p>
              {local.open && <button type="button" className="btn btn-primary btn-sm" onClick={focusPlay}>{t('플레이 창으로 가기')}</button>}
            </div>
          )}
          {airing && adUp && (
            <p className="console-ad" role="status">
              <span>{t('광고 송출')} · {STYLE_NAME[adUp.style]} · {adUp.varied ? `${t('시청자마다 다른 광고가 나가요')}${adUp.title ? ` · ${t('예: {title}', { title: adUp.title })}` : ''}`
                : `${adUp.title ? `${adUp.title} · ` : ''}${t('시청자에게 나가는 광고를 여기에도 보여 드려요')}`}</span>
              {view === 'play' && <button type="button" className="btn btn-sm" onClick={() => setView('live')} disabled={!on}>{t('라이브 방송에서 보기')}</button>}
            </p>
          )}
          {airing && adUp?.style === 'corner' && adUp.url && (
            <CornerAd key={adUp.eventId} url={adUp.url} title={adUp.title} gameUrl={adUp.gameUrl} onDone={() => setAdUp(null)} />
          )}
          {airing && adUp?.style === 'playable' && (
            // a seat for the game is held by the watch page (its launcher): the card here leads there
            <PlayableCard title={adUp.title} seconds={adUp.seconds} reason={adUp.reason} state={{ kind: 'idle' }} onPlay={() => tryOpen(watchOpen)} />
          )}
          {airing && adUp?.style === 'trailer' && adUp.url && view === 'play' && (
            // the stitched ad itself reaches the 라이브 방송 tab's player some seconds later; the mirror never has it
            <figure className="console-trailer" aria-label={t('전체 화면 광고 미리보기: {title}', { title: adUp.title })}>
              <video src={adUp.url} muted autoPlay playsInline onEnded={() => setAdUp(null)} onError={() => setAdUp(null)} />
              <figcaption>{t('전체 화면 트레일러 · 시청자 화면을 덮는 광고 (미리보기)')}
                <button type="button" className="icon-btn" aria-label={t('광고 미리보기 닫기')} onClick={() => setAdUp(null)}>×</button></figcaption>
            </figure>
          )}
          {view === 'live' && running && <span className="live-badge">● LIVE</span>}
          {view === 'live' && running && <LiveClock />}
          {view === 'live' && running && ad.on && <span className="live-ad" title={t('IVS 서버 측 광고 삽입 (MediaTailor)')}>{t('광고 중')} · {variedTrailer ? t('시청자마다 다른 트레일러') : t('모든 시청자가 같은 트레일러')}</span>}
        </div>

        <div className="game-modal-bar">
          <dl className="live-chips">
            <div><dt>{t('플레이 창')}</dt><dd>{lostPlay ? t('연결 안 됨') : !local.open ? t('닫힘') : covered ? t('가려짐 · 화면 멈춤') : t('열림')}</dd></div>
            <div><dt>{t('방송 상태')}</dt><dd>{on ? CHANNEL[live!.channelState] ?? live!.channelState : t('꺼짐')}</dd></div>
            {/* (the largest of the counts: the play window's own goes on after a stop, the ended broadcast's stays) */}
            <div><dt>{t('끝난 판')}</dt><dd>{tn('{n}판#판수', Math.max(stream?.rounds ?? 0, ended?.rounds ?? 0, local.rounds))}</dd></div>
            {nextAd !== null && <div><dt>{t('다음 광고까지')}</dt><dd>{tn('{n}판#판수', nextAd)}</dd></div>}
            <div><dt>{past ? t('지난 방송 광고') : t('나간 광고')}</dt><dd>{t('{n}회', { n: adsOut })}{last ? ` · ${fmtTime(last.at)}` : ''}</dd></div>
            {on && live?.mode === 'player' && (
              <div><dt>{t('자동 종료까지')}</dt><dd><LiveLimit job={live.job} onWarn={(text) => onNotice(text)} /></dd></div>
            )}
          </dl>
          {airing && <span className="badge">{live?.job?.adType === 'playable' ? `${STYLE_NAME.playable} · ${t('{n}초', { n: live?.job?.playableSeconds ?? '' })}`
            : STYLE_NAME[live?.job?.adType ?? 'trailer'] + (live?.job?.corner ? ` + ${t('코너 매 판')}` : '')}</span>}
          <div className="live-go">
          <div className="modal-actions">
            <button type="button" className="btn btn-sm"
              onClick={() => tryOpen(watchOpen)}>
              ◉ {t('시청 창 열기')}
            </button>
            {/* each its own key: a new button mounts when the broadcast turns on or off, never one with the other's state */}
            {airing && !starting ? (
              <ActionButton key="stop" className="btn btn-outline live-toggle" label={`■ ${t('라이브 끄기')}`} busyLabel={t('끄는 중…')} doneLabel={t('꺼짐')} run={stopLive} />
            ) : (
              <ActionButton key={`start-${startNo}`} className="btn btn-primary live-toggle" label={`● ${t('라이브 켜기')}`} busyLabel={t('플레이 창 준비 중…')} doneLabel={t('송출 중')}
                disabled={!hasTrailer && adTab !== 'playable'} disabledLabel={t('트레일러가 필요해요')} run={startLive} />
            )}
          </div>
          {/* what the button will do, before it is pressed (the 45-minute limit too); a playable broadcast starts the
              playable server too, so its price is here, beside the button that starts it */}
          {!airing && <small className="live-go-does">{t('플레이 창의 게임 화면을 방송해요')} · {LIVE_LIMIT_LINE}{adTab === 'playable'
            ? ` · ${playableServerLine(standby?.hourlyUsd)}` : ''}</small>}
          </div>
        </div>
        {/* why the button is off, and where a trailer is made */}
        {!hasTrailer && (
          <p className="live-need" role="status">{t('이 세션에 트레일러가 없어서 ‘전체 화면 트레일러’와 ‘코너 트레일러’ 방송은 켤 수 없어요. 영상 탭의 ‘연출해서 만들기’로 트레일러를 만들거나, ‘플레이어블 광고’ 탭에서 시작하세요.')}</p>
        )}
        <section className="ad-type" aria-label={t('게임 중 광고')}>
          <Tabs key={tabsKey} hashKey="adtype" label={t('광고 스타일')} tabs={AD_STYLES}>
            {(tab) => (
              <div className="ad-type-body">
                <TabSeen tab={tab} onSeen={setAdTab} />
                <p className="ad-type-what">{sameAd && job && tab === (job.adType ?? 'trailer')
                  ? <>{STYLE_DOES[adTypeOf(tab)]} <span className="same-ad-note" role="note">{sameAd}</span></> : STYLE_WHAT[adTypeOf(tab)]}{' '}
                  <span className="muted">{job ? t('방송 중이에요. 값을 바꾼 뒤 ‘변경 적용’을 누르세요.') : t('‘라이브 켜기’를 누르면 지금 고른 방식과 값으로 시작해요.')}</span></p>
                <div className="ad-type-fields">
                  {/* 광고 간격 [2] 판마다, as the play window's bar says it */}
                  <label className="field field--inline field--narrow live-every">
                    <span>{t('광고 간격')}</span>
                    <span className="live-every-row">
                      <input type="number" min={1} max={20} value={Number.isNaN(every) ? '' : every} onChange={(e) => setEvery(e.target.valueAsNumber)} />
                      <span>{tn('판마다', every)}</span>
                    </span>
                  </label>
                  {tab === 'trailer' && (
                    <label className="field field--inline live-adv-check">
                      <input type="checkbox" checked={cornerToo} onChange={(e) => setCornerToo(e.target.checked)} />
                      <span>{t('다른 판에는 코너 트레일러 (매 판)')}</span>
                    </label>
                  )}
                  {tab === 'playable' && (
                    <label className="field field--inline field--narrow">
                      <span>{t('체험 길이')}</span>
                      <select value={playSec} onChange={(e) => setPlaySec(e.target.value)}>
                        {['30', '60', '90', '120', '180'].map((v) => <option key={v} value={v}>{t('{n}초', { n: v })}</option>)}
                      </select>
                    </label>
                  )}
                  {job && (
                    <ActionButton className="btn btn-sm btn-primary" label={t('변경 적용')} busyLabel={t('적용 중…')} doneLabel={t('적용됨')}
                      disabled={tab === (job.adType ?? 'trailer') && every === job.everyRounds && (tab !== 'playable' || Number(playSec) === job.playableSeconds)
                        && (tab !== 'trailer' || cornerToo === !!job.corner)}
                      disabledLabel={t('방송 중인 설정')} run={() => applyAd(tab as LiveAdType)} />
                  )}
                </div>
                {/* the playable server in sight, outside the fold: what it is doing, what it costs, when it goes */}
                {tab === 'playable' && (
                  <p className="standby-line" role="status">
                    <span>{standbyLine(standby, airing, !!job && (job.adType ?? 'trailer') !== 'playable')}</span>
                    {/* each its own key: which of the two shows is the server's answer (standby.on), and a new button mounts
                        with it, never one with the other's press on it. While the answer is on its way the pressed one says so */}
                    {standby && !airing && (standby.on
                      ? <ActionButton key="down" className="btn btn-sm" label={t('지금 내리기')} busyLabel={t('내리는 중…')} doneLabel={t('내렸어요')}
                          disabled={standbyBusy} run={() => toggleStandby(false)} />
                      // (the price as the lines around it take it: an answer without one, as the client's mock mode
                      // gives, threw here and took the console down)
                      : <ActionButton key="warm" className="btn btn-sm" label={t('미리 켜기 · 시간당 약 ${usd}', { usd: (standby.hourlyUsd ?? GPU_HOURLY_USD).toFixed(2) })}
                          busyLabel={t('켜는 중…')} doneLabel={t('켰어요')} disabled={standbyBusy} run={prewarm} />)}
                  </p>
                )}
                {/* optional extras: a playable broadcast holds the playable server by itself (the switch pre-warms it
                    before one or takes it down), the shorts are an add-on, and how the ad type works under the hood */}
                <Fold id="live-adv" title={t('고급 설정')} storageKey="ipverse.liveAdvOpen" className="live-adv"
                  meta={[tab === 'playable' && standbyMeta, shortsMeta].filter(Boolean).join(' · ')}>
                  <div className="live-adv-body">
                    {tab === 'playable' && (
                      <div className="standby-row">
                        <button type="button" role="switch" aria-checked={!!standby?.on} aria-describedby="standby-status"
                          className="gen-switch" disabled={!standby || standbyBusy} aria-busy={standbyBusy}
                          onClick={() => void toggleStandby(!standby?.on).catch(() => undefined)}>
                          <span className="gen-switch-track" aria-hidden="true"><span className="gen-switch-thumb" /></span>
                          <span>{t('플레이어블 서버')} {standby?.on ? 'ON' : 'OFF'}</span>
                        </button>
                        <span id="standby-status" className="standby-status" aria-live="polite">
                          {!standby ? t('상태 확인 중…')
                            : standby.state === 'ready' ? `${tn('준비 완료 · 대기 GPU {n}대', standby.idle)}${standby.allocated > standby.idle ? ` · ${t('사용 중 {n}대', { n: standby.allocated - standby.idle })}` : ''}`
                            : standby.state === 'warming' ? t('준비 중 · 클라우드 GPU 할당 중 (보통 {wait})', { wait: CLOUD_WAIT.cold })
                            : standby.allocated ? tn('꺼짐 · 사용 중인 GPU {n}대 정리 중', standby.allocated) : t('꺼짐 · 켜 두면 카드를 누르는 순간 바로 시작해요')}
                        </span>
                        {/* when it goes: at a hold's minute (this console's standby poll ends the hold then), or with the broadcast,
                            said only while one is on */}
                        <small className="field-hint standby-cost">
                          {/* the price beside the switch before it is pressed too */}
                          {standby?.on ? '' : `${t('방송 전에 켜 두면 첫 카드부터 바로 열려요')} · `}
                          {/* (the line begins with it once the server is on: a capital there, in English) */}
                          {t('켜 둔 동안 GPU 1대당 시간당 약 ${usd}', { usd: (standby?.hourlyUsd ?? GPU_HOURLY_USD).toFixed(2) }).replace(/^[a-z]/, (c) => (standby?.on ? c.toUpperCase() : c))}
                          {standby?.mode === 'on' && standby.until ? ` · ${t('{time}에 자동으로 내려요', { time: clockTime(standby.until) })}` : ''}
                          {standby?.mode === 'auto' && standby.on && airing ? ` · ${t('방송을 끄면 자동으로 내려요')}` : ''}
                        </small>
                      </div>
                    )}
                    {job && live?.mode === 'player' && (
                      <div className="ad-type-fields">
                        <label className="field field--inline live-adv-check">
                          <input type="checkbox" checked={!!job.highlightGen} onChange={(e) => void setHighlights({ generate: e.target.checked })} />
                          <span>{t('판마다 하이라이트 쇼츠 만들기 (Pegasus 1.5)')}</span>
                        </label>
                        <label className="field field--inline field--narrow">
                          <span>{t('완성되면')}</span>
                          <select value={job.highlightAuto ?? 'off'} disabled={!job.highlightGen} onChange={(e) => void setHighlights({ auto: e.target.value as HighlightAuto })}>
                            {Object.entries(HIGHLIGHT_AUTO).map(([v, text]) => <option key={v} value={v}>{text}</option>)}
                          </select>
                        </label>
                      </div>
                    )}
                    <p className="muted field-hint">{tab === 'playable'
                      ? t('판이 끝나는 장면에 맞춰(IVS 타임드 메타데이터) 시청자마다 자기에게 맞는 게임의 “지금 플레이” 카드가 떠요. 시청 창이 어떤 게임이든 열 수 있는 GameLift Streams 세션을 미리 연결해 두어서, 누른 시청자의 게임이 몇 초 안에 열려요. 자리(동시 2명)가 차면 “대기 n번째”로 기다려요.')
                      : tab === 'corner'
                        ? t('판이 끝나는 장면에 맞춰(IVS 타임드 메타데이터) 시청자마다 다른 트레일러가 플레이어 오른쪽 위에 소리 없이 10–15초 떠요. 방송은 끊기지 않고, 광고 구간·MediaTailor 없이 플레이어가 그려요 (노출은 IPverse 비컨이 기록).')
                        : t('판이 끝나면 IVS가 광고 구간을 만들고, MediaTailor가 시청자마다 고른 트레일러를 방송에 넣어요 (IVS 서버 측 광고 삽입). 끝나는 때를 미리 아는 판(N초 버티기, 제한 시간까지 간 판, 자동 플레이 레이스의 마지막 구간)은 광고 구간을 2–3초쯤 먼저 보내서, 시청자 화면에서 판이 끝나고 보통 1–3초 뒤(늦으면 5초쯤) 광고가 시작돼요. 그 전에 끝난 판(일찍 클리어하거나 진 판, 직접 모는 레이스)은 끝난 뒤에 보내서 3–9초 뒤에 시작돼요 (자동 플레이는 그동안 결과 화면을 유지해요).')}</p>
                  </div>
                </Fold>
              </div>
            )}
          </Tabs>
        </section>
        {takeoverDialog}
        <p id="game-modal-hint" className="muted field-hint game-modal-hint">
          {t('게임은 별도 플레이 창에서 실행돼요. 플레이 창은 가리거나 최소화하지 말고 이 창 옆에 나란히 두세요. 이 화면과 라이브 방송은 같은 게임을 보여 주고, 방송은 몇 초 늦게 나가요. 정한 판수가 끝날 때마다 고른 광고가 나와요.')}
        </p>
      </div>
    </div>
  );
}
