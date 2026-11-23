import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNTIME, THREE, authoredMode, cityMode, trackMode, playRound, published } from './fixtures/headless.mjs';
import { endCard } from '../arpg-data.js';

// The end screen says why the round ended, its result and what 다시 시작 does:
// - an arena's death: the reason on the card, no stale objective line or crosshair across the dialog.
// - a version-2 death: where 다시 시작 goes on from; a race's place and time are on the card.
// - 다시 시작 starts the next round by itself (no second briefing).
const { SfMode } = await import('../sf.js');
const { RpgMode } = await import('../rpg.js');
const css = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');
function sliceOf(from, to) {
  const start = RUNTIME.indexOf(from), end = RUNTIME.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return RUNTIME.slice(start, end);
}

test('the card\'s words: why the round ended, what it came to, what 다시 시작 does', () => {
  // a death on the second of four stages, a checkpoint behind it
  assert.deepEqual(endCard({ won: false, summary: { reason: '체력이 다했어요.', result: ['4단계 중 2단계', '점수 800', '2:31'], resumeStage: 1 } }), {
    title: '게임 오버', reason: '체력이 다했어요.', result: '4단계 중 2단계 · 점수 800 · 2:31', next: '2단계부터 이어서 해요. Enter 키를 눌러도 돼요.' });
  // a reason the round was ended with comes first: a race lost on place, the built-in player's cap
  assert.equal(endCard({ won: false, failure: '4위로 완주 — 3위 안에 들어야 클리어', summary: { reason: null, result: ['5대 중 4위', '2:11.4'], resumeStage: 0 } }).reason,
    '4위로 완주 — 3위 안에 들어야 클리어');
  // a clear
  assert.deepEqual(endCard({ won: true, summary: { reason: '30초를 버텨냈다.', result: ['점수 1400', '0:30'], resumeStage: 0 } }), {
    title: '클리어!', reason: '30초를 버텨냈다.', result: '점수 1400 · 0:30', next: '처음부터 다시 해요. Enter 키를 눌러도 돼요.' });
  // a mode that says nothing of itself still gets a reason
  assert.equal(endCard({ won: false }).reason, '체력이 다했어요.');
  assert.equal(endCard({ won: false, timeout: true }).reason, '제한 시간이 끝났어요.');
  // a device without a keyboard is not told to press Enter
  assert.equal(endCard({ won: false, keys: false }).next, '처음부터 다시 해요.');
  // a playable ad's round: its numbers only (the ad's page says what comes next, and there is no 다시 시작)
  assert.deepEqual(endCard({ won: false, playable: true, timeout: true, summary: { reason: '제한 시간이 끝났어요.', result: ['점수 300', '1:30'], resumeStage: 0 } }),
    { title: '체험 종료 · 전체 게임에서 이어서 즐기세요', reason: '', result: '점수 300 · 1:30', next: '' });
});

test('ARPG gm_b870737b47: a death on stage 2 says so, with the score and the time, and where 다시 시작 goes on', () => {
  const mode = authoredMode(published('gm_b870737b47'), { autoplay: false });
  mode.phase = 'playing';
  mode.director.progress = 6; // the first room cleared
  mode.completeStage(mode.director.update(.016, { position: mode.player.pos, targets: [] }));
  assert.equal(mode.director.index, 1);
  assert.equal(mode.endSummary(false).resumeStage, 1, 'while it is played too: what the pause card says its 다시 시작 goes on from');
  Object.assign(mode, { score: 800, elapsed: 151.4, hp: 0 });
  mode.end(false);
  assert.deepEqual(mode.endSummary(false), { reason: '체력이 다했어요.', result: ['4단계 중 2단계', '점수 800', '2:31'], resumeStage: 1 });
  mode.world.input.dispose();
});

