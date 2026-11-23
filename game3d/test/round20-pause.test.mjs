import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { controlsFor, pauseRules, restartLine } from '../arpg-data.js';

// The pause: Esc and P stop a person's round and its clocks, in an arena Esc lets the captured mouse go, and a
// window that loses the focus pauses too.
// The page needs a browser: runtime3d.js's own makePause and its animation loop are run here on stand-ins.
const runtime = readFileSync(new URL('../runtime3d.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');
function sliceOf(from, to) {
  const start = runtime.indexOf(from), end = runtime.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return runtime.slice(start, end);
}

test('what a pause may do: all of it for a person\'s game, nothing under the built-in player, on air or in a playable ad', () => {
  assert.deepEqual(pauseRules({}), { manual: true, auto: true }); // a game's link, the studio's preview
  assert.deepEqual(pauseRules({ autoplay: true }), { manual: false, auto: false }); // a broadcast must go on
  assert.deepEqual(pauseRules({ autoplay: true, noAds: true, noPause: true }), { manual: false, auto: false });
  assert.deepEqual(pauseRules({ playable: true, noAds: true }), { manual: false, auto: false }); // the trial's clock is the ad page's
  // a person at the keys of a broadcast's play window: the window marks its game ?nopause=1
  assert.deepEqual(pauseRules({ noAds: true, noPause: true }), { manual: false, auto: false });
  // not by ?noads=1: cloud play loads that too, and keeps its own pause
  assert.deepEqual(pauseRules({ noAds: true }), { manual: true, auto: false });
  // boot() asks it with the page's own flags
  assert.match(runtime, /const noPause = query\.get\('nopause'\) === '1';/);
  assert.match(runtime, /const rules = pauseRules\(\{ autoplay, playable: !!playableSec, noAds, noPause \}\);/);
});

/** runtime3d.js's makePause on a stand-in page: its window and document as event targets, the card's elements.
 * `key(code)` → whether the key press was kept from going on (stopPropagation); `heard`: how each of the window's
 * listeners was set ([type, capture]). */
function page(rules, { playing = true } = {}) {
  const src = sliceOf('function makePause(', '\n}\n');
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { pointerLockElement: null, hidden: false, focused: true,
    hasFocus: () => doc.focused, exitPointerLock() { doc.pointerLockElement = null; doc.dispatchEvent(new Event('pointerlockchange')); } });
  const node = () => ({ hidden: true, textContent: '', focused: 0, focus() { this.focused += 1; } });
  const card = { root: node(), note: node(), next: node(), resume: node(), restart: node() };
  const input = { keys: new Set(['KeyW']), pressed: new Set(), fireHeld: true };
  const state = { playing, restarts: 0, now: 1000, next: '' }, heard = [];
  const makePause = new Function('addEventListener', 'document', 'performance', `${src}\n}\nreturn makePause;`)(
    (type, fn, capture = false) => { heard.push([type, capture]); win.addEventListener(type, fn); }, doc, { now: () => state.now });
  const canvas = node();
  const pause = makePause({ rules, input, canvas, card, playing: () => state.playing, next: () => state.next, onRestart: () => { state.restarts += 1; } });
  const key = (code, more = {}) => {
    const event = Object.assign(new Event('keydown'), { code, ...more });
    let kept = false;
    event.stopPropagation = () => { kept = true; };
    win.dispatchEvent(event);
    return kept;
  };
  return { pause, card, input, canvas, state, doc, key, heard, blur: () => win.dispatchEvent(new Event('blur')),
    hide: () => { doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); } };
}

test('Esc and P stop a person\'s round under a card and start it again; the keys held do not stay down', () => {
  const p = page(pauseRules({}));
  assert.deepEqual([p.pause.on, p.card.root.hidden], [false, true]);
  p.key('Escape');
  assert.deepEqual([p.pause.on, p.card.root.hidden], [true, false], 'Esc showed nothing and the round went on');
  assert.deepEqual([p.input.keys.size, p.input.fireHeld], [0, false], 'W was held when the card opened: its keyup goes to the card\'s button');
  assert.equal(p.card.resume.focused, 1, 'the focus is on 계속하기');
  assert.equal(p.card.note.hidden, true, 'a pause asked for needs no explanation');
  p.key('Escape');
  assert.deepEqual([p.pause.on, p.card.root.hidden, p.canvas.focused], [false, true, 1]);
  p.key('KeyP');
  assert.equal(p.pause.on, true);
  p.key('KeyP', { repeat: true }); // the key still held: not a second press
  assert.equal(p.pause.on, true);
  p.card.resume.onclick();
  assert.equal(p.pause.on, false);
  p.key('KeyW');
  assert.equal(p.pause.on, false, 'no other key pauses');
});

