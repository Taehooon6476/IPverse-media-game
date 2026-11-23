import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { validateSpec } from '../gamespec3d.js';

// The shared runtime:
// - a rig dropped for uneven legs stands as its raw mesh when the game folder has it, else as the cutout.
// - after a clear the objective line is the success text alone (no "(0/0)", no time left).
// - under ?autoplay=1 the HUD does not count the built-in player's round cap down next to the game's own clock.
// - behind the briefing the hero idles, not in the rig's bind pose (a broadcast's capture shows it).
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const THREE = await import(stub);
const { AuthoredMode } = await import('../authored.js');
const { World, PlayerController, animateBody, STATIC_GAIT } = await import('../world.js');
const { Animator } = await import('../anim.js');
const { legImbalance, LEG_IMBALANCE_MAX } = await import('../ualclips.js');
Object.assign(globalThis, { innerWidth: 1600, innerHeight: 1000, document: {
  getElementById: () => ({ append() {} }),
  createElement: () => {
    const node = { style: {}, hidden: false, setAttribute() {}, remove() {} };
    Object.defineProperty(node, 'innerHTML', { set() { node.firstChild = { style: {}, textContent: '' }; } });
    return node;
  } } });

const fixture = (id) => JSON.parse(readFileSync(new URL(`./fixtures/${id}.spec.json`, import.meta.url)));
function published(id) {
  const { ok, errors, spec } = validateSpec(fixture(id));
  assert.equal(ok, true, errors?.join('; '));
  return spec;
}
const idle = { look: { x: 0, y: 0 }, down: () => false, hit: () => false, clicked: false, fireHeld: false, pad: null };
/** An AuthoredMode on plain records; `lines` collects what it writes as the objective. */
function mode(spec, lines = []) {
  const actor = () => ({ root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'billboard' });
  const world = { scene: new THREE.Group(), flash() {}, particles: { emit() {} }, input: idle,
    rig: { yaw: 0, pitch: .25, shake() {}, forward: () => new THREE.Vector3(0, 0, -1), right: () => new THREE.Vector3(1, 0, 0) },
    makeActor: async () => actor() };
  const hud = { popup() {}, say() {}, float() {}, notice() {}, objective: (text) => lines.push(text), status() {}, health() {},
    dash() {}, crosshair() {}, end() {} };
  const m = new AuthoredMode(world, spec, hud, actor());
  m.player = { pos: new THREE.Vector3(spec.world.spawn.x, 0, spec.world.spawn.z), vel: new THREE.Vector3(), dashCooldown: 0 };
  return m;
}
/** Every stage's goal met in turn, the way update() runs it: director.update → completeStage. `finish`: false leaves the
 * director done without the mode's own end (a race lost on place ends it as a loss, race.js raceVerdict). */
function clearStages(m, finish = true) {
  m.activateStage();
  for (const stage of m.spec.mission.stages) {
    if (stage.type !== 'survive') m.director.progress = stage.target; // a survive stage counts its own clock
    const done = m.director.update(stage.type === 'survive' ? stage.target : .016);
    if (finish) m.completeStage(done);
  }
  assert.equal(m.director.completed, true);
}

// --- the objective line on the end screen ---------------------------------------------------------------------------

test('a cleared mission shows its success text alone: no "(0/0)" and no time left over (sky gm_494550db34)', () => {
  const lines = [];
  const m = mode(published('gm_8f1fc9a181'), lines); // a sky climb's mission
  Object.assign(m, { timeLimit: 180, elapsed: 8.2 }); // a round with a limit still running when it is cleared
  clearStages(m);
  m.refreshHud();
  assert.equal(m.phase, 'won');
  assert.equal(lines.at(-1), '카이로가 하늘섬 꼭대기에서 태양 나침반을 찾았습니다!'); // no '(0/0)', no time left
});

