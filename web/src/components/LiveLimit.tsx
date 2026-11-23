import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

/** What the status poll's job carries for this (server/live.py status: the owner's player broadcast only). */
type LimitJob = { secondsLeft?: number; maxMinutes?: number };

const WARN_AT = [300, 60]; // seconds before the cap: one notice each
const WARN_TEXT = (min: number, max: number) =>
  t('방송이 {min}분 뒤 자동으로 꺼져요 (한 번에 최대 {max}분). 더 하려면 꺼진 뒤 다시 켜 주세요.', { min, max });

/** Time left before the server ends the broadcast (live.MAX_MINUTES): counts down from the server's secondsLeft
 * (each status poll re-anchors it, so the browser clock's skew does not matter); onWarn fires once per WARN_AT. */
export function LiveLimit({ job, prefix = '', className = '', onWarn }: {
  job: object | null | undefined; prefix?: string; className?: string; onWarn?: (text: string) => void;
}) {
  const { secondsLeft, maxMinutes = 45 } = (job ?? {}) as LimitJob;
  const endAt = useRef<number | null>(null);
  const warned = useRef(new Set<number>());
  const [left, setLeft] = useState<number | null>(null);
  const warn = useRef(onWarn);
  warn.current = onWarn;

  const tick = () => {
    if (endAt.current == null) return;
    const n = Math.max(0, Math.round((endAt.current - Date.now()) / 1000));
    setLeft(n);
    const due = WARN_AT.filter((s) => n <= s && !warned.current.has(s));
    if (!due.length) return;
    WARN_AT.filter((s) => n <= s).forEach((s) => warned.current.add(s)); // the nearest one only
    if (n > 0) warn.current?.(WARN_TEXT(Math.round(Math.min(...due) / 60), maxMinutes));
  };
  useEffect(() => {
    if (typeof secondsLeft !== 'number') { endAt.current = null; setLeft(null); return; }
    const at = Date.now() + secondsLeft * 1000;
    if (endAt.current == null || Math.abs(at - endAt.current) > 1500) endAt.current = at; // poll jitter is not a jump
    tick();
  }, [secondsLeft]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (left == null) return null;
  const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <span className={`live-limit${left <= WARN_AT[0] ? ' is-warn' : ''}${className ? ` ${className}` : ''}`} role="timer"
      title={t('방송은 한 번에 최대 {n}분이에요. 시간이 되면 서버가 자동으로 꺼요.', { n: maxMinutes })}>
      {prefix}{t('{time} 남음', { time: text })}
    </span>
  );
}
