import { Fragment, useState } from 'react';
import { t } from '../i18n';
import { IDEAS } from '../ideas';
import { fmtTime, type SessionSummary } from '../types';

interface Props {
  /** null while the list loads. */
  sessions: SessionSummary[] | null;
  /** Why the list did not load (sessions is null then). */
  error: string | null;
  onRetry: () => void;
  /** Makes a session and opens it. With an idea, the idea waits in the new session's chat box, not sent. Resolves
   * false when it failed (the caller says why). */
  onCreate: (title: string, idea?: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  /** Signed in with 데모 로그인: the shared account. */
  demo: boolean;
  /** The address named a session this account cannot open: deleted, or another account's. */
  missing: boolean;
}

/** What one idea becomes, in order. */
const STEPS = [t('캐릭터·소품 그림'), '3D', t('영상'), t('플레이 가능한 게임'), t('라이브 방송과 광고')];
const RECENT = 8;

/** The studio with no session open: after a sign-up, a 데모 로그인, a delete, or an address whose session is gone.
 * No session opens by itself after a login (on the shared demo account it could be somebody else's). */
export function StartScreen({ sessions, error, onRetry, onCreate, onSelect, demo, missing }: Props) {
  const [busy, setBusy] = useState<string | null>(null); // 'new', or the idea being opened
  const [all, setAll] = useState(false);
  const start = async (idea?: string) => {
    if (busy) return;
    setBusy(idea ?? 'new');
    await onCreate('', idea); // the screen goes away when it worked
    setBusy(null);
  };
  const shown = all ? sessions ?? [] : (sessions ?? []).slice(0, RECENT);

  return (
    <main id="main" tabIndex={-1} className="start" aria-labelledby="start-title">
      <div className="start-inner">
        {missing && <p className="notice start-notice" role="status">{t('주소에 있는 세션을 찾을 수 없어요. 지워졌거나 다른 계정의 세션일 수 있어요.')}</p>}
        {/* both ways: others' sessions show here, and this account's show to them */}
        {demo && <p className="notice start-notice start-notice--demo" role="note">{t('공용 데모 계정이에요. 다른 사람이 만든 세션이 함께 보이고, 여기서 만든 것도 다른 사람에게 보여요.')}</p>}
        <header className="start-head">
          <h2 id="start-title">{t('아이디어 한 줄로 시작해요')}</h2>
          <p className="start-lead">{t('아이디어 하나가 캐릭터·소품 그림에서 3D, 영상, 플레이 가능한 게임, 라이브 방송과 광고까지 이어져요.')}</p>
          {/* the same order as the sentence, to take in at a glance */}
          <ol className="start-steps" aria-hidden="true">
            <li className="start-step start-step--idea">{t('아이디어 한 줄')}</li>
            {STEPS.map((s) => <Fragment key={s}><li className="start-arrow">→</li><li className="start-step">{s}</li></Fragment>)}
          </ol>
        </header>
        <div className="start-action">
          <button type="button" className="btn btn-primary start-new" onClick={() => start()} disabled={busy !== null}>
            {busy === 'new' ? t('세션 여는 중…') : t('새 세션 시작')}
          </button>
          <p className="start-hint">{t('세션 하나가 작품 하나예요. 여기서 만든 캐릭터·소품을 IP라고 불러요.')}</p>
        </div>
        <section className="start-section" aria-labelledby="start-ideas-title">
          <h3 id="start-ideas-title">{t('예시 아이디어로 시작하기')}</h3>
          <p className="start-hint">{t('누르면 새 세션이 열리고, 아이디어가 채팅 입력창에 들어가요. 고친 뒤 보내면 돼요.')}</p>
          <ul className="start-ideas">
            {IDEAS.map((idea) => (
              <li key={idea}>
                <button type="button" className="start-idea" onClick={() => start(idea)} disabled={busy !== null}>
                  <span>{idea}</span>
                  <span className="start-idea-go" aria-hidden="true">{busy === idea ? t('여는 중…') : '→'}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        {/* three states: loading, failed with a retry, and the list; none at all for an account with no session yet */}
        {sessions === null && !error && (
          <section className="start-section" aria-labelledby="start-recent-title" aria-busy="true">
            <h3 id="start-recent-title">{t('최근 세션')}</h3>
            <span className="sr-only" role="status">{t('세션 목록을 불러오고 있어요.')}</span>
            <ul className="start-sessions" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => <li key={i} className="skel start-session-skel" />)}
            </ul>
          </section>
        )}
        {sessions === null && error && (
          <section className="start-section" aria-labelledby="start-recent-title">
            <h3 id="start-recent-title">{t('최근 세션')}</h3>
            <div className="load-error" role="alert">
              <p>{t('세션 목록을 불러오지 못했어요.')} {error}</p>
              <button type="button" className="btn btn-sm" onClick={onRetry}>{t('다시 시도')}</button>
            </div>
          </section>
        )}
        {sessions && sessions.length > 0 && (
          <section className="start-section" aria-labelledby="start-recent-title">
            <h3 id="start-recent-title">{t('최근 세션')} <span className="start-count">{t('{n}개', { n: sessions.length })}</span></h3>
            <ul className="start-sessions">
              {shown.map((s) => (
                <li key={s.sessionId}>
                  <a className="start-session" href={`#s=${encodeURIComponent(s.sessionId)}`} title={s.title}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // a new tab or window: the browser follows #s=<id>
                      e.preventDefault();
                      onSelect(s.sessionId);
                    }}>
                    <span className="session-icon" aria-hidden="true">{Array.from(s.title)[0] ?? '·'}</span>
                    <span className="start-session-title">{s.title}</span>
                    <time className="start-session-time" dateTime={s.createdAt}>{fmtTime(s.createdAt)}</time>
                  </a>
                </li>
              ))}
            </ul>
            {sessions.length > RECENT && !all && (
              <button type="button" className="btn btn-sm btn-ghost start-more" onClick={() => setAll(true)}>{t('세션 {n}개 모두 보기', { n: sessions.length })}</button>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