test('a cleared survive mission too (gm_9539d06a71: "1/1 · 30초를 버텨냈다. … (0/0)")', () => {
  const lines = [];
  const m = mode(published('gm_9539d06a71'), lines);
  clearStages(m);
  m.refreshHud();
  assert.equal(m.phase, 'won');
  assert.equal(lines.at(-1), '30초를 버텨냈다. 카이로는 태양 나침반의 빛과 함께 협곡 유적을 빠져나간다.');
});

test('a loss keeps its own line: the stage and its count when time ran out, the failure text when there is one', () => {
  const lines = [];
  const m = mode(published('gm_8f1fc9a181'), lines);
  m.activateStage();
  Object.assign(m, { timeLimit: 60, elapsed: 60 });
  m.director.progress = 2;
  m.end(false); m.refreshHud();
  assert.equal(lines.at(-1), '1/2 · 섬을 차례로 뛰어 올라 수정 6개를 모은다 (2/6) · 0초');
  m.failure = '카이로: 선택한 GLB를 불러오지 못했습니다.'; m.refreshHud();
  assert.equal(lines.at(-1), m.failure);
  // a race finished out of place: every stage is done, yet the round is lost and says why, not the success text
  const raced = [];
  const r = mode(published('gm_8f1fc9a181'), raced);
  clearStages(r, false);
  r.failure = '3위로 완주 — 1위 안에 들어야 클리어';
  r.end(false); r.refreshHud();
  assert.equal(raced.at(-1), r.failure);
});

// --- the built-in player's round cap --------------------------------------------------------------------------------
// runtime3d.js needs a browser, so its own lines are run here on a mode: what build() does to a new round's mode under
// ?autoplay=1, and what window.ipverseRoundEndsIn then tells the play window (the pre-cue).
const runtime = readFileSync(new URL('../runtime3d.js', import.meta.url), 'utf8');
const AUTOPLAY_ROUND_SEC = Number(runtime.match(/const AUTOPLAY_ROUND_SEC = (\d+);/)[1]);
function sliceOf(from, to) {
  const start = runtime.indexOf(from), end = runtime.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return runtime.slice(start, end);
}
/** build(): the round's limits for the mode `next`. → the built-in player's cap the runtime keeps for the round (s) */
function roundLimits(spec, next, { autoplay = true, playableSec = 0 } = {}) {
  const lines = sliceOf('const surviveSec =', '    ended = false;\n    mode = next;');
  return new Function('spec', 'next', 'autoplay', 'playableSec', 'AUTOPLAY_ROUND_SEC', `let botCap = 0;\n${lines}\nreturn botCap;`)(
    spec, next, autoplay, playableSec, AUTOPLAY_ROUND_SEC);
}
/** window.ipverseRoundEndsIn() for the mode being played. */
function roundEndsIn(spec, mode, botCap) {
  const lines = sliceOf('window.ipverseRoundEndsIn = () => {', '\n  };\n');
  return new Function('window', 'spec', 'mode', 'ended', 'botCap', `${lines}\n};\nreturn window.ipverseRoundEndsIn();`)({}, spec, mode, false, botCap);
}
/** A round `seconds` in, as update() leaves it: both clocks and the HUD line. */
function playFor(m, seconds) {
  m.phase = 'playing';
  m.elapsed += seconds;
  m.director.update(seconds, { position: m.player.pos, targets: [] });
  m.refreshHud();
}

test("autoplay: the HUD shows the game's own clock, not the built-in player's round cap (survival gm_9539d06a71)", () => {
  const spec = published('gm_9539d06a71'), lines = [];
  const m = mode(spec, lines);
  m.activateStage();
  const cap = roundLimits(spec, m);
  playFor(m, 17.32);
  assert.equal(lines.at(-1), '1/1 · 사구 전갈의 습격을 30초 동안 버텨라 (17/30)'); // no cap counted down after it
  assert.equal(m.timeLimit, 0, 'the design sets no time limit, and the mode has none');
  assert.equal(cap, AUTOPLAY_ROUND_SEC, 'the cap stays with the runtime (the round ends at 30 s, long before it)');
});

