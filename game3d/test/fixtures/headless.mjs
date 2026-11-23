// Rounds without a browser. A mode's build() needs three.js (the page loads it from the CDN through its import map;
// it is not in the repo) and WebGL, so Node cannot run createTrack or createCity. Everything that decides how a round
// goes does run here as it stands: the mode's constructor on a stored spec, its update(), the car physics, the mission
// director, world.js's Input fed by key events, and the built-in player of ?autoplay=1, whose loop is read out of
// runtime3d.js. Only what build() draws is left out: trackMode and cityMode set up the records it would leave behind
// (the gates, the road's centre line, the colliders, the cars).
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { roadPoints } from './track-road.mjs';

const stub = new URL('./three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
// the page's globals the runtime touches: key events on the window, the goal arrow's node, the viewport
const bus = new EventTarget();
Object.assign(globalThis, { window: globalThis, innerWidth: 1600, innerHeight: 1000,
  addEventListener: (...args) => bus.addEventListener(...args), removeEventListener: (...args) => bus.removeEventListener(...args),
  dispatchEvent: (event) => bus.dispatchEvent(event),
  KeyboardEvent: class extends Event { constructor(type, init = {}) { super(type, init); this.code = init.code; } },
  HTMLButtonElement: class {}, HTMLInputElement: class {},
  document: { getElementById: () => ({ append() {} }), createElement: () => {
    const node = { style: {}, hidden: false, setAttribute() {}, remove() {} };
    Object.defineProperty(node, 'innerHTML', { set() { node.firstChild = { style: {}, textContent: '' }; } });
    return node;
  } } });
globalThis.matchMedia ??= () => ({ matches: false });

export const THREE = await import(stub);
export const { AuthoredMode } = await import('../../authored.js');
export const { TrackMode } = await import('../../track.js');
export const { CityMode } = await import('../../city.js');
export const { validateSpec } = await import('../../gamespec3d.js');
const { Input, PlayerController } = await import('../../world.js');
const { VehicleController } = await import('../../city-controller.js');
const { roundWatch } = await import('../../arpg-data.js');

export const RUNTIME = readFileSync(new URL('../../runtime3d.js', import.meta.url), 'utf8');
/** A stored spec (fixtures/<id>.spec.json: a game's spec.json as it is served), through the runtime's own validator. */
export function published(id) {
  const { ok, errors, spec } = validateSpec(JSON.parse(readFileSync(new URL(`./${id}.spec.json`, import.meta.url))));
  if (!ok) throw new Error(`${id}: ${errors.join('; ')}`);
  return spec;
}

// ---- the built-in player, as runtime3d.js runs it ----

// its loop: the body of `if (autoplay) { … }` in boot(), up to the block's closing brace at boot()'s indent
const LOOP = /\n  if \(autoplay\) \{\n([\s\S]*?)\n  \}\n/.exec(RUNTIME)?.[1];
const ROUND_SEC = Number(/const AUTOPLAY_ROUND_SEC = (\d+);/.exec(RUNTIME)?.[1]);
if (!LOOP || !/setInterval\(\(\) => \{/.test(LOOP) || !ROUND_SEC) throw new Error('runtime3d.js: the built-in player\'s loop is not where fixtures/headless.mjs reads it');
/** The loop's interval callback, bound to `round` ({mode, ended, stalled, botCap, hud, start()}) for the names boot()
 * keeps in its closure; every other name is the page's global. */
function builtInPlayer(round) {
  let tick = null;
  const own = { autoplay: true, startReady: true, building: null, roundWatch, AUTOPLAY_ROUND_SEC: ROUND_SEC,
    briefingStart: { onclick: () => round.start() }, setInterval: (fn) => { tick = fn; } };
  const scope = new Proxy(own, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in round ? round[k] : k in t ? t[k] : globalThis[k]),
    set: (t, k, v) => { (k in round ? round : t)[k] = v; return true; },
  });
  new Function('scope', `with (scope) {\n${LOOP}\n}`)(scope);
  return tick;
}

/** One round of `mode` under the built-in player, as boot() runs it: Enter on the briefing, then every frame the mode's
 * update() and the input's endFrame(), and the built-in player's loop every 80 ms. hud.end is runtime3d.js's.
 * `each(mode, seconds)` is called after every frame; the round is left when it returns true.
 * → {seconds, won, reason: clear | death | timeout | null (left while playing), stalled: the built-in player's watchdog
 * or cap ended it, failure, objective: the HUD's last objective line, mission: the director's snapshot} */
export function playRound(mode, options = {}) {
  const frames = roundFrames(mode, options);
  for (let step = frames.next(); ; step = frames.next()) if (step.done) return step.value;
}
/** The same round for a game that fights: an enemy's actor is made by a promise (authored.js spawnEnemy awaits the
 * world's makeActor), which only lands between frames, as on the page. `mode`: fightMode's. → a promise for playRound's
 * record */
export async function playFight(mode, options = {}) {
  const frames = roundFrames(mode, options);
  for (let step = frames.next(); ; step = frames.next()) {
    if (step.done) return step.value;
    await null; await null; await null; // makeActor, spawnEnemy's own steps, the spawn's finally
  }
}
function* roundFrames(mode, { seconds = 600, fps = 30, each = null } = {}) {
  const { spec } = mode, input = mode.world.input;
  // boot()'s cap for a round with no time limit of its own (runtime3d.js build())
  const surviveSec = spec.mission.stages.reduce((n, s) => n + (s.type === 'survive' ? s.target : 0), 0);
  const round = { mode, ended: false, stalled: false, won: null, reason: null, hud: mode.hud,
    botCap: !mode.timeLimit && (spec.objective.type !== 'survive' || surviveSec > 0) ? Math.max(ROUND_SEC, surviveSec * 2) : 0,
    start: () => { if (mode.phase === 'ready') { dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter' })); } } };
  mode.hud.end = (won) => {
    if (round.ended) return;
    Object.assign(round, { ended: true, won, reason: won ? 'clear' : round.stalled || (mode.timeLimit > 0 && mode.elapsed >= mode.timeLimit) ? 'timeout' : 'death' });
  };
  const tick = builtInPlayer(round), dt = 1 / fps;
  let t = 0, since = 0;
  round.start();
  for (; t < seconds && !round.ended; t += dt) {
    for (since += dt; since >= .08; since -= .08) tick();
    mode.update(dt);
    input.endFrame();
    if (each?.(mode, t) === true) break;
    yield;
  }
  input.dispose();
  return { seconds: +t.toFixed(1), won: round.won, reason: round.reason, stalled: round.stalled, failure: mode.failure ?? null,
    objective: mode.hud.lines.at(-1) ?? null, mission: mode.director.snapshot() };
}

// ---- a mode as build() leaves it, without the scene ----

const CAR = { length: 4.6, width: 2.03 }; // a generated car body (race.js carBody fits its long side to 4.6 m)
const KIT = { length: 3.4, width: 1.9 }; // a kit car (race.js carSize of the city kit's sedan)
/** A solid entity's collider as authored.js buildEntity leaves it in mode.boxes: its box turned by its rotation (a kit
 * rock's and a set piece's at 80 %). */
function solidBox({ kind, x, z, y = 0, width: w = 2, depth: d = 2, height: h = 2, rotation: r = 0 }) {
  const k = ['spire', 'crystal', 'model'].includes(kind) ? .8 : 1, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const hx = (c * w + s * d) * k / 2, hz = (s * w + c * d) * k / 2;
  return { min: new THREE.Vector3(x - hx, y, z - hz), max: new THREE.Vector3(x + hx, y + h, z + hz) };
}
/** The mode's constructor on the spec, with a world that draws nothing: world.js's Input on the page's key events, a
 * camera rig that only keeps its yaw, a HUD that keeps the objective lines. `autoplay` is the page's ?autoplay=1. */
function shell(Mode, spec, autoplay) {
  const lines = [];
  const hud = { lines, popup() {}, say() {}, float() {}, notice() {}, objective: (text) => lines.push(text), status() {}, health() {},
    dash() {}, crosshair() {}, end() {} };
  const rig = { yaw: 0, pitch: .25, update() {}, shake() {},
    forward: () => new THREE.Vector3(-Math.sin(rig.yaw), 0, -Math.cos(rig.yaw)), right: () => new THREE.Vector3(Math.cos(rig.yaw), 0, -Math.sin(rig.yaw)) };
  const world = { scene: new THREE.Group(), input: new Input({ addEventListener() {}, removeEventListener() {} }), rig, flash() {},
    particles: { emit() {}, clear() {} }, camera: { position: new THREE.Vector3() } };
  globalThis.location = { search: autoplay ? '?autoplay=1' : '' };
  world.input.botOnly = autoplay; // (boot(): under the built-in player a person's keys are not the hero's)
  const mode = new Mode(world, spec, hud, { root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'model' });
  mode.setPieces = new Map(); // no car model in the cast: kit cars, whose groups carry their size
  mode.makeCarGroup = () => ({ position: new THREE.Vector3(), rotation: new THREE.Vector3(), userData: { size: KIT } });
  return mode;
}
/** buildEntity for every entity of the spec: a beacon is a target, a solid a collider (where a road's clearRoad put it;
 * left out when it found no room), a car body is no set piece. */
function entities(mode) {
  for (const e of mode.spec.world.entities) {
    const spot = mode.roadside?.get(e.id);
    if (spot === null || (e.kind === 'model' && e.car)) continue;
    const at = { ...e, ...spot }, solid = e.kind === 'platform' || (e.solid ?? !['beacon', 'hazard'].includes(e.kind));
    if (e.kind === 'beacon') mode.targets.push({ id: e.id, x: e.x, z: e.z, y: e.y ?? 0, radius: Math.max((e.width ?? 2) / 2, mode.mechanics.interactRadius) });
    else if (solid) mode.boxes.push(solidBox(at));
    mode.entities.set(e.id, { ...at, group: new THREE.Group(), solid, width: e.width ?? 2, depth: e.depth ?? 2, height: e.height ?? 2 });
  }
}

/** An AuthoredMode on a stored spec as far as build() goes without the scene: its beacons as targets, its solids as
 * colliders, the hero on foot at the spawn, the first stage on. Its props and enemies need their models: none here. */
export function authoredMode(spec, { autoplay = true } = {}) {
  const mode = shell(AuthoredMode, spec, autoplay), { width, depth, spawn } = spec.world;
  entities(mode);
  mode.player = new PlayerController(mode.world, mode.actor, { speed: spec.player.speed, mechanics: mode.mechanics,
    groundAt: (x, z, y = 0) => mode.groundAt(x, z, y), collide: (p, r) => mode.collide(p, r),
    bounds: { minX: -width / 2 + .6, maxX: width / 2 - .6, minZ: -depth / 2 + .6, maxZ: depth / 2 - .6 } });
  mode.player.place(spawn.x, spawn.z);
  mode.activateStage();
  return mode;
}

/** authoredMode for a game that fights: its enemies appear as the round asks for them (spawnEnemy), each a stand-in for
 * its model (a rigged actor with nothing to draw), and what a blow, a bolt and a death draw goes nowhere. */
export function fightMode(spec, options) {
  const mode = authoredMode(spec, options);
  mode.world.makeActor = async (data, height) => ({ root: new THREE.Group(), body: new THREE.Group(), height, kind: 'rigged',
    weapon: data.weaponUrl ? { type: 'ranged', muzzle: { getWorldPosition: (v) => v } } : undefined });
  for (const placement of spec.world.propPlacements) { // build(): the props to pick up, where they lie
    const group = new THREE.Group();
    group.position.set(placement.x, mode.groundAt(placement.x, placement.z), placement.z);
    mode.pickups.push(mode.pickupFor(placement, group, new THREE.Group(), 'model', null));
  }
  for (const p of mode.pickups) p.group.visible = p.bonus || p.stage === mode.director.stage?.id; // (activateStage: the first stage's show)
  if (mode.arpg) { // arpg.js setup(), without its panel: the diagonal camera, a fifth more HP
    mode.arpg.yaw = mode.world.rig.yaw = Math.PI / 4;
    mode.maxHp = Math.round(mode.maxHp * 1.2); mode.hp = mode.maxHp;
  }
  return mode;
}

/** An AuthoredMode on a stored platformer or sky spec as build() leaves it for a climb. Besides authoredMode's colliders
 * and beacons: the platform tops are floors (the moving ones move and carry what stands on them), a beacon or a coin
 * over a platform stands on its top, the coins are there to touch and the props to pick up (stand-ins for their models,
 * each on the top it stands over), and the camera starts on the first goal. */
export function climbMode(spec, { autoplay = true } = {}) {
  const mode = shell(AuthoredMode, spec, autoplay), { width, depth, spawn } = spec.world;
  const tops = spec.world.entities.filter((e) => e.kind === 'platform');
  for (const e of spec.world.entities) if (e.kind === 'beacon' || e.pickup) { // build(): seated on the platform under it
    const under = tops.find((p) => Math.abs(e.x - p.x) <= (p.width ?? 2) / 2 && Math.abs(e.z - p.z) <= (p.depth ?? 2) / 2
      && (e.y ?? 0) >= (p.y ?? 0) - .05 && (e.y ?? 0) < (p.y ?? 0) + (p.height ?? 2));
    if (under) e.y = (under.y ?? 0) + (under.height ?? 2);
  }
  for (const e of spec.world.entities) { // buildEntity, without what it draws
    const solid = e.kind === 'platform' || (e.solid ?? !['beacon', 'hazard'].includes(e.kind));
    const w = e.width ?? 2, d = e.depth ?? 2, h = e.height ?? 2, own = [], group = new THREE.Group();
    group.position.set(e.x, e.y ?? 0, e.z);
    if (e.kind === 'beacon') mode.targets.push({ id: e.id, x: e.x, z: e.z, y: e.y ?? 0, radius: Math.max(w / 2, mode.mechanics.interactRadius) });
    else if (solid) {
      own.push(Object.assign(solidBox(e), { translate(v) { this.min.add(v); this.max.add(v); return this; } }));
      mode.boxes.push(own[0]);
      if (e.kind === 'platform') mode.walkable.push({ box: own[0] });
    }
    if (e.motion) mode.movers.push({ e, group, base: group.position.clone(), boxes: own, offset: new THREE.Vector3(), view: { translate() {} },
      period: e.motion.periodSec ?? 4, phase: mode.rnd() * Math.PI * 2 });
    if (e.pickup) mode.targets.push({ id: e.id, x: e.x, z: e.z, radius: Math.max(1.1, Math.max(w, d) / 2 + .5), pickup: true, group });
    mode.entities.set(e.id, { ...e, group, solid, width: w, depth: d, height: h });
  }
  for (const t of mode.targets) if (t.pickup) { const seat = mode.platformUnder(t.x, t.z, true); if (seat?.motion) t.rideId = seat.id; }
  mode.player = new PlayerController(mode.world, mode.actor, { speed: spec.player.speed, mechanics: mode.mechanics,
    groundAt: (x, z, y = 0) => mode.groundAt(x, z, y), collide: (p, r) => mode.collide(p, r),
    bounds: { minX: -width / 2 + .6, maxX: width / 2 - .6, minZ: -depth / 2 + .6, maxZ: depth / 2 - .6 } });
  mode.player.place(spawn.x, spawn.z);
  mode.player.yaw = Math.PI;
  for (const placement of spec.world.propPlacements) {
    const group = new THREE.Group(), seat = mode.platformUnder(placement.x, placement.z);
    group.position.set(placement.x, seat ? seat.y + seat.height : mode.groundAt(placement.x, placement.z), placement.z);
    mode.pickups.push(mode.pickupFor(placement, group, new THREE.Group(), 'model', seat));
  }
  mode.activateStage();
  mode.faceFirstGoal();
  return mode;
}

/** A TrackMode on a stored spec as TrackMode.build() leaves it: the road through the race's gates, the solid set pieces
 * off it, the player's car at the spawn, the race started (the grid, the gates, the rivals). */
export function trackMode(spec, { autoplay = true } = {}) {
  const mode = shell(TrackMode, spec, autoplay);
  const stage = spec.mission.stages.find((s) => s.type === 'race'), byId = new Map(spec.world.entities.map((e) => [e.id, e]));
  // buildRoad: the centre line through the gates, the asphalt and a 1.1 m curb each side
  mode.roadPoints = roadPoints(stage.entityIds.map((id) => [byId.get(id).x, byId.get(id).z]));
  mode.roadHalf = (mode.track.roadWidth ?? 14) / 2 + 1.1; mode.raceAside = mode.roadHalf + 3.5;
  mode.roadside = mode.clearRoad(spec.world.entities, spec.world);
  entities(mode);
  mode.raceSolids = mode.boxes.filter((b) => b.min.y < 1.2);
  const { spawn } = spec.world, adapters = mode.carAdapters();
  const group = { position: new THREE.Vector3(spawn.x, .06, spawn.z), rotation: new THREE.Vector3(), userData: { size: CAR } };
  const car = { id: 'player_car', group, adapters, customBody: true,
    controller: new VehicleController({ id: 'player_car', position: { x: spawn.x, z: spawn.z }, yaw: 0, ...CAR }, adapters) };
  mode.cars.push(car); mode.activeCar = car;
  mode.player = { pos: new THREE.Vector3(spawn.x, 0, spawn.z), vel: new THREE.Vector3(), dashCooldown: 0, grounded: true, animate() {},
    update: (dt, input, rig) => mode.drive(dt, input, rig) };
  mode.startRace(stage);
  mode.activateStage();
  return mode;
}

/** A CityMode on a stored spec as CityMode.build() leaves it: the buildings its cars and its walk grid keep off, the
 * gates and addresses, the people to talk to, its parked cars, the hero on foot at the spawn (in the car when the
 * first stage is a race). `stage` starts the mission at that stage instead of its first. */
export function cityMode(spec, { autoplay = true, stage = 0 } = {}) {
  const mode = shell(CityMode, spec, autoplay);
  const { width, depth, spawn, npc, city } = spec.world;
  for (const b of mode.plan.buildings) mode.spatial.insert({ minX: b.x - b.width / 2, maxX: b.x + b.width / 2, minZ: b.z - b.depth / 2, maxZ: b.z + b.depth / 2 });
  entities(mode);
  if (npc) mode.targets.push({ ...npc, radius: mode.mechanics.interactRadius });
  for (const p of city.pedestrians) mode.targets.push({ ...p, name: spec.props[p.propIndex].name, radius: mode.mechanics.interactRadius });
  Object.assign(mode, { carAsset: () => ({ id: 'kit' }), streetLights: [], sunOffset: new THREE.Vector3(),
    citySun: { position: new THREE.Vector3(), target: { position: new THREE.Vector3() } } });
  const walker = new PlayerController(mode.world, mode.actor, { speed: spec.player.speed, mechanics: mode.mechanics,
    collide: (p, r) => mode.collide(p, r), bounds: { minX: -width / 2 + .6, maxX: width / 2 - .6, minZ: -depth / 2 + .6, maxZ: depth / 2 - .6 } });
  walker.place(spawn.x, spawn.z);
  const walk = walker.update.bind(walker);
  mode.player = Object.assign(walker, { update: (dt, input, rig) => { // build(): E gets in and out, the car is driven, else the hero walks
    if (mode.phase === 'playing' && input.hit('KeyE')) mode.toggleCar();
    if (mode.activeCar) mode.drive(dt, input, rig); else walk(dt, input, rig);
  } });
  mode.director.index = stage;
  mode.activateStage();
  for (const v of city.vehicles) mode.addCar(v);
  if (mode.director.stage?.type === 'race') mode.startRace(mode.director.stage);
  return mode;
}
