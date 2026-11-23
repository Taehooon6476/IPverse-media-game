// runtime3d.js's end card without a browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as rules from '../../arpg-data.js';

const RUNTIME = readFileSync(new URL('../../runtime3d.js', import.meta.url), 'utf8');
function sliceOf(from, to) {
  const start = RUNTIME.indexOf(from), end = RUNTIME.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return RUNTIME.slice(start, end);
}

/** runtime3d.js's own end card on a stand-in page with a clock: its key listener (onKey), its button and hud.end, as
 * boot() has them. The page presses a focused button with Enter and Space itself, as a browser does, unless a
 * listener took the key (preventDefault); a hidden button (a playable ad's) takes no focus and no press.
 * `playableSec`: the page's ?playable=. → { end(won), key(code, {repeat}), click(), wait(ms), restarts, shown } */
export function endCardPage({ autoplay = false, playableSec = 0 } = {}) {
  const keys = sliceOf('  const onKey = (e) => {', '  hud.end = (won) => {'), body = sliceOf('  hud.end = (won) => {', '\n  };\n');
  const page = { now: 1000, restarts: 0, listeners: [], timers: [], focused: null };
  const node = (more = {}) => ({ hidden: false, textContent: '', dataset: {}, focus() { if (!this.hidden) page.focused = this; }, ...more });
  const nodes = { 'end-title': node(), restart: node(), crosshair: node(), notice: node() }, end = node({ hidden: true });
  const restart = () => { if (end.hidden) return; end.hidden = true; page.restarts += 1; page.listeners = page.listeners.filter((fn) => fn !== page.onKey); };
  const hud = new Function('mode', 'playableSec', 'autoplay', 'endCard', 'endKey', '$', 'endReason', 'endResult', 'endNext', 'end', 'document', 'window',
    'dispatchEvent', 'CustomEvent', 'performance', 'setTimeout', 'addEventListener', 'restart', 'console', 'page',
    `let ended = false, rounds = 0, stalled = false, adEvery = 0, holdUntil = 0, keyless = false, endAt = 0; const hud = {};
${keys}${body}\n  };\npage.onKey = onKey; return hud;`)(
    { timeLimit: 0, elapsed: 30, endSummary: () => ({ reason: '30초를 버텨냈다.', result: ['점수 1500', '0:30'], resumeStage: 0 }) }, playableSec, autoplay, rules.endCard,
    rules.endKey, (id) => nodes[id], node(), node(), node(), end, { pointerLockElement: null }, {}, () => {}, class { constructor(type) { this.type = type; } },
    { now: () => page.now }, (fn, ms) => page.timers.push({ at: page.now + ms, fn }), (type, fn) => { if (type === 'keydown' && !page.listeners.includes(fn)) page.listeners.push(fn); },
    restart, { warn() {} }, page);
  return Object.assign(page, {
    end: (won) => hud.end(won),
    shown: () => !end.hidden,
    /** `ms` pass: the timers due in them run in order. */
    wait(ms) {
      const until = page.now + ms;
      for (;;) {
        const due = page.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        page.timers.splice(page.timers.indexOf(due), 1);
        page.now = due.at; due.fn();
      }
      page.now = until;
    },
    key(code, { repeat = false, trusted = false } = {}) { // (trusted: pressed on a keyboard, not sent by a script)
      const e = { code, repeat, isTrusted: trusted, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const fn of [...page.listeners]) fn(e);
      if (!e.defaultPrevented && page.focused === nodes.restart && !end.hidden && !nodes.restart.hidden && ['Enter', 'Space'].includes(code)) nodes.restart.onclick?.({ detail: 0 });
      return e;
    },
    click: () => nodes.restart.onclick?.({ detail: 1 }),
  });
}