test('autoplay: the cap is kept for the round: 180 s, or twice the survive seconds of a longer mission', () => {
  const sky = published('gm_8f1fc9a181'), lines = [];
  const m = mode(sky, lines);
  m.activateStage();
  assert.equal(roundLimits(sky, m), AUTOPLAY_ROUND_SEC);
  playFor(m, 8.2);
  assert.equal(lines.at(-1), '1/2 · 섬을 차례로 뛰어 올라 수정 6개를 모은다 (0/6)'); // no cap counted down after it
  // waves of 30, 40 and 50 s with supply runs between them
  const waves = published('gm_e0ebd94446'), w = mode(waves);
  assert.equal(roundLimits(waves, w), 240);
  assert.equal(w.timeLimit, 0);
  // not the built-in player: no cap at all
  assert.equal(roundLimits(sky, mode(sky), { autoplay: false }), 0);
  // a v1 survive round ends by its own clock, and a mode without a round clock (v1 RPG) by interval time
  assert.equal(roundLimits({ objective: { type: 'survive' } }, { timeLimit: 0 }), 0);
  assert.equal(roundLimits({ objective: { type: 'kills' } }, {}), 0);
});

test('a real limit still counts down in the HUD, and takes the place of the cap: the design\'s, a playable ad\'s', () => {
  const spec = published('gm_9539d06a71'), lines = [];
  const designed = mode({ ...spec, rules: { ...spec.rules, timeLimitSec: 90 } }, lines);
  designed.activateStage();
  assert.equal(roundLimits(spec, designed), 0);
  playFor(designed, 17.32);
  assert.equal(lines.at(-1), '1/1 · 사구 전갈의 습격을 30초 동안 버텨라 (17/30) · 73초');
  const ad = mode(spec, lines);
  ad.activateStage();
  assert.equal(roundLimits(spec, ad, { autoplay: false, playableSec: 90 }), 0);
  playFor(ad, 17.32);
  assert.equal(lines.at(-1), '1/1 · 사구 전갈의 습격을 30초 동안 버텨라 (17/30) · 73초');
  assert.equal(roundLimits(spec, mode(spec), { playableSec: 90 }), 0, 'an ad session played by the bot: the ad\'s limit only');
});

