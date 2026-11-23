import { useCallback, useEffect, useRef, useState } from 'react';
import { liveAdEvent, liveStatus, liveViewer, liveViewers, type AdBreak, type LiveState, type Viewer } from '../api';
import { NO_DROP, WARMUP_MS, dropText, isLowQuality, qualityText, trackDrop, type DropState, type PlaybackQuality } from '../liveQuality';
import { GPU_HOURLY_USD, STYLE_NAME, errorText, lastBroadcast, loginExpired, sameAdNote } from '../liveSettings';
import { t, tn } from '../i18n';
import { fmtTime } from '../types';
import { CARD_MS, CornerAd, PlayableCard, type CardState } from './AdOverlays';
import { LiveClock } from './LiveClock';
import { HighlightCarousel } from './HighlightCarousel';
import { IvsPlayer, type IvsAd } from './IvsPlayer';
import { LivePlayable, type PlayRequest, type WarmState } from './LivePlayable';
import { readHash, writeHash } from './Tabs';
import { Toasts, type Toast } from './Toasts';
import { GENRE, PERSONA_VIEWER, ViewerGrid, useInBandAds, useViewerToken, type PlayClick } from './ViewerTiles';

/** The ad badge: whose ad this viewer got in the running break (a trailer break picks per viewer; a highlight goes
 * to everyone), and why. */
function adBadge(breaks: AdBreak[], viewer: string, viewers: Viewer[]): { text: string; why?: string } {
  const last = [...breaks].reverse().find((b) => b.kind === 'trailer' || b.kind === 'linear');
  if (!last) return { text: t('광고') };
  if (!last.picks) return { text: [t('광고'), t('하이라이트'), last.title].filter(Boolean).join(' · ') };
  const name = viewers.find((v) => v.viewerId === viewer)?.name;
  const pick = last.picks[viewer] ?? last.picks[''];
  return { text: [t('광고'), viewer && name ? t('{name} 맞춤', { name }) : t('기본'), pick?.title].filter(Boolean).join(' · '),
    why: viewer && pick?.reason ? t('이유: {reason}', { reason: pick.reason }) : undefined };
}

type View = 'grid' | 'one';
// the stage's words while nothing plays
const OFF_AIR = t('방송이 꺼져 있어요. 스튜디오의 라이브 방송 창이나 플레이 창에서 ‘라이브 켜기’를 눌러 주세요.');
const CHECKING = t('방송 상태를 확인하는 중이에요…'); // before the first answer: not "꺼져 있어요"
const CONNECTING_GRID = t('방송에 연결하는 중이에요 (보통 10–20초). 연결되면 네 화면이 함께 켜져요.');
const CONNECTING_ONE = t('방송에 연결하는 중이에요 (보통 10–20초). 연결되면 바로 보여요.');

type Overlay = { id: string; url: string; title: string; seconds: number };

// what went out, by the names the console uses
const KIND: Record<string, string> = {
  trailer: STYLE_NAME.trailer, linear: t('하이라이트 (전체 화면)'), overlay: t('하이라이트 (작은 화면)'), playable: STYLE_NAME.playable,
  corner: STYLE_NAME.corner, skip: t('트레일러 건너뜀 · 앞 광고가 아직 방송 중'), skip_no_room: t('트레일러 건너뜀 · 다음 광고까지 시간 부족'),
  skip_launcher: t('플레이어블 카드 미룸 · 서버 준비 중 (다음 판 끝에)'),
  // IVS took the call and no tile showed the ad (the server's check 30 s after it): not an ad anybody got
  lost: `${STYLE_NAME.trailer} · ${t('방송에 나가지 않음')}`,
};
const kindKey = (b: AdBreak) => b.lost ? 'lost' : b.playable ? 'playable' : b.kind === 'skip' && b.reason === 'no_room' ? 'skip_no_room'
  : b.kind === 'skip' && b.reason === 'launcher_warming' ? 'skip_launcher' : b.kind ?? 'trailer';

/** A trailer break against its round's end (the server's numbers, in the stream: each viewer's own picture shows the
 * ad that long after the round's end, whatever its delay). */
