// Race stage runtime shared by the city (city.js) and the open track (track.js): the player starts in a car, a 3 s
// countdown, glowing gates on the ordered checkpoints, AI rivals that follow the loop, contact between cars, a rank
// and lap HUD. The mode provides: cars [{id, group, controller, adapters}], activeCar, makeCarGroup(kind), targets,
// director, hud, world, root, rnd, accent, player, phase, timeLimit/elapsed, carEntities (kind model + car flag),
// and may provide parkSpot(r, order): where a rival done racing pulls over, knowing its roads (else raceParkSpot),
// roadPoints + roadHalf: a road's centre line (points ~2 m apart through the checkpoints in order, the last on the
// first) and half its width with the curbs (track.js), and raceSolids: the boxes ({min, max}) a car hits. On a road the
// grid stands on it whatever the spec's start says, the solid set pieces are kept off it (clearRoad), the rivals race
// along it, and off its asphalt every car gets half throttle. Rivals drive round solids and never into one.
import { THREE } from './world.js';
import { VehicleController, carOverlap, footprint, noseSign } from './city-controller.js';
import { driveRig, rigCar } from './carrig.js';
import { clock } from './arpg-data.js';

const CAR_LENGTH = 4.6; // metres; a generated car model is scaled to this
const TURN_RADIUS = 6; // an AI car's tightest arc, under a checkpoint's 7 m pass radius so it never circles one
const GRID_BACK = 30; // metres along a road from the grid's front (the player's car) on to the first gate
const LOOK = 8; // metres along a road a racing rival steers ahead of itself (cuts a 12.5 m hairpin by ~2.5 m)
// metres a solid set piece keeps clear of a road's curbs: past a car's 2.25 m collision radius (city-controller.js), so
// a car anywhere on the asphalt or the curbs never touches one, and the chase camera behind it stays over open ground
const CLEAR = 2.5;
const SLAB = .035; // a generated car's fused floor slab lies in this bottom share of its height
export const SAND = .5; // the throttle a car keeps off the asphalt
// ... so it holds 85 % of its top speed there: the player's car's 18.7 of 22 m/s (city-controller.js drag), and it
// loses the rest as that car does, about 1.2 m/s² (rivals: their own top, the same drop)
const SAND_TOP = .85, SAND_COAST = 1.2;
// The built-in player's driving (?autoplay=1, raceKeys). It takes a bend at BOT_GRIP m/s² sideways, of the 8 the
// player's car turns with (city-controller.js maxLateralAcceleration), and slows for one at BOT_BRAKE m/s², half of
// what its brake gives; it aims BOT_LOOK m up the road at least, farther at speed.
const BOT_GRIP = 6, BOT_BRAKE = 9, BOT_LOOK = 7;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** The built-in driver's keys go through the same input as a player's: a key event for each one that changes. */
export function holdKeys(input, want) {
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyF', 'Space']) {
    if (want.has(code) !== input.keys.has(code)) dispatchEvent(new KeyboardEvent(want.has(code) ? 'keydown' : 'keyup', { code, bubbles: true }));
  }
}
/** Half a car's footprint ({yaw, length, width}) along the unit direction (ux, uz). */
const reach = (o, ux, uz) => Math.abs(Math.sin(o.yaw) * ux + Math.cos(o.yaw) * uz) * o.length / 2
  + Math.abs(Math.cos(o.yaw) * ux - Math.sin(o.yaw) * uz) * o.width / 2;
/** Metres from (x, z) to a box ({min, max}) on the ground: 0 inside it. */
const boxGap = (b, x, z) => Math.hypot(Math.max(b.min.x - x, 0, x - b.max.x), Math.max(b.min.z - z, 0, z - b.max.z));
/** Metres from the segment p→q to a box on the ground: 0 when it runs into the box, else the nearest pair holds an end
 * of the segment or a corner of the box. */
function segGap(p, q, b) {
  const dx = q.x - p.x, dz = q.z - p.z;
  let t0 = 0, t1 = 1;
  for (const [o, d, lo, hi] of [[p.x, dx, b.min.x, b.max.x], [p.z, dz, b.min.z, b.max.z]]) {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) t0 = 2; continue; }
    const a = (lo - o) / d, c = (hi - o) / d;
    t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
  }
  if (t0 <= t1) return 0;
  const l2 = dx * dx + dz * dz || 1, toSegment = (x, z) => {
    const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / l2));
    return Math.hypot(p.x + t * dx - x, p.z + t * dz - z);
  };
  return Math.min(boxGap(b, p.x, p.z), boxGap(b, q.x, q.z), toSegment(b.min.x, b.min.z), toSegment(b.max.x, b.min.z),
    toSegment(b.max.x, b.max.z), toSegment(b.min.x, b.max.z));
}

/** A spec entity's ground footprint if it is solid as authored.js builds it (not a car body, a coin, a beacon or a
 * trap): the half extents {hx, hz} of the axis-aligned box its colliders fit in, its width × depth turned by its
 * rotation and swept by its motion along x or z. Else null. */
function solidFootprint(e) {
  const solid = e.kind === 'platform' || (e.solid ?? !['beacon', 'hazard'].includes(e.kind));
  if (!solid || e.pickup || (e.kind === 'model' && e.car)) return null;
  const r = e.rotation ?? 0, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r)), w = (e.width ?? 2) / 2, d = (e.depth ?? 2) / 2;
  const m = e.motion && e.motion.axis !== 'y' ? e.motion.distance / 2 : 0, alongX = e.motion?.axis === 'x';
  return { hx: c * w + s * d + m * (alongX ? c : s), hz: s * w + c * d + m * (alongX ? s : c) };
}

