import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// race.js (and track.js, for its park spots) load three.js through the page's import map. Here 'three' resolves to a
// stub: empty classes for module scope, the few Vector3 calls the grid makes, a gate mesh that takes a position, and
// MathUtils.clamp.
const stub = `data:text/javascript,${encodeURIComponent(`${['Color', 'Box3', 'GLTFLoader', 'DRACOLoader', 'clone',
  'EffectComposer', 'RenderPass', 'UnrealBloomPass', 'ShaderPass', 'OutputPass', 'TorusGeometry', 'Object3D', 'RoomEnvironment',
  'RoundedBoxGeometry', 'RGBELoader', 'GroundedSkybox'].map((name) => `export class ${name} {}`).join('\n')}
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  addScaledVector(v, s) { return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
  normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; return this.set(this.x / l, this.y / l, this.z / l); }
}
export class MeshStandardMaterial { constructor(o) { Object.assign(this, o); } }
export class Mesh { constructor(geometry, material) { Object.assign(this, { geometry, material, position: new Vector3(), rotation: {} }); } }
export const MathUtils = { clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)) };`)}`;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const { RaceMixin } = await import('../race.js');
const { TrackMode } = await import('../track.js');
const { VehicleController, carOverlap, footprint } = await import('../city-controller.js');
const { MissionDirector } = await import('../mission.js');
const { mulberry32 } = await import('../world.js');
const { Vector3 } = await import('three');
const { roadPoints } = await import('./fixtures/track-road.mjs');

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// the published races: checkpoints, spawn, road width and car sizes (carBody fits the Ray/Viper GLBs to 4.6 m; kit
// cars by kind)
const VIPER = { length: 4.6, width: 2.035 }, RAY = { length: 4.6, width: 2.011 }; // the Viper without its fused floor slab
const KIT = { sedan: { length: 3.24, width: 1.9 }, suv: { length: 3.43, width: 1.9 }, taxi: { length: 3.02, width: 1.65 },
  police: { length: 3.93, width: 1.9 }, delivery: { length: 3.25, width: 1.5 } };
// each race's solid set pieces as its spec places them: [id, kind, x, z, width, depth, height, rotation]
const NEW = { id: 'gm_67ddba1756', spawn: { x: -90, z: -194 }, width: 16, rival: () => VIPER, // seeded tops of the published game
  tops: [17.36, 18.684, 20.322, 17.484],
  cps: [[-60, -220], [100, -230], [220, -150], [230, -20], [140, 60], [170, 180], [40, 230], [-110, 170], [-220, 60], [-200, -100]],
  solids: [['grandstand1', 'box', -72, -172, 14, 4, 3, -.7], ['grandstand2', 'box', -56, -158, 14, 4, 4, -.7],
    ['rock1', 'spire', -170, -250, 8, 8, 12, 0], ['rock2', 'spire', 60, -275, 9, 9, 14, 0], ['rock3', 'spire', 272, -90, 8, 8, 11, 0],
    ['rock4', 'spire', 255, 120, 9, 9, 13, 0], ['rock5', 'spire', 110, 272, 8, 8, 12, 0], ['rock6', 'spire', -60, 275, 9, 9, 14, 0],
    ['rock7', 'spire', -262, 120, 8, 8, 11, 0], ['rock8', 'spire', -272, -40, 9, 9, 13, 0], ['rock9', 'spire', 20, -60, 8, 8, 10, 0],
    ['rock10', 'spire', -80, 40, 7, 7, 9, 0], ['rock11', 'spire', 80, -120, 8, 8, 11, 0]] };
const OLD_CPS = [[-60, -220], [120, -200], [230, -90], [150, 20], [240, 130], [110, 230], [-60, 170], [-130, 60], [-240, -20], [-200, -140]];
const OLD_SOLIDS = [['stand_start', 'building', -95, -255, 20, 8, 5, 0], ['rock1', 'spire', -250, -230, 14, 14, 16, 0],
  ['rock2', 'spire', 60, -280, 12, 12, 14, 0], ['rock3', 'spire', 280, -30, 16, 16, 18, 0], ['rock4', 'spire', 280, 200, 14, 14, 15, 0],
  ['rock5', 'spire', 200, 280, 12, 12, 13, 0], ['rock6', 'spire', 0, 270, 15, 15, 17, 0], ['rock7', 'spire', -150, 210, 13, 13, 14, 0],
  ['rock8', 'spire', -280, 110, 16, 16, 18, 0], ['rock9', 'spire', -290, -80, 14, 14, 16, 0], ['rock10', 'spire', 0, -20, 12, 12, 12, 0],
  ['rock11', 'spire', 60, 90, 14, 14, 14, 0]];
const KITS = { id: 'gm_029e2a1164', spawn: { x: -95, z: -200 }, width: 16, rival: (kind) => KIT[kind], cps: OLD_CPS, solids: OLD_SOLIDS };
const VIPERS = { id: 'gm_4d0beb5607', spawn: { x: -95, z: -200 }, width: 16, rival: () => VIPER, cps: OLD_CPS, solids: OLD_SOLIDS };
// the straights-and-hairpins circuit, its spawn 22 m off the road (the cp12→cp1 curve passes it by)
const HAIRPIN = { id: 'gm_05aa877fab', spawn: { x: -165, z: -228 }, width: 14, rival: () => VIPER, tops: [16.73, 20.2, 18.13, 17.94],
  cps: [[-120, -230], [40, -230], [190, -230], [270, -140], [200, -50], [60, -90], [-50, -10], [230, 200], [80, 245], [-100, 245],
    [-250, 170], [-270, -50]],
  solids: [['stand_a', 'box', -120, -205, 20, 6, 4, 0], ['stand_b', 'box', 40, -262, 20, 6, 4, 0], ['rock1', 'spire', -40, -160, 8, 8, 12, 0],
    ['rock2', 'spire', 150, 60, 9, 9, 14, 0], ['rock3', 'spire', -150, 60, 9, 9, 13, 0], ['rock4', 'spire', 0, 170, 8, 8, 12, 0],
    ['rock5', 'spire', -180, -100, 8, 8, 11, 0], ['rock6', 'spire', 290, 0, 10, 10, 15, 0], ['rock7', 'spire', -30, -285, 9, 9, 14, 0],
    ['rock8', 'spire', 235, -285, 9, 9, 13, 0]] };
