import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { validateSpec } from '../gamespec3d.js';

// The end screen:
// - the last stage's notice pill does not stay over 클리어! (a stage that begins under 2.5 s before the clear).
// - the hero does not stand frozen mid-stride behind it: its animator is ticked once the round is over.
// - a round the built-in player ended (its cap, its watchdog) says why.
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const THREE = await import(stub);
const { AuthoredMode } = await import('../authored.js');
const { PlayerController } = await import('../world.js');
const { Animator } = await import('../anim.js');

const fixture = (id) => JSON.parse(readFileSync(new URL(`./fixtures/${id}.spec.json`, import.meta.url)));
function published(id) {
  const { ok, errors, spec } = validateSpec(fixture(id));
  assert.equal(ok, true, errors?.join('; '));
  return spec;
}
const runtime = readFileSync(new URL('../runtime3d.js', import.meta.url), 'utf8');
function sliceOf(from, to) {
  const start = runtime.indexOf(from), end = runtime.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return runtime.slice(start, end);
}

/** An AuthoredMode on plain records; `shown` keeps what it writes on the HUD and when it ends. */
function mode(spec, shown = { notice: [], objective: [], end: [] }) {
  const actor = () => ({ root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'billboard' });
  const world = { scene: new THREE.Group(), flash() {}, particles: { emit() {} },
    input: { look: { x: 0, y: 0 }, down: () => false, hit: () => false, clicked: false, fireHeld: false, pad: null },
    rig: { yaw: 0, pitch: .25, update() {}, shake() {}, forward: () => new THREE.Vector3(0, 0, -1), right: () => new THREE.Vector3(1, 0, 0) } };
  const hud = { popup() {}, say() {}, float() {}, status() {}, health() {}, dash() {}, crosshair() {},
    notice: (text) => shown.notice.push(text), objective: (text) => shown.objective.push(text), end: (won) => shown.end.push(won) };
  const m = new AuthoredMode(world, spec, hud, actor());
  m.player = { pos: new THREE.Vector3(spec.world.spawn.x, 0, spec.world.spawn.z), vel: new THREE.Vector3(), dashCooldown: 0, animate() {} };
  return Object.assign(m, { shown });
}
/** `seconds` of a round being played, as update() runs it: the clocks, the stage that completes, the HUD. */
function play(m, seconds, progress) {
  m.phase = 'playing';
  m.elapsed += seconds;
  m.stageNotice = Math.max(0, m.stageNotice - seconds);
  if (progress != null) m.director.progress = progress;
  const done = m.director.update(seconds, { position: m.player.pos, targets: [] });
  if (done) m.completeStage(done);
  m.refreshHud();
}

test('a clear takes the last stage\'s notice off the screen (sky gm_494550db34: "꼭대기 섬에서 태양 나침반을 찾는다" over 클리어!)', () => {
  const m = mode(published('gm_8f1fc9a181')); // a sky climb's mission
  m.activateStage();
  play(m, 7, 6); // the six crystals: the second stage begins and says so for 2.5 s
  assert.equal(m.shown.notice.at(-1), '꼭대기 섬에서 태양 나침반을 찾는다');
  play(m, 1.2, 1); // the compass, 1.2 s later
  assert.deepEqual([m.phase, m.shown.end], ['won', [true]]);
  assert.equal(m.shown.notice.at(-1), '', 'the stage\'s notice stayed over the end screen');
  m.idle(1 / 60); m.refreshHud();
  assert.equal(m.shown.notice.at(-1), '');
});

