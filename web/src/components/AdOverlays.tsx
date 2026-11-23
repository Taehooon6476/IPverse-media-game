import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n';
import { CLOUD_WAIT } from '../liveSettings';

/** A playable card stays up this long after its cue unless clicked (or waiting in line). */
export const CARD_MS = 20000;
/** A corner trailer shows this long unless tapped (the server's CORNER_SEC rides on the cue). */
export const CORNER_SEC = 12;

export type CardState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'playing' } | { kind: 'queued'; position: number };

interface CardProps {
  title: string;
  seconds: number;
  reason?: string;
  state: CardState;
  onPlay: () => void;
  /** While it waits in line: the viewer's trailer of the game instead. */
  onTrailer?: () => void;
  onCancel?: () => void;
  /** The page's warm launcher is still starting: when it should be ready (epoch ms, an estimate). */
  warmUntil?: number;
}

/** Seconds past warmUntil after which the card says a server is starting from cold (minutes, not "soon"). */
const PREP_LATE_SEC = 20;
export function prepText(warmUntil: number, now = Date.now()): string {
  const n = Math.ceil((warmUntil - now) / 1000);
  return n > 0 ? t('준비 중 · 약 {n}초', { n }) : n > -PREP_LATE_SEC ? t('준비 중 · 곧') : t('서버를 켜는 중 · 처음에는 {wait} 걸려요', { wait: CLOUD_WAIT.cold });
}

/** The playable card of one viewer: its game, why it was picked for them, and the way in (or its place in line). */
export function PlayableCard({ title, seconds, reason, state, onPlay, onTrailer, onCancel, warmUntil }: CardProps) {
  const [, tick] = useState(0);
  const prepId = useId();
  const prep = warmUntil && (state.kind === 'idle' || state.kind === 'loading') ? prepText(warmUntil) : '';
  useEffect(() => { // the countdown ticks while it shows
    if (!prep) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [!!prep]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <figure className="hl-overlay hl-overlay--card lp-card play-card" aria-label={t('플레이어블 광고: {title}', { title })}>
      <p className="hl-overlay-title">{t('{title} · 지금 바로', { title })}</p>
      {reason && <p className="play-card-why">{t('이유: {reason}', { reason })}</p>}
      <figcaption title={t('Amazon GameLift Streams로 게임을 바로 열어요')}>{t('플레이어블 광고')}</figcaption>
      {state.kind === 'queued' ? (
        <div className="play-card-wait" role="status">
          <strong>{t('대기 {n}번째', { n: state.position })}</strong>
          <small>{t('자리가 나면 바로 시작해요')}</small>
          <div className="play-card-row">
            {onTrailer && <button type="button" className="btn btn-sm" onClick={onTrailer}>{t('트레일러 보기')}</button>}
            {onCancel && <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>{t('취소')}</button>}
          </div>
        </div>
      ) : (
        <>
          <button type="button" className="btn btn-primary btn-sm hl-overlay-play" onClick={onPlay}
            disabled={state.kind !== 'idle'} aria-busy={state.kind === 'loading'}
            aria-describedby={prep && state.kind === 'idle' ? prepId : undefined}>
            {state.kind === 'loading' ? prep || t('게임을 여는 중…') : state.kind === 'playing' ? t('플레이 중') : `▶ ${t('지금 플레이 ({n}초)', { n: seconds })}`}
          </button>
          {/* read with the button, not a live region: as one, its countdown would be read out every second */}
          {prep && state.kind === 'idle' && <small id={prepId} className="play-card-prep">{prep}</small>}
        </>
      )}
    </figure>
  );
}

type CornerAction = 'impression' | 'click' | 'expand' | 'unmute';

interface CornerProps {
  url: string;
  title: string;
  gameUrl?: string;
  seconds?: number;
  /** What the viewer did with it (the watch page's beacon: the corner trailer never goes through MediaTailor). */
  onEvent?: (action: CornerAction) => void;
  onDone: () => void;
  /** Opens already big with sound (the trailer a waiting card offers instead of the game). */
  big?: boolean;
}

/** The corner trailer: the viewer's own trailer, small and muted in the player's top right, over the broadcast that
 * keeps playing. A tap makes it big with sound; 게임 보기 opens the published game. It hides after `seconds`, or at
 * the trailer's end once it is big. */
export function CornerAd({ url, title, gameUrl, seconds = CORNER_SEC, onEvent, onDone, big: startBig = false }: CornerProps) {
  const [big, setBig] = useState(startBig);
  const ref = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onEvent, onDone });
  cb.current = { onEvent, onDone };
  // the impression goes out when the trailer starts playing, once: a creative that never loads (its error drops the
  // corner) was never seen
  const seen = useRef(false);
  const playing = () => {
    if (seen.current) return;
    seen.current = true;
    cb.current.onEvent?.('impression');
  };
  useEffect(() => {
    if (big) return;
    const timer = window.setTimeout(() => cb.current.onDone(), seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [big, seconds]);
  useEffect(() => {
    if (!startBig || !ref.current) return;
    ref.current.muted = false;
    void ref.current.play()?.catch(() => undefined);
  }, [startBig]);
  const tap = () => {
    const el = ref.current;
    if (big) { if (el) el.muted = !el.muted; return; }
    setBig(true);
    if (el) { el.muted = false; void el.play()?.catch(() => undefined); }
    cb.current.onEvent?.('expand');
    cb.current.onEvent?.('unmute');
  };
  return (
    <figure className={`corner-ad${big ? ' is-big' : ''}`} aria-label={t('코너 광고: {title}', { title })}>
      <button type="button" className="corner-ad-media" onClick={tap} aria-label={big ? t('소리 켜기/끄기') : t('크게 보기 · 소리 켜기')}>
        <video ref={ref} src={url} muted={!startBig} autoPlay playsInline onPlaying={playing} onEnded={() => cb.current.onDone()}
          onError={() => cb.current.onDone()} />
      </button>
      <figcaption>
        <span className="corner-ad-title">{title}</span>
        <small>{t('광고')}</small>
        <span className="corner-ad-row">
          {/* the published game of the trailer's own session (server/adserver.trailer_game); none yet: no link */}
          {gameUrl ? <a className="btn btn-primary btn-sm" href={gameUrl} target="_blank" rel="noopener noreferrer"
            onClick={() => cb.current.onEvent?.('click')}>{t('게임 보기')}</a> : <small className="corner-ad-soon">{t('게임 준비 중')}</small>}
          <button type="button" className="icon-btn corner-ad-close" aria-label={t('코너 광고 닫기')} onClick={() => cb.current.onDone()}>×</button>
        </span>
      </figcaption>
    </figure>
  );
}
