import { t } from '../i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  /** Runs the action. A returned promise shows busyLabel → doneLabel next to the trigger (as ActionButton did);
   * a rejection clears it (the caller shows the error toast). */
  onSelect?: () => unknown;
  /** A link item (e.g. a download) instead of an action. */
  href?: string;
  download?: boolean;
  disabled?: boolean;
  /** Why the item is disabled, or a short hint (shown under the label). */
  hint?: string;
  busyLabel?: string;
  doneLabel?: string;
}

interface Props {
  /** Accessible name of the trigger and the menu, e.g. "테오 작업 더보기". */
  label: string;
  items: MenuItem[];
  /** Trigger content; default "⋯". */
  children?: ReactNode;
  /** Which trigger edge the menu lines up with. */
  align?: 'start' | 'end';
  className?: string;
}

const ROW_H = 40;
const MAX_ROWS = 8; // the menu scrolls past this (origin.css .menu-list max-height)

/** Dropdown action menu, portalled to <body> with fixed coordinates so overflow: hidden does not clip it; it flips
 * above near the viewport bottom and is a bottom sheet under 640px (CSS). Closing returns focus to the trigger. */
export function ActionMenu({ label, items, children, align = 'end', className = 'btn btn-sm menu-trigger' }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false); // a request from this menu is in flight: no second one
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const firstFocus = useRef<'first' | 'last'>('first');
  const anchor = useRef({ top: 0, left: 0 }); // where the trigger was when the menu was placed
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const enabled = items.map((it) => !it.disabled);
  /** The next enabled item from `from` in `step` direction, or -1 when none is enabled. */
  const next = (from: number, step: 1 | -1) => {
    for (let k = 1; k <= items.length; k++) {
      const i = (from + step * k + items.length * k) % items.length;
      if (enabled[i]) return i;
    }
    return -1;
  };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    anchor.current = { top: r.top, left: r.left };
    const need = Math.min(items.length, MAX_ROWS) * ROW_H + 16;
    const above = window.innerHeight - r.bottom < need && r.top > need;
    setPlace({
      position: 'fixed', minWidth: Math.max(180, r.width),
      ...(above ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      ...(align === 'end' ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) }),
    });
    const start = firstFocus.current === 'last' ? next(0, -1) : next(-1, 1);
    // nothing enabled yet (a card still drawing its picture): the menu itself takes focus, so its keys still work
    requestAnimationFrame(() => (refs.current[start] ?? menu.current)?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- placed once per opening
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    // Esc inside the menu is onMenuKey's; this one is for focus anywhere else.
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const at = document.activeElement;
      close(!at || at === document.body || !!root.current?.contains(at));
    };
    // Fixed coordinates would drift once the trigger moves: a resize, or a scroll that moves it, closes the menu.
    const away = () => setOpen(false);
    const scrolled = (e: Event) => {
      if (!(e.target instanceof Node) || !button.current || !e.target.contains(button.current)) return;
      const r = button.current.getBoundingClientRect();
      if (Math.abs(r.top - anchor.current.top) >= 1 || Math.abs(r.left - anchor.current.left) >= 1) away();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [open]);

  function show(focus: 'first' | 'last' = 'first') {
    if (!items.length || busy) return;
    firstFocus.current = focus;
    setOpen(true);
  }
  function close(refocus = true) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }

  async function run(item: MenuItem) {
    if (item.disabled) return;
    close();
    const result = item.onSelect?.();
    if (!result || typeof (result as Promise<unknown>).then !== 'function') return;
    window.clearTimeout(timer.current);
    setStatus(item.busyLabel ?? t('요청 중…'));
    setBusy(true);
    try {
      await result;
      setStatus(item.doneLabel ?? t('등록됨'));
      timer.current = window.setTimeout(() => setStatus(''), 2000);
    } catch {
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const at = refs.current.findIndex((el) => el === document.activeElement);
    switch (e.key) {
      case 'ArrowDown': refs.current[next(at, 1)]?.focus(); break;
      case 'ArrowUp': refs.current[next(at < 0 ? 0 : at, -1)]?.focus(); break;
      case 'Home': refs.current[next(-1, 1)]?.focus(); break;
      case 'End': refs.current[next(0, -1)]?.focus(); break;
      case 'Escape': e.stopPropagation(); close(); break;
      case 'Tab': close(); return; // the trigger has focus again: the browser's Tab goes on from it
      case ' ':
        if (at >= 0 && items[at].href) refs.current[at]?.click(); // a link runs on Enter natively, not on Space
        else return; // a button runs on Space natively
        break;
      default: {
        if (e.key.length !== 1) return;
        const k = e.key.toLowerCase();
        for (let step = 1; step <= items.length; step++) {
          const i = ((at < 0 ? -1 : at) + step) % items.length;
          if (enabled[i] && items[i].label.toLowerCase().startsWith(k)) { refs.current[i]?.focus(); break; }
        }
      }
    }
    e.preventDefault();
  }

  return (
    <div className="menu" ref={root}>
      <button ref={button} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-disabled={busy || undefined}
        aria-controls={open ? `${id}-menu` : undefined} aria-label={label} title={label}
        onClick={() => (open ? close() : show())} onKeyDown={onTriggerKey}>
        {children ?? <span aria-hidden="true" className="menu-dots">⋯</span>}
      </button>
      <span className="menu-status" role="status">{status}</span>
      {open && createPortal(
        <div ref={menu} id={`${id}-menu`} role="menu" aria-label={label} className="menu-list" style={place} tabIndex={-1} onKeyDown={onMenuKey}>
          {items.map((it, i) => {
            const body = <><span>{it.label}</span>{it.hint && <small>{it.hint}</small>}</>;
            return it.href && !it.disabled ? (
              <a key={i} ref={(el) => { refs.current[i] = el; }} role="menuitem" tabIndex={-1} className="menu-item" href={it.href}
                {...(it.download ? { download: '' } : { target: '_blank', rel: 'noreferrer' })} onClick={() => close()}>{body}</a>
            ) : (
              <button key={i} ref={(el) => { refs.current[i] = el; }} type="button" role="menuitem" tabIndex={-1} className="menu-item"
                aria-disabled={it.disabled || undefined} onClick={() => void run(it)}>{body}</button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
