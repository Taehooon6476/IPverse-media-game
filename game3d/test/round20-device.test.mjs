import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KEYLESS_NOTE, keylessDevice } from '../arpg-data.js';

// On a phone the games cannot be played (nothing moves the hero or the car without a keyboard): the page says what
// the game needs. No touch controls.
const runtime = readFileSync(new URL('../runtime3d.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');
function sliceOf(from, to) {
  const start = runtime.indexOf(from), end = runtime.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return runtime.slice(start, end);
}
/** matchMedia of a device with these media features. */
const device = (features) => (query) => ({ matches: features.includes(query) });

// Told by the primary input: a finger (pointer: coarse) that cannot hover (hover: none). Not "no fine pointer
// anywhere": a phone or a tablet with a pen digitizer has one (any-pointer fine, the primary pointer coarse).
test('a device without a keyboard to play on, told by its primary input: the media-query table', () => {
  const TOUCH = ['(pointer: coarse)', '(hover: none)', '(any-pointer: coarse)'], PEN = ['(any-pointer: fine)', '(any-hover: hover)'];
  const MOUSE = ['(pointer: fine)', '(hover: hover)', '(any-pointer: fine)', '(any-hover: hover)'];
  for (const [name, features, keyless] of [
    ['a phone', [...TOUCH, '(any-hover: none)'], true],
    ['a phone or a tablet with a pen (Galaxy S Ultra, Note, Fold, Tab S)', [...TOUCH, ...PEN], true],
    ['a tablet with a mouse on it (its primary input is still the finger; a key pressed takes the notice back)', [...TOUCH, ...PEN], true],
    ['a PC', MOUSE, false],
    ['a laptop with a touch screen', [...MOUSE, '(any-pointer: coarse)'], false],
    ['a set with no pointer at all', ['(pointer: none)', '(hover: none)', '(any-pointer: none)', '(any-hover: none)'], false],
  ]) assert.equal(keylessDevice(device(features)), keyless, name);
  assert.equal(KEYLESS_NOTE, '이 게임은 키보드와 마우스로 플레이해요. PC에서 열어 주세요.');
  assert.match(runtime, /let keyless = keylessDevice\(matchMedia\);/);
});

/** runtime3d.js's own tellDevice on stand-ins: what the page says for a device with (or without) a keyboard. */
function page(keyless, { briefing = true } = {}) {
  const body = sliceOf('  const tellDevice = () => {', '\n  };\n');
  const node = () => ({ hidden: false, textContent: '' });
  const nodes = { hint: node() }, note = briefing ? node() : null, classes = new Set(), started = [];
  new Function('keyless', 'document', '$', 'KEYLESS_NOTE', 'controlsLine', 'controls', 'briefingNote', 'setStartReady', 'startReady',
    `${body}\n  };\ntellDevice();`)(keyless, { body: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } } },
    (id) => nodes[id], KEYLESS_NOTE, () => '이동 W A S D', [], note, (ready) => started.push(ready), true);
  return { hint: nodes.hint.textContent, note: note && !note.hidden ? KEYLESS_NOTE : null, classes: [...classes], started };
}

test('on such a device the briefing says so over its start button, and the keys line says it in place of the keys', () => {
  const phone = page(true);
  assert.equal(phone.note, '이 게임은 키보드와 마우스로 플레이해요. PC에서 열어 주세요.');
  assert.equal(phone.hint, '이 게임은 키보드와 마우스로 플레이해요. PC에서 열어 주세요.', 'a 10-px line of keys nobody can press');
  assert.deepEqual(phone.classes, ['keyless']);
  assert.deepEqual(phone.started, [true], 'the start button is labelled again');
  // a version-1 game has no briefing: the line under the game says it
  assert.equal(page(true, { briefing: false }).hint, KEYLESS_NOTE);
  const pc = page(false);
  assert.deepEqual([pc.note, pc.hint, pc.classes], [null, '이동 W A S D', []]);
  // the start button says what pressing it means there, and the briefing builds the note over it
  assert.match(runtime, /ready \? \(keyless \? '그래도 시작하기' : '임무 시작'\)/);
  assert.match(runtime, /briefingNote = el\('p', KEYLESS_NOTE, 'briefing-device'\);/);
  assert.match(runtime, /card\.append\(stages, briefingNote, start,/);
  // a key pressed after all (a keyboard on a tablet): the page takes its word back
  assert.match(runtime, /if \(keyless && e\.isTrusted\) \{ keyless = false; tellDevice\(\); \}/);
  // the end card does not tell such a device to press Enter
  assert.match(runtime, /const words = \{ won, [^}]*keys: !keyless \};/);
});

test('what cannot be pressed there is not shown: the keys list, the Enter hint, the story box\'s keys', () => {
  assert.match(css, /body\.keyless :is\(\.briefing-enter, \.briefing-keys, \.briefing-controls\) \{ display: none; \}/);
  assert.match(css, /body\.keyless #say::after \{ content: "눌러서 넘기기 ▶"; \}/);
});

test('at phone width the ARPG\'s panel is a compact box in its corner, not a column over the hero', () => {
  const rules = [...css.matchAll(/@media \(max-width: 600px\) \{ #arpg \{([^}]*)\}([^@]*)\}/g)].map((m) => m[0]).join('\n');
  assert.ok(rules, 'ui.css: the panel\'s rule under 600 px');
  assert.doesNotMatch(rules, /bottom: 70px/, 'top 56 px and bottom 70 px stretched it from y 56 to y 774');
  assert.match(rules, /#arpg \.arpg-gear, #arpg \.arpg-keys \{ display: none; \}/, 'its gear list and its keys are left out there');
});
