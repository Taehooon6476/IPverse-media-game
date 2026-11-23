import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { liveAdEvent, liveToken, type AdBreak, type AdPick, type Viewer } from '../api';
import { CARD_MS, CORNER_SEC, CornerAd, PlayableCard, type CardState } from './AdOverlays';
import { IvsPlayer, type IvsAd } from './IvsPlayer';

/** A viewer's token is asked for again this long before it expires (a reload then still finds a valid one). */
export const RENEW_BEFORE_MS = 3 * 60 * 1000;
/** A tile plays a small picture: four low-latency players share one PC. */
const TILE_SIZE: [number, number] = [480, 270];

export const GENRE: Record<string, string> = {
  arpg: t('액션 RPG'), racing: t('레이싱'), explore: t('탐험·수집'), shooter: t('SF 슈터'), survival: t('서바이벌'), platformer: t('플랫포머'),
};
const DEVICE: Record<string, string> = { pc: 'PC', console: t('콘솔'), mobile: t('모바일') };
/** Older persona ids mapped to these viewers (an old link still opens the right one). */
export const PERSONA_VIEWER: Record<string, string> = { action: 'v-minji', racer: 'v-junho', explorer: 'v-seoyeon' };

/** The private channel's URL with this viewer's token ('' until it is issued), renewed before it runs out. A new
 * token for the same channel does not restart the player (IVS checks it at load). */
export function useViewerToken(viewerId: string): string {
  const [tok, setTok] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!viewerId) return;
    let alive = true;
    let timer = 0;
    const renew = async () => {
      try {
        const t = await liveToken(viewerId);
        if (!alive) return;
        setTok({ id: viewerId, url: t.playbackUrl });
        timer = window.setTimeout(renew, Math.max(30_000, t.expiresAt * 1000 - Date.now() - RENEW_BEFORE_MS));
      } catch { if (alive) timer = window.setTimeout(renew, 10_000); }
    };
    void renew();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [viewerId]);
  return tok?.id === viewerId ? tok.url : '';
}

/** The breaks that gave this viewer an ad, newest first: full-screen trailers, corner trailers and playable cards. */
export function adHistory(breaks: AdBreak[], viewerId: string): { round: number; eventId: string; pick: AdPick; kind: string }[] {
  return breaks.filter((b) => (b.kind === 'trailer' || b.kind === 'corner' || b.playable) && b.picks?.[viewerId] && !b.lost)
    .map((b) => ({ round: b.round, eventId: b.eventId, pick: b.picks![viewerId], kind: b.playable ? 'playable' : b.kind! })).reverse();
}

const HISTORY_KIND: Record<string, string> = { corner: ` · ${t('코너')}`, playable: ` · ${t('플레이어블')}` };

/** What a viewer sees in the running break: "광고: <title> · 이유: <reasons>" (a highlight goes to everyone). */
export function adLine(breaks: AdBreak[], viewerId: string): string {
  const last = [...breaks].reverse().find((b) => b.kind === 'trailer' || b.kind === 'linear');
  if (!last) return t('광고');
  if (!last.picks) {
    return `${t('광고: {title}', { title: [t('하이라이트'), last.title].filter(Boolean).join(' · ') })} · ${t('이유: {reason}', { reason: t('모든 시청자에게 같은 장면') })}`;
  }
  const p = last.picks[viewerId] ?? last.picks[''];
  if (!p) return t('광고');
  return `${t('광고: {title}', { title: p.title })}${p.reason ? ` · ${t('이유: {reason}', { reason: p.reason })}` : ''}`;
}

/** A break's pick for this viewer ('' = 기본), once the break log has it. */
export function pickOf(breaks: AdBreak[], eventId: string, viewerId: string): AdPick | null {
  const b = breaks.find((x) => x.eventId === eventId);
  return b?.picks?.[viewerId] ?? b?.picks?.[''] ?? null;
}