test('a loss says why in the notice when it has a reason, and nothing of the stage when it has none', () => {
  // the built-in player's watchdog (runtime3d.js): its reason must be shown, not only kept in mode.failure
  const stuck = mode(published('gm_8f1fc9a181'));
  stuck.activateStage();
  play(stuck, 7, 6);
  stuck.failure = '진행이 멈춰서 이번 판을 마쳐요.';
  stuck.end(false);
  assert.deepEqual([stuck.phase, stuck.shown.end, stuck.shown.notice.at(-1)], ['lost', [false], '진행이 멈춰서 이번 판을 마쳐요.']);
  // a death a second into a stage: its label is not a reason
  const dead = mode(published('gm_8f1fc9a181'));
  dead.activateStage();
  play(dead, 7, 6);
  dead.hp = 0;
  dead.end(false);
  assert.equal(dead.shown.notice.at(-1), '');
});

/** The built-in player's 80 ms tick up to where it ends a round itself (runtime3d.js), for the mode being played.
 * `watchdog`: what arpg-data.js roundWatch answers; `played`: seconds of interval time. → the runtime's `stalled` */
function botTick(m, hud, { botCap = 0, watchdog = null, played = 0 } = {}) {
  const lines = sliceOf('      // the watchdog (authored worlds)', '      if (!mode || ended || mode.selfDriven) return;');
  // what those lines call, where the runtime has it
  const own = (from) => (runtime.includes(from) ? sliceOf(from, '\n') : '');
  const stop = own('    const stop = (why) =>');
  const BOT_END = new Function(`${own('const BOT_END = {')}\nreturn typeof BOT_END === 'undefined' ? {} : BOT_END;`)();
  const run = new Function('mode', 'hud', 'botCap', 'roundWatch', 'AUTOPLAY_ROUND_SEC', 'BOT_END', 'played', `
    let stalled = false, ended = false, watch = null, detour = 0, side = 'KeyA';
    const shown = hud.end; hud.end = (won) => { ended = true; shown(won); }; // the runtime's own hud.end
    ${stop}
    ${lines}
    return stalled;`);
  return run(m, hud, botCap, () => ({ state: null, action: watchdog }), 180, BOT_END, played);
}

test('autoplay: a round the built-in player ends says why on the end screen: its cap, its watchdog', () => {
  // an authored round at the cap
  const capped = mode(published('gm_8f1fc9a181'));
  capped.activateStage();
  play(capped, 180.02);
  assert.equal(botTick(capped, capped.hud, { botCap: 180 }), true, 'still counted as a timeout');
  assert.deepEqual([capped.phase, capped.shown.end], ['lost', [false]]);
  assert.equal(capped.shown.notice.at(-1), '자동 플레이 시간이 다 돼서 이번 판을 마쳐요.');
  assert.equal(capped.failure, '자동 플레이 시간이 다 돼서 이번 판을 마쳐요.', 'and the page\'s state says it (__ipverseGameState)');
  // the watchdog's own text reaches the screen
  const stuck = mode(published('gm_8f1fc9a181'));
  stuck.activateStage();
  play(stuck, 47);
  assert.equal(botTick(stuck, stuck.hud, { botCap: 180, watchdog: 'end' }), true);
  assert.deepEqual([stuck.phase, stuck.shown.notice.at(-1)], ['lost', '진행이 멈춰서 이번 판을 마쳐요.']);
  // a v1 mode's own end() writes no notice (sf.js): the runtime does
  const shown = { notice: [], end: [] };
  const hud = { notice: (text) => shown.notice.push(text), end: (won) => shown.end.push(won) };
  const sf = { timeLimit: 0, elapsed: 180.02, end(won) { hud.end(won); } };
  assert.equal(botTick(sf, hud, { botCap: 180 }), true);
  assert.deepEqual([shown.end, shown.notice.at(-1)], [[false], '자동 플레이 시간이 다 돼서 이번 판을 마쳐요.']);
  // a mode without a round clock (v1 RPG) ends by interval time
  const rpgShown = { notice: [], end: [] };
  const rpgHud = { notice: (text) => rpgShown.notice.push(text), end: (won) => rpgShown.end.push(won) };
  assert.equal(botTick({ end(won) { rpgHud.end(won); } }, rpgHud, { played: 180 }), true);
  assert.deepEqual([rpgShown.end, rpgShown.notice.at(-1)], [[false], '자동 플레이 시간이 다 돼서 이번 판을 마쳐요.']);
  // the built-in player's block holds its own texts: a suite that runs the block alone (the race branch's
  // fixtures/headless.mjs, with boot()'s names only) would end a stuck round on a TypeError instead
  const block = /\n  if \(autoplay\) \{\n([\s\S]*?)\n  \}\n/.exec(runtime)?.[1] ?? '';
  assert.ok(block.includes('const BOT_END = {') && block.includes('stop(BOT_END.stuck)') && !runtime.replace(block, '').includes('BOT_END'));
  // a round that is neither stuck nor at its cap goes on
  const going = mode(published('gm_8f1fc9a181'));
  going.activateStage();
  play(going, 30);
  assert.equal(botTick(going, going.hud, { botCap: 180 }), false);
  assert.deepEqual([going.phase, going.shown.end], ['playing', []]);
});

