import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNTIME, THREE, authoredMode, cityMode, trackMode, playRound, published, validateSpec } from './fixtures/headless.mjs';
import { controlsFor, controlsLine } from '../arpg-data.js';

// What a first-time player reads before and during a round:
// - the briefing in a player's words, its keys as a list; no camera keys for an ARPG (its camera is fixed) or a
//   race (the arrow keys drive there).
// - only the gauges a game uses: no HP bar, 대시 gauge or crosshair in a race, no HP where nothing can end the round.
// - the race's HUD in two short lines and its 3-2-1 large.
const css = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');
const labels = (id, more) => controlsFor(published(id), more).map((c) => c.label);
const keysOf = (id, label) => controlsFor(published(id)).find((c) => c.label === label)?.keys.join(' ');

test('the keys a game is told are the keys it takes', () => {
  // sky climb: no dash, nothing to fight, nobody to talk to
  assert.deepEqual(labels('gm_8f1fc9a181'), ['이동', '시점', '달리기', '점프']);
  // survival: no jump; its crossbow
  assert.deepEqual(labels('gm_9539d06a71'), ['이동', '시점', '달리기', '대시', '공격']);
  // ARPG: a fixed camera (arpg.js zeroes the look every frame), its own attacks
  const arpg = labels('gm_b870737b47');
  assert.ok(!arpg.includes('시점'), 'the ARPG\'s camera cannot be turned');
  assert.deepEqual(arpg, ['이동', '달리기', '점프', '대시', '연속 베기', '회오리 베기 (Lv 3)', '물약']);
  assert.equal(keysOf('gm_b870737b47', '물약'), '1');
  // a track race: the car only (W/S also sit on the arrow keys there: no camera keys)
  assert.deepEqual(labels('gm_2ceb5d2311'), ['가속', '후진', '좌우 방향', '브레이크']);
  assert.equal(keysOf('gm_2ceb5d2311', '좌우 방향'), 'A D');
  // a city delivery: on foot and at the wheel; it has no jump and no dash
  assert.deepEqual(labels('gm_7a41fcae9e'), ['이동', '시점', '달리기', '대화', '차 타고 내리기', '운전', '브레이크']);
  assert.equal(keysOf('gm_7a41fcae9e', '차 타고 내리기'), 'E');
  // version 1
  assert.deepEqual(labels('gm_c153ff5ceb'), ['이동', '시점', '달리기', '점프', '대시', '사격']);
  assert.deepEqual(labels('gm_87e5e315b0'), ['이동', '시점', '달리기', '점프', '대시', '공격', '대화']);
  // where a pause can be had it is on the list
  assert.equal(labels('gm_9539d06a71', { pause: true }).at(-1), '일시정지');
  assert.equal(controlsFor(published('gm_9539d06a71'), { pause: true }).at(-1).keys.join(), 'Esc');
});

test('the same list as one line (the hint under the game)', () => {
  assert.equal(controlsLine(controlsFor(published('gm_8f1fc9a181'))), '이동 W A S D · 시점 마우스 드래그/방향키 · 달리기 Shift · 점프 Space');
  assert.equal(controlsLine(controlsFor(published('gm_2ceb5d2311'), { pause: true })), '가속 W · 후진 S · 좌우 방향 A D · 브레이크 Space · 일시정지 Esc');
});

test('the briefing speaks to a player: no file-format names, no studio words, its keys a list', () => {
  const code = RUNTIME.replace(/^\s*\/\/.*$/gm, ''); // (its comments quote the old words)
  assert.doesNotMatch(code, /GAME SPEC|CITY \/|IP 모델|작성된 세계/);
  assert.match(RUNTIME, /'임무 브리핑', 'briefing-kicker'/);
  assert.match(RUNTIME, /keyList\(controls\)/, 'the keys as a list (one row a key)');
  const rule = /\.briefing-controls \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.doesNotMatch(rule, /font-size: 11px|opacity: \.6/, 'an 11-px line at 60 %');
  const hint = /#hint \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(hint, /font-size: 13px/);
  assert.match(hint, /background/, 'on its own dark pill: readable over a bright scene');
});

/** The page's HUD object (runtime3d.js makeHud) on stand-in elements. */
function pageHud() {
  const from = RUNTIME.indexOf('function makeHud('), to = RUNTIME.indexOf('\n}\n', from);
  assert.ok(from >= 0 && to > from, 'runtime3d.js: makeHud');
  const nodes = new Map();
  const node = () => ({ hidden: false, textContent: '', dataset: {}, style: {}, classes: new Set(),
    classList: { toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); } },
    setAttribute() {}, querySelector: () => node() });
  const $ = (id) => { if (!nodes.has(id)) { const n = node(); n.classList.owner = n; nodes.set(id, n); } return nodes.get(id); };
  $('end').hidden = true;
  const makeHud = new Function('$', 'el', `${RUNTIME.slice(from, to + 2)}\nreturn makeHud;`)($, () => node());
  return { hud: makeHud({ camera: {} }, THREE), $ };
}