/** The vertex positions of an object's meshes in its own frame, flat [x, y, z, ...]. */
function positionsIn(object) {
  object.updateMatrixWorld(true);
  const inv = object.matrixWorld.clone().invert(), m = new THREE.Matrix4(), v = new THREE.Vector3(), out = [];
  object.traverse((n) => {
    const p = n.isMesh && n.geometry.attributes.position;
    if (!p) return;
    m.multiplyMatrices(inv, n.matrixWorld);
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); out.push(v.x, v.y, v.z); }
  });
  return out;
}

/** The floor slab image-to-3D fuses under some generated cars (a thin plate under the tyres, wider than the body):
 * every triangle wholly in the bottom SLAB of the model's height, when the flat, down-facing faces there cover 40 %
 * of its footprint or more (tyres alone touch the ground in four small patches). parts: each mesh's {positions: flat
 * [x, y, z, ...] in one frame, +Y up; index or null} → per mesh the Set of its triangles to drop (empty: no slab). */
export function floorSlab(parts) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, down = 0;
  for (const { positions: p } of parts) for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
    z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]);
  }
  const top = y0 + (y1 - y0) * SLAB;
  const low = parts.map(({ positions: p, index }) => {
    const out = new Set(), n = (index ? index.length : p.length / 3) / 3, at = (i) => 3 * (index ? index[i] : i);
    for (let t = 0; t < n; t++) {
      const a = at(3 * t), b = at(3 * t + 1), c = at(3 * t + 2);
      if (p[a + 1] >= top || p[b + 1] >= top || p[c + 1] >= top) continue;
      out.add(t);
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const ny = uz * vx - ux * vz; // (u × v).y: twice the face's area seen from below, negative when it faces down
      if (ny < -.9 * Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx)) down -= ny / 2;
    }
    return out;
  });
  return down >= .4 * (x1 - x0) * (z1 - z0) ? low : parts.map(() => new Set());
}

/** A generated car without the floor slab its mesh may carry (floorSlab): each mesh it lies in gets a geometry without
 * it, so the tyres stand on the ground and the body alone sets the car's size. */
function dropFloorSlab(object) {
  object.updateMatrixWorld(true);
  const inv = object.matrixWorld.clone().invert(), m = new THREE.Matrix4(), v = new THREE.Vector3(), meshes = [];
  object.traverse((n) => {
    const p = n.isMesh && n.geometry.attributes.position;
    if (!p) return;
    m.multiplyMatrices(inv, n.matrixWorld);
    const positions = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) v.fromBufferAttribute(p, i).applyMatrix4(m).toArray(positions, 3 * i);
    meshes.push({ mesh: n, positions, index: n.geometry.index?.array ?? null });
  });
  floorSlab(meshes).forEach((drop, k) => {
    const { mesh } = meshes[k], g = mesh.geometry, keep = [];
    if (!drop.size || g.groups.length) return; // draw groups (several materials) would no longer match the triangles
    for (let t = 0; t < (g.index?.count ?? g.attributes.position.count) / 3; t++) {
      if (!drop.has(t)) for (let j = 3 * t; j < 3 * t + 3; j++) keep.push(g.index ? g.index.getX(j) : j);
    }
    const kept = g.clone(); kept.setIndex(keep);
    mesh.geometry = kept.toNonIndexed(); // only the kept triangles' vertices: the slab leaves the bounding box too
  });
}

/** A car group's footprint (its long side along local Z), for car-to-car contact: {length, width} in metres. */
export function carSize(group) {
  const yaw = group.rotation.y;
  group.rotation.y = 0; group.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  group.rotation.y = yaw; group.updateMatrixWorld(true);
  return { length: Math.max(1, size.z), width: Math.max(.8, Math.min(size.x, size.z)) };
}

/** A generated car model (an IP's GLB) as a car body: its long side along the driving axis, real-car size, on the
 * ground, nose forward (-Z). The nose is read from the mesh itself (the tail is its taller end); with no clear cue
 * +X (a side view facing right) or +Z (glTF's front) leads. A floor slab fused under the mesh is cut away first. */
export function carBody(scene) {
  const visual = scene.clone(true);
  dropFloorSlab(visual); // the clone's own geometries: the scene stays whole for the next car made from it
  const box = new THREE.Box3().setFromObject(visual), size = box.getSize(new THREE.Vector3());
  const axis = size.x > size.z ? 'x' : 'z';
  const nose = noseSign(positionsIn(visual), axis) || 1;
  visual.rotation.y = axis === 'x' ? nose * Math.PI / 2 : nose > 0 ? Math.PI : 0; // +X→-Z is +π/2, +Z→-Z is π
  const scale = CAR_LENGTH / Math.max(size.x, size.z, .01);
  visual.scale.setScalar(scale);
  visual.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(visual), c = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-c.x, -fitted.min.y, -c.z);
  const group = new THREE.Group();
  group.add(visual);
  visual.traverse((n) => { if (n.isMesh) n.castShadow = n.receiveShadow = true; });
  rigCar(group); // wheels cut out of the generated mesh so they roll and steer
  group.userData.nose = `${nose > 0 ? '+' : '-'}${axis}`;
  group.userData.size = carSize(group);
  return group;
}