/** An in-band cue (IVS timed metadata) this player reached: a playable card or a corner trailer, by break id. wait: how
 * long a corner may be held behind a full-screen ad on this player (the server's room before the next round's ad). */
export type Cue = { type: 'playable' | 'corner'; eventId: string; seconds?: number; wait?: number };
export function parseCue(text: string): Cue | null {
  try {
    const m = JSON.parse(text) as { type?: string; e?: string; seconds?: number; wait?: number };
    return (m.type === 'playable' || m.type === 'corner') && m.e
      ? { type: m.type, eventId: m.e, seconds: m.seconds, ...(typeof m.wait === 'number' ? { wait: m.wait } : {}) } : null;
  } catch { return null; }
}

/** A corner held behind a full-screen ad shows when the ad ends if that is within this long of its cue (an old
 * server's cue carries no wait). With no ad on, a corner waits at least this long for the break log to bring its pick. */
export const CORNER_WAIT_SEC = 10;

/** A playable break the break log has but this player never got the cue of shows its card anyway once the cue is
 * this late (its video is past the moment), while the card would still be up: a cue sent while the players rejoin
 * after a send restart reaches no tile. */
export const CUE_LATE_MS = 9000;

/** A full-screen break's mark (timed metadata the server sends with ivs:InsertAdBreak, on the frame of the call)
 * counts for an ad that starts within this long of it: a break sits 3–7.5 s after its call in the stream. */
export const MARK_MAX_MS = 15_000;
/** A player that stood still for this long between a break's mark and its ad has no reading to give: the reading is
 * the tile's wall clock, and a rebuffer is in it. A tile that plays through stands under 0.25 s there and the
 * readings spread 0.75 s, so 1 s tells a stall from both. */
export const STALL_MAX_MS = 1000;
/** A full-screen break's ad starts about this long after its mark on a tile's picture, when the tiles that told of
 * it gave no figure (a break sits 3.0–7.5 s after its call in the stream). */
export const QUIET_LEAD_SEC = 5;
/** What the break log carries of a break beside what AdBreak names: the tiles that reported its ad, and how long
 * after its mark each saw it (server/live.py _ad_shown: seconds). */
type Seen = AdBreak & { shown?: Record<string, number>; tileLead?: Record<string, number> };
/** The break id of a mark cue, else null. */
function markOf(text: string): string | null {
  try {
    const m = JSON.parse(text) as { type?: string; e?: string };
    return m.type === 'mark' && m.e ? m.e : null;
  } catch { return null; }
}

/** One player's in-band ads: the playable card (up for CARD_MS unless it is in play or in line) and the corner
 * trailer, each resolved against the break log (an unknown break asks for a status poll now). The watch page's
 * beacon records what was shown and what the viewer did. adOn: this player is in a full-screen ad: a corner cued
 * during it waits and shows after it, unless the ad ends later than the cue's wait (dropped); a full-screen ad
 * that starts while a corner is up ends that corner. A stitched ad replaces the frame a cue rides on, so a player
 * inside its ad never gets that cue: there the break log stands in for it. adLate: the player told of its ad
 * after it had begun (IvsPlayer), so the report says the break aired and gives no figure. */
