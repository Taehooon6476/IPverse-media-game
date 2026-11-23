import { t } from '../i18n';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { local } from '../storage';

const SPLIT_KEY = 'ipverse.split';
/** The IP pane's share of the two panes' width: never under 30% or over 70%, so neither pane is squeezed shut. */
const MIN = 0.3;
const MAX = 0.7;
const clamp = (share: number) => Math.min(MAX, Math.max(MIN, Math.round(share * 100) / 100));

function saved(): number | null {
  try {
    const share = Number(JSON.parse(local.get(SPLIT_KEY) ?? 'null'));
    return share >= MIN && share <= MAX ? share : null;
  } catch {
    return null;
  }
}

/** `main#main`: the IP pane and the game pane side by side, half and half until the user drags the handle between
 * them (or moves it with ← →): the share is kept per browser, a double click gives half and half back. One column,
 * IP first, below 1200 px, where the handle is not shown (origin.css). */
export function SplitPanes({ left, right }: { left: ReactNode; right: ReactNode }) {
  const main = useRef<HTMLElement>(null);
  const [share, setShare] = useState<number | null>(saved); // null: half and half
  useEffect(() => {
    if (share === null) local.remove(SPLIT_KEY);
    else local.set(SPLIT_KEY, JSON.stringify(share)); // blocked storage: the share lasts for this page
  }, [share]);

  function drag(e: ReactPointerEvent<HTMLDivElement>) {
    const el = main.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId); // the game's frame under the pointer must not take the moves
    document.documentElement.classList.add('is-resizing-split');
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const from = box.left + parseFloat(style.paddingLeft);
    const width = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const move = (ev: PointerEvent) => { if (width > 0) setShare(clamp((ev.clientX - from) / width)); };
    const up = () => {
      document.documentElement.classList.remove('is-resizing-split');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 0.1 : 0.02;
    const now = share ?? 0.5;
    const next = e.key === 'ArrowLeft' ? now - step : e.key === 'ArrowRight' ? now + step : e.key === 'Home' ? MIN : e.key === 'End' ? MAX : null;
    if (next === null) return;
    e.preventDefault();
    setShare(clamp(next));
  }

  // fr units: the two panes share what the handle's own column leaves. In hundredths (42fr and 58fr, not 0.42fr and
  // 0.58fr): when one pane is held at its least width, a lone factor under 1 would leave the other short of the rest
  const percent = Math.round((share ?? 0.5) * 100);
  const columns = share === null ? undefined : { '--split-a': `${percent}fr`, '--split-b': `${100 - percent}fr` } as CSSProperties;
  return (
    <main ref={main} id="main" tabIndex={-1} className="split" style={columns}>
      {left}
      <div className="split-handle" role="separator" aria-orientation="vertical" aria-label={t('IP 창과 게임 창의 너비')} title={t('드래그해서 두 창의 너비 조절')}
        aria-valuemin={MIN * 100} aria-valuemax={MAX * 100} aria-valuenow={percent} tabIndex={0}
        onPointerDown={drag} onKeyDown={onKey} onDoubleClick={() => setShare(null)} />
      {right}
    </main>
  );
}
