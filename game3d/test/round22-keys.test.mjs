import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME, authoredMode, climbMode, playRound, published } from './fixtures/headless.mjs';
import { endCardPage } from './fixtures/end-card.mjs';

// Under ?autoplay=1 a keyboard's keys do not reach the hero: whoever has the focus of a play window that runs the
// built-in player could otherwise hold a broadcast's round (and its ads, which wait for the round's end) with one
// key. A key from a keyboard is told from the built-in player's by the event itself: a script's event is not trusted
// (isTrusted false: runtime3d.js's and arpg.js's dispatchEvent), a person's is.
/** A key as a keyboard sends it: straight to the input's own listener (a test cannot make a trusted event). */
function person(input, type, code) {
  const event = { code, isTrusted: true, target: null, prevented: false, preventDefault() { this.prevented = true; } };
  for (const [, heard, listener] of input.handlers) if (heard === type) listener(event);
  return event;
}

test('under the built-in player a person\'s keys are not the hero\'s; the built-in player\'s own are', () => {
  const mode = authoredMode(published('gm_9539d06a71')), input = mode.world.input;
  const pressed = person(input, 'keydown', 'KeyS');
  assert.equal(input.down('KeyS'), false, 'a held S reached the hero');
  assert.equal(pressed.prevented, true, 'the key is still kept from the page (Space would scroll it)');
  person(input, 'keydown', 'Enter');
  assert.equal(input.hit('Enter'), false);
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })); // as the built-in player holds a key
  assert.equal(input.down('KeyW'), true);
  person(input, 'keyup', 'KeyW');
  assert.equal(input.down('KeyW'), true, 'a person\'s key let go lifted the built-in player\'s W');
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  assert.equal(input.down('KeyW'), false);
  input.dispose();
  // boot() says so to the world's input, for the built-in player only
  assert.match(RUNTIME, /world\.input\.botOnly = autoplay;/);
});

test('a person\'s round takes the keyboard as before', () => {
  const mode = authoredMode(published('gm_9539d06a71'), { autoplay: false }), input = mode.world.input;
  person(input, 'keydown', 'KeyS');
  assert.equal(input.down('KeyS'), true);
  person(input, 'keyup', 'KeyS');
  assert.equal(input.down('KeyS'), false);
  input.dispose();
});

test('gm_1e7d17bbb0 with S held down all round: the built-in player clears it in the time it takes alone', () => {
  const alone = playRound(climbMode(published('gm_1e7d17bbb0')), { seconds: 200, fps: 30 });
  const mode = climbMode(published('gm_1e7d17bbb0'));
  const held = playRound(mode, { seconds: 200, fps: 30, each: (m) => { person(m.world.input, 'keydown', 'KeyS'); } }); // (a held key repeats)
  assert.deepEqual([alone.won, held.won, held.seconds], [true, true, alone.seconds], `with S held: ${held.failure ?? held.reason} after ${held.seconds} s (${alone.seconds} s alone)`);
});

test('nor do a person\'s Enter and Space press the end card under the built-in player: its restart and a broadcast\'s hold decide', () => {
  const bot = endCardPage({ autoplay: true });
  bot.end(true);
  bot.wait(1500);
  for (const code of ['Enter', 'Space']) bot.key(code, { trusted: true });
  assert.deepEqual([bot.restarts, bot.shown()], [0, true], 'a stray key started the next round ahead of the built-in player (and of an ad\'s hold)');
  bot.wait(2500);
  assert.equal(bot.restarts, 1, 'the built-in player\'s next round comes 4 s after the end, as before');
  // a person's own round: the card's keys
  const own = endCardPage();
  own.end(true);
  own.wait(1500);
  own.key('Enter', { trusted: true });
  assert.equal(own.restarts, 1);
});