test('a clear tells the mission\'s success text; a time limit that ran out is named; a first-stage death starts over', () => {
  const won = authoredMode(published('gm_9539d06a71'), { autoplay: false });
  won.phase = 'playing';
  Object.assign(won, { score: 1400, elapsed: 30.02 });
  won.completeStage(won.director.update(30.02, { position: won.player.pos, targets: [] }));
  assert.equal(won.phase, 'won');
  assert.deepEqual(won.endSummary(true), { reason: '30초를 버텨냈다. 카이로는 태양 나침반의 빛과 함께 협곡 유적을 빠져나간다.', result: ['점수 1400', '0:30'], resumeStage: 0 });
  const late = authoredMode(published('gm_8f1fc9a181'), { autoplay: false });
  Object.assign(late, { phase: 'playing', timeLimit: 60, elapsed: 60.01 });
  late.end(false);
  assert.deepEqual(late.endSummary(false), { reason: '제한 시간이 끝났어요.', result: ['2단계 중 1단계', '1:00'], resumeStage: 0 }, 'a score of 0 is not a result');
  won.world.input.dispose(); late.world.input.dispose();
});

// The card prints no '점수 0' for a game that never scores (a city delivery: a talk and four addresses).
test('city gm_7a41fcae9e: a game with nothing to score tells no score, only its time', () => {
  const mode = cityMode(published('gm_7a41fcae9e'));
  const round = playRound(mode);
  assert.deepEqual([round.won, round.reason], [true, 'clear'], JSON.stringify(round));
  const { result } = mode.endSummary(true);
  assert.equal(result.length, 1, `the card read '${result.join(' · ')}'`);
  assert.match(result[0], /^1:\d\d$/);
});

test('the goal arrow is not left over the end card', () => {
  const mode = authoredMode(published('gm_8f1fc9a181'), { autoplay: false });
  mode.phase = 'playing';
  mode.targets.push({ id: 'coin1', x: 20, z: 20, radius: 1.1, pickup: true, group: { visible: true, rotation: { y: 0 }, position: new THREE.Vector3(20, 0, 20) } });
  mode.pointToGoal(mode.director.stage);
  assert.equal(mode.goalArrow.hidden, false, 'the arrow points at the stage\'s goal');
  mode.hp = 0;
  mode.end(false);
  assert.equal(mode.goalArrow.hidden, true, 'a death left "➤ 11m" on the card (the arrow is drawn above it)');
  mode.world.input.dispose();
});

test('track gm_2ceb5d2311: the race\'s place and time are the result', () => {
  const mode = trackMode(published('gm_2ceb5d2311'));
  const round = playRound(mode);
  assert.deepEqual([round.won, round.reason], [true, 'clear']);
  const { reason, result, resumeStage } = mode.endSummary(true);
  assert.equal(reason, '3위 안에 들어왔습니다! 사막 협곡 정복 완료.');
  assert.equal(result.length, 2);
  assert.match(result[0], /^5대 중 [123]위$/);
  assert.match(result[1], /^[12]:\d\d\.\d$/, `the race took ${result[1]}`);
  assert.equal(resumeStage, 0);
});

test('arena gm_c153ff5ceb: a death says so and counts what was done; a clear says the goal was met', () => {
  const mode = new SfMode({ scene: new THREE.Group() }, published('gm_c153ff5ceb'), {}, { root: new THREE.Group() });
  Object.assign(mode, { kills: 6, score: 120, elapsed: 146.7, hp: 0 });
  assert.deepEqual(mode.endSummary(false), { reason: '체력이 다했어요.', result: ['적 6/20명 격파', '점수 120', '2:26'], resumeStage: 0 });
  Object.assign(mode, { hp: 40, elapsed: 420 });
  assert.equal(mode.endSummary(false).reason, '제한 시간이 끝났어요.');
  Object.assign(mode, { kills: 23 });
  assert.deepEqual(mode.endSummary(true), { reason: '목표를 달성했어요.', result: ['적 20/20명 격파', '점수 120', '7:00'], resumeStage: 0 });
});

