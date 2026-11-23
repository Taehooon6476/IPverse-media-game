import { useEffect, useReducer, useRef, useState, type RefObject } from 'react';
import { getRelease, pollStream, startStream, stopStream } from '../api';
import { said, sentenceOf, t } from '../i18n';
import { CLOUD_WAIT_LINE, GPU_HOURLY_USD } from '../liveSettings';
import type { Game, StreamState } from '../types';
import { useDialog } from './useDialog';

type Phase = 'idle' | 'allocating' | 'connecting' | 'live' | 'ended' | 'error';
type Sdk = import('../vendor/gameliftstreams/gameliftstreams-1.3.0.mjs').GameLiftStreams;
type Ad = { videoUrl: string; skipAfterSec: number };

const POLL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** The UE5 build of the game over Amazon GameLift Streams (Web SDK 1.3.0, vendored per its licence):
 * generateSignalRequest → POST /stream → poll until ACTIVE (pre-roll ad meanwhile) → processSignalResponse → attachInput. */
export function UnrealStream({ sessionId, game, kind = 'unreal', big = false, onBigClose }: {
  sessionId: string; game: Game; kind?: 'unreal' | 'web';
  /** 크게 보기: the stream itself in a Modal (GamePane's button); onBigClose: its 닫기, Esc and backdrop */
  big?: boolean; onBigClose?: () => void;
}) {
  const web = kind === 'web';
  const panel = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const sdk = useRef<Sdk | null>(null);
  const streamId = useRef<string | null>(null);
  const run = useRef(0); // bumps on stop/unmount so a stale start loop exits
  const adDone = useRef<() => void>(() => {});
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [ad, setAd] = useState<Ad | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (phase !== 'allocating' && phase !== 'connecting') return;
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  const teardown = () => {
    run.current += 1;
    sdk.current?.close();
    sdk.current = null;
    const id = streamId.current;
    streamId.current = null;
    if (id) stopStream(sessionId, id).catch(() => {}); // billing stops with the session
  };
  useEffect(() => {
    addEventListener('pagehide', teardown); // closing the tab stops the paid session (keepalive DELETE)
    return () => { removeEventListener('pagehide', teardown); teardown(); };
  }, [sessionId, game.gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function play() {
    const mine = ++run.current;
    const alive = () => run.current === mine;
    setError('');
    setPhase('allocating');
    setStartedAt(Date.now());
    try {
      const release = await getRelease(game).catch(() => ({ ad: null }));
      const adFinished = new Promise<void>((resolve) => {
        adDone.current = () => {
          setAd(null);
          resolve();
        };
        if (!release.ad) resolve();
      });
      setAd(release.ad);

      const { GameLiftStreams } = await import('../vendor/gameliftstreams/gameliftstreams-1.3.0.mjs');
      const client = new GameLiftStreams({
        videoElement: video.current!,
        audioElement: audio.current!,
        inputConfiguration: { autoMouse: true, autoKeyboard: true, autoGamepad: true, autoPointerLock: true, setCursor: 'visibility' },
        clientConnection: {
          connectionState: (state) => {
            if (!alive()) return;
            if (state === 'connected') setPhase('live');
            if (state === 'failed') fail(t('클라우드 플레이 연결이 끊어졌어요.'));
          },
          channelError: () => alive() && fail(t('게임 화면을 받는 중에 문제가 생겼어요.')),
          serverDisconnect: () => { if (alive()) { teardown(); setAd(null); setPhase('ended'); } }, // 'idle' or 'terminated'
        },
      });
      sdk.current = client;
      const started = await startStream(sessionId, await client.generateSignalRequest(), game.gameId, kind);
      if (!alive()) { stopStream(sessionId, started.streamId).catch(() => {}); return; } // 취소 while it started
      streamId.current = started.streamId;

      let state: StreamState = started;
      while (alive() && !(state.status === 'ACTIVE' && state.signalResponse)) {
        if (state.status === 'ERROR' || state.status === 'TERMINATED' || state.status === 'TERMINATING') {
          throw said(state.statusReason === 'placementTimeout'
            ? t('지금은 클라우드 플레이 자리가 없어요. 잠시 뒤 다시 시도해 주세요.')
            : t('클라우드 플레이를 시작하지 못했어요.'));
        }
        await sleep(POLL_MS);
        state = await pollStream(sessionId, started.streamId);
      }
      await adFinished;
      if (!alive()) return;
      setPhase('connecting');
      await client.processSignalResponse(state.signalResponse!);
      if (!alive()) return;
      client.attachInput();
      setPhase('live');
      video.current?.focus();
    } catch (e) {
      // a sentence of ours, or the server's; the streaming SDK's own English is not one to show
      if (alive()) fail(sentenceOf(e) ?? t('클라우드 플레이를 시작하지 못했어요.'));
    }
  }

  function fail(message: string) {
    teardown();
    setAd(null);
    setError(message);
    setPhase('error');
  }

  function stop() {
    teardown();
    setAd(null);
    setPhase('ended');
  }

  const waited = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const busy = phase === 'allocating' || phase === 'connecting';
  // what a session costs and when it ends by itself, beside every button that starts one (다시 플레이 and 다시 시도 too)
  const cost = `${web ? t('켜 둔 동안 시간당 약 ${usd}', { usd: GPU_HOURLY_USD.toFixed(2) }) : t('켜 둔 동안 GPU 서버 요금이 들어요')} · ${t('{n}분 뒤 자동으로 꺼져요', { n: 30 })}`;

  // 크게 보기 (big): the same stage and <video> move into a Modal by class alone, never remounted, so the live
  // WebRTC session carries on; an empty frame keeps the inline spot
  return (
    <div className="preview">
      {big && <div className="media media-16x9 unreal-stage stream-big-spot" aria-hidden="true" />}
      <div className={big ? 'modal-root stream-big-root' : 'stream-inline'}>
      {big && <div className="modal-backdrop" onClick={onBigClose} />}
      <div ref={panel} className={big ? 'modal stream-big' : 'stream-panel'} role={big ? 'dialog' : undefined}
        aria-modal={big ? true : undefined} aria-labelledby={big ? 'stream-big-title' : undefined}>
      {big && <BigTrap panel={panel} onClose={() => onBigClose?.()} />}
      {big && (
        <div className="dialog-head">
          <h2 id="stream-big-title">{game.title}</h2>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onBigClose}>×</button>
        </div>
      )}
      <div className="media media-16x9 unreal-stage" onClick={() => phase === 'live' && sdk.current?.attachInput()}>
        <video ref={video} className="unreal-video" autoPlay playsInline disablePictureInPicture tabIndex={0}
          aria-label={t('{title} {what} 화면', { title: game.title, what: web ? t('클라우드 플레이') : 'Unreal' })} />
        <audio ref={audio} autoPlay />
        {ad && (
          <AdOverlay ad={ad} onDone={() => adDone.current()} />
        )}
        {!ad && phase !== 'live' && (
          <div className="unreal-overlay" role="status" aria-live="polite">
            {phase === 'idle' && (
              <>
                {/* before the press: what opens, how long the wait can be, what it costs and when it ends by itself */}
                <p className="unreal-headline">{web ? t('클라우드 플레이') : t('Unreal Engine 5 고품질 버전')}</p>
                <p className="muted">{t('이 게임을 클라우드 GPU 서버에서 실행해 이 창으로 보여 줘요.')} {web ? t('내 기기 사양과 상관없이 키보드와 마우스로 조작해요.') : t('키보드와 마우스로 조작해요.')}</p>
                <p className="muted">{CLOUD_WAIT_LINE}. {cost}.</p>
                <button className="btn btn-primary" onClick={play}>{web ? t('클라우드로 플레이') : t('Unreal로 플레이')}</button>
              </>
            )}
            {busy && (
              <>
                <div className="spinner" aria-hidden="true" />
                <p className="unreal-headline">{phase === 'allocating' ? t('1/2 · GPU 서버를 켜는 중이에요') : t('2/2 · 게임 화면을 연결하는 중이에요')}
                  {/* the seconds are for the eye: in this live region they would be read out every second */}
                  <span aria-hidden="true"> · {t('{n}초', { n: waited })}</span></p>
                <p className="muted">{phase === 'allocating' ? `${CLOUD_WAIT_LINE}.` : t('곧 시작해요.')}</p>
                <button className="btn btn-sm" onClick={stop}>{t('취소')}</button>
              </>
            )}
            {phase === 'ended' && (
              <>
                <p className="unreal-headline">{t('클라우드 플레이가 끝났어요')}</p>
                <p className="muted">{t('다시 플레이하면 GPU 서버가 다시 켜져요.')} {cost}.</p>
                <button className="btn btn-primary" onClick={play}>{t('다시 플레이')}</button>
              </>
            )}
            {phase === 'error' && (
              <>
                <p className="unreal-headline">{error}</p>
                <p className="muted">{t('다시 시도하면 GPU 서버가 켜져요.')} {cost}.</p>
                <button className="btn btn-primary" onClick={play}>{t('다시 시도')}</button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="preview-bar">
        <span className="preview-title">
          {game.title}
          <span className="badge">{web ? t('클라우드') : 'Unreal'}</span>
          {phase === 'live' && <span className="badge badge--done">{t('스트리밍 중')}</span>}
        </span>
        {phase === 'live' && (
          <span className="unreal-actions">
            <button className="btn btn-sm" onClick={() => video.current?.requestFullscreen?.()}>{t('전체 화면')}</button>
            <button className="btn btn-sm" onClick={stop}>{t('종료')}</button>
          </span>
        )}
      </div>
      </div>
      </div>
    </div>
  );
}

/** While the stream is big: the Modal's focus trap and Esc (useDialog), and the page does not scroll underneath. */
function BigTrap({ panel, onClose }: { panel: RefObject<HTMLDivElement | null>; onClose: () => void }) {
  useDialog(panel, onClose);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return null;
}

function AdOverlay({ ad, onDone }: { ad: Ad; onDone: () => void }) {
  const [left, setLeft] = useState(ad.skipAfterSec);
  useEffect(() => {
    const t = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="unreal-ad">
      <video src={ad.videoUrl} autoPlay playsInline onEnded={onDone} onError={onDone} />
      <span className="badge unreal-ad-label">{t('광고 · 게임 준비 중')}</span>
      <button className="btn btn-sm unreal-ad-skip" disabled={left > 0} onClick={onDone}>
        {left > 0 ? t('{n}초 후 건너뛰기', { n: left }) : t('건너뛰기')}
      </button>
    </div>
  );
}