function timing(b: AdBreak): string {
  if (b.kind !== 'trailer' || b.lost) return '';
  // no tile was playing through the break: nothing says it aired, so no time is claimed for it
  if (b.unseen) return ` · ${t('광고 시작 확인 안 됨 (재생 중인 화면이 없었어요)')}`;
  if (typeof b.endToAdSec !== 'number') return '';
  // measured: the median of what this page's tiles saw (their ad after the break's mark); else the usual place
  return ` · ${t('판이 끝나고 {n}초 뒤', { n: b.endToAdSec.toFixed(1) })}${b.measured ? '' : ` ${t('(예상)')}`}${b.makeup ? ` · ${t('앞 판 광고 대신')}` : ''}`;
}
/** How a break's number was got, and its id: for whoever asks (the row's tooltip), not the row. */
function detail(b: AdBreak): string {
  return [b.kind === 'trailer' && !b.lost && b.measured ? tn('화면 {n}개에서 잰 값', b.measured) : '',
    b.kind === 'trailer' && b.preCue ? t('판이 끝나기 {n}초 전에 미리 보냄', { n: b.leadSec ?? '' }) : '', `#${b.eventId}`].filter(Boolean).join(' · ');
}
/** What a break's row names: one ad's title, or that each viewer got its own. */
function shown(b: AdBreak): string {
  const titles = new Set(Object.entries(b.picks ?? {}).filter(([viewer]) => viewer).map(([, p]) => p.title));
  return titles.size > 1 ? t('시청자마다 다른 광고 {n}개', { n: titles.size }) : [...titles][0] ?? b.picks?.['']?.title ?? b.title ?? '';
}

/** The 광고 삽입 chip: how this broadcast's ads reach the viewer, by its style (the console's three: a full-screen
 * trailer through IVS and MediaTailor, a playable card or a corner trailer drawn by the player), with the corner that
 * fills a trailer or playable broadcast's other rounds. Off air: what the channel is set up for. */
export function adInsertionText(live: LiveState | null | undefined): string {
  const job = live?.active ? live.job : null;
  const style = job?.adType ?? 'trailer';
  // only a full-screen trailer goes through the channel's ad insertion: the player draws a corner trailer and a
  // playable card, so those broadcasts name their style on a channel without it too
  if (live?.adInsertion !== 'ivs' && (!job || style === 'trailer')) return t('설정 안 됨');
  if (!job) return '–';
  return `${STYLE_NAME[style]}${job.corner && style !== 'corner' ? ` + ${STYLE_NAME.corner}` : ''}`;
}
/** The same chip's tooltip: which service brings each style to the viewer. */
export function adInsertionHow(live: LiveState | null | undefined): string {
  const job = live?.active ? live.job : null;
  if (!job) return '';
  const corner = t('플레이어에서 표시');
  if (job.adType === 'corner') return corner;
  if (job.adType !== 'playable' && live?.adInsertion !== 'ivs') return ''; // nothing brings a full-screen trailer there
  const main = job.adType === 'playable' ? 'GameLift Streams' : t('IVS 서버 측 광고 삽입 (SSAI) + MediaTailor');
  return job.corner ? t('{main} · 코너 트레일러는 {how}', { main, how: corner }) : main;
}

/** Separate viewer window, monitoring only (every setting lives in the game's live control room): the broadcast as an
 * audience sees it, the highlight shorts of every finished round, and the ad breaks sent. Overlays and the playable
 * card come in-band (timed metadata), so they show when this viewer's video reaches the moment they were sent at. */