test('nothing is paused that is not a round being played: the briefing, the end card, a pre-roll ad', () => {
  const p = page(pauseRules({}), { playing: false });
  p.key('Escape'); p.blur(); p.hide();
  assert.deepEqual([p.pause.on, p.card.root.hidden], [false, true]);
});

// The studio's big view (web BigGameModal) is the game in a frame, and the view puts its own Esc hook on that
// frame's window as the frame loads, before boot() sets the pause's: one Esc during a round must pause the game
// and not also close the view.
test('while a round is played or paused, Esc and P are the game\'s alone: heard first, and kept from the page around the frame', () => {
  const p = page(pauseRules({}));
  assert.deepEqual(p.heard.filter(([type]) => type === 'keydown'), [['keydown', true]], 'in the capture phase: the view\'s hook on this window was set first');
  assert.equal(p.key('Escape'), true, 'the Esc that paused went on to the view\'s hook, which closed the view');
  assert.equal(p.pause.on, true);
  assert.equal(p.key('Escape', { repeat: true }), true, 'the key still held is no second press, and not the view\'s either');
  assert.equal(p.pause.on, true);
  assert.equal(p.key('Escape'), true, 'nor the Esc that goes on with the round');
  assert.equal(p.pause.on, false);
  assert.equal(p.key('KeyP'), true);
  assert.equal(p.key('KeyP'), true);
  assert.equal(p.key('KeyW'), false, 'every other key goes on to the game\'s input');
  // no round on (the briefing, the end card, a pre-roll ad): Esc is the page's, so the view can close
  const idle = page(pauseRules({}), { playing: false });
  assert.equal(idle.key('Escape'), false);
  assert.equal(idle.key('KeyP'), false);
});

// the same on a real event path (capture, target, bubble). jsdom is the web client's: web/node_modules
let JSDOM = null;
try { ({ JSDOM } = createRequire(new URL('../../web/package.json', import.meta.url))('jsdom')); } catch { /* not installed here */ }

test('the studio\'s big view: Esc pauses the round and goes on with it, and closes the view only when no round is on', { skip: !JSDOM && 'jsdom is not installed (web/node_modules)' }, () => {
  const { window } = new JSDOM('<!doctype html><body><canvas tabindex="0"></canvas><div><p></p><p></p><button></button><button></button></div></body>');
  const { document } = window, [root, note, next, resume, restart] = [document.querySelector('div'), ...document.querySelectorAll('p, button')];
  let closed = 0;
  // BigGameModal.tsx, at the frame's load: contentWindow.addEventListener('keydown', (k) => { if (k.key === 'Escape') onClose(); })
  window.addEventListener('keydown', (k) => { if (k.key === 'Escape') closed += 1; });
  const state = { playing: true };
  const makePause = new Function('addEventListener', 'document', 'performance', `${sliceOf('function makePause(', '\n}\n')}\n}\nreturn makePause;`)(
    (...args) => window.addEventListener(...args), document, window.performance);
  const pause = makePause({ rules: pauseRules({}), input: { keys: new Set(), pressed: new Set(), fireHeld: false }, canvas: document.querySelector('canvas'),
    card: { root, note, next, resume, restart }, playing: () => state.playing, next: () => '', onRestart() {} });
  /** A key press where the keyboard's focus is. */
  const press = (code, more = {}) => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { code, key: code === 'KeyP' ? 'p' : code, bubbles: true, ...more }));
  press('Escape');
  assert.deepEqual([pause.on, closed], [true, 0], 'one Esc paused the round and closed the view');
  assert.equal(document.activeElement, resume, 'the keyboard is on 계속하기');
  press('Escape', { repeat: true });
  assert.deepEqual([pause.on, closed], [true, 0], 'the key held down');
  press('Escape');
  assert.deepEqual([pause.on, closed], [false, 0], 'Esc goes on with the round, as the card says, and the view stays');
  press('KeyP'); press('KeyP');
  assert.deepEqual([pause.on, closed], [false, 0]);
  state.playing = false; // the end card is up (or the briefing)
  press('Escape');
  assert.deepEqual([pause.on, closed], [false, 1], 'with no round on, Esc closes the view');
});

test('leaving the window or the tab pauses a person\'s game, and the card says why', () => {
  const away = page(pauseRules({}));
  away.blur();
  assert.equal(away.pause.on, true, 'the round went on while the window was elsewhere');
  assert.deepEqual([away.card.note.hidden, away.card.note.textContent], [false, '다른 곳을 보는 동안 게임을 멈춰 뒀어요.']);
  away.card.resume.onclick();
  away.hide();
  assert.equal(away.pause.on, true);
  // a cloud stream (?noads=1): the stream's page loses the focus as its viewer uses the page around it
  const cloud = page(pauseRules({ noAds: true }));
  cloud.blur(); cloud.hide();
  assert.equal(cloud.pause.on, false);
  cloud.key('Escape');
  assert.equal(cloud.pause.on, true, 'their own pause still works');
});