test('다시 시작 takes the reason off with the end screen: it is not over the next round\'s briefing', () => {
  const lines = sliceOf('  const restart = async () => {\n', "    removeEventListener('keydown', onKey);");
  const shown = [], end = { hidden: false }, briefing = { hidden: true };
  new Function('end', 'building', 'hud', '$', 'setStartReady', 'briefing', lines.slice(lines.indexOf('\n') + 1))(
    end, null, { notice: (text) => shown.push(text) }, () => ({ querySelectorAll: () => [] }), () => {}, briefing);
  assert.deepEqual([end.hidden, briefing.hidden], [true, false]);
  assert.deepEqual(shown, [''], 'the pill stayed up while the next round was built (the built-in player restarts 4 s after the end)');
});

test('behind the end screen the hero comes out of its stride into idle', () => {
  const pair = (name) => ({ upper: { name: `${name}.upper` }, lower: { name: `${name}.lower` }, duration: 1 });
  const bound = { parts: { idle: pair('idle'), walk: pair('walk'), jump: pair('jump'), fall: pair('fall') }, bones: new Map(),
    loco: [{ role: 'walk', speed: 1.5, offset: 0, cycle: 1.5 }] };
  const kairo = published('gm_8f1fc9a181');
  const actor = { root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'rigged', animator: new Animator(new THREE.Group(), bound) };
  const world = { scene: new THREE.Group(), particles: { emit() {} }, input: { hit: () => false, clicked: false, pad: null },
    rig: { yaw: 0, update() {} } };
  const m = new AuthoredMode(world, kairo, { notice() {}, float() {}, end() {} }, actor);
  m.player = new PlayerController(world, actor, { groundAt: () => 0 });
  m.player.place(kairo.world.spawn.x, kairo.world.spawn.z);
  const posed = actor.animator.mixer.updates; // each mixer update: the weight of every playing action as it wrote the bones
  for (let frame = 0; frame < 60; frame++) m.player.animate(1 / 60, 1, world.rig, 3); // running at the compass
  assert.ok(posed.at(-1)['walk.lower'] > .99 && posed.at(-1)['idle.lower'] < .01, 'in its stride');
  const stride = actor.animator.phase;
  m.phase = 'playing';
  m.end(true);
  const before = posed.length;
  for (let frame = 0; frame < 90; frame++) m.idle(1 / 60); // 1.5 s of the end screen (runtime3d.js: mode.idle once it ended)
  assert.equal(posed.length - before, 90, 'nothing ticked the hero once the round was over: it stood frozen mid-stride');
  assert.ok(posed.at(-1)['idle.lower'] > .99 && posed.at(-1)['walk.lower'] < .01, `idle ${posed.at(-1)['idle.lower']}, walk ${posed.at(-1)['walk.lower']}`);
  assert.equal(actor.animator.phase, stride, 'it stands: the stride does not run on');
  assert.deepEqual(actor.root.position.toArray(), [kairo.world.spawn.x, 0, kairo.world.spawn.z]);
});
