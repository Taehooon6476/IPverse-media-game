import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  /** Shown while `run` is in flight. */
  busyLabel?: string;
  /** Shown for 2 s after `run` resolves. */
  doneLabel?: string;
  run: () => Promise<unknown>;
  disabled?: boolean;
  /** Replaces the label while disabled (e.g. "3D 진행 중"). */
  disabledLabel?: string;
  className?: string;
  ariaLabel?: string;
}

/** A card button that does its job in place: spinner while the request runs, a check mark when accepted, a shake
 * when it failed. While busy or focused it is aria-disabled, not natively disabled: Chrome drops the focus of an
 * element that becomes disabled to <body>. */
export function ActionButton({ label, busyLabel, doneLabel = t('등록됨'), run, disabled, disabledLabel, className = 'btn btn-sm', ariaLabel }: Props) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const self = useRef<HTMLButtonElement>(null);
  const [, redraw] = useState(0);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const off = disabled || state === 'busy';
  // Asked of the document, not kept from focus events: those do not fire in a window that is not in front.
  const soft = state === 'busy' || (!!disabled && self.current !== null && document.activeElement === self.current);

  async function click() {
    if (off) return;
    setState('busy');
    try {
      await run();
      setState('done');
    } catch {
      setState('error');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }

  const text =
    state === 'busy' ? busyLabel ?? label : state === 'done' ? doneLabel : disabled && disabledLabel ? disabledLabel : label;
  return (
    <button
      ref={self}
      type="button"
      className={`${className} action-btn is-${state}`}
      aria-label={ariaLabel}
      aria-busy={state === 'busy'}
      aria-disabled={soft || undefined}
      disabled={off && !soft}
      onBlur={() => redraw((n) => n + 1)} // the focus has gone elsewhere: an off button is disabled again
      onClick={click}
    >
      {state === 'busy' && <span className="action-spin" aria-hidden="true" />}
      {state === 'done' && <span className="action-check" aria-hidden="true">✓</span>}
      {text}
      <span className="sr-only" role="status">{state === 'done' ? `${label}: ${doneLabel}` : state === 'error' ? t('{label} 실패', { label }) : ''}</span>
    </button>
  );
}