test('a version-1 quest: lives lost, or what the quest giver asked', () => {
  const mode = Object.assign(Object.create(RpgMode.prototype), { spec: { objective: { type: 'talk' } }, npcName: '노인 정비사 카이',
    score: 0, elapsed: 75, collected: 1, goal: 1 });
  assert.deepEqual(mode.endSummary(false), { reason: '목숨을 모두 잃었어요.', result: ['1:15'], resumeStage: 0 });
  assert.equal(mode.endSummary(true).reason, '노인 정비사 카이의 부탁을 들어줬어요.');
  const collect = Object.assign(Object.create(RpgMode.prototype), { spec: { objective: { type: 'collect' } }, score: 30, elapsed: 61, collected: 2, goal: 3 });
  assert.deepEqual(collect.endSummary(false).result, ['아이템 2/3개', '점수 30', '1:01']);
});

/** runtime3d.js's own hud.end on stand-in elements, for the mode being played. → what the page shows and tells;
 * `restarts`: 다시 시작 as the built-in player presses it, once the timers hud.end set have run (a restart needs the
 * end card up, as boot()'s does); `warned`: what the page logged. */
function endScreen(mode, { won, playableSec = 0, autoplay = false } = {}) {
  const body = sliceOf('  hud.end = (won) => {', '\n  };\n');
  const node = (more = {}) => ({ hidden: false, textContent: '', dataset: {}, focus() {}, ...more });
  const nodes = { 'end-title': node(), restart: node(), crosshair: node(), notice: node({ textContent: '진행이 멈춰서 이번 판을 마쳐요.' }) };
  const card = { reason: node(), result: node(), next: node() }, end = node({ hidden: true }), events = [], timers = [], warned = [];
  let restarts = 0, thrown = null;
  const hud = new Function('mode', 'playableSec', 'autoplay', 'endCard', '$', 'endReason', 'endResult', 'endNext', 'end', 'document', 'window',
    'dispatchEvent', 'CustomEvent', 'performance', 'setTimeout', 'addEventListener', 'restart', 'onKey', 'console',
    `let ended = false, rounds = 0, stalled = false, adEvery = 0, holdUntil = 0, keyless = false, endAt = 0; const hud = {};\n${body}\n  };\nreturn hud;`)(
    mode, playableSec, autoplay, endCard, (id) => nodes[id], card.reason, card.result, card.next, end, { pointerLockElement: null }, {},
    (event) => events.push(event), class { constructor(type, init) { Object.assign(this, { type }, init); } }, { now: () => 0 },
    (fn, ms) => timers.push([ms, fn]), () => {}, () => { if (!end.hidden) restarts += 1; }, () => {}, { warn: (...said) => warned.push(said.map(String).join(' ')) });
  try { hud.end(won); } catch (error) { thrown = error; }
  for (const [, fn] of timers.splice(0)) fn();
  const text = (n) => (n.hidden ? null : n.textContent);
  return { title: nodes['end-title'].textContent, reason: text(card.reason), result: text(card.result), next: text(card.next), shown: !end.hidden,
    restart: !nodes.restart.hidden, crosshair: !nodes.crosshair.hidden, pill: !nodes.notice.hidden, round: events[0]?.detail, restarts, warned, thrown };
}