test('under the built-in player (?autoplay=1) nothing pauses: a broadcast goes on', () => {
  const p = page(pauseRules({ autoplay: true, noAds: true }));
  p.key('Escape'); p.key('KeyP'); p.blur(); p.hide();
  assert.deepEqual([p.pause.on, p.card.root.hidden], [false, true]);
});

// A person playing on air in the play window (?noads=1, no built-in player) must not pause: the capture would send
// a standing picture and the rounds the ads wait for would not end. The play window marks its game ?nopause=1.
test('a person on air in the play window (?nopause=1) cannot pause: no key is taken, nothing stops the round the ads wait for', () => {
  const p = page(pauseRules({ noAds: true, noPause: true }));
  assert.deepEqual(p.heard, [], 'no listener: Esc and P are not the game\'s there');
  assert.equal(p.key('Escape'), false, 'Esc stopped the round on air');
  p.key('KeyP'); p.blur(); p.hide();
  p.doc.pointerLockElement = {};
  p.doc.exitPointerLock(); // Esc out of an arena's captured mouse, to reach the window's buttons
  assert.deepEqual([p.pause.on, p.card.root.hidden, p.card.resume.focused], [false, true, 0]);
  assert.deepEqual([p.input.keys.size, p.input.fireHeld], [1, true], 'the keys held stay held');
  // and neither the briefing's list nor the line under the game offers a pause there (a cloud stream's does)
  const arena = { genre: 'sf-shooter', version: 1 }, offered = (rules) => controlsFor(arena, { pause: rules.manual }).some((c) => c.label === '일시정지');
  assert.deepEqual([offered(pauseRules({ noAds: true, noPause: true })), offered(pauseRules({ noAds: true })), offered(pauseRules({}))], [false, true, true]);
});

// In a playable ad nothing pauses and no card opens: a card over a round that runs on would take the keyboard, on
// a trial billed by the second.
test('in a playable ad nothing pauses and no card takes the keyboard: Esc and P do nothing there', () => {
  const p = page(pauseRules({ playable: true, noAds: true }));
  assert.deepEqual(p.heard, [], 'no listener: the keys are the round\'s');
  assert.equal(p.key('Escape'), false);
  p.key('KeyP'); p.blur(); p.hide();
  p.doc.pointerLockElement = {};
  p.doc.exitPointerLock(); // Esc out of an arena's captured mouse
  assert.deepEqual([p.pause.on, p.card.root.hidden, p.card.resume.focused], [false, true, 0], 'the keys\' card opened over the round and took the focus');
  assert.deepEqual([p.input.keys.size, p.input.fireHeld], [1, true], 'W and the fire button held stay held');
});

test('Esc out of a captured mouse (an arena) pauses: the browser keeps that key press, the capture\'s end tells it', () => {
  const p = page(pauseRules({}));
  p.doc.pointerLockElement = {};
  p.doc.exitPointerLock(); // the browser, on Esc
  assert.equal(p.pause.on, true, 'the mouse was let go and the drones kept firing');
  p.key('Escape'); // a browser that hands the page the same Esc as well
  assert.equal(p.pause.on, true, 'that Esc is not a second press');
  p.state.now += 1000;
  p.key('Escape');
  assert.equal(p.pause.on, false);
  // P with the mouse captured: the card opens and the mouse is let go for it
  p.doc.pointerLockElement = {};
  p.key('KeyP');
  assert.deepEqual([p.pause.on, p.doc.pointerLockElement], [true, null]);
  // a capture the window's loss of focus took is the window's rule, not a pause by Esc
  const cloud = page(pauseRules({ noAds: true }));
  cloud.doc.pointerLockElement = {}; cloud.doc.focused = false;
  cloud.doc.exitPointerLock();
  assert.equal(cloud.pause.on, false);
});

test('다시 시작 on the card leaves the round and starts the next: not a finished round, no ad', async () => {
  const p = page(pauseRules({}));
  p.key('Escape');
  p.card.restart.onclick();
  assert.deepEqual([p.pause.on, p.state.restarts], [false, 1]);
  // boot()'s startOver: the next round without a mid-roll, and never over a round that is over or being built
  const body = sliceOf('  const startOver = async () => {', '\n  };\n');
  const run = (state) => {
    const log = [];
    const go = new Function('building', 'mode', 'ended', 'hud', '$', 'setStartReady', 'briefing', 'nextRound', `${body}\n  };\nreturn startOver();`);
    return go(state.building ?? null, state.mode === undefined ? {} : state.mode, !!state.ended, { notice: (text) => log.push(`notice '${text}'`) },
      () => ({ querySelectorAll: () => [] }), (ready) => log.push(`start ${ready ? 'lit' : 'busy'}`), { hidden: true },
      async (midroll) => { log.push(`next round, mid-roll ${midroll}`); }).then(() => log);
  };
  assert.deepEqual(await run({}), ['notice \'\'', 'start busy', 'next round, mid-roll false']);
  assert.deepEqual(await run({ ended: true }), []);
  assert.deepEqual(await run({ building: Promise.resolve() }), []);
});