// the S-bends circuit: its grandstand standA stands on the road 30-44 m before gate 1, where the grid stands (its
// spec placed the stands by its spawn, 28 m off the road)
const SNAKE = { id: 'gm_0894b6b98a', spawn: { x: -210, z: -232 }, width: 14, rival: () => VIPER,
  cps: [[-170, -230], [-60, -180], [60, -250], [190, -200], [255, -90], [140, -40], [250, 60], [170, 180], [50, 250], [-70, 160],
    [-200, 240], [-250, 0]],
  solids: [['standA', 'box', -200, -205, 16, 4, 3, 0], ['standB', 'box', -190, -262, 16, 4, 3, 0], ['rock1', 'spire', -110, -280, 6, 6, 8, 0],
    ['rock2', 'spire', 100, -290, 6, 6, 9, 0], ['rock3', 'spire', 285, -170, 6, 6, 8, 0], ['rock4', 'spire', 0, 0, 7, 7, 9, 0],
    ['rock5', 'spire', -80, 60, 6, 6, 8, 0], ['rock6', 'spire', 60, 80, 6, 6, 8, 0], ['rock7', 'spire', -150, -80, 6, 6, 8, 0],
    ['rock8', 'spire', -285, 100, 6, 6, 9, 0], ['rock9', 'spire', 280, 200, 6, 6, 8, 0]] };

/** Metres from a road's centre line (a smooth closed polyline): to the two segments at its nearest point. */
function offLine(line, p) {
  const m = line.length - 1;
  let k = 0, near = Infinity, best = Infinity;
  for (let i = 0; i < m; i++) { const d = (line[i].x - p.x) ** 2 + (line[i].z - p.z) ** 2; if (d < near) { near = d; k = i; } }
  for (const [a, b] of [[line[(k + m - 1) % m], line[k]], [line[k], line[k + 1]]]) {
    const dx = b.x - a.x, dz = b.z - a.z, t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz));
  }
  return best;
}
/** The point `metres` along a road's centre line past the point of it nearest `p` (its points are ~2 m apart). */
function ahead(line, p, metres) {
  const m = line.length - 1;
  let k = 0;
  for (let i = 1; i < m; i++) if (Math.hypot(line[i].x - p.x, line[i].z - p.z) < Math.hypot(line[k].x - p.x, line[k].z - p.z)) k = i;
  return line[(k + Math.round(metres / 2)) % m];
}

/** A solid set piece's collider as authored.js builds it (a kit rock's at 80 %, a box or a building whole), as an
 * axis-aligned box: what the cars (track.js) and the camera (world.js) test against. */
function solidBox({ id, kind, x, z, width: w, depth: d, height: h, rotation: r = 0 }) {
  const k = kind === 'spire' ? .8 : 1, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const hx = (c * w + s * d) * k / 2, hz = (s * w + c * d) * k / 2;
  return { id, min: { x: x - hx, y: 0, z: z - hz }, max: { x: x + hx, y: h, z: z + hz } };
}
/** How deep a car's footprint (a capsule, city-controller.js) sits in a solid box (<= 0: clear of it). */
function boxDepth(f, b) {
  let worst = -Infinity;
  for (let i = 0; i <= 16; i++) {
    const x = f.ax + (f.bx - f.ax) * i / 16, z = f.az + (f.bz - f.az) * i / 16;
    const dx = Math.max(b.min.x - x, 0, x - b.max.x), dz = Math.max(b.min.z - z, 0, z - b.max.z);
    worst = Math.max(worst, f.r - (dx || dz ? Math.hypot(dx, dz) : -Math.min(x - b.min.x, b.max.x - x, z - b.min.z, b.max.z - z)));
  }
  return worst;
}
/** The chase camera on the grid as CameraRig places it, behind the car along its heading: AuthoredMode's rig (6.2 m
 * back at pitch .25, looking at a point 1.5 m over the car) and startRace's car rig (10.5 m, .22, 1.8) alike. → the
 * first solid box on a ray from that point out to the camera, else null. A box there pulls the camera in to 1.2 m
 * and lifts it over the roof (world.js). */