test('the page: a round\'s end fills the card from the mode, takes the crosshair and the pill off it, and still reports the round', () => {
  const mode = { timeLimit: 0, elapsed: 151.4, failure: null,
    endSummary: () => ({ reason: '체력이 다했어요.', result: ['4단계 중 2단계', '점수 800', '2:31'], resumeStage: 1 }) };
  const lost = endScreen(mode, { won: false });
  assert.deepEqual([lost.title, lost.reason, lost.result, lost.next], ['게임 오버', '체력이 다했어요.', '4단계 중 2단계 · 점수 800 · 2:31',
    '2단계부터 이어서 해요. Enter 키를 눌러도 돼요.']);
  assert.deepEqual([lost.shown, lost.restart, lost.crosshair, lost.pill], [true, true, false, false], 'the crosshair and the notice pill are not over the card');
  assert.deepEqual(lost.round, { rounds: 1, won: false, reason: 'death', adDue: false, everyRounds: 0 }, 'the round is reported as before');
  // the built-in player's reason (mode.failure) is the card's
  const stuck = endScreen({ ...mode, failure: '진행이 멈춰서 이번 판을 마쳐요.' }, { won: false, autoplay: true });
  assert.equal(stuck.reason, '진행이 멈춰서 이번 판을 마쳐요.');
  // a mode that tells nothing of itself (an older one): the card still says why
  assert.equal(endScreen({ timeLimit: 90, elapsed: 90 }, { won: false }).reason, '제한 시간이 끝났어요.');
  // a playable ad: no reason, no button, its numbers
  const ad = endScreen({ ...mode, timeLimit: 90, elapsed: 90 }, { won: false, playableSec: 90 });
  assert.deepEqual([ad.title, ad.reason, ad.restart, ad.next], ['체험 종료 · 전체 게임에서 이어서 즐기세요', null, false, null]);
  assert.equal(ad.result, '4단계 중 2단계 · 점수 800 · 2:31');
});

// The round's report (ipverse:round) and the built-in player's restart timer come before endCard() and
// mode.endSummary(): a throw there must not leave a broadcast with a counted round, no report and no next round.
test('the page: whatever a mode says of its round, the round is reported, the card comes up and the built-in player goes on', () => {
  const round = { rounds: 1, won: false, reason: 'death', adDue: false, everyRounds: 0 };
  // a summary that throws
  const thrown = endScreen({ timeLimit: 0, elapsed: 12, failure: null, endSummary: () => { throw new Error('no director'); } }, { won: false, autoplay: true });
  assert.equal(thrown.thrown, null, `hud.end threw: ${thrown.thrown?.message}`);
  assert.deepEqual(thrown.round, round, 'a counted round with no report');
  assert.deepEqual([thrown.shown, thrown.title, thrown.reason, thrown.result, thrown.next], [true, '게임 오버', '체력이 다했어요.', null, '처음부터 다시 해요. Enter 키를 눌러도 돼요.'],
    'the card says its own words');
  assert.equal(thrown.restarts, 1, 'the built-in player\'s next round: its 다시 시작 needs the card up');
  assert.match(thrown.warned.join('\n'), /no director/, 'what went wrong is in the console');
  // a summary the card cannot write (its result is no list)
  const odd = endScreen({ timeLimit: 0, elapsed: 12, failure: null, endSummary: () => ({ reason: '체력이 다했어요.', result: '점수 800' }) }, { won: false, autoplay: true });
  assert.deepEqual([odd.thrown, odd.round, odd.shown, odd.restarts], [null, round, true, 1]);
  // and a round that tells itself well is reported before a word of the card is written
  const order = [];
  const node = (name) => ({ dataset: {}, focus() {}, set textContent(text) { order.push(`${name} '${text}'`); }, set hidden(on) { if (name === 'end' && !on) order.push('the card is up'); } });
  const nodes = { 'end-title': node('title'), restart: node('restart'), crosshair: node('crosshair'), notice: node('notice') };
  new Function('mode', 'playableSec', 'autoplay', 'endCard', '$', 'endReason', 'endResult', 'endNext', 'end', 'document', 'window', 'dispatchEvent', 'CustomEvent',
    'performance', 'setTimeout', 'addEventListener', 'restart', 'onKey',
    `let ended = false, rounds = 0, stalled = false, adEvery = 0, holdUntil = 0, keyless = false, endAt = 0; const hud = {};\n${sliceOf('  hud.end = (won) => {', '\n  };\n')}\n  };\nhud.end(true);`)(
    { timeLimit: 0, elapsed: 30, endSummary: () => { order.push('the mode\'s summary'); return { reason: '30초를 버텨냈다.', result: ['점수 1400', '0:30'], resumeStage: 0 }; } },
    0, true, endCard, (id) => nodes[id], node('reason'), node('result'), node('next'), node('end'), { pointerLockElement: null }, {},
    (event) => order.push(event.type), class { constructor(type) { this.type = type; } }, { now: () => 0 }, (fn, ms) => { if (ms === 4000) order.push('the built-in player\'s restart timer'); },
    () => {}, () => {}, () => {});
  assert.deepEqual(order.slice(0, 4), ['ipverse:round', 'the built-in player\'s restart timer', 'the mode\'s summary', 'title \'클리어!\'']);
  assert.equal(order.at(-1), 'the card is up');
});