export const RaceMixin = {
  /** A car model chosen for the race (kind model entity with car: 'player' | 'rival'), else null. */
  raceCarScene(role, i = 0) {
    const list = (this.carEntities ?? []).filter((e) => e.car === role);
    const e = list.length ? list[i % list.length] : null;
    return e ? this.setPieces.get(e.id) ?? null : null;
  },
  /** The rivals as other cars for the player's car (city-controller.js cars adapter): it slides off them. */
  rivalCars() {
    return (this.rivals ?? []).map((r) => ({ id: r.id, x: r.pos.x, z: r.pos.z, yaw: r.yaw, ...r.size }));
  },
  startRace(stage) {
    if (!this.cars.length) return; // the mode starts it once its cars exist
    this.raceStage = stage.id;
    const car = this.cars.find((c) => c.id === stage.vehicleId)
      ?? [...this.cars].sort((a, b) => a.group.position.distanceTo(this.player.pos) - b.group.position.distanceTo(this.player.pos))[0];
    const body = this.raceCarScene('player');
    if (car && body && !car.customBody) { // the user's own sports car replaces the kit car
      for (const child of [...car.group.children]) car.group.remove(child);
      const fresh = carBody(body);
      car.group.add(fresh); car.group.userData.rig = fresh.userData.rig; car.customBody = true; // its wheels drive now
      car.group.userData.size = fresh.userData.size;
    }
    if (car && this.activeCar !== car) {
      this.activeCar = car; this.enterCount = (this.enterCount ?? 0) + 1; this.actor.root.visible = false;
      Object.assign(this.world.rig, { distance: 10.5, height: 1.8, pitch: .22, yaw: car.controller.stateSnapshot().yaw, first: true });
    }
    this.raceHold = 3; this.raceClock = 0; this.raceDone = null; this.raceParked = 0;
    this.raceRoute = stage.entityIds.map((id) => this.targets.find((t) => t.id === id)).filter(Boolean);
    for (const t of this.raceRoute) { const e = this.entities?.get(t.id); if (e?.group) e.group.visible = false; } // the gates mark them
    this.raceNeed = stage.finishRank ?? (stage.rivals ? Math.min(3, stage.rivals) : 0); // last place never wins
    this.raceLine = this.roadLine();
    const grid = this.raceLine && this.roadGrid((stage.rivals ?? 0) + 1);
    if (car && this.raceRoute[0]) { // face the first checkpoint on the grid (on a road: the grid's front, along it)
      const p = car.group.position, f = this.raceRoute[0];
      if (grid) { p.set(grid[0].x, p.y, grid[0].z); Object.assign(this.player.pos, { x: p.x, z: p.z }); }
      const yaw = grid ? grid[0].yaw : Math.atan2(-(f.x - p.x), -(f.z - p.z));
      car.controller = new VehicleController({ id: car.id, position: { x: p.x, z: p.z }, yaw, ...car.group.userData.size }, car.adapters);
      car.group.rotation.y = yaw; this.world.rig.yaw = yaw;
    }
    for (const g of this.raceGates ?? []) { this.root.remove(g.mesh); g.mesh.geometry.dispose(); g.mesh.material.dispose(); }
    this.raceGates = this.raceRoute.map((t, i) => {
      const next = this.raceRoute[(i + 1) % this.raceRoute.length];
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(6, .28, 10, 48), new THREE.MeshStandardMaterial({
        color: this.accent, emissive: this.accent, emissiveIntensity: 1, transparent: true, opacity: .9 }));
      mesh.position.set(t.x, 5.6, t.z); mesh.rotation.y = Math.atan2(next.x - t.x, next.z - t.z);
      this.root.add(mesh);
      return { id: t.id, mesh };
    });
    const start = car ? car.group.position : this.player.pos, first = this.raceRoute[0];
    const forward = new THREE.Vector3(first.x - start.x, 0, first.z - start.z).normalize();
    const side = new THREE.Vector3(forward.z, 0, -forward.x), yaw = Math.atan2(-forward.x, -forward.z);
    for (const r of this.rivals ?? []) this.root.remove(r.group);
    this.rivals = Array.from({ length: stage.rivals ?? 0 }, (_, i) => {
      const scene = this.raceCarScene('rival', i);
      const group = scene ? carBody(scene) : this.makeCarGroup(['sedan', 'suv', 'taxi', 'police', 'delivery'][i % 5]);
      if (scene) this.root.add(group);
      const slot = grid?.[i + 1];
      const pos = slot ? new THREE.Vector3(slot.x, .06, slot.z)
        : start.clone().addScaledVector(side, (i % 2 ? -1 : 1) * 4.4).addScaledVector(forward, -7 * Math.floor(i / 2 + 1));
      group.position.set(pos.x, .06, pos.z); group.rotation.y = slot?.yaw ?? yaw;
      return { id: `rival_${i}`, group, pos, yaw: slot?.yaw ?? yaw, size: group.userData.size ?? carSize(group),
        k: slot?.k ?? null, lane: slot?.lane ?? 0, next: 0, lap: 0, speed: 0, top: 16 + this.rnd() * 5.5, done: false, parked: false };
    });
  },
  /** The mode's road as the racing line: its points (the repeated last one dropped), their spacing, the road point at
   * each checkpoint and a nearest-point lookup. No road (the city): null. */
  roadLine() {
    const pts = this.roadPoints;
    if (!(pts?.length > 3)) return null;
    const m = pts.length - (Math.hypot(pts.at(-1).x - pts[0].x, pts.at(-1).z - pts[0].z) < .01 ? 1 : 0);
    let length = 0;
    for (let i = 0; i < m; i++) length += Math.hypot(pts[(i + 1) % m].x - pts[i].x, pts[(i + 1) % m].z - pts[i].z);
    const nearest = (p) => {
      let k = 0, best = Infinity;
      for (let i = 0; i < m; i++) { const d = (pts[i].x - p.x) ** 2 + (pts[i].z - p.z) ** 2; if (d < best) { best = d; k = i; } }
      return k;
    };
    return { pts, m, step: length / m, gates: this.raceRoute.map(nearest), nearest };
  },
  /** The start grid on the road: the player's car (slot 0) on the centre line GRID_BACK m before the first gate (half
   * the way from the last gate at most), the rivals two abreast in rows 7 m apart behind it, each facing along the road
   * → [{x, z, yaw, k: its road point, lane: metres left of the centre line}]. */
  roadGrid(slots) {
    const { m, step, gates } = this.raceLine, room = ((gates[0] - gates.at(-1) + m) % m || m) * step;
    const front = Math.min(GRID_BACK, room / 2), lane = Math.min(4.4, this.roadHalf - 2.5); // a car's width inside the curb
    return Array.from({ length: slots }, (_, i) => {
      const row = i && Math.floor((i - 1) / 2) + 1, side = i && ((i - 1) % 2 ? -1 : 1);
      const k = ((gates[0] - Math.round((front + 7 * row) / step)) % m + m) % m, { x, z, fx, fz } = this.roadAt(k, side * lane);
      return { k, x, z, yaw: Math.atan2(-fx, -fz), lane: side * lane };
    });
  },
  /** Road point k moved `lane` m to the left of the centre line, and the road's direction there. */
  roadAt(k, lane = 0) {
    const { pts, m } = this.raceLine, a = pts[(k + m - 1) % m], b = pts[(k + 1) % m], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const fx = (b.x - a.x) / l, fz = (b.z - a.z) / l; // along the road; its left is (fz, -fx)
    return { x: pts[k].x + fz * lane, z: pts[k].z - fx * lane, fx, fz };
  },
  /** On a road, where a racing rival steers: LOOK m along the road past its own spot on it, in its lane (the grid's,
   * fading as it drives), never past the gate it has to pass next; pushed wide past that gate's spot, the gate itself
   * (as without a road). No road: null. */
  roadAhead(r) {
    const line = this.raceLine;
    if (!line) return null;
    const { pts, m, step, gates } = line;
    // its spot: the nearest road point just around the last one (a road may pass close by itself), else anywhere
    let k = r.k, best = Infinity;
    for (let i = -5; k != null && i <= 25; i++) {
      const j = (r.k + i + m) % m, d = (pts[j].x - r.pos.x) ** 2 + (pts[j].z - r.pos.z) ** 2;
      if (d < best) { best = d; k = j; }
    }
    r.k = best < 400 ? k : line.nearest(r.pos);
    const left = (gates[r.next] - r.k + m) % m; // road points on to the gate
    return left > m / 2 ? this.raceRoute[r.next] : this.roadAt((r.k + Math.min(left, Math.round(LOOK / step))) % m, r.lane);
  },
  /** Off the asphalt: farther from the road's centre line than its curbs and 1 m more. No road: never. */
  offRoad(p) {
    if (!this.roadPoints?.length) return false;
    let best = Infinity;
    for (let i = 0; i < this.roadPoints.length; i += 2) {
      const q = this.roadPoints[i], d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best) > this.roadHalf + 1;
  },
  /** On a road, where its solid set pieces stand (TrackMode builds them there): one whose footprint comes within CLEAR m
   * of the curbs of any stretch is moved straight away from the road to the nearest spot clear of it, inside the world
   * and off the other solids; with none within 40 m it is left out.
   * → Map id → {x, z} (moved) | null (left out); the rest stand where the spec put them. */
  clearRoad(entities, { width, depth }) {
    const pts = this.roadPoints, need = this.roadHalf + CLEAR, moved = new Map();
    if (!(pts?.length > 3)) return moved;
    const gap = (x, z, f) => { // metres from the road's centre line to the footprint's edge
      let best = Infinity;
      for (const q of pts) best = Math.min(best, Math.hypot(Math.max(0, Math.abs(q.x - x) - f.hx), Math.max(0, Math.abs(q.z - z) - f.hz)));
      return best;
    };
    const solids = entities.map((e) => ({ e, f: solidFootprint(e), x: e.x, z: e.z })).filter((s) => s.f);
    for (const s of solids) {
      if (gap(s.x, s.z, s.f) >= need) continue;
      // away from the road: from its nearest road point through the piece's centre (across the road if that is on it)
      let k = 0, near = Infinity;
      pts.forEach((q, i) => { const d = (q.x - s.x) ** 2 + (q.z - s.z) ** 2; if (d < near) { near = d; k = i; } });
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      let ux = s.x - pts[k].x, uz = s.z - pts[k].z;
      if (Math.hypot(ux, uz) < .5) { ux = b.z - a.z; uz = a.x - b.x; }
      const l = Math.hypot(ux, uz) || 1, f = s.f;
      const free = (x, z) => Math.abs(x) + f.hx <= width / 2 - 1 && Math.abs(z) + f.hz <= depth / 2 - 1 && gap(x, z, f) >= need
        && solids.every((o) => o === s || !o.f || Math.abs(o.x - x) >= o.f.hx + f.hx + 1 || Math.abs(o.z - z) >= o.f.hz + f.hz + 1);
      let spot = null;
      for (let t = .5; t <= 40 && !spot; t += .5) for (const side of [1, -1]) {
        const x = +(s.x + ux / l * t * side).toFixed(2), z = +(s.z + uz / l * t * side).toFixed(2);
        if (free(x, z)) { spot = { x, z }; break; }
      }
      moved.set(s.e.id, spot);
      if (spot) Object.assign(s, spot); else s.f = null; // left out: nothing for the others to keep clear of
    }
    return moved;
  },
  /** Whether a solid the cars hit (raceSolids) stands within `radius` m of the point p. */
  solidNear(p, radius) {
    return (this.raceSolids ?? []).some((b) => boxGap(b, p.x, p.z) < radius);
  },
  /** Where a rival making for `target` heads past the solids (raceSolids): straight there when its contact circle
   * (half its length) clears them; else along the outline of the nearest box in the way, grown 1.5 m past that circle,
   * 6 m ahead of its own spot on it, round the side that turns it least, kept until the way is clear. A box the target
   * itself stands by is no way round. */
  roundSolid(r, target) {
    const R = Math.max(r.size.length, r.size.width) / 2, p = r.pos;
    let b = null;
    for (const box of this.raceSolids ?? []) {
      if (segGap(p, target, box) < R && boxGap(box, target.x, target.z) >= R && (!b || boxGap(box, p.x, p.z) < boxGap(b, p.x, p.z))) b = box;
    }
    if (!b) { r.round = null; return target; }
    const g = R + 1.5, x0 = b.min.x - g, x1 = b.max.x + g, z0 = b.min.z - g, z1 = b.max.z + g, W = x1 - x0, D = z1 - z0;
    const along = (u) => { // the outline's point u metres round from its (x0, z0) corner: +x, +z, -x, -z
      u = ((u % (2 * (W + D))) + 2 * (W + D)) % (2 * (W + D));
      return u < W ? { x: x0 + u, z: z0 } : u < W + D ? { x: x1, z: z0 + u - W } : u < 2 * W + D ? { x: x1 - (u - W - D), z: z1 } : { x: x0, z: z1 - (u - 2 * W - D) };
    };
    // its own spot on the outline: the nearest point of it (out to the nearest side from within)
    const cx = Math.max(x0, Math.min(x1, p.x)), cz = Math.max(z0, Math.min(z1, p.z)), inside = cx === p.x && cz === p.z;
    const side = inside ? [p.z - z0, x1 - p.x, z1 - p.z, p.x - x0].reduce((k, v, i, all) => (v < all[k] ? i : k), 0)
      : cz === z0 ? 0 : cx === x1 ? 1 : cz === z1 ? 2 : 3;
    const at = [cx - x0, W + cz - z0, W + D + x1 - cx, 2 * W + D + z1 - cz][side];
    if (r.round?.box !== b) { // round the side whose way on turns it least from the target
      const turn = (q) => Math.abs(wrap(Math.atan2(q.x - p.x, q.z - p.z) - Math.atan2(target.x - p.x, target.z - p.z)));
      r.round = { box: b, sense: turn(along(at + 6)) <= turn(along(at - 6)) ? 1 : -1 };
    }
    return along(at + 6 * r.round.sense);
  },
  raceProgress(lap, next, pos) {
    const t = this.raceRoute[next];
    return lap * 1000 + next * 10 - (t ? Math.hypot(t.x - pos.x, t.z - pos.z) / 1000 : 0);
  },
  /** Where a rival that is done racing pulls over: off the racing line, past the finish (or ahead of where it was
   * when the race ended), one spot per car on alternating sides. Modes with real roads refine it in parkSpot. */
  raceParkSpot(r, order, aside = this.raceAside ?? 6) {
    const finish = this.raceRoute.at(-1), first = this.raceRoute[0];
    const from = r.finishedAt != null ? finish : r.pos;
    let fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw), room = 60;
    if (r.finishedAt != null) {
      const dx = first.x - finish.x, dz = first.z - finish.z, d = Math.hypot(dx, dz) || 1;
      fx = dx / d; fz = dz / d; room = Math.max(12, d - 12);
    }
    const ahead = Math.min(room, 22 + 9 * order), side = (order % 2 ? -1 : 1) * aside;
    return { x: from.x + fx * ahead - fz * side, z: from.z + fz * ahead + fx * side };
  },
  /** AI rivals: race the checkpoint loop (on a road along it, roadAhead); once done (or when the race is over) they
   * leave the racing line and park. A car right ahead holds a rival back; a much slower one is driven round on its
   * open side; of two rivals only the one behind gives way. They yield to the player's car, push each other apart
   * and drive round solids (raceSolids), never into one. Off the asphalt they get half throttle, as the player's car. */
  driveRivals(dt, racing) {
    const laps = racing?.target ?? 0;
    const mine = this.activeCar?.controller.stateSnapshot();
    const me = mine ? { id: 'player', x: mine.position.x, z: mine.position.z, yaw: mine.yaw, speed: Math.abs(mine.speed),
      ...(this.activeCar.group.userData.size ?? { length: 4.4, width: 1.9 }) } : null;
    const pose = (r) => ({ id: r.id, x: r.pos.x, z: r.pos.z, yaw: r.yaw, speed: r.speed, ...r.size });
    const behind = (r, o) => { // r is behind o along their mean heading; dead level, the later rival gives way
      const k = (o.pos.x - r.pos.x) * (Math.sin(r.yaw) + Math.sin(o.yaw)) + (o.pos.z - r.pos.z) * (Math.cos(r.yaw) + Math.cos(o.yaw));
      return k < 0 || (k === 0 && this.rivals.indexOf(o) < this.rivals.indexOf(r));
    };
    for (const r of this.rivals) {
      if (!racing && !r.done) r.done = true; // the race is over: everyone pulls over
      if (r.done && r.parkAt == null) { const order = this.raceParked++; r.parkAt = this.parkSpot?.(r, order) ?? this.raceParkSpot(r, order); }
      if (r.parked) continue;
      const goal = r.done ? r.parkAt : this.raceRoute[r.next], d = Math.hypot(goal.x - r.pos.x, goal.z - r.pos.z);
      // the way it steers: on a road along it, and round a solid standing in between
      const target = this.roundSolid(r, r.done ? goal : this.roadAhead(r) ?? goal);
      let want = r.done ? Math.min(r.top * .5, Math.max(0, d - 1) * 1.1) : d < 26 ? r.top * .62 : r.top; // brake for gates
      const way = Math.atan2(-(target.x - r.pos.x), -(target.z - r.pos.z)), cruise = want;
      const fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw), ux = -Math.sin(way), uz = -Math.cos(way);
      let aim = way, pass = null;
      for (const o of [...(me ? [me] : []), ...this.rivals.filter((x) => x !== r && (x.parked || behind(r, x))).map(pose)]) {
        const ox = o.x - r.pos.x, oz = o.z - r.pos.z, clear = (r.size.width + o.width) / 2 + .4, speed = Math.abs(o.speed ?? 0);
        // a car right ahead (the player or a rival) holds this one back instead of being driven into
        const along = ox * fx + oz * fz, lateral = Math.abs(ox * fz - oz * fx);
        if (along > 0 && along <= 16 && lateral <= clear)
          want = Math.min(want, speed * .9 + Math.max(0, along - (r.size.length + o.length) / 2 - .8) * 1.5);
        // a much slower one on the way to the target (not one braking for the gate this one brakes for too) is passed:
        // the way bends just wide of it (us > 0: on the left), outside the hold-back, by its real footprint across the
        // way (a car stopped across the road blocks its length, not its width)
        const ua = ox * ux + oz * uz, us = ox * uz - oz * ux, wide = Math.max(clear, r.size.width / 2 + reach(o, uz, -ux) + .4) + .3;
        const pace = !r.done && Math.hypot(goal.x - o.x, goal.z - o.z) < 26 ? Math.min(cruise, r.top * .62) : cruise;
        if (ua > 0 && ua < Math.min(24, d + 6) && Math.abs(us) < wide && speed < pace - 3 && !(pass?.ua < ua))
          pass = { id: o.id, ua, us, clear: wide };
      }
      if (pass) { // round the side it leaves open, kept while it stays on the other side so the rival does not weave
        const kept = r.passing?.id === pass.id && pass.us * r.passing.side < .5 ? r.passing.side : null;
        const side = kept ?? (pass.us > 0 ? -1 : 1), dist = Math.hypot(pass.ua, pass.us);
        aim = way + Math.atan2(pass.us, pass.ua) + side * Math.asin(Math.min(1, pass.clear / dist));
        r.passing = { id: pass.id, side };
      } else r.passing = null;
      const err = wrap(aim - r.yaw);
      if (Math.abs(err) > .9) want = Math.min(want, 7); // a sharp turn: slow enough to make it
      // off the asphalt: half the push, and above what half throttle holds it slows as the player's car does there
      const grip = this.offRoad(r.pos) ? SAND : 1, held = grip < 1 ? Math.min(want, r.top * SAND_TOP) : want;
      r.speed = r.speed < held ? Math.min(held, r.speed + 7 * grip * dt)
        : Math.max(held, r.speed - (r.speed > want ? 18 : SAND_COAST) * dt);
      const rate = Math.max(1.2, r.speed / TURN_RADIUS) * dt; // the heading turns through an arc, never snaps
      r.yaw = wrap(r.yaw + THREE.MathUtils.clamp(err, -rate, rate));
      const step = Math.min(r.done ? d : Infinity, r.speed * dt);
      r.pos.x -= Math.sin(r.yaw) * step; r.pos.z -= Math.cos(r.yaw) * step;
      // the grid's lane fades into the centre line, 1 m per 25 m driven: two columns merge gently, never in a squeeze
      if (r.lane) r.lane = Math.sign(r.lane) * Math.max(0, Math.abs(r.lane) - step / 25);
      r.steer = THREE.MathUtils.clamp(-err * 1.2, -.5, .5);
      if (r.done) { if (d < 1.2) { r.parked = true; r.speed = 0; } continue; }
      if (d < 7) {
        r.next = (r.next + 1) % this.raceRoute.length;
        if (r.next === 0 && ++r.lap >= laps) { r.done = true; r.finishedAt = this.raceClock; }
      }
    }
    // contact: a rival yields to the player's car (moves itself out and slows), rivals split a push between them
    for (const r of this.rivals) {
      if (me) {
        const hit = carOverlap(footprint(pose(r)), footprint(me));
        if (hit.depth > 0) { r.pos.x += hit.nx * (hit.depth + .01); r.pos.z += hit.nz * (hit.depth + .01); r.speed *= .8; }
      }
      for (const o of this.rivals) {
        if (o === r) continue;
        const hit = carOverlap(footprint(pose(r)), footprint(pose(o)));
        if (hit.depth <= 0) continue;
        const push = (hit.depth + .01) / 2;
        r.pos.x += hit.nx * push; r.pos.z += hit.nz * push; o.pos.x -= hit.nx * push; o.pos.z -= hit.nz * push;
      }
    }
    // solids have the last word: a rival's contact circle (half its length round its centre, as the player's car's
    // 2.25 m) is put back outside any it reached, and it keeps only its speed along the face
    for (const r of this.rivals) for (const b of this.raceSolids ?? []) {
      const R = Math.max(r.size.length, r.size.width) / 2, d = boxGap(b, r.pos.x, r.pos.z);
      if (d >= R) continue;
      let nx, nz;
      if (d > 1e-6) { // out along the line from the box's nearest point
        const cx = THREE.MathUtils.clamp(r.pos.x, b.min.x, b.max.x), cz = THREE.MathUtils.clamp(r.pos.z, b.min.z, b.max.z);
        nx = (r.pos.x - cx) / d; nz = (r.pos.z - cz) / d; r.pos.x = cx + nx * R; r.pos.z = cz + nz * R;
      } else { // its centre inside: out through the nearest face
        const [ox, oz] = [[b.min.x - R - r.pos.x, 0], [b.max.x + R - r.pos.x, 0], [0, b.min.z - R - r.pos.z], [0, b.max.z + R - r.pos.z]]
          .reduce((p, q) => (Math.hypot(...p) < Math.hypot(...q) ? p : q));
        r.pos.x += ox; r.pos.z += oz; nx = Math.sign(ox); nz = Math.sign(oz);
      }
      const into = Math.sin(r.yaw) * nx + Math.cos(r.yaw) * nz; // its heading (-sin, -cos) against the face's normal
      if (into > 0) r.speed *= Math.sqrt(Math.max(0, 1 - into * into));
    }
    for (const r of this.rivals) {
      r.group.position.set(r.pos.x, .06, r.pos.z); r.group.rotation.y = r.yaw;
      driveRig(r.group.userData.rig, dt, { speed: r.speed, steer: r.parked ? 0 : r.steer ?? 0, yaw: r.yaw });
    }
  },
  updateRace(dt) {
    const stage = this.director.stage;
    const racing = stage?.type === 'race' && this.raceRoute?.length ? stage : null;
    if (this.phase !== 'playing' || !this.raceRoute?.length) return;
    // a race that is over leaves the status line while the mission goes on. Cleared here, before the return for a race
    // without rivals
    if (!racing) this.raceHud = null;
    if (!racing && !this.rivals?.length) return;
    let held = false; // the countdown: nobody drives, the clock stands, the HUD's race lines are up already
    if (racing && this.raceHold > 0) {
      this.raceHold -= dt;
      held = this.raceHold > 0;
      // the 3-2-1 in the big pill, then GO! for a second: as a tip, which refreshHud keeps up (a notice written here
      // would be gone with the next frame)
      if (held) this.hud.notice(`${Math.ceil(this.raceHold)}`, true);
      else { this.hud.notice('GO!', true); this.tip?.('GO!', 1, true); }
    }
    if (!held) this.driveRivals(dt, racing);
    if (!racing) return;
    if (!held) this.raceClock += dt;
    const laps = stage.target;
    const lap = Math.floor(this.director.progress), next = this.director.raceNext;
    const mine = this.raceProgress(lap, next, this.player.pos);
    const rank = 1 + this.rivals.filter((r) => r.finishedAt != null || this.raceProgress(r.lap, r.next, r.pos) > mine).length;
    this.raceRank = rank;
    for (const g of this.raceGates) {
      const on = g.id === this.raceRoute[next]?.id;
      g.mesh.material.emissiveIntensity = on ? 2.6 : .25; g.mesh.material.opacity = on ? .95 : .35;
    }
    // two short lines: on the left the lap, the gate and the place it takes; on the right, in the mode's status line
    // (raceHud), the place and the time
    this.raceHud = `${this.rivals.length ? `${rank}/${this.rivals.length + 1}위 · ` : ''}${clock(this.raceClock, true)}`;
    const need = this.raceNeed ? ` · ${this.raceNeed}위 안에 들어야 해요` : '';
    const limit = this.timeLimit ? ` · 남은 ${Math.ceil(Math.max(0, this.timeLimit - this.elapsed))}초` : ''; // playable ads time the race too
    this.hud.objective(`랩 ${Math.min(lap + 1, laps)}/${laps} · 체크포인트 ${next + 1}/${this.raceRoute.length}${need}${limit}`);
  },
  /** After the race stage completes: a place-based loss ends the game (call from the mode's update). */
  raceFinish(racing) {
    if (!racing || this.director.stage?.id === racing || this.raceDone) return;
    this.raceDone = { rank: this.raceRank ?? 1, seconds: +this.raceClock.toFixed(2) };
    this.hud.popup(`${this.raceDone.rank}위로 완주! ${this.raceDone.seconds.toFixed(1)}초`, this.player.pos.clone().setY(3), 'pickup');
    for (const g of this.raceGates ?? []) g.mesh.visible = false;
    if (!this.ended && this.raceNeed && this.raceDone.rank > this.raceNeed) this.end(false);
  },
  /** A race is won by place, not just by finishing the laps: call at the top of the mode's end(won). */
  raceVerdict(won) {
    const rank = this.raceDone?.rank ?? this.raceRank ?? 1;
    if (this.raceNeed && rank > this.raceNeed && (won || this.raceDone)) {
      this.failure = `${rank}위로 완주 — ${this.raceNeed}위 안에 들어야 클리어`;
      this.hud.notice(this.failure);
      return false;
    }
    return won;
  },
  /** The race's numbers for the end screen (AuthoredMode.endSummary): the place among the cars and the time, at the
   * finish or where the round ended. No race run: null. */
  raceSummary() {
    if (!this.raceRoute?.length || !(this.raceClock > 0)) return null;
    const rank = this.raceDone?.rank ?? this.raceRank, cars = (this.rivals?.length ?? 0) + 1;
    return [...(cars > 1 && rank ? [`${cars}대 중 ${rank}위`] : []), clock(this.raceDone?.seconds ?? this.raceClock, true)];
  },
  /** The built-in player's car in a race (?autoplay=1; the mode's botDrive holds the keys this returns). On a road it
   * follows the centre line: it steers through a point BOT_LOOK m ahead or more (pure pursuit, tapping A/D) and takes
   * the speed the bends within its braking distance allow. With no road it makes straight for the next gate. Stopped
   * for 1.5 s it backs out, turning the other way. Each 5 m nearer the next gate is a gain the round watchdog counts
   * (navGain): a lap takes longer than the watchdog's 40 s. → Set of key codes */
  raceKeys(dt) {
    const car = this.activeCar, want = new Set(), next = this.director.raceNext, gate = this.raceRoute?.[next];
    if (!car || !gate || this.raceHold > 0) return want; // the countdown: hands off
    const s = car.controller.stateSnapshot(), p = s.position, v = Math.abs(s.speed), line = this.raceLine;
    let aim = gate, top = Infinity, left = Math.hypot(gate.x - p.x, gate.z - p.z);
    if (line) {
      const { pts, m, step, gates } = line;
      // its spot on the road, as a rival's (roadAhead): the nearest point just around the last one, else anywhere
      let k = this.botK ?? null, best = Infinity;
      for (let i = -5; k != null && i <= 25; i++) {
        const j = (this.botK + i + m) % m, d = (pts[j].x - p.x) ** 2 + (pts[j].z - p.z) ** 2;
        if (d < best) { best = d; k = j; }
      }
      this.botK = k = best < 400 ? k : line.nearest(p);
      const here = this.roadAt(k), along = ((gates[next] - k + m) % m) * step; // metres of road on to the gate
      // the gate lies just behind, out of its 7 m reach: driven past wide (shoved off the line by a rival's car). Straight
      // back to it, not round the whole lap for it, at a pace whose turning circle (4 m) fits inside that reach
      if (along > m * step - 60 && left > 9) top = 5;
      else {
        // facing back down the road (after such a turn) it aims far enough up it to come about in one arc
        const back = here.fx * Math.sin(s.yaw) + here.fz * Math.cos(s.yaw) > 0;
        aim = this.roadAt((k + Math.round(Math.max(BOT_LOOK, v * .6, back ? 20 : 0) / step)) % m);
        left = along;
        // each bend ahead allows sqrt(BOT_GRIP / its curvature), and that much more per metre still to brake in
        for (let i = 0, reach = Math.ceil((v * v / (2 * BOT_BRAKE) + 12) / step); i <= reach; i++) {
          const a = this.roadAt((k + i) % m), b = this.roadAt((k + i + 3) % m);
          const bend = Math.abs(wrap(Math.atan2(b.fx, b.fz) - Math.atan2(a.fx, a.fz))) / (3 * step);
          top = Math.min(top, Math.sqrt(BOT_GRIP / Math.max(bend, 1e-4) + 2 * BOT_BRAKE * i * step));
        }
        // coming up to the gate wide of the centre line (abreast of a rival on the outside): it lifts and tucks in
        if (along < 45 && Math.hypot(pts[k].x - p.x, pts[k].z - p.z) > 4) top = Math.min(top, 10);
      }
    }
    if (this.botGate !== next) { this.botGate = next; this.botLeft = Infinity; }
    if (left < this.botLeft - 5 || left > this.botLeft + 30) { // (a gate driven past wide comes round again)
      if (this.botLeft < Infinity) this.navGain = (this.navGain ?? 0) + 1;
      this.botLeft = left;
    }
    const err = wrap(Math.atan2(-(aim.x - p.x), -(aim.z - p.z)) - s.yaw); // > 0: the aim is to the left (A)
    if (this.botReverse > 0) {
      this.botReverse -= dt; this.botSlow = 0;
      want.add('KeyS'); if (err > .1) want.add('KeyD'); if (err < -.1) want.add('KeyA'); // reversing turns the other way
      return want;
    }
    this.botSlow = v < .6 ? (this.botSlow ?? 0) + dt : 0;
    if (this.botSlow > 1.5) { this.botReverse = 1.4; this.botSlow = 0; }
    // the steering angle whose arc passes through the aim (+ = right, as the controller's): the key of its side is
    // held until the wheels are there, then let go
    const steer = -Math.atan(2 * car.controller.wheelBase * Math.sin(THREE.MathUtils.clamp(err, -Math.PI / 2, Math.PI / 2))
      / Math.max(1, Math.hypot(aim.x - p.x, aim.z - p.z)));
    if (steer < -.002 && s.steeringAngle > steer) want.add('KeyA');
    else if (steer > .002 && s.steeringAngle < steer) want.add('KeyD');
    if (Math.abs(err) > .9) top = Math.min(top, 7); // facing off the road ahead (after a shove): turn first
    if (v > top + 1) want.add('Space'); else if (v < top) want.add('KeyW');
    return want;
  },
  /** Seconds until the race is over at the car's pace, on its last stretch only: the mission's last stage, the last
   * lap, the last checkpoint ahead, the car at 8 m/s or more; the road metres on to the checkpoint's reach over its
   * speed. null anywhere else. A broadcast reads it (runtime3d.js ipverseRoundEnd, once it is steady) to send the
   * round's ad break ahead of an end no clock tells. */
  raceEndsIn() {
    const d = this.director, stage = d?.stage, route = this.raceRoute, car = this.activeCar;
    if (stage?.type !== 'race' || !route?.length || !car || this.phase !== 'playing' || this.raceHold > 0) return null;
    if (d.index !== d.mission.stages.length - 1 || Math.floor(d.progress) !== stage.target - 1
      || d.raceNext !== route.length - 1) return null;
    const s = car.controller.stateSnapshot(), p = s.position, v = Math.abs(s.speed), gate = route.at(-1), line = this.raceLine;
    if (v < 8) return null;
    let left = Math.hypot(gate.x - p.x, gate.z - p.z);
    if (line) {
      const along = ((line.gates[route.length - 1] - line.nearest(p) + line.m) % line.m) * line.step;
      if (along > line.m * line.step - 60) return left > 9 ? null : 0; // driven past it wide: it turns back for it
      left = Math.max(left, along);
    }
    return Math.max(0, left - Math.max(gate.radius ?? 0, 7)) / v; // (mission.js: passed within 7 m, or its radius)
  },
  /** Read-only race telemetry for the mode's debugState. */
  raceState() {
    return this.raceRoute ? { rank: this.raceRank ?? null, clock: +(this.raceClock ?? 0).toFixed(2), done: this.raceDone,
      rivals: (this.rivals ?? []).map((r) => ({ id: r.id, lap: r.lap, next: r.next, done: r.done, parked: r.parked,
        finishedAt: r.finishedAt ?? null, x: +r.pos.x.toFixed(2), z: +r.pos.z.toFixed(2), yaw: +r.yaw.toFixed(3),
        speed: +r.speed.toFixed(2), parkAt: r.parkAt ? { x: +r.parkAt.x.toFixed(1), z: +r.parkAt.z.toFixed(1) } : null })) } : null;
  },
};
