import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { ToastEvent } from '../types';

export interface Toast extends ToastEvent {
  id: number;
  /** What an error said is over (the server it could not reach answers again): it is no longer kept, and closes by
   * the clock of a plain toast. */
  passed?: boolean;
}

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  /** A toast's action button; the toast closes after it. */
  onAction: (actionId: string) => void;
  /** A toast's link to where its result shows (ToastEvent.open: an IP pane tab); the toast closes after it. */
  onOpen?: (tab: string) => void;
  /** A toast that says something failed stays until it is closed (the studio): it is the one place a failed send or
   * a refused action is said. It goes when it is closed, when its link is followed, or when a fourth toast needs its
   * place. Without this (the play and watch windows) it keeps its clock. */
  keepErrors?: boolean;
}

/** A plain toast's life: 4 s plus 60 ms a character, at most 12 s. One that did not go as asked, or that links to
 * a result, gets twice that, 8 s at least and 20 s at most. */
export const lifeMs = (t: Pick<ToastEvent, 'text' | 'level' | 'open'>) => (t.level !== 'ok' || t.open
  ? Math.min(20_000, 8_000 + 120 * t.text.length)
  : Math.min(12_000, 4_000 + 60 * t.text.length));

/** What a toast's link says, by the tab it opens (IpPane's tab ids). */
const OPEN_LABEL: Record<string, string> = { characters: t('그림 보기'), props: t('그림 보기'), '3d': t('3D 탭에서 보기'), video: t('영상 탭에서 보기'),
  pipeline: t('작업 현황에서 보기') };
// (said here, not in the list below: a toast there is named t)
const REGION = t('작업 알림');
const OPEN = t('보기');
const CLOSE = t('알림 닫기');

/** The first sentence of what a tool told the agent, without what only the agent needs: keys such as world.background
 * or render_3d, and anything in backticks. */
function firstSentence(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/`[^`]*`|\b[a-z][a-z0-9]*(?:[._][a-z0-9]+)+\b/g, '')
    .replace(/([.!?。])\s/g, '$1\n') // one sentence a line; 2.5D or 0.5 stay whole
    .split('\n')
    // tidy what a removed key leaves: "()", a space before punctuation, the colon of "찾을 수 없습니다: ip_x."
    .map((s) => s.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').replace(/ (?=[.,:;!?)])/g, '').trim().replace(/[:;,]+(?=[.!?]?$)/, ''))
    .find(Boolean) ?? '';
}

/** What a card button's tool said beyond "registered" (or why it refused), for its toast: the server's short `notice`,
 * else the first sentence of its message or warning (written for the agent). Null when it said nothing. */
export function toolNotice(result?: Record<string, unknown>): string | null {
  const notice = typeof result?.notice === 'string' ? result.notice.trim() : '';
  return notice || firstSentence(result?.message) || firstSentence(result?.warning) || null;
}

/** The stack at the foot of the workspace, beside the chat (origin.css): never over the top bar's jobs menu nor
 * under the phone's open chat. A plain toast lives by its length (a CSS animation); one with an action button
 * stays until used or closed, and so does an error where the page asks for that (keepErrors). Its clock stops
 * while the pointer moves over it or the focus is in it, and while the page is in the background. */
export function Toasts({ toasts, onDismiss, onAction, onOpen, keepErrors = false }: Props) {
  const stays = (t: Toast) => !!t.action || (keepErrors && t.level === 'error' && !t.passed); // no clock on it
  // The toast the pointer is moving over. Not :hover: a toast that came up under a resting pointer would never expire.
  const [held, setHeld] = useState<number | null>(null);
  const [away, setAway] = useState(() => document.hidden);
  useEffect(() => {
    const seen = () => setAway(document.hidden);
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []);
  useEffect(() => { if (held !== null && !toasts.some((t) => t.id === held)) setHeld(null); }, [toasts, held]);

  return (
    <div className={away ? 'toasts is-away' : 'toasts'} role="region" aria-label={REGION}>
      {toasts.map((t) => (
        // the text is the group's name for whoever reaches its buttons; it is read out once, by the regions below
        <div key={t.id} role="group" aria-label={t.text}
          className={`toast toast--${t.level}${t.action ? ' toast--action' : ''}${held === t.id ? ' is-held' : ''}`}
          // a real move only: the browser also reports a "move" of 0 px when a toast comes up under a still pointer
          onPointerMove={(e) => { if ((e.movementX || e.movementY) && held !== t.id) setHeld(t.id); }}
          onPointerLeave={() => setHeld((id) => (id === t.id ? null : id))}>
          <span className="toast-icon" aria-hidden="true">{t.level === 'ok' ? '✓' : '!'}</span>
          <div className="toast-body">
            <p className="toast-text" aria-hidden="true">{t.text}</p>
            {/* where the result is. Beside the text when there is room, so a short "루나 영상 샷 완료" stays one line high */}
            {!t.action && t.open && onOpen && (
              <button type="button" className="link-btn toast-open" onClick={() => { onOpen(t.open!); onDismiss(t.id); }}>
                {OPEN_LABEL[t.open] ?? OPEN}
              </button>
            )}
          </div>
          <button type="button" className="icon-btn toast-close" aria-label={CLOSE} title={CLOSE} onClick={() => onDismiss(t.id)}>×</button>
          {t.action && (
            <button
              type="button"
              className="btn btn-primary btn-sm toast-action"
              onClick={() => {
                onAction(t.action!.id);
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          {!stays(t) && <span className="toast-life" aria-hidden="true" style={{ animationDuration: `${lifeMs(t.passed ? { text: t.text, level: 'ok' } : t)}ms` }}
            onAnimationEnd={() => onDismiss(t.id)} />}
        </div>
      ))}
      {/* Read out by two regions that are on the page before anything is said (a live region that arrives together
          with its text is often not announced): what went wrong at once, the rest when the reader is idle. */}
      <div className="sr-only" role="status" aria-live="polite">
        {toasts.filter((t) => t.level === 'ok').map((t) => <p key={t.id}>{t.text}</p>)}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {toasts.filter((t) => t.level !== 'ok').map((t) => <p key={t.id}>{t.text}</p>)}
      </div>
    </div>
  );
}
