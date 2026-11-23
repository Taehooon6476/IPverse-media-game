import { useEffect, useState, type ReactNode } from 'react';
import { local } from '../storage';

interface Props {
  /** Prefix for the header and region ids (`<id>-head`, `<id>-region`). */
  id: string;
  title: ReactNode;
  /** Short summary on the right of the header (a count, the current values), visible while folded. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  /** Remembers open/closed per browser under this localStorage key. */
  storageKey?: string;
  className?: string;
  headClassName?: string;
  children: ReactNode;
}

const OPEN_MS = 200; // origin.css .fold-region transition

function initial(storageKey: string | undefined, fallback: boolean) {
  const saved = storageKey ? local.get(storageKey) : null;
  return saved === '1' ? true : saved === '0' ? false : fallback;
}

/** Accordion section; several may be open at once. A folded region is inert (not reachable by Tab); once open it
 * stops clipping, so a dropdown inside can overflow it. */
export function Fold({ id, title, meta, defaultOpen = false, storageKey, className, headClassName, children }: Props) {
  const [open, setOpen] = useState(() => initial(storageKey, defaultOpen));
  const [settled, setSettled] = useState(open);
  useEffect(() => { if (storageKey) local.set(storageKey, open ? '1' : '0'); }, [open, storageKey]);
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const t = window.setTimeout(() => setSettled(true), OPEN_MS + 20);
    return () => window.clearTimeout(t);
  }, [open]);
  return (
    <div className={['fold', open && 'is-open', className].filter(Boolean).join(' ')}>
      <button type="button" id={`${id}-head`} className={['fold-head', headClassName].filter(Boolean).join(' ')}
        aria-expanded={open} aria-controls={`${id}-region`} onClick={() => setOpen((o) => !o)}>
        <span className="fold-title">{title}</span>
        {meta != null && meta !== '' && <span className="fold-meta">{meta}</span>}
        <svg className="fold-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div id={`${id}-region`} role="region" aria-labelledby={`${id}-head`}
        className={settled ? 'fold-region is-settled' : 'fold-region'} data-open={open ? '' : undefined} inert={!open}>
        <div className="fold-inner">{children}</div>
      </div>
    </div>
  );
}
