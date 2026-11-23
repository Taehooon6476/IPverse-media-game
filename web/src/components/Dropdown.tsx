import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props<T extends string> {
  label: string;
  value: T;
  /** badge: a short tag after the label (e.g. 신규 on a model an Agent proposal added). */
  options: { value: T; label: string; badge?: string }[];
  onChange: (value: T) => void;
  /** Keep the label for screen readers only (compact toolbars). */
  hideLabel?: boolean;
}

const OPTION_H = 36;
const MAX_ROWS = 8; // the list scrolls past this (styles.css .listbox max-height)
const EDGE = 8; // how near the window's edge (px) the list may come

/** Button + listbox; a native <select> takes over under 640px (CSS swaps them). */
export function Dropdown<T extends string>({ label, value, options, onChange, hideLabel }: Props<T>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [above, setAbove] = useState(false);
  // The button's edge the list is turned to when it would run past the window's ('end': it opens leftwards).
  const [side, setSide] = useState<'start' | 'end' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const selected = Math.max(0, options.findIndex((o) => o.value === value));

  useLayoutEffect(() => { // measured where the stylesheet put it, before it is painted
    const box = open ? list.current?.getBoundingClientRect() : undefined;
    if (!box?.width) return;
    if (box.right > window.innerWidth - EDGE) setSide('end');
    else if (box.left < EDGE) setSide('start');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // without scrolling to itself: a list that reached past the window would scroll the whole studio sideways
    list.current?.focus({ preventScroll: true });
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  function show(index = selected) {
    if (!options.length || !button.current) return;
    const rect = button.current!.getBoundingClientRect();
    const need = Math.min(options.length, MAX_ROWS) * OPTION_H + 24;
    setAbove(window.innerHeight - rect.bottom < need && rect.top > need);
    setSide(null);
    setActive(index);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function choose(i: number) {
    if (!options[i]) return;
    close();
    if (options[i].value !== value) onChange(options[i].value);
  }

  /** Next option (after `from`) whose label starts with the typed character. */
  function match(ch: string, from: number): number {
    const k = ch.toLowerCase();
    for (let step = 1; step <= options.length; step++) {
      const i = (from + step) % options.length;
      if (options[i].label.toLowerCase().startsWith(k)) return i;
    }
    return from;
  }

  function onButtonKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // Cmd+F, Cmd+R… are not first-letter jumps
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show();
    } else if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      show(match(e.key, selected));
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown': setActive((a) => Math.min(last, a + 1)); break;
      case 'ArrowUp': setActive((a) => Math.max(0, a - 1)); break;
      case 'Home': setActive(0); break;
      case 'End': setActive(last); break;
      case 'Enter':
      case ' ': choose(active); break;
      case 'Escape': e.stopPropagation(); close(); break;
      case 'Tab': close(); return;
      default:
        if (e.key.length !== 1) return;
        setActive(match(e.key, active));
    }
    e.preventDefault();
  }

  return (
    <div className="dropdown" ref={root}>
      <span id={`${id}-label`} className={hideLabel ? 'sr-only' : 'dropdown-label'}>{label}</span>
      <div className="dropdown-custom">
        <button
          ref={button}
          id={`${id}-button`}
          type="button"
          className="dropdown-button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined}
          aria-labelledby={`${id}-label ${id}-button`}
          onClick={() => (open ? close() : show())}
          onKeyDown={onButtonKeyDown}
        >
          <span>{options[selected]?.label}{options[selected]?.badge && <span className="option-badge">{options[selected].badge}</span>}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open && (
          <ul
            ref={list}
            id={`${id}-list`}
            role="listbox"
            tabIndex={-1}
            aria-labelledby={`${id}-label`}
            aria-activedescendant={`${id}-opt-${active}`}
            className={['listbox', above && 'is-above', side && `is-${side}`].filter(Boolean).join(' ')}
            onKeyDown={onListKeyDown}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === selected}
                className={i === active ? 'is-active' : undefined}
                onClick={() => choose(i)}
                onPointerMove={() => setActive(i)}
              >
                <span>{o.label}{o.badge && <span className="option-badge">{o.badge}</span>}</span>
                {i === selected && (
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="m3 7.5 2.5 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <select className="dropdown-native" aria-labelledby={`${id}-label`} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.badge ? `${o.label} · ${o.badge}` : o.label}</option>)}
      </select>
    </div>
  );
}
