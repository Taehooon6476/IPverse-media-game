import { useEffect, useRef, useState } from 'react';
import { getPlayableAd, pollAdStream, startAdStream, stopAdStream, type PlayableAd } from '../api';
import { CLOUD_WAIT_LINE } from '../liveSettings';
import type { StreamState } from '../types';

type Phase = 'loading' | 'trailer' | 'allocating' | 'live' | 'end' | 'error';
type Sdk = import('../vendor/gameliftstreams/gameliftstreams-1.3.0.mjs').GameLiftStreams;

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const IDLE_MS = 30000;

/** Public playable ad (#ad=<id>, no login): trailer, then "N초 무료 체험 시작" streams the real game over Amazon GameLift
 * Streams for ad.seconds, then the end card sends the viewer to the full game. The page says before the press what
 * opens, how long the wait can be and how long the trial is. */
export function PlayableAdPage({ adId }: { adId: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const sdk = useRef<Sdk | null>(null);
  const streamId = useRef<string | null>(null);
  const run = useRef(0);
  const [ad, setAd] = useState<PlayableAd | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [, setLeft] = useState(0); // the hard stop; the game shows the time left
  // the game holds its round until the viewer's first input (&standby=1), so the hard stop starts then too (or
  // after IDLE_MS without any input)
  const [real, setReal] = useState(false);
  const [go, setGo] = useState(false);
  const waits = useRef(false); // the server asked the game to wait (a runtime that cannot starts on load)
  const [startedAt, setStartedAt] = useState(0);
  const [linking, setLinking] = useState(false); // the wait's second step: a server has the game, the picture is being connected
  const [, tick] = useState(0);
  useEffect(() => {
    if (phase !== 'allocating') return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);
  const waited = Math.max(0, Math.round((Date.now() - startedAt) / 1000));

  useEffect(() => {
    getPlayableAd(adId).then(
      (a) => { setAd(a); setPhase('trailer'); },
      (e) => { setError(e instanceof Error ? e.message : '체험판을 불러오지 못했어요.'); setPhase('error'); },
    );
  }, [adId]);
  useEffect(() => { if (ad) document.title = `${ad.title} · 체험판`; }, [ad]); // (the tab was titled like the studio)

  const teardown = () => {
    run.current += 1;
    sdk.current?.close();
    sdk.current = null;
    const id = streamId.current;
    streamId.current = null;
    if (id) stopAdStream(adId, id).catch(() => {});
  };
  useEffect(() => {
    window.addEventListener('pagehide', teardown);
    return () => { window.removeEventListener('pagehide', teardown); teardown(); };
  }, [adId]);

  // the play timer runs only while live, from the first input; at zero the stream ends and the end card shows
  useEffect(() => {
    if (phase !== 'live') return;
    if (!waits.current) { setReal(true); setGo(true); }
    const idle = window.setTimeout(() => setGo(true), IDLE_MS);
    return () => { window.clearTimeout(idle); setGo(false); setReal(false); };
  }, [phase]);
  useEffect(() => {
    if (phase !== 'live' || !go || !ad) return;
    setLeft(ad.seconds + 20);
    const t = window.setInterval(() => setLeft((n) => {
      if (n <= 1) { teardown(); setPhase('end'); return 0; }
      return n - 1;
    }), 1000);
    return () => window.clearInterval(t);
  }, [phase, go]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstInput = () => { if (phase === 'live' && !real) { setReal(true); setGo(true); } };

  async function play() {
    if (!ad) return;
    const mine = ++run.current;
    const alive = () => run.current === mine;
    setError('');
    setPhase('allocating');
    setLinking(false);
    setStartedAt(Date.now());
    try {
      const { GameLiftStreams } = await import('../vendor/gameliftstreams/gameliftstreams-1.3.0.mjs');
      const client = new GameLiftStreams({
        videoElement: video.current!,
        audioElement: audio.current!,
        inputConfiguration: { autoMouse: true, autoKeyboard: true, autoGamepad: true, autoPointerLock: true, setCursor: 'visibility' },
        clientConnection: {
          connectionState: (s) => { if (alive() && s === 'failed') fail('연결이 끊어졌어요.'); },
          channelError: () => alive() && fail('게임 화면을 받는 중에 문제가 생겼어요.'),
          serverDisconnect: () => { if (alive()) { teardown(); setPhase('end'); } },
        },
      });
      sdk.current = client;
      const started = await startAdStream(adId, await client.generateSignalRequest());
      if (!alive()) { stopAdStream(adId, started.streamId).catch(() => {}); return; } // 취소 while it started
      streamId.current = started.streamId;
      waits.current = !!started.waitsForInput;
      let state: StreamState = started;
      while (alive() && !(state.status === 'ACTIVE' && state.signalResponse)) {
        if (state.status === 'ERROR' || state.status === 'TERMINATED' || state.status === 'TERMINATING') {
          throw new Error('지금은 체험 자리가 없어요. 잠시 뒤 다시 시도해 주세요.');
        }
        await sleep(2000);
        state = await pollAdStream(adId, started.streamId);
      }
      if (!alive()) return;
      setLinking(true);
      await client.processSignalResponse(state.signalResponse!);
      if (!alive()) return;
      client.attachInput();
      setPhase('live');
      video.current?.focus();
    } catch (e) {
      if (alive()) fail(e instanceof Error ? e.message : '게임을 시작하지 못했어요.');
    }
  }

  function fail(message: string) {
    teardown();
    setError(message);
    setPhase('error');
  }

  return (
    // is-start: the button and its note are under the stage, and the page's column leaves them their room in the
    // window
    <main className={phase === 'trailer' && ad ? 'playable-ad is-start' : 'playable-ad'}>
      <header className="playable-ad-head">
        <span className="badge">설치 없이 바로 체험</span>
        <h1>{ad?.title ?? '…'}</h1>
        {phase === 'live' && <span className="playable-ad-timer">{ad?.seconds}초 체험 · 남은 시간은 게임 화면에</span>}
      </header>
      <div className="media media-16x9 unreal-stage playable-ad-stage" onClick={() => phase === 'live' && sdk.current?.attachInput()}
        onPointerDownCapture={firstInput} onKeyDownCapture={firstInput}>
        <video ref={video} className="unreal-video" autoPlay playsInline disablePictureInPicture tabIndex={0}
          aria-label={`${ad?.title ?? '게임'} 스트림`} hidden={phase !== 'live'} />
        {phase === 'live' && !real && <p className="lp-hint">클릭하거나 아무 키나 누르면 시작해요</p>}
        <audio ref={audio} autoPlay />
        {/* the session's trailer plays as it is, with a word on what it is (the start button sat over its own title) */}
        {phase === 'trailer' && ad?.trailerUrl && (
          <figure className="playable-ad-trailer-box">
            <video className="playable-ad-trailer" src={ad.trailerUrl} autoPlay muted loop playsInline aria-label="세계관 트레일러" />
            <figcaption>세계관 트레일러 · 체험은 {ad.title}</figcaption>
          </figure>
        )}
        {phase === 'trailer' && ad && !ad.trailerUrl && (
          <div className="playable-ad-pitch" aria-hidden="true"><span>{ad.title}</span><small>설치 없이 {ad.seconds}초 동안 바로 플레이</small></div>
        )}
        {phase !== 'live' && phase !== 'trailer' && (
          <div className="unreal-overlay" role="status" aria-live="polite">
            {phase === 'loading' && <div className="spinner" aria-hidden="true" />}
            {phase === 'allocating' && (
              <div className="ad-wait" aria-busy="true">
                <span className="sr-only" role="status">게임을 불러오는 중</span>
                <div className="spinner" aria-hidden="true" />
                <p className="unreal-headline">{linking ? '2/2 · 게임 화면을 연결하는 중이에요' : '1/2 · 게임 서버를 켜는 중이에요'}
                  <span aria-hidden="true"> · {waited}초</span></p>{/* the seconds: not read out every second */}
                <p className="muted">{linking ? '곧 시작해요.' : `${CLOUD_WAIT_LINE}. 이 창을 열어 두면 준비되는 대로 시작해요.`}</p>
                <button className="btn btn-sm" onClick={() => { teardown(); setPhase('trailer'); }}>취소</button>
              </div>
            )}
            {phase === 'end' && ad && (
              <>
                <p className="unreal-headline">체험이 끝났어요</p>
                <a className="btn btn-primary" href={ad.ctaUrl} target="_blank" rel="noopener noreferrer">전체 게임 하러 가기</a>
                <button className="btn btn-sm" onClick={play}>다시 체험</button>
              </>
            )}
            {phase === 'error' && (
              <>
                <p className="unreal-headline">{error}</p>
                {ad && <button className="btn btn-primary" onClick={play}>다시 시도</button>}
              </>
            )}
          </div>
        )}
      </div>
      {/* under the stage, before the press: what opens, how long the wait can be, how long the trial is */}
      {phase === 'trailer' && ad && (
        <div className="playable-ad-go">
          <button className="btn btn-primary game-start-btn" onClick={play}>▶ {ad.seconds}초 무료 체험 시작</button>
          <p className="muted">게임이 클라우드에서 실행돼 이 화면으로 바로 보여요 (설치 없음). 게임을 켜는 데 {CLOUD_WAIT_LINE}. 체험은 {ad.seconds}초이고, PC의 키보드와 마우스로 플레이해요.</p>
        </div>
      )}
    </main>
  );
}