test('autoplay: the cap still feeds the pre-cue and still ends the round as a timeout', () => {
  // a reach / collect round: the play window hears how long the round can still run
  const sky = published('gm_8f1fc9a181'), m = mode(sky);
  m.activateStage();
  const cap = roundLimits(sky, m);
  playFor(m, 8.2);
  assert.ok(Math.abs(roundEndsIn(sky, m, cap) - (AUTOPLAY_ROUND_SEC - 8.2)) < 1e-9, `ends in ${roundEndsIn(sky, m, cap)}`);
  // a survive round: its own clock
  const survival = published('gm_9539d06a71'), s = mode(survival);
  s.activateStage();
  const survivalCap = roundLimits(survival, s);
  playFor(s, 17.32);
  assert.ok(Math.abs(roundEndsIn(survival, s, survivalCap) - 12.68) < 1e-9, `ends in ${roundEndsIn(survival, s, survivalCap)}`);
  // the design's limit comes first
  const designed = mode({ ...sky, rules: { timeLimitSec: 90 } });
  designed.activateStage();
  playFor(designed, 8.2);
  assert.ok(Math.abs(roundEndsIn(sky, designed, roundLimits(sky, designed)) - 81.8) < 1e-9);
  // the built-in player's loop ends the round at the cap, counted as a timeout (hud.end reads `stalled`)
  assert.match(runtime, /if \(botCap && mode && !ended && mode\.elapsed >= botCap\) stop\(BOT_END\.cap\);/);
  assert.match(runtime, /const stop = \(why\) => \{ stalled = true; mode\.failure = why; mode\.end \? mode\.end\(false\) : hud\.end\(false\); /);
  assert.match(runtime, /const reason = won \? 'clear' : stalled \|\| /);
  // and the interval-time cap of a mode without a clock does not cut a longer one short
  assert.match(runtime, /if \(played > AUTOPLAY_ROUND_SEC && !\(mode\.timeLimit > 0\) && !botCap\)/);
});

// --- the hero behind the briefing -----------------------------------------------------------------------------------

test("behind the briefing (phase ready) the rigged hero idles facing its way, not in the rig's bind pose", () => {
  const kairo = published('gm_8f1fc9a181'), ticks = [];
  const actor = { root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'rigged',
    animator: { update: (dt, state) => ticks.push(state) } }; // anim.js Animator
  const world = { scene: new THREE.Group(), particles: { emit() {} }, input: { hit: () => false, clicked: false, pad: null },
    rig: { yaw: 0, update() {} } };
  const m = new AuthoredMode(world, kairo, { notice() {} }, actor);
  m.player = new PlayerController(world, actor, { groundAt: () => 0 });
  m.player.place(kairo.world.spawn.x, kairo.world.spawn.z);
  m.player.yaw = Math.PI; // build(): its back to the camera
  m.update(1 / 60); m.update(1 / 60); // two frames with the briefing up: nobody pressed 임무 시작
  assert.equal(m.phase, 'ready');
  assert.equal(m.elapsed, 0, 'the round has not started');
  assert.equal(ticks.length, 2, 'the animator never ticked: the rig stood in its bind pose (arms out)');
  assert.ok(ticks.every((t) => t.speed === 0 && t.grounded === true), 'standing still');
  assert.equal(actor.root.rotation.y, Math.PI, 'and it faces the way the round starts');
  assert.deepEqual(actor.root.position.toArray(), [kairo.world.spawn.x, 0, kairo.world.spawn.z]);
});

test('a new Animator poses its rig at once: idle at full weight before anything ticks it', () => {
  const pair = (name) => ({ upper: { name: `${name}.upper` }, lower: { name: `${name}.lower` }, duration: 2 });
  const bound = { parts: { idle: pair('idle'), walk: pair('walk'), jump: pair('jump'), fall: pair('fall') }, bones: new Map(),
    loco: [{ role: 'walk', speed: 1.5, offset: 0, cycle: 3 }] };
  const animator = new Animator(new THREE.Group(), bound); // world.js makeActor: nothing has ticked it yet
  const posed = animator.mixer.updates; // each mixer update: the weight of every playing action as it wrote the bones
  assert.equal(posed.length, 1, 'no pose was written: the rig stood in its bind pose until its first update');
  assert.deepEqual(Object.keys(posed[0]).sort(), ['fall', 'idle', 'jump', 'walk'].flatMap((n) => [`${n}.lower`, `${n}.upper`]));
  for (const [name, weight] of Object.entries(posed[0])) assert.ok(weight === (name.startsWith('idle') ? 1 : 0), `${name} ${weight}`);
  // the first real tick goes on from there: still idle, nothing fired by the construction
  animator.update(1 / 60, { speed: 0 });
  assert.equal(posed.length, 2);
  assert.ok(posed[1]['idle.upper'] === 1 && posed[1]['walk.lower'] === 0);
  assert.equal(animator.oneShots.length, 0);
});

// --- a dropped rig and its raw mesh ---------------------------------------------------------------------------------
const bone = (name, at = [0, 0, 0]) => ({ name, isBone: true, getWorldPosition: (v) => v.set(...at) });
/** A UAL rig's scene as brokenRig reads it: the bones isUalRig asks for and two straight legs of `left` and `right` m. */
function rigScene(left, right) {
  const nodes = [bone('pelvis'), bone('spine_01'), bone('hand_r'),
    ...[['l', left, .1], ['r', right, -.1]].flatMap(([side, length, x]) => [bone(`thigh_${side}`, [x, length, 0]),
      bone(`calf_${side}`, [x, length / 2, 0]), bone(`foot_${side}`, [x, 0, 0])])];
  return { updateMatrixWorld() {}, traverse: (visit) => nodes.forEach(visit) };
}
/** World.makeActor for a skeleton king as the boss (authored.js spawnEnemy: 3.4 m in an ARPG), with the game
 * folder's files given as {url: model}. → {actor, asked: the GLBs it requested, warned} */
async function makeKing(folder) {
  const king = published('gm_b870737b47').enemies[2], asked = [], warned = [];
  const world = { anims: null, bindCache: new Map(),
    loadModel: async (url) => { asked.push(url); return folder[url] ?? null; }, // null: world.js loadModel on an HTTP 403
    loadCutout: async () => ({ texture: {}, aspect: 4.443 / 3.4, cut: false }) };
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try { return { actor: await World.prototype.makeActor.call(world, king, 3.4, () => new THREE.Group()), asked, warned, king }; }
  finally { console.warn = warn; }
}
const KING_RIG = { scene: rigScene(1.19, .807), clips: [] }; // legs 0.322 apart in length, against the 0.12 limit
const rawMesh = () => ({ scene: Object.assign(new THREE.Group(), { size: [1.9, 2.4, 1.1], updateMatrixWorld() {},
  traverse(visit) { visit(this); } }), clips: [] });

test('a rig dropped for uneven legs asks the game folder for the raw mesh next to it; without it the cutout stands', async () => {
  assert.ok(legImbalance({ thigh_l: [.1, 1.19, 0], calf_l: [.1, .595, 0], foot_l: [.1, 0, 0],
    thigh_r: [-.1, .807, 0], calf_r: [-.1, .4035, 0], foot_r: [-.1, 0, 0] }) > LEG_IMBALANCE_MAX);
  // a game folder without the raw mesh next to the rig
  const { actor, asked, warned, king } = await makeKing({ 'assets/ip_db7535d83e.rig.glb': KING_RIG });
  assert.equal(king.modelUrl, 'assets/ip_db7535d83e.rig.glb');
  assert.deepEqual(asked, ['assets/ip_db7535d83e.rig.glb', 'assets/ip_db7535d83e.glb']);
  assert.match(warned[0], /rig with uneven legs, using the raw mesh assets\/ip_db7535d83e\.rig\.glb/);
  assert.deepEqual([actor.kind, actor.rigDropped, actor.animator], ['billboard', true, null]);
  const plane = actor.billboard.geometry.parameters; // the flat picture: 4.4 m wide, 3.4 m tall
  assert.ok(Math.abs(plane.width - 4.443) < 1e-9 && plane.height === 3.4, `${plane.width} x ${plane.height}`);
});

test('with the raw mesh in the folder the dropped rig is its 3D mesh, and it hops when it walks', async () => {
  const { actor, asked } = await makeKing({ 'assets/ip_db7535d83e.rig.glb': KING_RIG, 'assets/ip_db7535d83e.glb': rawMesh() });
  assert.deepEqual(asked, ['assets/ip_db7535d83e.rig.glb', 'assets/ip_db7535d83e.glb']);
  assert.deepEqual([actor.kind, actor.rigDropped, actor.animator, actor.billboard], ['model', true, null, null]);
  const mesh = actor.body.children[0];
  assert.ok(Math.abs(mesh.scale.y * 2.4 - 3.4) < 1e-9, 'stood 3.4 m tall');
  let phase = 0, top = 0;
  for (let t = 0; t < 1; t += 1 / 60) { // authored.js updateEnemies: no animator, so animateBody moves it
    animateBody(actor, 1 / 60, { speed01: 1, phase: phase += 11 / 60 });
    top = Math.max(top, actor.body.position.y);
    assert.deepEqual(actor.body.scale.toArray(), [1, 1, 1]);
  }
  assert.ok(top > STATIC_GAIT.hop * (3.4 / 1.8) * .9, `hop ${top}`);
});