test('the page hides a gauge its game does not use: no health, no dash; a countdown is written large', () => {
  const { hud, $ } = pageHud();
  hud.health(.5);
  assert.equal($('vitals').dataset.kind, 'hp');
  hud.health(null);
  assert.equal($('vitals').dataset.kind, 'none', 'a game where nothing can hurt has no health bar');
  hud.dash(.4);
  assert.equal($('dash').hidden, false);
  hud.dash(null);
  assert.equal($('dash').hidden, true, 'a game without a dash has no 대시 gauge');
  hud.notice('3', true);
  assert.ok($('notice').classes.has('big'));
  hud.notice('GO!');
  assert.ok(!$('notice').classes.has('big'));
});

/** What a mode told the page's gauges in its last refreshHud. */
function gauges(mode) {
  const told = {};
  Object.assign(mode.hud, { health: (frac) => { told.health = frac; }, dash: (frac) => { told.dash = frac; },
    crosshair: (on) => { told.crosshair = on; }, status: (text) => { told.status = text; }, notice: (text, big) => { told.notice = [text, !!big]; } });
  mode.refreshHud();
  return told;
}

test('sky gm_8f1fc9a181: nothing can hurt the hero and it has no dash: no health bar, no 대시 gauge', () => {
  const told = gauges(authoredMode(published('gm_8f1fc9a181'), { autoplay: false }));
  assert.equal(told.health, null, 'its HP fell to 1 with every fall although a fall cannot end the round');
  assert.equal(told.dash, null);
});

test('survival gm_9539d06a71: its health and its dash are on the HUD', () => {
  const told = gauges(authoredMode(published('gm_9539d06a71'), { autoplay: false }));
  assert.equal(told.health, 1);
  assert.equal(told.dash, 1);
});

test('track gm_2ceb5d2311: a race has no health bar, no 대시 gauge and no crosshair; its numbers are short and its 3-2-1 large', () => {
  const mode = trackMode(published('gm_2ceb5d2311'), { autoplay: false });
  const told = gauges(mode);
  assert.deepEqual([told.health, told.dash, told.crosshair], [null, null, false]);
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter' }));
  mode.update(1 / 30); mode.world.input.endFrame();
  mode.update(1 / 30); mode.world.input.endFrame();
  assert.deepEqual(told.notice, ['3', true], 'the countdown in the big pill');
  for (let t = 0; t < 5; t += 1 / 30) { mode.update(1 / 30); mode.world.input.endFrame(); }
  const line = mode.hud.lines.at(-1);
  assert.match(line, /^랩 1\/2 · 체크포인트 \d+\/10 · 3위 안에 들어야 해요 · 남은 \d+초$/, `'${line}'`);
  assert.match(told.status, /^\d\/5위 · 0:0\d\.\d · \d+ km\/h$/, `'${told.status}': the place and the time at the top right`);
  mode.world.input.dispose();
});

// A city race with no rivals (rivals 0 is valid) followed by another stage must not keep the finished race's time
// in the district's place on the status line.
test('city gm_1a22c1dc81 with no rivals and a stage after the race: once the race is over the status line names the district again', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/gm_1a22c1dc81.spec.json', import.meta.url), 'utf8'));
  Object.assign(raw.mission.stages[0], { rivals: 0, target: 1 }); // (one lap: the race is not what is looked at)
  delete raw.mission.stages[0].finishRank;
  raw.mission.stages.push({ id: 'drive', type: 'drive', label: '도심을 150m 더 달리기', target: 1, entityIds: ['playerCar'], distanceMeters: 150 });
  const { ok, errors, spec } = validateSpec(raw);
  assert.ok(ok, errors?.join('; '));
  const mode = cityMode(spec), told = [];
  mode.hud.status = (text) => { if (/ km\/h$/.test(text)) told.push([mode.director.index, text]); }; // at the wheel
  const round = playRound(mode, { seconds: 400 });
  assert.deepEqual([round.won, round.mission.history.map((h) => h.id)], [true, ['race', 'drive']], JSON.stringify(round));
  assert.match(told.findLast(([stage]) => stage === 0)[1], /^\d:\d\d\.\d · \d+ km\/h$/, 'in the race: its time and the speed');
  const after = told.filter(([stage]) => stage === 1).map(([, text]) => text);
  assert.ok(after.length > 60, 'the drive stage was driven');
  const districts = spec.world.city.districts.map((d) => d.name);
  for (const text of after) assert.ok(districts.includes(text.replace(/ · \d+ km\/h$/, '')), `the stage after the race read '${text}'`);
});

test('city gm_7a41fcae9e: at the wheel there is no 대시 gauge; on foot the game\'s own (it has none)', () => {
  const mode = cityMode(published('gm_7a41fcae9e'), { autoplay: false, stage: 1 });
  assert.equal(gauges(mode).dash, null);
  mode.mechanics.dash = true; // a city whose hero dashes
  assert.equal(gauges(mode).dash, 1);
  mode.activeCar = mode.cars[0];
  assert.equal(gauges(mode).dash, null);
  mode.world.input.dispose();
});