export function useInBandAds(sessionId: string, viewerId: string, breaks: AdBreak[], onUnknown?: () => void, adOn = false, adLate = false) {
  const [card, setCard] = useState<{ eventId: string; until: number } | null>(null);
  const [corner, setCorner] = useState<{ eventId: string; seconds: number; deadline: number; shown: boolean } | null>(null);
  const [, tick] = useState(0);
  const cued = useRef(new Set<string>()); // the breaks this player's video brought (or the log stood in for)
  const adNow = useRef(adOn);
  adNow.current = adOn;
  const adEnd = useRef(0); // when this player's last full-screen ad ended (Infinity while one is on)
  // The newest break mark this player's video reached. Its ad's start is reported with how long after the mark it
  // came on this player's own picture: where the break sat in the stream after the server's call, and the server's
  // only word that the break aired at all.
  const mark = useRef<{ e: string; at: number } | null>(null);
  // how long this player has not been playing since that mark (since: when it stopped, 0 while it plays)
  const stall = useRef({ since: 0, ms: 0 });
  const onPlaying = useCallback((on: boolean) => {
    const s = stall.current;
    if (!on) s.since ||= Date.now();
    else if (s.since) { s.ms += Date.now() - s.since; s.since = 0; }
  }, []);
  useEffect(() => {
    if (!adOn) return;
    adEnd.current = Infinity;
    const m = mark.current && Date.now() - mark.current.at <= MARK_MAX_MS ? mark.current : null;
    mark.current = null;
    const s = stall.current;
    const stood = s.ms + (s.since ? Date.now() - s.since : 0);
    // a stalled player still says the break aired (its mark's id), without the number; so does one that told late
    void liveAdEvent(sessionId, { viewerId, eventId: m?.e ?? '', kind: 'trailer', action: 'start',
      ...(m && stood < STALL_MAX_MS && !adLate ? { leadMs: Date.now() - m.at } : {}) }).catch(() => undefined);
    return () => { adEnd.current = Date.now(); };
  }, [adOn]); // eslint-disable-line react-hooks/exhaustive-deps
  // The ad a player plays without telling (its ad events do not always come). The break log then stands in for the
  // player's word: a break whose mark this player's video reached, and whose ad another screen reported, is on this
  // picture too, from the mark plus what the others measured, for this viewer's own creative's length. The mark
  // alone does not say it aired (IVS can take a break and never stitch it), and nothing is reported from here:
  // neither the player nor the video element shows that an ad is on, so a tile must not report an ad it cannot
  // tell it played.
  const reached = adOn ? null : mark.current;
  const told = reached ? (breaks as Seen[]).find((b) => b.breakId === reached.e && b.kind === 'trailer' && !b.lost) : undefined;
  const others = Object.entries({ ...told?.shown, ...told?.tileLead }).filter(([v]) => v !== viewerId);
  const leads = Object.entries(told?.tileLead ?? {}).filter(([v]) => v !== viewerId).map(([, s]) => s);
  const quietFrom = reached && told && others.length ? reached.at + (leads.length ? Math.min(...leads) : QUIET_LEAD_SEC) * 1000 : 0;
  const quietUntil = quietFrom && quietFrom + ((told!.picks?.[viewerId] ?? told!.picks?.[''])?.seconds ?? told!.seconds) * 1000;
  useEffect(() => { // its own clock: the line comes and goes without a poll
    const ahead = [quietFrom, quietUntil].filter((t) => t > Date.now());
    const timers = ahead.map((t) => window.setTimeout(() => tick((n) => n + 1), t - Date.now() + 10));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [quietFrom, quietUntil]);
  const quietAd = !!quietFrom && Date.now() >= quietFrom && Date.now() < quietUntil;
  const onCue = useCallback((text: string) => {
    const marked = markOf(text);
    if (marked) {
      mark.current = { e: marked, at: Date.now() };
      stall.current = { since: stall.current.since && Date.now(), ms: 0 }; // counted from the mark
      return;
    }
    const cue = parseCue(text);
    if (cue?.type === 'playable') cued.current.add(cue.eventId);
    if (cue?.type === 'playable') setCard({ eventId: cue.eventId, until: Date.now() + CARD_MS });
    else if (cue?.type === 'corner' && !cued.current.has(cue.eventId)) { // once: not again from a replayed cue
      cued.current.add(cue.eventId);
      const wait = adNow.current ? cue.wait ?? CORNER_WAIT_SEC : Math.max(cue.wait ?? 0, CORNER_WAIT_SEC);
      setCorner({ eventId: cue.eventId, seconds: cue.seconds ?? CORNER_SEC, shown: false, deadline: Date.now() + wait * 1000 });
    }
  }, []);
  // a playable break whose cue never reached this player: its card from the log once the cue is CUE_LATE_MS late
  const logged = [...breaks].reverse().find((b) => b.playable);
  const loggedAt = logged ? Date.parse(logged.at) : NaN;
  const loggedPick = !!logged && !!(logged.picks?.[viewerId] ?? logged.picks?.['']);
  useEffect(() => {
    if (!logged || !loggedPick || Number.isNaN(loggedAt) || cued.current.has(logged.eventId)) return;
    const id = logged.eventId;
    const t = window.setTimeout(() => {
      const last = loggedAt + CUE_LATE_MS + CARD_MS; // the card is up until then at most
      if (cued.current.has(id) || Date.now() > last - 3000) return; // cued meanwhile, or nearly over
      cued.current.add(id);
      setCard({ eventId: id, until: Math.min(Date.now() + CARD_MS, last) });
    }, Math.max(0, loggedAt + CUE_LATE_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [logged?.eventId, loggedAt, loggedPick]); // eslint-disable-line react-hooks/exhaustive-deps
  const cardPick = card ? pickOf(breaks, card.eventId, viewerId) : null;
  const cornerPick = corner ? pickOf(breaks, corner.eventId, viewerId) : null;
  // a corner shows when no full-screen ad is on; one still waiting for the ad's end goes once its wait is over
  const cornerUp = !!corner && !!cornerPick && !adOn && (corner.shown || Date.now() <= corner.deadline);
  useEffect(() => {
    if (!corner) return;
    if (adOn && corner.shown) setCorner(null); // the ad took the screen: this corner is over
    // on screen, its impression sent: it stays
    else if (cornerUp && !corner.shown) setCorner({ ...corner, shown: true });
    else if (!adOn && !corner.shown && Date.now() > corner.deadline) setCorner(null); // too late for it now
  }, [adOn, corner, cornerUp]);
  // a corner break whose cue this player never got because its full-screen ad replaced the cue's frame: the corner
  // from the log once the cue is CUE_LATE_MS late, held like a cued one (shown when the ad ends, inside its wait).
  // Only a player whose ad was on since the break: any other's video is still on its way to that round's end
  const lost = [...breaks].reverse().find((b) => b.kind === 'corner');
  const lostAt = lost ? Date.parse(lost.at) : NaN;
  const lostPick = !!lost && !!(lost.picks?.[viewerId] ?? lost.picks?.['']);
  useEffect(() => {
    if (!lost || !lostPick || Number.isNaN(lostAt) || cued.current.has(lost.eventId)) return;
    const { eventId, seconds } = lost;
    const deadline = lostAt + CUE_LATE_MS + (lost.wait ?? CORNER_WAIT_SEC) * 1000;
    const t = window.setTimeout(() => {
      if (cued.current.has(eventId) || adEnd.current < lostAt || Date.now() >= deadline) return;
      cued.current.add(eventId);
      setCorner({ eventId, seconds, shown: false, deadline });
    }, Math.max(0, lostAt + CUE_LATE_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [lost?.eventId, lostAt, lostPick]); // eslint-disable-line react-hooks/exhaustive-deps
  const unknown = (card && !cardPick) || (corner && !cornerPick);
  const asked = useRef(onUnknown);
  asked.current = onUnknown;
  useEffect(() => { if (unknown) asked.current?.(); }, [unknown]);
  useEffect(() => { // the card's own clock (a card in play or in line stays: the caller decides)
    if (!card) return;
    const t = window.setTimeout(() => tick((n) => n + 1), Math.max(0, card.until - Date.now()) + 10);
    return () => window.clearTimeout(t);
  }, [card]);
  const beacon = useCallback((eventId: string, kind: 'corner' | 'playable', action: 'impression' | 'click' | 'expand' | 'unmute') => {
    if (viewerId) void liveAdEvent(sessionId, { viewerId, eventId, kind, action }).catch(() => undefined);
  }, [sessionId, viewerId]);
  const shownCard = useRef('');
  useEffect(() => {
    if (card && cardPick && shownCard.current !== card.eventId) {
      shownCard.current = card.eventId;
      beacon(card.eventId, 'playable', 'impression');
    }
  }, [card, cardPick, beacon]);
  return {
    onCue,
    onPlaying,
    quietAd,
    card: card && cardPick ? { eventId: card.eventId, pick: cardPick, fresh: Date.now() < card.until } : null,
    dropCard: () => setCard(null),
    corner: corner && cornerPick && cornerUp ? { eventId: corner.eventId, pick: cornerPick, seconds: corner.seconds } : null,
    dropCorner: () => setCorner(null),
    beacon,
  };
}

function ago(at: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(at)) / 1000);
  if (s < 60) return t('방금');
  if (s < 3600) return t('{n}분 전', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n}시간 전', { n: Math.floor(s / 3600) });
  return t('{n}일 전', { n: Math.floor(s / 86400) });
}

/** A playable card click: the viewer, the break and its pick. */
export interface PlayClick { viewerId: string; eventId: string; pick: AdPick }

interface TileProps {
  viewer: Viewer;
  breaks: AdBreak[];
  running: boolean;
  onPlaying: (viewerId: string, playing: boolean) => void;
  sessionId?: string;
  /** This viewer's playable request on the page: in line at n, opening, playing (or none). */
  playState?: (viewerId: string) => CardState;
  onPlay?: (click: PlayClick) => void;
  onCancel?: (viewerId: string) => void;
  /** A cue named a break the status has not brought yet. */
  onUnknown?: () => void;
  /** The card this viewer clicked (in line, opening): it stays on the tile through a newer cue. */
  lockedCard?: (viewerId: string) => { eventId: string; pick: AdPick } | null;
  /** The page's launcher is still starting: when it should be ready (the card's "준비 중 · 약 n초"). */
  warmUntil?: number;
}

/** One viewer: its own IVS player (its own token, so MediaTailor asks for its own VAST), profile chips, the latest
 * activity, the ad it sees now with the reasons, its ad history, and the in-band ads of its own player: its playable
 * card (its own game) and its corner trailer. */
export function ViewerTile({ viewer, breaks, running, onPlaying, sessionId = '', playState, onPlay, onCancel, onUnknown,
  lockedCard, warmUntil }: TileProps) {
  const src = useViewerToken(viewer.viewerId);
  const [ad, setAd] = useState<IvsAd>({ on: false });
  const history = adHistory(breaks, viewer.viewerId).slice(0, 4);
  const inband = useInBandAds(sessionId, viewer.viewerId, breaks, onUnknown, running && ad.on, !!ad.late);
  const state = playState?.(viewer.viewerId) ?? { kind: 'idle' };
  const [instead, setInstead] = useState<AdPick | null>(null); // the trailer a waiting card offers instead
  // clicked: the clicked game until it plays or is called off; else the latest cue's card while it is fresh
  const card = (state.kind !== 'idle' ? lockedCard?.(viewer.viewerId) : null)
    ?? (inband.card && (inband.card.fresh || state.kind !== 'idle') ? inband.card : null);
  const now = Date.now();
  const p = viewer.profile;
  return (
    <article className="vt" aria-label={t('가상 시청자 {name}', { name: viewer.name })} data-viewer={viewer.viewerId}>
      <header className="vt-head">
        <span className="vt-avatar" style={{ background: viewer.color }} aria-hidden="true">{viewer.initials}</span>
        <div className="vt-who">
          <strong>{viewer.name}</strong>
          <ul className="vt-chips" aria-label={t('프로필')}>
            <li>{p.ageBand}</li><li>{p.region}</li><li>{DEVICE[p.device] ?? p.device}</li>
            {p.genres.map((g) => <li key={g} className="vt-chip--fav">{GENRE[g] ?? g}</li>)}
            {viewer.provider === 'gam' && <li className="vt-chip--gam">GAM</li>}
          </ul>
        </div>
      </header>
      <div className="vt-stage">
        {running && src
          ? <IvsPlayer src={src} ariaLabel={t('{name}의 방송 화면', { name: viewer.name })} maxSize={TILE_SIZE} onAd={setAd}
              onMetadata={inband.onCue} onPlaying={(on) => { inband.onPlaying(on); onPlaying(viewer.viewerId, on); }} />
          : <p className="live-idle">{running ? t('방송 화면을 여는 중…') : t('방송 대기 중')}</p>}
        {/* the player's own word, or the break log's when the player plays its ad without telling */}
        {running && (ad.on || inband.quietAd) && <p className="vt-ad" role="status">{adLine(breaks, viewer.viewerId)}</p>}
        {running && inband.corner && !ad.on && !instead && (
          <CornerAd key={inband.corner.eventId} url={inband.corner.pick.url ?? ''} title={inband.corner.pick.title}
            gameUrl={inband.corner.pick.gameUrl} seconds={inband.corner.seconds}
            onEvent={(action) => inband.beacon(inband.corner!.eventId, 'corner', action)} onDone={inband.dropCorner} />
        )}
        {instead?.trailerUrl && (
          <CornerAd key={`instead-${instead.adId}`} url={instead.trailerUrl} title={instead.title} gameUrl={instead.ctaUrl} big
            onDone={() => setInstead(null)} />
        )}
        {running && card && !ad.on && state.kind !== 'playing' && !instead && (
          <PlayableCard title={card.pick.title} seconds={card.pick.seconds} reason={card.pick.reason} state={state} warmUntil={warmUntil}
            onPlay={() => onPlay?.({ viewerId: viewer.viewerId, eventId: card.eventId, pick: card.pick })}
            onTrailer={card.pick.trailerUrl ? () => { onCancel?.(viewer.viewerId); setInstead(card.pick); inband.dropCard(); } : undefined}
            onCancel={() => onCancel?.(viewer.viewerId)} />
        )}
      </div>
      <div className="vt-body">
        <section aria-label={t('최근 활동')}>
          <h4 className="vt-h">{t('최근 활동')} <small>{t('{n}건', { n: viewer.events })}</small></h4>
          <ol className="vt-feed">
            {viewer.recent.slice(0, 5).map((e) => (
              <li key={`${e.at}-${e.type}`} className={e.simulated ? 'is-sim' : undefined}>
                {/* one line a row beside the tile's ad history: the whole line is its tooltip where the row cuts it */}
                <span title={e.text}>{e.text}</span><time dateTime={e.at}>{ago(e.at, now)}</time>
              </li>
            ))}
          </ol>
        </section>
        <section aria-label={t('광고 기록')}>
          <h4 className="vt-h">{t('광고 기록')}</h4>
          {history.length ? (
            <ol className="vt-ads">
              {history.map((h) => (
                <li key={h.eventId}><strong>{t('{n}판', { n: h.round })}{HISTORY_KIND[h.kind] ?? ''} · {h.pick.title}{h.pick.fallback ? ` ${t('(대체)')}` : ''}</strong>
                  {h.pick.reason && <span>{h.pick.reason}</span>}</li>
              ))}
            </ol>
          ) : <p className="muted vt-empty">{t('아직 받은 광고가 없어요.')}</p>}
        </section>
      </div>
    </article>
  );
}

/** "가상 시청자 4명": the four dummy viewers side by side (2×2), each its own muted, small player on the same channel. */
export function ViewerGrid({ viewers, ...rest }: Omit<TileProps, 'viewer'> & { viewers: Viewer[] }) {
  if (!viewers.length) return <p className="live-idle">{t('가상 시청자 정보를 불러오는 중이에요…')}</p>;
  return (
    <div className="vt-grid">
      {viewers.map((v) => <ViewerTile key={v.viewerId} viewer={v} {...rest} />)}
    </div>
  );
}
