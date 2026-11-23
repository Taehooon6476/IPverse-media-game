import { t } from '../i18n';
import { useEffect, useRef, useState, type RefObject } from 'react';

// iframe and summary: the game in 크게 보기 and a folded section are stops of the trap too
const FOCUSABLE = 'a[href], button, input, select, textarea, video[controls], iframe, summary, [tabindex]';
/** The fields a person types sentences into: what Esc or a click beside the panel must not throw away. */
const TYPED = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"]';
/** How long a first Esc (or a click beside the panel) is remembered: the next Esc within it closes. */
const KEEP_MS = 6000;
const dialogs: HTMLElement[] = [];
/** The toast stack. It is drawn on top of every dialog (styles.css), so its buttons are stops of the open dialog's
 * Tab round, after the dialog's own. */
const toastStack = () => document.querySelector<HTMLElement>('.toasts');

function available(element: HTMLElement) {
  if (!element.isConnected || element.matches(':disabled, input[type="hidden"]')
      || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

/** What a dialog says when it stays open over typed text: the ways to close it after all, as this dialog and this
 * device have them. Its own button (취소, else 닫기, else the × at its head) and, with a keyboard, a second Esc. */
function keepText(el: HTMLElement): string {
  const buttons = [...el.querySelectorAll<HTMLElement>('button')].filter(available);
  const says = (word: string) => buttons.some((b) => b.textContent?.trim() === word);
  const cancel = t('취소');
  const close = t('닫기');
  const button = says(cancel) ? cancel : says(close) ? close : buttons.some((b) => b.getAttribute('aria-label') === close) ? t('닫기(×)') : '';
  const keyboard = !window.matchMedia?.('(hover: none) and (pointer: coarse)').matches; // not a phone or a tablet
  const how = keyboard && button ? t('Esc를 한 번 더 누르거나 {button}를 눌러 주세요.', { button })
    : button ? t('{button}를 눌러 주세요.', { button }) : t('Esc를 한 번 더 눌러 주세요.');
  return t('입력한 내용이 있어요. 닫으려면 {how}', { how });
}

/** Focus trap + Esc for a modal panel; on unmount focus returns to whatever opened it. `initial` picks the element
 * focused on open (default: the first focusable). Typed text is not lost to a slip: while a text field of the panel
 * holds something new, the first Esc and a click beside the panel leave the dialog open and say so in a line at its
 * foot (keepText); a second Esc within 6 s closes. 취소, 닫기 and × close at once. */
export function useDialog(panel: RefObject<HTMLElement | null>, onClose: () => void, initial?: string) {
  // Captured during the first render, before the dialog moves focus (StrictMode re-runs effects).
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const previousTabIndex = el.getAttribute('tabindex');
    if (previousTabIndex === null) el.tabIndex = -1;
    dialogs.push(el);
    const isTop = () => dialogs.at(-1) === el;
    const stops = (within: HTMLElement | null) => Array.from(within?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((element) => element.tabIndex >= 0 && available(element));
    const focusables = () => stops(el);
    const requested = initial ? el.querySelector<HTMLElement>(initial) : null;
    let lastFocused = requested && available(requested) ? requested : focusables()[0] ?? el;

    // what each text field held when it came into the dialog (at the opening, or when a later step of the dialog
    // brought it with a value of its own)
    const held = new Map<Element, string>();
    const note = (field: Element) => { if (field.matches(TYPED) && !held.has(field)) held.set(field, (field as HTMLInputElement).value); };
    el.querySelectorAll(TYPED).forEach(note);
    const arrivals = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => {
      if (!(n instanceof Element)) return;
      note(n);
      n.querySelectorAll(TYPED).forEach(note);
    })));
    arrivals.observe(el, { childList: true, subtree: true });
    const typed = () => [...el.querySelectorAll<HTMLInputElement>(TYPED)]
      .some((f) => !f.readOnly && f.value.trim() !== '' && f.value.trim() !== (held.get(f) ?? '').trim());
    let warned = 0; // when the dialog last said it stays open
    let notice: HTMLElement | null = null;
    let noticeTimer = 0;
    /** The dialog stays open and says why, in a line at its foot. */
    const stay = () => {
      warned = Date.now();
      notice ??= Object.assign(document.createElement('p'), { className: 'dialog-keep' });
      notice.textContent = keepText(el); // each time: a later step of the dialog may have other buttons
      notice.setAttribute('role', 'status');
      el.append(notice);
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => notice?.remove(), KEEP_MS);
    };

    lastFocused.focus();
    function onFocus(e: FocusEvent) {
      if (!isTop()) return;
      const target = e.target;
      if (target instanceof HTMLElement && el!.contains(target)) {
        lastFocused = target;
        note(target);
      } else if (target instanceof Node && toastStack()?.contains(target)) {
        // a toast's button: a stop of this dialog's round
      } else {
        (available(lastFocused) ? lastFocused : focusables()[0] ?? el!).focus();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        // An open custom listbox owns its first Escape; its handler restores the picker button.
        if (e.target instanceof Element && e.target.closest('[role="listbox"]')) return;
        e.preventDefault();
        e.stopPropagation(); // capture phase: the mobile nav drawer underneath must not close too
        if (typed() && Date.now() - warned >= KEEP_MS) stay(); // the next Esc within 6 s closes
        else closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const own = focusables();
      const toasts = stops(toastStack());
      const f = [...own, ...toasts];
      const first = f[0];
      const last = f[f.length - 1];
      const at = document.activeElement;
      const outside = !el!.contains(at) && !toastStack()?.contains(at);
      if (!first) {
        e.preventDefault();
        el!.focus();
      } else if (e.shiftKey && (outside || at === first || at === el)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (outside || at === last || at === el)) {
        e.preventDefault();
        first?.focus();
      } else if (toasts.length && own.length && (e.shiftKey ? at === toasts[0] : at === own[own.length - 1])) {
        // between the dialog and the toast stack, which are not neighbours in the page
        e.preventDefault();
        (e.shiftKey ? own[own.length - 1] : toasts[0]).focus();
      }
    }
    // A click on the backdrop beside the panel closes the dialog (each dialog wires that itself): with typed text it
    // is stopped here, on its way down, before the dialog's own handler hears it.
    const root = el.parentElement;
    function onBackdrop(e: MouseEvent) {
      if (!isTop() || !(e.target instanceof Element) || el!.contains(e.target) || !/backdrop/.test(String(e.target.className))) return;
      if (!typed()) return;
      e.stopPropagation();
      stay();
    }
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    root?.addEventListener('click', onBackdrop, true);
    return () => {
      const wasTop = isTop();
      dialogs.splice(dialogs.lastIndexOf(el), 1);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus, true);
      root?.removeEventListener('click', onBackdrop, true);
      arrivals.disconnect();
      window.clearTimeout(noticeTimer);
      notice?.remove();
      if (previousTabIndex === null) el.removeAttribute('tabindex');
      if (!wasTop) return;
      if (opener && available(opener) && (!dialogs.length || dialogs.at(-1)!.contains(opener))) opener.focus();
      else if (dialogs.length) dialogs.at(-1)!.focus();
      // the opener is gone (a card that was re-drawn, a row that was deleted): the page's main part takes the focus
      else document.getElementById('main')?.focus();
    };
  }, [opener, panel, initial]);
}