/** runtime3d.js's own nextRound on stand-ins. → what happened, in order. */
async function nextRound({ midroll = false } = {}) {
  const body = sliceOf('  const nextRound = async (midroll) => {', '\n  };\n');
  const log = [], timers = [];
  const old = { ended: false, dispose: () => log.push('the last round\'s world is gone') };
  const briefing = { classes: new Set(), classList: { add: (name) => briefing.classes.add(name) } };
  const run = new Function('mode', 'briefing', 'release', 'playAd', 'build', 'world', 'setStartReady', 'setTimeout', 'briefingStart', 'showErrors',
    'dispatchEvent', 'CustomEvent', 'rounds', `let replay = false, building = null;\n${body}\n  };\nreturn nextRound(${midroll}).then(() => ({ replay, building }));`);
  const state = await run(old, briefing, Promise.resolve({ ad: { videoUrl: 'ad.mp4' } }), async () => { log.push('the mid-roll played'); },
    async () => { log.push('the world is built'); }, { input: { keys: { clear() {} }, pressed: { clear() {} } }, canvas: { focus() {} } },
    (ready) => log.push(`start ${ready ? 'lit' : 'busy'}`), (fn, ms) => timers.push([ms, fn]), { onclick: () => log.push('임무 시작 pressed') }, () => {},
    (event) => log.push(event.type), class { constructor(type) { this.type = type; } }, 1);
  for (const [, fn] of timers) fn();
  return { log, timers: timers.map(([ms]) => ms), old, briefing, state };
}

test('다시 시작 starts the next round by itself: the briefing is not asked for a second press', async () => {
  const { log, timers, old, briefing } = await nextRound();
  assert.deepEqual(log, ['the last round\'s world is gone', 'the world is built', 'start lit', 'ipverse:roundstart', '임무 시작 pressed'],
    'a person\'s round waited behind the briefing for a second press');
  assert.deepEqual(timers, [300]);
  assert.equal(old.ended, true);
  assert.ok(briefing.classes.has('again'), 'the card shows its title and the busy button, not the whole briefing');
  assert.match(css, /\.briefing\.again :is\([^)]*\.briefing-steps[^)]*\) \{ display: none; \}/);
  // restart() goes through it, with the mid-roll when one is due
  assert.match(RUNTIME, /removeEventListener\('keydown', onKey\);\n    await nextRound\(adEvery > 0 && rounds % adEvery === 0\);/);
  const due = await nextRound({ midroll: true });
  assert.deepEqual(due.log.slice(0, 3), ['the last round\'s world is gone', 'the mid-roll played', 'the world is built']);
});

test('the end card on the page: its lines have their own sizes, and a broadcast\'s capture draws the reason and the result', () => {
  assert.doesNotMatch(css, /#end p \{[^}]*font-size: 64px/, 'every line of the card at the title\'s 64 px');
  assert.match(css, /#end-title \{[^}]*font-size: 64px/);
  assert.match(css, /#end-reason \{[^}]*font-size: 19px/);
  assert.match(RUNTIME, /center\(txt\('end-reason'\)/);
  assert.match(RUNTIME, /center\(txt\('end-result'\)/);
  // the lines exist on a page made with an older index.html (a runtime patch brings no index.html)
  assert.match(RUNTIME, /const endReason = ensure\('end-reason', 'p', end, \$\('restart'\)\)/);
});