// 다시 시작 on the pause card goes on from the last checkpoint (the stage being played), and says so as the end
// card does.
test('the pause card says what its 다시 시작 does, as the end card does', () => {
  assert.deepEqual([restartLine(0), restartLine(1), restartLine(undefined)], ['처음부터 다시 해요.', '2단계부터 이어서 해요.', '처음부터 다시 해요.']);
  // boot()'s own line for the card, from the mode being played: its word on where a round left now goes on
  const body = sliceOf('  const restartNote = () => {', '\n  };\n');
  const note = (mode) => new Function('mode', 'restartLine', `${body}\n  };\nreturn restartNote();`)(mode, restartLine);
  assert.equal(note({ endSummary: (won) => ({ reason: null, result: [], resumeStage: won ? 0 : 2 }) }), '다시 시작을 누르면 3단계부터 이어서 해요.');
  assert.equal(note({ endSummary: () => ({ reason: null, result: [], resumeStage: 0 }) }), '다시 시작을 누르면 처음부터 다시 해요.');
  assert.equal(note({}), '다시 시작을 누르면 처음부터 다시 해요.', 'a mode that tells nothing of itself');
  assert.equal(note({ endSummary: () => { throw new Error('no director'); } }), '다시 시작을 누르면 처음부터 다시 해요.', 'a summary that throws does not keep the card down');
  // the card shows it each time it opens: the mission may have moved on since
  const p = page(pauseRules({}));
  p.state.next = '다시 시작을 누르면 2단계부터 이어서 해요.';
  p.key('Escape');
  assert.equal(p.card.next.textContent, '다시 시작을 누르면 2단계부터 이어서 해요.', 'the card said nothing of what 다시 시작 does');
  p.key('Escape');
  p.state.next = '다시 시작을 누르면 3단계부터 이어서 해요.';
  p.key('KeyP');
  assert.equal(p.card.next.textContent, '다시 시작을 누르면 3단계부터 이어서 해요.');
  // it is a line of the card under its buttons, and a device without a keyboard keeps it (the Esc line and the keys go)
  assert.match(runtime, /card\.append\(title, note, actions, el\('p', 'Esc 키로도 계속해요', 'pause-esc'\), next, /);
  assert.match(css, /body\.keyless \.pause-card :is\(\.pause-esc, h3, \.keys\) \{ display: none; \}/);
});

/** runtime3d.js's animation loop on stand-ins: `frames` frames of 1/60 s. → what the round and the world were given. */
function frames(n, { paused = false, held = false, ended = false } = {}) {
  const body = sliceOf('  world.renderer.setAnimationLoop(() => {', '\n  });\n');
  const log = { update: [], idle: [], world: [], render: 0 };
  let loop = null;
  const world = { lite: false, renderer: { setAnimationLoop: (fn) => { loop = fn; } }, input: { pollPad() {}, endFrame() {} },
    update: (dt) => log.world.push(dt), render: () => { log.render += 1; } };
  new Function('world', 'clock', 'frozen', 'pause', 'mode', 'held', 'authored', 'startReady', 'ended', 'briefing', `${body}\n  });`)(
    world, { getDelta: () => 1 / 60 }, false, { on: paused }, { phase: 'playing', update: (dt) => log.update.push(dt), idle: (dt) => log.idle.push(dt) },
    held, true, true, ended, { hidden: true });
  for (let i = 0; i < n; i++) loop();
  return log;
}

test('while the pause card is up no time passes in the round, and its picture is still drawn', () => {
  const playing = frames(60);
  assert.equal(playing.update.length, 60);
  assert.ok(Math.abs(playing.update.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'a second of the round in 60 frames');
  const paused = frames(60, { paused: true });
  assert.deepEqual([paused.update.length, paused.idle.length], [0, 0], 'the round was updated under the pause card: its clock ran on');
  assert.ok(paused.world.every((dt) => dt === 0), 'the particles and the flashes stand too');
  assert.equal(paused.render, 60, 'the frame is still drawn (a broadcast\'s capture reads the canvas every frame)');
  // the round's end is not told ahead while it stands: the play window sends no ad break for it
  assert.match(runtime, /window\.ipverseRoundEndsIn = \(\) => \(pause\.on \? null : endsIn\(\)\);/);
  // and the keys' list says how to pause only where Esc and P pause
  assert.match(runtime, /controlsFor\(spec, \{ pause: rules\.manual \}\)/);
});