function cameraBlock(mode) {
  const s = mode.activeCar.controller.stateSnapshot();
  for (const [distance, pitch, height] of [[6.2, .25, 1.5], [10.5, .22, 1.8]]) {
    const o = { x: s.position.x, y: height, z: s.position.z };
    const d = { x: Math.sin(s.yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(s.yaw) * Math.cos(pitch) };
    const hit = mode.solidBoxes.find((b) => {
      let t0 = 0, t1 = distance;
      for (const k of ['x', 'y', 'z']) {
        const a = (b.min[k] - o[k]) / d[k], c = (b.max[k] - o[k]) / d[k];
        t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
      }
      return t0 <= t1;
    });
    if (hit) return `${hit.id} (${distance} m rig)`;
  }
  return null;
}

/** A track race as TrackMode runs it: the real startRace grid, MissionDirector laps, raceFinish and updateRace. With
 * `road` the track's road too, as track.js lays it (roadPoints through the checkpoints, curbs 1.1 m wide); with
 * `solids` its solid set pieces as well (kept off the road by clearRoad), colliding with the player's car and
 * handed to the rivals (raceSolids), who park where track.js's parkSpot puts them. */
function raceMode(track, { seed = 1, tops = track.tops, spawn = track.spawn, rivals = 4, laps = 2, road = false, solids = false } = {}) {
  const stage = { id: 'race', type: 'race', target: laps, entityIds: track.cps.map((_, i) => `cp${i + 1}`), rivals, finishRank: 3 };
  const targets = track.cps.map(([x, z], i) => ({ id: `cp${i + 1}`, x, z }));
  const position = new Vector3(spawn.x, .06, spawn.z);
  const car = { id: 'player_car', group: { position, rotation: { y: 0 }, userData: { size: RAY } }, adapters: {} };
  const draw = mulberry32(seed);
  const roadHalf = (track.width ?? 16) / 2 + 1.1;
  let n = 0;
  const mode = Object.assign({ ...RaceMixin }, {
    cars: [car], activeCar: car, targets, director: new MissionDirector({ stages: [stage] }), phase: 'playing',
    rnd: () => (tops ? (tops[n++ % tops.length] - 16) / 5.5 : draw()), accent: '#ff7a1a', carEntities: [],
    root: { add() {}, remove() {} }, world: { rig: {} }, actor: { root: {} }, hud: { notice() {}, objective() {}, popup() {} },
    player: { pos: { x: spawn.x, z: spawn.z, clone: () => ({ setY: () => ({}) }) } }, raceAside: roadHalf + 3.5, end() {},
    makeCarGroup: (kind) => ({ position: { set() {} }, rotation: {}, userData: { size: track.rival(kind) } }),
    ...(road ? { roadPoints: roadPoints(track.cps), roadHalf } : {}),
  });
  if (solids) {
    const world = { width: 600, depth: 600 }, entities = track.solids.map(([id, kind, x, z, width, depth, height, rotation]) =>
      ({ id, kind, x, z, width, depth, height, rotation }));
    mode.placed = mode.clearRoad(entities, world);
    mode.solidBoxes = entities.filter((e) => mode.placed.get(e.id) !== null).map((e) => solidBox({ ...e, ...mode.placed.get(e.id) }));
    mode.raceSolids = mode.solidBoxes; // every one stands on the ground
    car.adapters.collide = (p, radius) => mode.solidBoxes.some((b) => p.x > b.min.x - radius && p.x < b.max.x + radius
      && p.z > b.min.z - radius && p.z < b.max.z + radius && b.min.y < 1.2);
    Object.assign(mode, { spec: { world }, parkSpot: TrackMode.prototype.parkSpot });
  }
  car.adapters.cars = () => mode.rivalCars(); // as track.js: the player's car slides off the rivals
  car.controller = new VehicleController({ id: car.id, position: spawn, ...RAY }, car.adapters);
  mode.startRace(stage);
  return mode;
}

/** Run the race at `fps`: the player's car is parked on the grid (drive null) or follows the gates (on a road: the road)
 * at `throttle`, half of it off the asphalt as track.js gives it. → the rivals' finish times, their longest stop while
 * racing, and the player's longest stop with the throttle on; with `offRoad` also each rival's share of racing time
 * off the asphalt and farthest distance off the centre line; with solid set pieces how deep each rival ever sat in
 * one (<= 0: never in any). */
function run(mode, { seconds = 420, fps = 30, drive = null, offRoad = false } = {}) {
  const dt = 1 / fps, car = mode.activeCar, stops = new Map(mode.rivals.map((r) => [r.id, { now: 0, worst: 0, at: null }]));
  const me = { now: 0, worst: 0, contacts: 0, deepest: 0, finishedAt: null, speed: 0 };
  const line = mode.roadPoints, sand = (p) => !!line && offLine(line, p) > mode.roadHalf + 1;
  const off = new Map(mode.rivals.map((r) => [r.id, { racing: 0, sand: 0, worst: 0 }]));
  const solid = new Map(mode.rivals.map((r) => [r.id, { depth: -Infinity, at: null }]));
  let t = 0, turn = 0, frame = 0;
  for (; t < seconds && mode.phase === 'playing'; t += dt, frame++) {
    const racing = mode.director.stage?.type === 'race' ? mode.director.stage.id : null;
    const s0 = car.controller.stateSnapshot(), go = drive && racing && mode.raceHold <= 0;
    const aim = go && line ? ahead(line, s0.position, 12) : mode.raceRoute[mode.director.raceNext];
    const err = wrap(Math.atan2(-(aim.x - s0.position.x), -(aim.z - s0.position.z)) - s0.yaw);
    const sharp = Math.abs(err) > .6 && Math.abs(s0.speed) > 9; // lift for a sharp turn
    const grip = go && sand(s0.position) ? .5 : 1;
    const s = car.controller.step(dt, go ? { throttle: sharp ? 0 : (drive.throttle ?? 1) * grip, brake: Math.abs(err) > 1.2 && Math.abs(s0.speed) > 7,
      steer: clamp(-err * 3, -1, 1) } : {});
    me.speed = s.speed;
    const yaws = mode.rivals.map((r) => r.yaw);
    car.group.position.set(s.position.x, .06, s.position.z);
    Object.assign(mode.player.pos, { x: s.position.x, z: s.position.z });
    if (go) { me.now = Math.abs(s.speed) < .5 ? me.now + dt : 0; me.worst = Math.max(me.worst, me.now); }
    me.contacts += s.contacts.length ? 1 : 0;
    for (const r of mode.rivals) me.deepest = Math.max(me.deepest, carOverlap(footprint({ ...s.position, yaw: s.yaw, ...RAY }),
      footprint({ x: r.pos.x, z: r.pos.z, yaw: r.yaw, ...r.size })).depth);
    if (mode.director.update(dt, { position: mode.player.pos, targets: mode.targets, driving: true }) && mode.director.completed) {
      me.finishedAt = mode.raceClock; mode.phase = 'ended'; // TrackMode.end(true): the game is over
    }
    mode.raceFinish(racing);
    mode.updateRace(dt);
    mode.rivals.forEach((r, i) => {
      const stop = stops.get(r.id), on = racing && mode.raceHold <= 0 && !r.done;
      if (on && r.speed < .5) {
        stop.now += dt;
        if (stop.now > stop.worst) { stop.worst = stop.now; stop.at = { x: +r.pos.x.toFixed(1), z: +r.pos.z.toFixed(1), lap: r.lap, next: r.next }; }
      } else stop.now = 0;
      // the heading turns through an arc (at most max(1.2, speed / 6) rad/s; contact with the player's car takes 20 %
      // of the speed after the turn): the share of that limit used
      if (on) turn = Math.max(turn, Math.abs(wrap(r.yaw - yaws[i])) / dt / Math.max(1.2, r.speed / .8 / 6));
      if (on && offRoad && frame % 3 === 0) { // sampled at 10 Hz
        const o = off.get(r.id), d = offLine(line, r.pos);
        o.racing += 1; o.sand += d > mode.roadHalf + 1; o.worst = Math.max(o.worst, d);
      }
      for (const b of mode.solidBoxes ?? []) { // every frame, racing or not
        const depth = boxDepth(footprint({ x: r.pos.x, z: r.pos.z, yaw: r.yaw, ...r.size }), b), o = solid.get(r.id);
        if (depth > o.depth) Object.assign(o, { depth, at: { box: b.id, x: +r.pos.x.toFixed(1), z: +r.pos.z.toFixed(1), t: +t.toFixed(1) } });
      }
    });
    if (!drive && mode.rivals.every((r) => r.parked)) break;
  }
  return { t, me, turn, rivals: mode.rivals.map((r) => ({ id: r.id, top: +r.top.toFixed(2), lap: r.lap, next: r.next, done: r.done, parked: r.parked,
    finishedAt: r.finishedAt ?? null, stop: +stops.get(r.id).worst.toFixed(1), stopAt: stops.get(r.id).at })),
    offRoad: Object.fromEntries([...off].map(([id, o]) => [id, { share: o.racing ? o.sand / o.racing : 0, worst: +o.worst.toFixed(1) }])),
    solid: Object.fromEntries(solid) };
}
const show = (res) => JSON.stringify(res.rivals);

test('gm_67ddba1756: every rival races every gate to the finish and parks, with the player\'s car left on the grid', () => {
  const res = run(raceMode(NEW));
  for (const r of res.rivals) {
    assert.ok(r.finishedAt != null && r.finishedAt < 240, `${r.id} finished 2 laps: ${show(res)}`);
    assert.ok(r.parked, `${r.id} parked after the finish: ${show(res)}`);
    assert.ok(r.stop < 2, `${r.id} never stood still while racing: ${show(res)}`);
  }
});

test('gm_67ddba1756: rivals race on while the player drives, and the player is never held by a rival', () => {
  for (const throttle of [1, .45]) {
    const res = run(raceMode(NEW), { drive: { throttle } });
    assert.ok(res.me.finishedAt != null, `the player finished (throttle ${throttle})`);
    assert.ok(res.me.worst < 1, `the player was never held still: ${res.me.worst.toFixed(1)} s (throttle ${throttle})`);
    assert.ok(res.me.deepest < .3, `no rival drove into the player's car: ${res.me.deepest.toFixed(2)} m (throttle ${throttle})`);
    for (const r of res.rivals) assert.ok(r.stop < 2, `${r.id} never stood still while racing (throttle ${throttle}): ${show(res)}`);
    if (throttle < 1) assert.ok(res.rivals.some((r) => r.finishedAt != null && r.finishedAt < res.me.finishedAt),
      `a rival beat the slow player to the finish: ${show(res)}`);
  }
});

test('rivals never deadlock on any grid: many seeds and start positions, on the new and the old circuits', () => {
  for (const track of [NEW, KITS, VIPERS]) {
    for (let k = 0; k < 12; k++) {
      const jitter = mulberry32(100 + k), spawn = { x: track.spawn.x + (jitter() - .5) * 20, z: track.spawn.z + (jitter() - .5) * 20 };
      const res = run(raceMode(track, { seed: 11 + k * 7, tops: null, spawn }));
      const where = `${track.id} run ${k} grid (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})`;
      for (const r of res.rivals) {
        assert.ok(r.finishedAt != null && r.parked, `${where}: ${r.id} finished and parked: ${show(res)}`);
        assert.ok(r.stop < 2, `${where}: ${r.id} never stood still while racing: ${show(res)}`);
      }
    }
  }
});

test('the old circuits stay fixed: a rival that finishes first parks off the line, and the player behind is never held', () => {
  for (const track of [KITS, VIPERS]) {
    const mode = raceMode(track, { seed: 3, tops: [21.4, 21.2, 20.9, 20.6] });
    const res = run(mode, { drive: { throttle: .45 } });
    const first = res.rivals.filter((r) => r.finishedAt != null).sort((a, b) => a.finishedAt - b.finishedAt)[0];
    assert.ok(first && first.finishedAt < res.me.finishedAt, `${track.id}: a rival finished first: ${show(res)}`);
    assert.ok(res.me.worst < 1, `${track.id}: the player was never held still: ${res.me.worst.toFixed(1)} s`);
    const parked = mode.rivals.filter((r) => r.parked);
    assert.ok(parked.length, `${track.id}: the finished rival parked`);
    const [a, b] = [mode.raceRoute.at(-1), mode.raceRoute[0]], len = Math.hypot(b.x - a.x, b.z - a.z);
    for (const r of parked) { // off the finish straight the player drives down
      const off = Math.abs((r.pos.x - a.x) * (b.z - a.z) - (r.pos.z - a.z) * (b.x - a.x)) / len;
      assert.ok(off > 6, `${track.id}: ${r.id} parked ${off.toFixed(1)} m off the line`);
    }
  }
});

// ---- two ways rivals can deadlock, in isolation
const GATES = [[0, -60], [60, -120], [0, -180], [-60, -120]];
function abreast(gap, { player = null, road = false } = {}) {
  const track = { id: 'unit', spawn: player ?? { x: 0, z: 40 }, rival: () => VIPER, cps: GATES };
  const mode = raceMode(track, { tops: [18, 18], rivals: 2, laps: 1, road });
  mode.raceHold = 0;
  if (road) mode.activeCar.controller.position = { ...player }; // the grid put the player's car on the road
  // two rivals level with each other, `gap` m apart, 22 m before the first gate and heading for it
  mode.rivals.forEach((r, i) => {
    Object.assign(r.pos, { x: (i ? 1 : -1) * gap / 2, z: -38 });
    r.yaw = Math.atan2(-(0 - r.pos.x), -(-60 - r.pos.z)); r.speed = 12;
  });
  return mode;
}

test('two rivals abreast, closing on the same gate, never hold each other back', () => {
  for (const gap of [2.5, 2.6, 2.7, 3.2]) {
    const mode = abreast(gap, { player: { x: 300, z: 280 } }); // the player's car far away
    for (let i = 0; i < 30 * 4; i++) mode.driveRivals(1 / 30, { target: 1 });
    for (const r of mode.rivals) assert.ok(r.next >= 1, `gap ${gap}: ${r.id} passed the gate: ${JSON.stringify(mode.raceState().rivals)}`);
  }
});

test('a rival drives round a car stopped on its line (the player\'s or a parked rival) instead of waiting behind it', () => {
  // the player's car stands still on the line to the first gate, a rival comes up behind it
  const mode = raceMode({ id: 'unit', spawn: { x: 0, z: -30 }, rival: () => VIPER, cps: GATES }, { tops: [18], rivals: 1, laps: 1 });
  mode.raceHold = 0;
  const r = mode.rivals[0];
  Object.assign(r.pos, { x: 0, z: 0 }); r.yaw = 0; r.speed = 15;
  let deepest = 0;
  for (let i = 0; i < 30 * 6 && r.next === 0; i++) {
    mode.driveRivals(1 / 30, { target: 1 });
    deepest = Math.max(deepest, carOverlap(footprint({ x: 0, z: -30, yaw: 0, ...RAY }), footprint({ ...r.pos, yaw: r.yaw, ...r.size })).depth);
  }
  assert.ok(r.next >= 1, `went round the stopped car to the gate: ${JSON.stringify(mode.raceState().rivals)}`);
  assert.ok(deepest < .3, `never drove into it, ${deepest.toFixed(2)} m`);
  // a parked rival on the line is driven round the same way
  const two = abreast(8, { player: { x: 300, z: 280 } });
  const [parked, racer] = two.rivals;
  Object.assign(parked, { parked: true, done: true, speed: 0 }); Object.assign(parked.pos, { x: 0, z: -30 }); parked.yaw = 0;
  Object.assign(racer.pos, { x: 0, z: 0 }); racer.yaw = 0; racer.speed = 15;
  for (let i = 0; i < 30 * 6 && racer.next === 0; i++) two.driveRivals(1 / 30, { target: 1 });
  assert.ok(racer.next >= 1, `went round the parked rival: ${JSON.stringify(two.raceState().rivals)}`);
});

test('a rival passing a slow car that drifts across its way goes round the side left open, never back across it', () => {
  for (const drift of [-4, 4]) {
    // the player's car slides across the line to the gate, 25 m ahead of a rival closing at 15 m/s
    const spawn = { x: -1.2 * Math.sign(drift), z: -25 };
    const mode = raceMode({ id: 'unit', spawn, rival: () => VIPER, cps: GATES }, { tops: [18], rivals: 1, laps: 1 });
    mode.raceHold = 0;
    const r = mode.rivals[0], car = mode.activeCar.controller;
    Object.assign(r.pos, { x: 0, z: 0 }); r.yaw = 0; r.speed = 15;
    let deepest = 0, swing = 0;
    for (let i = 0; i < 30 * 6 && r.next === 0; i++) {
      car.position = { x: car.position.x + drift / 30, z: car.position.z }; car.speed = Math.abs(drift);
      mode.driveRivals(1 / 30, { target: 1 });
      swing = Math.max(swing, Math.abs(wrap(r.yaw - Math.atan2(r.pos.x, 60 + r.pos.z))));
      deepest = Math.max(deepest, carOverlap(footprint({ ...car.position, yaw: car.yaw, ...RAY }),
        footprint({ ...r.pos, yaw: r.yaw, ...r.size })).depth);
    }
    assert.ok(r.next >= 1, `drift ${drift}: reached the gate: ${JSON.stringify(mode.raceState().rivals)}`);
    assert.ok(swing < 1.2, `drift ${drift}: never turned back across it, swing ${swing.toFixed(2)} rad`);
    assert.ok(deepest < .3, `drift ${drift}: never drove into it, ${deepest.toFixed(2)} m`);
  }
});

// ---- the open track's road (track.js): the grid stands on it right behind the first gate, the rivals race on it
const TRACKS = [HAIRPIN, NEW, KITS, VIPERS];
function nearest(line, p) { // the index of the road point nearest p (the last point repeats the first)
  let k = 0;
  for (let i = 1; i < line.length - 1; i++) if (Math.hypot(line[i].x - p.x, line[i].z - p.z) < Math.hypot(line[k].x - p.x, line[k].z - p.z)) k = i;
  return k;
}
const alongRoad = (line, k) => { // the road's heading at point k, as a yaw (nose −Z)
  const m = line.length - 1, a = line[(k + m - 1) % m], b = line[(k + 1) % m];
  return Math.atan2(-(b.x - a.x), -(b.z - a.z));
};

test('every published track: the whole grid stands on the asphalt right behind the first gate, facing along the road', () => {
  for (const track of TRACKS) {
    const mode = raceMode(track, { road: true }), line = mode.roadPoints, m = line.length - 1, first = nearest(line, mode.raceRoute[0]);
    const s = mode.activeCar.controller.stateSnapshot();
    const cars = [{ id: 'player_car', x: s.position.x, z: s.position.z, yaw: s.yaw, ...RAY },
      ...mode.rivals.map((r) => ({ id: r.id, x: r.pos.x, z: r.pos.z, yaw: r.yaw, ...r.size }))];
    for (const c of cars) {
      const k = nearest(line, c), before = ((first - k + m) % m) * 2, off = offLine(line, c); // road points ~2 m apart
      const where = `${track.id} ${c.id} at (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`;
      assert.ok(off + c.width / 2 <= track.width / 2, `${where}: on the asphalt (${off.toFixed(1)} m off the centre line)`);
      assert.ok(before >= 12 && before <= 60, `${where}: right behind the first gate (${before} m before it along the road)`);
      assert.ok(Math.abs(wrap(c.yaw - alongRoad(line, k))) < .1, `${where}: faces along the road (${c.yaw.toFixed(2)} vs ${alongRoad(line, k).toFixed(2)})`);
    }
    cars.forEach((a, i) => cars.slice(i + 1).forEach((b) => assert.ok(carOverlap(footprint(a), footprint(b)).depth <= 0,
      `${track.id}: ${a.id} and ${b.id} stand clear of each other`)));
    assert.deepEqual([mode.player.pos.x, mode.player.pos.z], [s.position.x, s.position.z], `${track.id}: the player is in the car`);
  }
});

test('every published track: the player\'s car launches off the grid at full throttle, not at half throttle on the sand', () => {
  for (const track of TRACKS) {
    const res = run(raceMode(track, { road: true }), { seconds: 3 + 1.2, drive: { throttle: 1 } });
    assert.ok(res.me.speed > 7, `${track.id}: ${res.me.speed.toFixed(2)} m/s 1.2 s after GO`);
  }
});

test('every published track: rivals race on the road, off the asphalt under 2 % of their racing time and never far off it', () => {
  for (const track of TRACKS) for (const drive of [null, { throttle: 1 }]) {
    const mode = raceMode(track, { road: true }), res = run(mode, { drive, offRoad: true });
    const where = `${track.id} (${drive ? 'the player racing' : 'the player on the grid'})`;
    for (const r of res.rivals) {
      const o = res.offRoad[r.id];
      assert.ok(o.share < .02, `${where} ${r.id}: off the asphalt ${(o.share * 100).toFixed(1)} % of its racing time`);
      assert.ok(o.worst < mode.roadHalf + 2, `${where} ${r.id}: at most ${o.worst} m off the centre line`);
    }
    assert.ok(res.turn <= 1.001, `${where}: the rivals turn through arcs, never snap (${res.turn.toFixed(2)} of the turn limit)`);
    if (!drive) for (const r of res.rivals) assert.ok(r.finishedAt != null && r.parked && r.stop < 2, `${where}: ${r.id} raced to the finish and parked: ${show(res)}`);
    else assert.ok(res.me.finishedAt != null && res.me.worst < 1 && res.me.deepest < .3, `${where}: the player finished, never held or hit: ${JSON.stringify(res.me)}`);
  }
});

test('off the asphalt a rival gets half throttle as the player\'s car does: half the push and the same drop in top speed', () => {
  const rival = (sand) => { // one rival off the grid with all the ground taken for asphalt, then for sand
    const mode = raceMode(HAIRPIN, { road: true, rivals: 1, tops: [20] });
    mode.offRoad = () => sand; mode.raceHold = 0; mode.activeCar.controller.position = { x: 300, z: 280 };
    const r = mode.rivals[0];
    let at1 = 0, top = 0;
    for (let i = 1; i <= 30 * 15; i++) { mode.driveRivals(1 / 30, { target: 2 }); if (i === 30) at1 = r.speed; top = Math.max(top, r.speed); }
    return { at1, top };
  };
  const car = (throttle) => { // the player's car (city-controller.js) at full and half throttle, as track.js drives it
    const c = new VehicleController({ id: 'c', position: { x: 0, z: 0 }, ...RAY });
    let at1 = 0;
    for (let i = 1; i <= 30 * 30; i++) { c.step(1 / 30, { throttle }); if (i === 30) at1 = c.speed; }
    return { at1, top: c.speed };
  };
  const [road, sand, full, half] = [rival(false), rival(true), car(1), car(.5)];
  assert.ok(sand.at1 <= road.at1 * .55, `half the push: ${sand.at1.toFixed(2)} vs ${road.at1.toFixed(2)} m/s 1 s from a standstill (the player's car: ${half.at1.toFixed(2)} vs ${full.at1.toFixed(2)})`);
  assert.ok(Math.abs(sand.top / road.top - half.top / full.top) < .02,
    `the top speed drops as the player's car's does: ${sand.top.toFixed(2)} of ${road.top.toFixed(2)} vs ${half.top.toFixed(2)} of ${full.top.toFixed(2)} m/s`);
});

test('on the road a rival drives round the player\'s car stopped on it, staying on the asphalt', () => {
  const mode = raceMode(HAIRPIN, { road: true, rivals: 1, tops: [20] }), line = mode.roadPoints;
  mode.raceHold = 0;
  const k = nearest(line, { x: -60, z: -230 }), stopped = { x: line[k].x, z: line[k].z, yaw: alongRoad(line, k), ...RAY };
  mode.activeCar.controller = new VehicleController({ id: 'player_car', position: stopped, yaw: stopped.yaw, ...RAY }, mode.activeCar.adapters);
  const r = mode.rivals[0];
  let deepest = 0, worst = 0;
  for (let i = 0; i < 30 * 15 && r.pos.x < stopped.x + 20; i++) {
    mode.driveRivals(1 / 30, { target: 2 });
    deepest = Math.max(deepest, carOverlap(footprint(stopped), footprint({ ...r.pos, yaw: r.yaw, ...r.size })).depth);
    worst = Math.max(worst, offLine(line, r.pos));
  }
  assert.ok(r.pos.x >= stopped.x + 20, `got past it: ${JSON.stringify(mode.raceState().rivals)}`);
  assert.ok(deepest < .3, `never drove into it, ${deepest.toFixed(2)} m`);
  assert.ok(worst + r.size.width / 2 <= HAIRPIN.width / 2, `stayed on the asphalt going round it, ${worst.toFixed(1)} m off the centre line`);
});

test('on the road rivals drive round the player\'s car stopped across it, where its length blocks the way', () => {
  // spots where a parked car can pin rivals: its length across the road counts, not only its width
  for (const [track, at] of [[KITS, 240], [NEW, 390]]) {
    const mode = raceMode(track, { road: true, tops: NEW.tops }), line = mode.roadPoints, m = line.length - 1;
    const a = line[at - 1], b = line[at + 1], l = Math.hypot(b.x - a.x, b.z - a.z), fx = (b.x - a.x) / l, fz = (b.z - a.z) / l;
    const across = { x: line[at].x + fz * 3, z: line[at].z - fx * 3, yaw: alongRoad(line, at % m) + Math.PI / 2 }; // 3 m left of the line
    mode.activeCar.controller = new VehicleController({ id: 'player_car', position: across, yaw: across.yaw, ...RAY }, mode.activeCar.adapters);
    Object.assign(mode.player.pos, { x: across.x, z: across.z });
    const res = run(mode);
    for (const r of res.rivals) assert.ok(r.finishedAt != null && r.parked && r.stop < 2,
      `${track.id}: ${r.id} drove round it, finished and parked: ${show(res)}`);
  }
});

test('on the road rivals never deadlock either: many seeds, two abreast at a gate, on the new and the old circuits', () => {
  for (const track of TRACKS) for (let k = 0; k < 4; k++) {
    const res = run(raceMode(track, { road: true, seed: 11 + k * 7, tops: null }));
    for (const r of res.rivals) assert.ok(r.finishedAt != null && r.parked && r.stop < 2,
      `${track.id} seed ${11 + k * 7}: ${r.id} finished and parked, never standing still while racing: ${show(res)}`);
  }
  for (const gap of [2.5, 2.6, 2.7, 3.2]) { // only the one behind gives way
    const mode = abreast(gap, { player: { x: 300, z: 280 }, road: true });
    for (let i = 0; i < 30 * 4; i++) mode.driveRivals(1 / 30, { target: 1 });
    for (const r of mode.rivals) assert.ok(r.next >= 1, `gap ${gap}: ${r.id} passed the gate: ${JSON.stringify(mode.raceState().rivals)}`);
  }
});

// ---- solid set pieces on a race track: the road, the grid and the countdown camera stay clear of them, and the
// rivals never drive into one
const RACES = [SNAKE, ...TRACKS];
const boxGap = (b, p) => Math.hypot(Math.max(b.min.x - p.x, 0, p.x - b.max.x), Math.max(b.min.z - p.z, 0, p.z - b.max.z));

test('every published race keeps its road clear: no solid set piece within reach of a car on the asphalt or the curbs', () => {
  for (const track of RACES) {
    const mode = raceMode(track, { road: true, solids: true });
    for (const b of mode.solidBoxes) {
      const gap = Math.min(...mode.roadPoints.map((q) => boxGap(b, q)));
      // a car hits a box within its 2.25 m collision radius (city-controller.js), and it may drive out to the curbs' edge
      assert.ok(gap > mode.roadHalf + 2.25, `${track.id} ${b.id}: ${gap.toFixed(1)} m from the centre line (the curbs end at ${mode.roadHalf} m)`);
    }
    const moved = Object.fromEntries(mode.placed);
    if (track !== SNAKE) { assert.deepEqual(moved, {}, `${track.id}: nothing stood in the way, nothing moved`); continue; }
    assert.deepEqual(Object.keys(moved), ['standA'], `${track.id}: only the grandstand on the road moved: ${JSON.stringify(moved)}`);
    const shift = Math.hypot(moved.standA.x + 200, moved.standA.z + 205);
    assert.ok(shift < 20, `${track.id}: standA stays by the start, ${shift.toFixed(1)} m from where the spec put it`);
  }
});

test('every published race: the grid and the countdown camera stand clear of the solid set pieces', () => {
  for (const track of RACES) {
    const mode = raceMode(track, { road: true, solids: true }), s = mode.activeCar.controller.stateSnapshot();
    assert.ok(!mode.activeCar.adapters.collide(s.position, 2.25), `${track.id}: the player's car drives off the grid freely`);
    for (const r of mode.rivals) for (const b of mode.solidBoxes) {
      const depth = boxDepth(footprint({ x: r.pos.x, z: r.pos.z, yaw: r.yaw, ...r.size }), b);
      assert.ok(depth <= 0, `${track.id}: ${r.id}'s grid slot is clear of ${b.id} (${depth.toFixed(2)} m in it)`);
    }
    assert.equal(cameraBlock(mode), null, `${track.id}: nothing stands between the car and the countdown camera`);
  }
});

test('every published race with its set pieces: the player\'s car laps without a dead stop, the rivals never drive into a solid', () => {
  for (const track of RACES) for (const drive of [null, { throttle: 1 }]) {
    const mode = raceMode(track, { road: true, solids: true }), res = run(mode, { drive, offRoad: true });
    const where = `${track.id} (${drive ? 'the player racing' : 'the player on the grid'})`;
    for (const r of res.rivals) {
      const s = res.solid[r.id], o = res.offRoad[r.id];
      assert.ok(s.depth <= 0, `${where} ${r.id}: never in a solid, but ${s.depth.toFixed(2)} m into ${JSON.stringify(s.at)}`);
      assert.ok(o.share < .02, `${where} ${r.id}: off the asphalt ${(o.share * 100).toFixed(1)} % of its racing time`);
      assert.ok(r.stop < 2, `${where} ${r.id}: never stood still while racing: ${show(res)}`);
    }
    if (!drive) for (const r of res.rivals) assert.ok(r.finishedAt != null && r.parked, `${where}: ${r.id} raced to the finish and parked: ${show(res)}`);
    else assert.ok(res.me.finishedAt != null && res.me.worst < 1, `${where}: the player finished, never stopped dead: ${JSON.stringify(res.me)}`);
  }
});

test('a rival drives round a solid standing between it and the road, never into it and never stopping against it', () => {
  // a rival off the road behind a wall (shoved there, or making for a park spot past one): the wall stands across its
  // way back, 14-20 m off the hairpin circuit's first straight
  for (const [x, yaw] of [[-80, -Math.PI / 2], [-60, Math.PI / 2], [-70, Math.PI]]) {
    const mode = raceMode(HAIRPIN, { road: true, rivals: 1, tops: [20] }), line = mode.roadPoints;
    mode.raceHold = 0; mode.activeCar.controller.position = { x: 300, z: 280 }; // the player's car far away
    const wall = { id: 'wall', min: { x: -90, y: 0, z: -216 }, max: { x: -50, y: 3, z: -210 } };
    mode.raceSolids = mode.solidBoxes = [wall];
    const r = mode.rivals[0];
    Object.assign(r, { k: null, next: 1, lane: 0, yaw, speed: 12 }); Object.assign(r.pos, { x, z: -198 });
    let deepest = -Infinity, still = 0, longest = 0, back = null;
    for (let i = 0; i < 30 * 20 && back == null; i++) {
      mode.driveRivals(1 / 30, { target: 2 });
      deepest = Math.max(deepest, boxDepth(footprint({ x: r.pos.x, z: r.pos.z, yaw: r.yaw, ...r.size }), wall));
      still = r.speed < .5 ? still + 1 / 30 : 0; longest = Math.max(longest, still);
      if (offLine(line, r.pos) < mode.roadHalf - 2) back = i / 30;
    }
    const where = `from (${x}, -198) heading ${yaw.toFixed(2)}`;
    assert.ok(back != null, `${where}: back on the road: ${JSON.stringify(mode.raceState().rivals)}`);
    assert.ok(deepest <= 0, `${where}: never drove into the wall (${deepest.toFixed(2)} m in)`);
    assert.ok(longest < 1, `${where}: never stood against it (${longest.toFixed(1)} s still)`);
  }
});

test('a rival done racing parks clear of a set piece standing on its park spot, and never drives into it', () => {
  const mode = raceMode(SNAKE, { road: true, solids: true, rivals: 1 }), r = mode.rivals[0], line = mode.roadPoints;
  mode.raceHold = 0; mode.activeCar.controller.position = { x: 300, z: 280 };
  const finish = mode.raceRoute.at(-1), k = nearest(line, finish);
  Object.assign(r, { done: true, finishedAt: 100, k, yaw: alongRoad(line, k), speed: 10 }); Object.assign(r.pos, { x: line[k].x, z: line[k].z });
  const first = mode.parkSpot(r, 0); // where it parks with nothing there: a grandstand goes up on that spot
  const stand = { id: 'stand', min: { x: first.x - 8, y: 0, z: first.z - 2 }, max: { x: first.x + 8, y: 3, z: first.z + 2 } };
  mode.raceSolids = mode.solidBoxes = [...mode.solidBoxes, stand];
  const spot = mode.parkSpot(r, 0);
  assert.ok(boxGap(stand, spot) > r.size.length / 2 + .4, `parks clear of it: (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}), ${boxGap(stand, spot).toFixed(1)} m from it`);
  assert.ok(mode.offRoad(spot), 'still off the asphalt');
  let deepest = -Infinity;
  for (let i = 0; i < 30 * 20 && !r.parked; i++) {
    mode.driveRivals(1 / 30, { target: 2 });
    deepest = Math.max(deepest, boxDepth(footprint({ x: r.pos.x, z: r.pos.z, yaw: r.yaw, ...r.size }), stand));
  }
  assert.ok(r.parked, `parked: ${JSON.stringify(mode.raceState().rivals)}`);
  assert.ok(deepest <= 0, `never drove into the stand (${deepest.toFixed(2)} m in)`);
});