export function WatchWindow({ sessionId }: { sessionId: string }) {
  const [latency, setLatency] = useState<number | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [ad, setAd] = useState<IvsAd>({ on: false });
  // the page's launcher; until: when a launcher still starting should be ready (the cards' "준비 중 · 약 n초")
  const [warm, setWarm] = useState<{ state: WarmState; took?: number; until?: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const toast = useCallback((level: Toast['level'], text: string, action?: Toast['action']) =>
    setToasts((l) => [...l, { level, text, action, id: ++seq.current }].slice(-3)), []);
  useEffect(() => { document.title = `${t('라이브 시청')} · IPverse Studio`; }, []);

  // the status (every 4 s, or now when an in-band cue names a break it has not brought yet). A poll that fails is
  // kept: with no status yet, or with the login gone, the page says so instead of "방송이 꺼져 있어요"
  const [statusError, setStatusError] = useState<{ text: string; login: boolean } | null>(null);
  const pollNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      window.clearTimeout(timer);
      try {
        const s = await liveStatus(sessionId);
        if (alive) { setLive(s); setStatusError(null); }
      } catch (e) {
        if (alive) setStatusError({ text: errorText(e), login: loginExpired(e) }); // (the next poll asks again)
      }
      if (alive) timer = window.setTimeout(poll, 4000);
    };
    pollNow.current = () => { void poll(); };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); pollNow.current = () => undefined; };
  }, [sessionId]);
  const lastAsk = useRef(0);
  const onUnknown = useCallback(() => {
    if (Date.now() - lastAsk.current < 1500) return;
    lastAsk.current = Date.now();
    pollNow.current();
  }, []);

  // 시청자 4명 (a 2×2 grid, each tile its own player and token) or 1명 보기 (one big player with the playable card and
  // overlays). The four dummy viewers and their activity come from the server, refreshed as their logs grow
  const [view, setView] = useState<View>(() => (readHash('view') === 'one' ? 'one' : 'grid'));
  useEffect(() => { writeHash('view', view === 'one' ? 'one' : null); }, [view]);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      try { const r = await liveViewers(); if (alive) setViewers(r.viewers); } catch { /* next time */ }
      if (alive) timer = window.setTimeout(load, 15_000);
    };
    void load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);
  // 1명 보기: the viewer this window watches as ('' = 기본: the status URL's default token). The channel is private: a
  // viewer plays its own token URL (its ads params make MediaTailor ask for its VAST), renewed before it runs out
  const [persona, setPersona] = useState(() => { const h = readHash('persona') ?? ''; return PERSONA_VIEWER[h] ?? h; });
  useEffect(() => { writeHash('persona', persona || null); }, [persona]);
  const viewerSrc = useViewerToken(view === 'one' ? persona : '');
  const src = persona ? viewerSrc : (live?.playbackUrl ?? '');
  const [tiles, setTiles] = useState<Record<string, boolean>>({}); // the grid's tiles that are playing
  const onTile = useCallback((id: string, on: boolean) => setTiles((was) => (was[id] === on ? was : { ...was, [id]: on })), []);
  const playingTiles = view === 'grid' ? Object.keys(tiles).filter((k) => tiles[k]).sort().join(',') : '';

  // toast once per newly finished highlight
  const seen = useRef<Set<string> | null>(null);
  const highlights = live?.highlights ?? [];
  useEffect(() => {
    const ready = highlights.filter((h) => h.state === 'ready');
    if (seen.current) for (const h of ready) if (!seen.current.has(h.id)) toast('ok', t('{n}판 하이라이트 쇼츠 “{title}” 완성', { n: h.round, title: String(h.title) }));
    if (live) seen.current = new Set([...(seen.current ?? []), ...ready.map((h) => h.id)]); // kept: an undone delete is not new
  }, [highlights, live, toast]);

  // what the page cannot show: no status has come yet and the last poll failed, or the login ran out (nothing on the
  // page works then, also one that was showing a broadcast). A poll that fails on a page that has a status keeps it
  const failed = statusError && (!live || statusError.login) ? statusError : null;
  const running = !failed && !!live?.active && live.channelState === 'RUNNING';
  const [watching, setWatching] = useState(false); // the IVS player is actually playing
  const [stuck, setStuck] = useState(false); // the picture stopped moving and the player reloads
  // the picture this window really plays (IVS stream health stays HEALTHY through a collapse): playback.q is the
  // latest sample, playback.drop.dropped a sustained low picture. The player never samples a stitched ad, and the
  // sender's ramp-up right after the stream starts does not count.
  const [playback, setPlayback] = useState<{ q: PlaybackQuality; drop: DropState } | null>(null);
  const runningSince = useRef(0);
  useEffect(() => { runningSince.current = Date.now(); if (!running) setPlayback(null); }, [running]);
  const onQuality = useCallback((q: PlaybackQuality) => setPlayback((p) => ({ q, drop: trackDrop(p?.drop ?? NO_DROP,
    Date.now() - runningSince.current >= WARMUP_MS && isLowQuality(q)) })), []);
  // Toast when the picture drops and when it recovers; the IVS 스트림 chip keeps the state (a toast is never the only record)
  const lowShown = useRef(false);
  useEffect(() => {
    const low = !!playback?.drop.dropped;
    if (low === lowShown.current) return;
    lowShown.current = low;
    if (!playback) return; // the broadcast ended: nothing recovered
    toast(low ? 'error' : 'ok', low
      ? t('방송 화질이 떨어졌어요 · {quality}. 플레이 창 PC의 CPU나 네트워크가 부족할 수 있어요.', { quality: qualityText(playback.q) })
      : t('방송 화질이 돌아왔어요 · {quality}', { quality: qualityText(playback.q) }));
  }, [playback, toast]);
  // a viewer is watching: the server can warm new ad creatives now (MediaTailor transcodes what a break asks for); the
  // ids of the viewers playing grow their watch time and let one warm-up break warm a creative per viewer
  useEffect(() => {
    const ids = view === 'grid' ? (playingTiles ? playingTiles.split(',') : []) : persona && watching ? [persona] : [];
    if (!running || (view === 'grid' ? !ids.length : !watching)) return;
    const beat = () => void liveViewer(sessionId, ids, true).catch(() => undefined); // true: this page reports its tiles' ad starts
    beat();
    const t = window.setInterval(beat, 15000);
    return () => window.clearInterval(t);
  }, [running, watching, sessionId, view, playingTiles, persona]);

  const job = live?.job;
  // The record of the ads that went out, and the rounds, stay after the broadcast ends, as the last broadcast's (the
  // status of a stopped broadcast has no stream). The list is the last one this page saw, until the next broadcast
  // brings its own; a page opened after the stop says how many ads the status counts for the broadcast that ended
  // (lastBroadcast).
  const seenStream = useRef<LiveState['stream']>(null);
  if (live?.stream) seenStream.current = live.stream;
  else if (live?.active) seenStream.current = null; // (a broadcast with no status yet: the record kept is never an older one's)
  const stream = live?.stream ?? (live && !live.active ? seenStream.current : null);
  const ended = lastBroadcast(live);
  const past = !live?.active && (!!stream || !!ended?.ads);
  const breaks = stream?.breaks ?? [];
  // 1명 보기: this window's viewer's in-band ads (its playable card, its corner trailer), like a tile's
  const one = view === 'one';
  const oneAds = useInBandAds(sessionId, persona, breaks, onUnknown, running && ad.on, !!ad.late);
  const gate = useRef(true);
  const onMetadata = useCallback((text: string) => {
    let m: { type?: string; id?: string; url?: string; title?: string; seconds?: number } = {};
    try { m = JSON.parse(text); } catch { return; }
    if (m.type === 'playable' || m.type === 'corner' || m.type === 'mark') oneAds.onCue(text); // mark: a break's call (its ad is measured from it)
    else if (m.type === 'overlay' && m.url && gate.current) setOverlay({ id: m.id ?? m.url, url: m.url, title: m.title ?? t('하이라이트'), seconds: m.seconds ?? 5 });
  }, [oneAds.onCue]); // eslint-disable-line react-hooks/exhaustive-deps

  const badge = adBadge(breaks, persona, viewers);
  const every = job?.everyRounds ?? 0;
  const rounds = stream?.rounds ?? ended?.rounds ?? 0;
  // the server counts from the broadcast's first report (roundBase); before it, a full N rounds are still ahead
  const next = every ? every - ((rounds - (job?.roundBase ?? rounds)) % every) : null;
  const generating = !!job?.highlightGen;
  // With one ad to give, the four viewers all get it: the page says why and how to change that, and its words on
  // "a different ad for each" give way.
  const sameAd = sameAdNote(live);

  // the playable slot: one game at a time on this page. A card click joins the page's line (want); the first is
  // played on the page's warm launcher (or waits for a seat: "대기 n번째"), the others follow when it ends. The slot
  // stays while a playable broadcast runs, and a game being played keeps it until the viewer is done
  const playableOn = !!(live?.active && job?.adType === 'playable');
  const [want, setWant] = useState<PlayRequest[]>([]);
  const [seat, setSeat] = useState<Record<number, number>>({}); // the server line's position of a waiting request
  const [lpPlaying, setLpPlaying] = useState(false);
  const [lpEnded, setLpEnded] = useState(false); // its end card (the full game) is showing
  const seq2 = useRef(0);
  const lpMounted = playableOn || lpPlaying || lpEnded || want.length > 0;
  const onPlay = useCallback((c: PlayClick) => {
    if (!c.pick.adId) return;
    setWant((w) => w.some((r) => r.viewerId === c.viewerId) ? w : [...w, { key: ++seq2.current, viewerId: c.viewerId,
      eventId: c.eventId, adId: c.pick.adId!, title: c.pick.title, seconds: c.pick.seconds, ctaUrl: c.pick.ctaUrl, pick: c.pick }]);
  }, []);
  const lpPlayingRef = useRef(false);
  lpPlayingRef.current = lpPlaying;
  // a card leaves the line (취소, or 트레일러 보기 instead); the game being played is not called off from here
  const onCancel = useCallback((viewerId: string) => setWant((w) => w.filter((r) => r.viewerId !== viewerId || (r === w[0] && lpPlayingRef.current))), []);
  // a viewer who clicked keeps the game they clicked: their card shows that pick until it plays or they cancel, even
  // when a newer card's cue arrives meanwhile
  const lockedCard = useCallback((viewerId: string) => {
    const r = want.find((x) => x.viewerId === viewerId);
    return r?.pick ? { eventId: r.eventId, pick: r.pick } : null;
  }, [want]);
  const playState = useCallback((viewerId: string): CardState => {
    const i = want.findIndex((r) => r.viewerId === viewerId);
    if (i < 0) return { kind: 'idle' };
    const head = seat[want[0].key];
    if (i === 0) return lpPlaying ? { kind: 'playing' } : head ? { kind: 'queued', position: head } : { kind: 'loading' };
    return { kind: 'queued', position: i + (head ?? 0) };
  }, [want, seat, lpPlaying]);
  const onDone = useCallback((req: PlayRequest, secs: number) => {
    if (req.viewerId) void liveAdEvent(sessionId, { viewerId: req.viewerId, eventId: req.eventId, kind: 'playable', action: 'end', seconds: secs }).catch(() => undefined);
    setWant((w) => w.filter((r) => r.key !== req.key));
  }, [sessionId]);
  const playingReq = lpPlaying ? want[0] : undefined;
  // whose card this page will most likely play: the launcher loads their game ahead (at the cue, and again when the
  // break log brings a fresh card), so a click only reveals it
  const likely = one ? persona : viewers[0]?.viewerId;
  const fresh = [...breaks].reverse().find((b) => b.playable);
  const hint = fresh && likely !== undefined && fresh.picks?.[likely] && Date.now() - Date.parse(fresh.at) < CARD_MS + 10_000
    ? { viewerId: likely, eventId: fresh.eventId } : null;
  // a card while the page's launcher is still starting says so ("준비 중 · 약 n초"); a click waits for it
  const warmUntil = playableOn && !job?.standbyOff && warm?.state === 'warming' ? warm.until : undefined;
  const who = playingReq ? viewers.find((v) => v.viewerId === playingReq.viewerId) : undefined;
  const oneLocked = lockedCard(persona);
  const oneCard = oneLocked ?? (oneAds.card?.fresh ? oneAds.card : null);
  gate.current = running && !lpPlaying && !oneAds.card;
  useEffect(() => { if (!(running && !lpPlaying && !oneAds.card)) setOverlay(null); }, [running, lpPlaying, oneAds.card]);
  // a narrow page scrolls as one (origin.css): a card pressed far down the tiles opens its game at the page's top
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => { if (lpPlaying) page.current?.scrollTo?.({ top: 0 }); }, [lpPlaying]);
  // What the stage says while nothing plays: checking (no answer yet), failed (with the way on), connecting, off air.
  const idle = (connecting: string) => (failed ? (
    <div className="live-idle">
      <div className="load-error" role="alert">
        <p>{failed.login ? failed.text : <><strong>{t('방송 상태를 불러오지 못했어요.')}</strong> {failed.text}</>}</p>
        {failed.login ? <button type="button" className="btn btn-sm" onClick={() => location.reload()}>{t('다시 로그인')}</button>
          : <button type="button" className="btn btn-sm" onClick={() => pollNow.current()}>{t('다시 시도')}</button>}
      </div>
    </div>
  ) : <p className="live-idle">{!live ? CHECKING : live.active ? connecting : OFF_AIR}</p>);

  return (
    <div ref={page} className="popup-window watch">
      <header className="popup-bar">
        <span className="brand-mark" aria-hidden="true" />
        <strong className="popup-title">{t('라이브 시청')} <small>{sameAd ? t('가상 시청자 4명이 같은 방송을 봐요 · 지금은 광고가 1개라 모두 같은 광고를 받아요')
          : t('가상 시청자 4명이 같은 방송에서 저마다 다른 광고를 받아요')}</small></strong>
        {running && <span className="live-badge live-badge--inline">● LIVE</span>}
        {/* a tab list by keyboard too, as the console's own switch: arrow keys move, one Tab stop */}
        <div className="view-switch" role="tablist" aria-label={t('보기')} onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const next: View = e.key === 'Home' ? 'grid' : e.key === 'End' ? 'one' : one ? 'grid' : 'one';
          setView(next);
          e.currentTarget.querySelector<HTMLButtonElement>(`#watch-view-${next}`)?.focus();
        }}>
          <button id="watch-view-grid" type="button" role="tab" className="genre-tab" aria-controls="watch-main" aria-selected={!one} tabIndex={one ? -1 : 0} onClick={() => setView('grid')}>{t('가상 시청자 4명')}</button>
          <button id="watch-view-one" type="button" role="tab" className="genre-tab" aria-controls="watch-main" aria-selected={one} tabIndex={one ? 0 : -1} onClick={() => setView('one')}>{t('1명 보기')}</button>
        </div>
      </header>
      <div className={`watch-split${one ? '' : ' watch-split--grid'}`}>
        {/* the playable slot sits over whichever view is open (a switch of views keeps its session), and over the
            whole grid while it plays: the clicked tile, expanded */}
        <div id="watch-main" role="tabpanel" aria-labelledby={`watch-view-${view}`} className={`watch-main${lpPlaying ? ' is-playing' : ''}`}>
          {!one && (
            // inert while the page's one game plays over it: a covered card's button takes no click and no Tab. The tiles
            // keep playing and reporting behind it.
            <main className="watch-grid" aria-label={t('가상 시청자 4명')} inert={lpPlaying}>
              {running ? <ViewerGrid viewers={viewers} lockedCard={lockedCard} breaks={breaks} running={running} onPlaying={onTile} sessionId={sessionId}
                  playState={playState} onPlay={onPlay} onCancel={onCancel} onUnknown={onUnknown} warmUntil={warmUntil} />
                : idle(CONNECTING_GRID)}
            </main>
          )}
          {one && <main className="watch-stage" data-playback={playback ? qualityText(playback.q) : undefined}
            data-playback-low={playback?.drop.dropped ? 'true' : undefined}>
            {running && src ? <IvsPlayer key={persona} src={src} onMetadata={onMetadata} onAd={setAd} onLatency={setLatency} onPlaying={(on) => { oneAds.onPlaying(on); setWatching(on); }} onQuality={onQuality} onStall={setStuck} />
              : running ? <p className="live-idle">{t('방송 화면을 여는 중이에요…')}</p> : idle(CONNECTING_ONE)}
            {running && <LiveClock />}
            {running && ad.on && <span className="live-ad">{badge.text}{badge.why && <small className="live-ad-why">{badge.why}</small>}</span>}
            {running && oneAds.corner && !ad.on && (
              <CornerAd key={oneAds.corner.eventId} url={oneAds.corner.pick.url ?? ''} title={oneAds.corner.pick.title}
                gameUrl={oneAds.corner.pick.gameUrl} seconds={oneAds.corner.seconds}
                onEvent={(action) => oneAds.beacon(oneAds.corner!.eventId, 'corner', action)} onDone={oneAds.dropCorner} />
            )}
            {running && oneCard && !lpPlaying && !lpEnded && (
              <PlayableCard title={oneCard.pick.title} seconds={oneCard.pick.seconds} reason={persona ? oneCard.pick.reason : undefined}
                state={playState(persona)} onCancel={() => onCancel(persona)} warmUntil={warmUntil}
                onPlay={() => onPlay({ viewerId: persona, eventId: oneCard.eventId, pick: oneCard.pick })} />
            )}
            {running && overlay && !oneAds.card && !oneAds.corner && !lpPlaying && (
              <figure className="hl-overlay" key={overlay.id}>
                <video src={overlay.url} muted autoPlay playsInline onEnded={() => setOverlay(null)}
                  onError={() => setOverlay(null)} aria-label={t('오버레이: {title}', { title: overlay.title })} />
                <figcaption>{t('하이라이트 · 오버레이')}</figcaption>
              </figure>
            )}
          </main>}
          {lpMounted && (
            <LivePlayable key={job?.jobId ?? 'off'} sessionId={sessionId} request={playableOn || lpPlaying ? want[0] ?? null : null}
              standby={playableOn && !job?.standbyOff} standbyToken={job?.standbyToken} viewerId={likely} hint={want.length ? null : hint}
              header={playingReq && (
                <span className="lp-who">
                  {who && <span className="vt-avatar" style={{ background: who.color }} aria-hidden="true">{who.initials}</span>}
                  <strong>{who ? t('{name}의 게임', { name: who.name }) : t('기본')} · {playingReq.title}</strong>
                </span>
              )}
              onEnded={setLpEnded} onPlaying={setLpPlaying} onDone={onDone}
              onQueue={(key, pos) => setSeat((s) => { const n = { ...s }; if (pos) n[key] = pos; else delete n[key]; return n; })}
              onWarm={(state, took, eta) => setWarm({ state, took, until: state === 'warming' && eta ? Date.now() + eta * 1000 : undefined })} />
          )}
        </div>
        <aside className="watch-side" aria-label={t('방송 정보')}>
          {one ? (
            <label className="watch-persona" style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
              <span>{t('가상 시청자')}</span>
              <select aria-label={t('가상 시청자')} value={persona} onChange={(e) => setPersona(e.target.value)}>
                <option value="">{t('기본 (시청자 정보 없음)')}</option>
                {viewers.map((v) => <option key={v.viewerId} value={v.viewerId}>{v.name} · {v.profile.genres.map((g) => GENRE[g] ?? g).join(', ')}</option>)}
              </select>
              <small className="muted">{viewers.find((v) => v.viewerId === persona)?.bio
                ?? t('맞춤 없이 기본 광고를 받아요. 가상 시청자를 고르면 그 프로필과 활동 기록에 맞춰 고른 광고가 나가요.')}</small>
            </label>
          ) : (
            <p className="muted field-hint">{t('가상 시청자 4명은 실제 사람이 아니에요. 시청자마다 다른 광고가 나가는 걸 보여 주려고 만든 프로필이에요. 같은 방송을 보지만, 광고는 각자의 프로필과 활동 기록에 맞춰 골라요. 플레이어블 광고 카드를 누르면 그 화면이 커져서 바로 플레이할 수 있어요 (한 번에 한 명).')}</p>
          )}
          {/* why they all get the same ad now, and how to change that: above the chips, in both views */}
          {sameAd && <p className="same-ad-note" role="note">{sameAd}</p>}
          <dl className="live-chips live-chips--stack">
            <div><dt>{t('방송 화면')}</dt><dd>{live?.active ? t('플레이 창의 게임 화면') : '–'}</dd></div>
            <div><dt>{t('방송 상태')}</dt><dd>{failed ? t('확인 안 됨') : !live ? t('확인 중')
              : running ? (stuck ? `LIVE · ${t('영상 멈춤, 다시 연결 중')}` : playback?.drop.dropped ? `LIVE · ${dropText(playback.q, isLowQuality(playback.q))}`
                : live.health === 'STARVING' ? `LIVE · ${t('송출 불안정')}` : 'LIVE') : live.active ? t('연결 중') : t('꺼짐')}</dd></div>
            <div><dt>{t('끝난 판')}</dt><dd>{tn('{n}판#판수', rounds)}</dd></div>
            <div><dt>{t('다음 광고까지')}</dt><dd>{next ? tn('{n}판#판수', next) : '–'}</dd></div>
            {/* (with no status yet the page does not know how the channel is set up: no word on it) */}
            <div title={adInsertionHow(live) || undefined}><dt>{t('광고 방식')}</dt><dd>{live ? adInsertionText(live) : '–'}</dd></div>
            {/* with the server switched off a card's ▶ 지금 플레이 here starts one for that play: its price is said.
                A server the broadcast holds was priced at 라이브 켜기 */}
            {playableOn && job?.standbyOff && <div><dt>{t('플레이어블 서버')}</dt><dd>{t('꺼짐 · 카드를 누르면 그때 켜져요 (켜져 있는 동안 시간당 약 ${usd})', { usd: GPU_HOURLY_USD.toFixed(2) })}</dd></div>}
            {playableOn && !job?.standbyOff && <div><dt>{t('플레이어블 서버')}</dt><dd>{warm?.state === 'ready' ? t('준비 완료 · 어떤 게임이든 ({n}초 걸림)', { n: warm.took ?? 0 }) : warm?.state === 'error' ? t('자리 없음 · 다시 시도 중') : t('준비 중')}</dd></div>}
          </dl>
          <h3 className="watch-h">{t('하이라이트 쇼츠')} <small title={t('Pegasus 1.5가 판마다 명장면을 골라요')}>{generating ? t('자동 생성 중') : t('자동 생성 꺼짐')}</small></h3>
          <HighlightCarousel items={highlights} onSend={() => undefined} onDelete={() => undefined} readOnly />
          <h3 className="watch-h">{t('나간 광고 기록')}{past && <small>{t('지난 방송')}</small>}</h3>
          {breaks.length ? (
            <ol className="watch-breaks">
              {[...breaks].reverse().map((b) => (
                <li key={b.eventId} title={detail(b)}><strong>{t('{n}판', { n: b.round })} · {KIND[kindKey(b)]}</strong>
                  <span>{fmtTime(b.at)}{shown(b) ? ` · ${shown(b)}` : ''} · {t('{n}초', { n: Math.round(b.seconds) })}{timing(b)}</span>
                  {/* why this ad and not the one the broadcast is set to (the server's sentence) */}
                  {b.note && <small className="watch-break-note">{b.note}</small>}</li>
              ))}
            </ol>
          ) : <p className="muted">{ended?.ads ? tn('지난 방송에서 광고가 {n}번 나갔어요.', ended.ads) : t('아직 광고가 나가지 않았어요.')} {!every
            // off air the page does not know the interval (it is chosen in the console): no number, and no literal N
            ? t('라이브를 켜면 정한 판수가 끝날 때마다 시청자마다 다른 광고가 나가요.')
            : job?.adType === 'playable' ? (sameAd ? tn('{n}판이 끝나면 플레이어블 광고 카드가 떠요.', every) : tn('{n}판이 끝나면 시청자마다 다른 플레이어블 광고 카드가 떠요.', every))
              : job?.adType === 'corner' ? (sameAd ? tn('{n}판이 끝나면 코너 트레일러가 화면 구석에 떠요.', every) : tn('{n}판이 끝나면 시청자마다 다른 코너 트레일러가 화면 구석에 떠요.', every))
                : sameAd ? tn('{n}판이 끝나면 트레일러가 화면 전체에 나와요.', every) : tn('{n}판이 끝나면 시청자마다 다른 트레일러가 화면 전체에 나와요.', every)}</p>}
          <p className="muted field-hint">{latency ? t('방송은 플레이보다 약 {n}초 늦게 보여요.', { n: Math.max(1, Math.round(latency + 1)) }) : t('방송은 플레이보다 몇 초 늦게 보여요.')} {t('화면 속 ‘송출’ 시각과 오른쪽 아래 ‘지금’ 시각의 차이가 실제 지연이에요.')}</p>
        </aside>
      </div>
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((l) => l.filter((x) => x.id !== id))} onAction={() => undefined} />
    </div>
  );
}
