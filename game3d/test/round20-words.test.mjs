import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNTIME, THREE, cityMode, playRound, published } from './fixtures/headless.mjs';

// Words on screen that the game keeps:
// - a version-2 story box names E and Enter, which close it (authored.js updateCalm), not Space.
// - a version-1 arena's kills target over 20 plays as 20 (sf.js): the label says the number played.
// - a talk stage shows every one of the game's dialogue lines before it counts.
const { SfMode } = await import('../sf.js');
const css = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');

test('the story box names the keys that close it, and a click on it closes it too', () => {
  const footer = /#say::after \{ content: "([^"]+)"/.exec(css)?.[1];
  assert.ok(footer, 'ui.css: the story box\'s footer');
  assert.doesNotMatch(footer, /스페이스|Space/, `'${footer}': Space does not close it (it jumps)`);
  assert.match(footer, /E/);
  assert.match(footer, /Enter/);
  // the page: a click or a tap on the box is the Enter the modes close it on (authored.js updateCalm, rpg.js act)
  assert.match(RUNTIME, /\$\('say'\)\.onclick = \(\) => tap\('Enter'\);/);
  assert.match(css, /#say \{[^}]*cursor: pointer/);
});

/** A version-1 arena's mode as its HUD needs it (its arena needs WebGL): the constructor on the stored spec. */
function arena(spec) {
  const lines = [];
  const hud = { objective: (text) => lines.push(text), status() {}, health() {}, dash() {}, notice() {} };
  const mode = new SfMode({ scene: new THREE.Group() }, spec, hud, { root: new THREE.Group() });
  mode.player = { dashCooldown: 0 };
  return { mode, lines };
}

test('arena gm_c153ff5ceb: a kills target played as 20 is counted against 20 in words too', () => {
  const spec = published('gm_c153ff5ceb');
  assert.deepEqual([spec.objective.target, spec.objective.label], [30, '정거장의 침입 방어 드론 30기를 처치하라']);
  const { mode, lines } = arena(spec);
  assert.equal(mode.target, 20);
  mode.refreshHud();
  assert.equal(lines.at(-1), '목표: 적 20명 격파 (0/20) · 남은 시간 420초', 'the sentence says 30, the count is of 20');
  // a label whose number is the one played stays as it was written
  const kept = arena({ ...spec, objective: { type: 'kills', target: 15, label: '드론 15기를 처치하라' } });
  kept.mode.refreshHud();
  assert.equal(kept.lines.at(-1), '목표: 드론 15기를 처치하라 (0/15) · 남은 시간 420초');
});

/** gm_7a41fcae9e on its first stage (the talk), the hero beside the NPC; `said` keeps what the dialogue box showed. */
function atTheNpc({ autoplay = false } = {}) {
  const spec = published('gm_7a41fcae9e'), mode = cityMode(spec, { autoplay }), said = [];
  mode.hud.say = (line) => said.push(line ? line.text : null);
  const tap = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code })); dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const frame = (seconds = 1 / 30) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 30) { mode.update(1 / 30); mode.world.input.endFrame(); } };
  tap('Enter'); frame(); // the briefing
  assert.equal(mode.phase, 'playing');
  mode.player.pos.set(spec.world.npc.x + 1.5, 0, spec.world.npc.z);
  frame(.5);
  said.length = 0;
  return { spec, mode, said, tap, frame };
}

test('city gm_7a41fcae9e: a talk goes through every line of the dialogue, a line a press, before its stage is done', () => {
  const { spec, mode, said, tap, frame } = atTheNpc();
  const lines = spec.dialogue.map((line) => line.text);
  assert.equal(lines.length, 4);
  tap('KeyE'); frame();
  assert.deepEqual(said, [lines[0]]);
  assert.equal(mode.director.index, 0, 'the stage was done on the first press: lines 2-4 never showed');
  frame(5);
  assert.deepEqual(said, [lines[0]], 'a line stays until it is passed: no 3 s timer');
  tap('KeyE'); frame();
  tap('Enter'); frame(); // Enter moves on too
  assert.deepEqual(said, lines.slice(0, 3));
  assert.equal(mode.director.index, 0);
  tap('KeyE'); frame();
  assert.deepEqual(said, lines);
  tap('KeyE'); frame();
  assert.equal(said.at(-1), null, 'the box closes after the last line');
  assert.equal(mode.director.index, 1, 'and the stage is done');
  mode.world.input.dispose();
});

test('walking off in the middle of a talk closes the box, and the stage is still to do', () => {
  const { spec, mode, said, tap, frame } = atTheNpc();
  tap('KeyE'); frame();
  tap('KeyE'); frame();
  mode.player.pos.set(spec.world.npc.x + 12, 0, spec.world.npc.z);
  frame();
  assert.equal(said.at(-1), null);
  assert.equal(mode.director.index, 0);
  mode.player.pos.set(spec.world.npc.x + 1.5, 0, spec.world.npc.z);
  frame(); tap('KeyE'); frame();
  assert.equal(said.at(-1), spec.dialogue[0].text, 'it starts over');
  mode.world.input.dispose();
});

test('E held down (the built-in player holds it at its target) reads the lines one after another', () => {
  const { spec, mode, said, frame } = atTheNpc();
  const before = mode.progressKey();
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' }));
  frame(2);
  assert.deepEqual(said, spec.dialogue.slice(0, 2).map((line) => line.text), 'a line every second and a half');
  assert.notEqual(mode.progressKey(), before, 'each line is progress for the round watchdog');
  frame(8);
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' }));
  assert.equal(mode.director.index, 1);
  assert.deepEqual(said.filter(Boolean), spec.dialogue.map((line) => line.text));
  mode.world.input.dispose();
});

test('the built-in player (?autoplay=1) still gets through the talk stage', () => {
  const mode = cityMode(published('gm_7a41fcae9e'));
  const round = playRound(mode, { seconds: 90, each: (m) => m.director.index >= 1 });
  assert.equal(mode.director.index, 1, `after ${round.seconds} s: ${JSON.stringify(round.mission)}`);
  assert.equal(round.stalled, false);
});

test('a mission with two talk stages: each person says the lines that name them', () => {
  const { mode } = atTheNpc();
  const stages = [{ id: 'a', type: 'talk', label: '라이카와 대화', target: 1, entityIds: ['raika'] },
    { id: 'b', type: 'talk', label: '행인과 대화', target: 1, entityIds: ['ped1'] }];
  mode.spec.mission.stages = stages;
  mode.spec.dialogue = [{ speaker: '라이카', text: '소포를 부탁해.' }, { speaker: '테오', text: '맡겨 줘.' }, { speaker: '행인', text: '우체국은 저쪽이에요.' }];
  const raika = mode.targets.find((t) => t.id === 'raika'), walker = Object.assign(mode.targets.find((t) => t.id === 'ped1'), { name: '행인' });
  assert.deepEqual(mode.talkLines(stages[0], raika).map((line) => `${line.speaker}: ${line.text}`), ['라이카: 소포를 부탁해.', '테오: 맡겨 줘.']);
  assert.deepEqual(mode.talkLines(stages[1], walker).map((line) => `${line.speaker}: ${line.text}`), ['행인: 우체국은 저쪽이에요.']);
  // a game without dialogue: the stage's own sentence
  mode.spec.dialogue = [];
  assert.deepEqual(mode.talkLines(stages[0], raika), [{ speaker: raika.name, text: '라이카와 대화' }]);
  mode.world.input.dispose();
});
