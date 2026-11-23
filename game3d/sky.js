// Sky islands (artDirection.setting 'sky', server/gamespec.py apply_setting): no floor. The play area is islands over
// a cloud sea far below.
//
// The floor is solid only on ground islands (skyIslands): the one the hero starts on, and one under whatever the spec
// stands on the floor (an enemy spawn, the NPC, a floor entity, a prop off the platforms). Platforms are the other
// islands. Off them the hero falls; below SKY.fallY they are put back on the last top stood on (AuthoredMode.skyFall).
// server/authored_contract.py sky_islands builds the same islands and connects the climb from them.
import { THREE, canvasTexture } from './world.js';

export const SKY = {
  home: 8, // m, the island under the spawn (square)
  pad: 1.5, // m around a floor entity's footprint
  spot: 5, // m, the island under an enemy spawn, the NPC or a prop off the platforms
  fallY: -4, // below this the hero has fallen off (an island's top is y = 0)
  seaY: -26, // the cloud sea's surface
  noFloor: -1e9, // groundAt off every island
};

const island = (x, z, w, d, id) => ({ id, x, z, width: w, depth: d });
const over = (p, x, z) => Math.abs(x - p.x) <= p.width / 2 && Math.abs(z - p.z) <= p.depth / 2;
function onPlatform(platforms, x, z) {
  return platforms.some((p) => {
    const r = p.rotation ?? 0, dx = x - p.x, dz = z - p.z;
    return Math.abs(dx * Math.cos(r) - dz * Math.sin(r)) <= p.width / 2 && Math.abs(dx * Math.sin(r) + dz * Math.cos(r)) <= p.depth / 2;
  });
}

/** The ground islands of a sky world (server/authored_contract.py sky_islands): [{id, x, z, width, depth}], top y = 0. */
export function skyIslands(world) {
  const platforms = (world.entities ?? []).filter((e) => e.kind === 'platform');
  const out = [island(world.spawn.x, world.spawn.z, SKY.home, SKY.home, 'home')];
  for (const e of world.entities ?? []) {
    if (e.kind === 'platform' || (e.y ?? 0) >= .05 || onPlatform(platforms, e.x, e.z)) continue;
    const size = Math.max(e.width ?? 2, e.depth ?? 2) + 2 * SKY.pad;
    out.push(island(e.x, e.z, size, size, e.id));
  }
  for (const p of [...(world.enemySpawns ?? []), ...(world.npc ? [{ id: 'npc', ...world.npc }] : []),
    ...(world.propPlacements ?? []).filter((q) => !onPlatform(platforms, q.x, q.z))]) {
    out.push(island(p.x, p.z, SKY.spot, SKY.spot, p.id));
  }
  return out;
}

/** The ground island under (x, z), or null. */
export const islandAt = (islands, x, z) => islands.find((p) => over(p, x, z)) ?? null;

// ---- the climb: a graph of tops (the ground islands at y = 0, the platforms at y + height); one step is a jump
// within the contract's limits (server/authored_contract.py STEP_RISE / STEP_GAP), or any drop across the same gap.
export const CLIMB = { rise: 1.2, gap: 2.5, ahead: .75, runup: 2, land: 1.2, align: .94, speed: 3 };

/** The tops a climb stands on: [{id, x, z, width, depth, rotation, top}] from the ground islands and the platforms
 * ({id, x, z, y, width, depth, height, rotation}; a moving one where it is now). */
export function climbNodes(islands, platforms) {
  return [...islands.map((i) => ({ ...i, rotation: 0, top: 0 })),
    ...platforms.map((p) => ({ id: p.id, x: p.x, z: p.z, width: p.width, depth: p.depth, rotation: p.rotation ?? 0, top: (p.y ?? 0) + p.height }))];
}
const holds = (n, x, z) => onPlatform([n], x, z);
function bounds(n) {
  const c = Math.abs(Math.cos(n.rotation)), s = Math.abs(Math.sin(n.rotation));
  const hx = (n.width * c + n.depth * s) / 2, hz = (n.width * s + n.depth * c) / 2;
  return [n.x - hx, n.x + hx, n.z - hz, n.z + hz];
}
/** Edge-to-edge gap (m) between two tops' footprints. */
export function climbGap(a, b) {
  const [ax0, ax1, az0, az1] = bounds(a), [bx0, bx1, bz0, bz1] = bounds(b);
  return Math.hypot(Math.max(0, bx0 - ax1, ax0 - bx1), Math.max(0, bz0 - az1, az0 - bz1));
}
/** Whether one step leads from top a to top b: a jump within the contract's limits. `reach` (m): how high the hero
 * really gets onto a top it stands right beside (no gap to cross); games made before the contract's limit have a
 * first step higher than it, which a person climbs. */
export const canStep = (a, b, reach = CLIMB.rise) => {
  const gap = climbGap(a, b), rise = b.top - a.top;
  return (gap <= CLIMB.gap + 1e-6 && rise <= CLIMB.rise + 1e-6) || (gap <= .05 && rise <= reach + 1e-6);
};
/** The highest top holding (x, z), at most `y` + .4 up (a hero there stands on it), or null. */
export function nodeAt(nodes, x, z, y = Infinity) {
  let best = null;
  for (const n of nodes) if (holds(n, x, z) && n.top <= y + .4 && (!best || n.top > best.top)) best = n;
  return best;
}
/** The fewest steps from top `from` to top `to`: [from, …, to], or null when no climb gets there. `reach`: canStep's. */
export function climbPath(nodes, from, to, reach = CLIMB.rise) {
  const prev = new Map([[from, null]]), queue = [from];
  while (queue.length) {
    const n = queue.shift();
    if (n === to) {
      const path = [];
      for (let k = n; k; k = prev.get(k)) path.unshift(k);
      return path;
    }
    for (const m of nodes) if (!prev.has(m) && canStep(n, m, reach)) { prev.set(m, n); queue.push(m); }
  }
  return null;
}
/** The nearest points (x, z) of two tops' footprint boxes, a's then b's (the middle of an overlap on an axis). */
function nearest(a, b) {
  const A = bounds(a), B = bounds(b), pa = [], pb = [];
  for (const [lo, hi, lo2, hi2] of [[A[0], A[1], B[0], B[1]], [A[2], A[3], B[2], B[3]]]) {
    if (hi < lo2) { pa.push(hi); pb.push(lo2); } else if (hi2 < lo) { pa.push(lo); pb.push(hi2); }
    else { const mid = (Math.max(lo, lo2) + Math.min(hi, hi2)) / 2; pa.push(mid); pb.push(mid); }
  }
  return [pa, pb];
}
const inward = ([x, z], n, by) => { // `by` metres from (x, z) toward the top's middle (at most to it)
  const dx = n.x - x, dz = n.z - z, d = Math.hypot(dx, dz);
  const k = d > by ? by / d : 1;
  return { x: x + dx * k, z: z + dz * k };
};
/** The built-in player's next move toward `goal` ({x, z}) from top `from` (the one it stands or last stood on):
 * {x, z} to walk at, `left` (m, the rest of the way), `jump` (now, at the edge) and `next`. A step across a gap or up
 * is taken square: first to a run-up point `CLIMB.runup` m inside `from`'s edge facing the next top, then at the
 * landing point `CLIMB.land` m inside the next top's edge, jumping where the way leaves `from`. `state` ({next,
 * runup}) keeps whether the run-up is done for this step. With the hero's velocity `vel` it jumps only when already
 * running that way; else it `stop`s short of the edge and runs up again. Null without a climb there.
 * A top that stands on this one (their footprints overlap and it is higher) is stepped onto from beside it: straight
 * at its nearest side, jumping where the way ahead is over it. `up`: canStep's reach. */
export function climbStep(nodes, pos, goal, from, state = {}, vel = null, up = CLIMB.rise) {
  const to = nodeAt(nodes, goal.x, goal.z);
  if (!from || !to) return null;
  const path = climbPath(nodes, from, to, up);
  if (!path) return null;
  if (path.length === 1) return { x: goal.x, z: goal.z, left: Math.hypot(goal.x - pos.x, goal.z - pos.z), jump: false, next: to };
  const next = path[1];
  if (state.next !== next.id) Object.assign(state, { next: next.id, runup: false });
  const [fx0, fx1, fz0, fz1] = bounds(from), [x0, x1, z0, z1] = bounds(next);
  const onIt = next.top - from.top > .3 && x0 < fx1 && fx0 < x1 && z0 < fz1 && fz0 < z1; // (it stands on this top)
  const [pa, pb] = onIt ? [null, [Math.min(Math.max(pos.x, x0), x1), Math.min(Math.max(pos.z, z0), z1)]] : nearest(from, next);
  const land = inward(pb, next, CLIMB.land);
  const across = climbGap(from, next) > .05 || next.top - from.top > .3;
  const start = onIt ? land : inward(pa, from, CLIMB.runup);
  if (!across || onIt || Math.hypot(start.x - pos.x, start.z - pos.z) < .5) state.runup = true;
  const aim = state.runup || !holds(from, pos.x, pos.z) ? land : start;
  const dx = aim.x - pos.x, dz = aim.z - pos.z, d = Math.hypot(dx, dz) || 1;
  const ax = pos.x + dx / d * CLIMB.ahead, az = pos.z + dz / d * CLIMB.ahead;
  const over = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  const edge = across && aim === land && holds(from, pos.x, pos.z)
    && (onIt ? !over(pos.x, pos.z) && over(ax, az) : !holds(from, ax, az));
  const speed = vel ? Math.hypot(vel.x, vel.z) : Infinity;
  const aligned = !vel || (speed > CLIMB.speed && (vel.x * dx + vel.z * dz) / (speed * d) > CLIMB.align);
  // where its own momentum takes it
  const reach = Math.max(CLIMB.ahead, speed * .12), mx = pos.x + vel?.x / speed * reach, mz = pos.z + vel?.z / speed * reach;
  const drift = !!vel && speed > .5 && holds(from, pos.x, pos.z) && !holds(from, mx, mz) && !(holds(next, mx, mz) && !across);
  const jump = edge && aligned, stop = (edge && !aligned) || (drift && !jump);
  if (stop) state.runup = false; // brake at the edge, then run up square again
  let left = Math.hypot(land.x - pos.x, land.z - pos.z);
  for (let k = 2; k < path.length; k++) left += Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z);
  left += Math.hypot(goal.x - to.x, goal.z - to.z);
  return { x: aim.x, z: aim.z, left, jump, stop, next };
}

const rock = () => new THREE.MeshStandardMaterial({ color: '#7d6a55', roughness: 1, flatShading: true });
const grass = () => new THREE.MeshStandardMaterial({ color: '#7fbf5a', roughness: .95 });

/** An island's rock root hanging under a footprint (local y = 0 is its underside), cone tip down. */
export function islandRoot(width, depth, rnd = Math.random) {
  const g = new THREE.Group();
  const r = Math.max(width, depth) * .55, h = Math.min(9, r * 1.4 + 1);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7, 2), rock());
  cone.rotation.x = Math.PI; cone.position.y = -h / 2;
  cone.scale.set(width / Math.max(width, depth), 1, depth / Math.max(width, depth));
  cone.rotation.y = rnd() * Math.PI;
  g.add(cone);
  for (let i = 0; i < 2; i++) { // a couple of smaller stones under it, so the edge reads as broken rock, not a funnel
    const s = new THREE.Mesh(new THREE.ConeGeometry(r * .35, h * .45, 5), cone.material);
    s.rotation.x = Math.PI;
    s.position.set((rnd() - .5) * width * .6, -h * .25, (rnd() - .5) * depth * .6);
    g.add(s);
  }
  g.name = 'island-root';
  return g;
}

/** The sky: a gradient dome (unless a background image takes the backdrop), light from above and around, a cloud sea
 * far below with drifting puffs, and the ground islands' grassy tops and rock roots. → {group, update(t)} */
export function buildSky(world, { islands, span, rnd, hasBackdrop }) {
  const group = new THREE.Group();
  group.name = 'sky';
  const disposables = [];
  if (!hasBackdrop) {
    const dome = canvasTexture(256, (ctx, size) => {
      const grad = ctx.createLinearGradient(0, 0, 0, size);
      grad.addColorStop(0, '#3d8be0'); grad.addColorStop(.45, '#9fd0f5'); grad.addColorStop(.52, '#eef6fc'); grad.addColorStop(1, '#ffffff');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
    });
    dome.mapping = THREE.EquirectangularReflectionMapping;
    world.scene.background = dome;
    disposables.push(dome);
  }
  world.scene.fog = new THREE.FogExp2('#dcebf7', Math.min(.009, 1.2 / span));
  group.add(new THREE.HemisphereLight('#cfe8ff', '#f6efe2', 1.25));
  // the cloud sea: soft white blobs on a pale plane, well below, fading into the fog at the horizon
  const sea = canvasTexture(512, (ctx, size) => {
    ctx.fillStyle = '#e9f2fa'; ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 260; i++) {
      const x = rnd() * size, y = rnd() * size, r = 12 + rnd() * 46;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  }, { repeat: 6 });
  disposables.push(sea);
  const reach = span * 6;
  const seaMesh = new THREE.Mesh(new THREE.PlaneGeometry(reach, reach).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: sea, color: '#ffffff', roughness: 1, emissive: '#ffffff', emissiveIntensity: .35 }));
  seaMesh.position.y = SKY.seaY; seaMesh.name = 'cloud-sea';
  group.add(seaMesh);
  const puffs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2),
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#eaf3fb', emissiveIntensity: .4 }), 90);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < puffs.count; i++) {
    const a = rnd() * Math.PI * 2, d = span * (.25 + rnd() * 1.6), r = 3 + rnd() * 7;
    p.set(Math.cos(a) * d, SKY.seaY + 1 + rnd() * 6, Math.sin(a) * d);
    s.set(r * (1.4 + rnd()), r * .55, r);
    puffs.setMatrixAt(i, m.compose(p, q, s));
  }
  puffs.name = 'cloud-puffs';
  group.add(puffs);
  // ground islands: a grassy slab whose top is the floor (y = 0), and a rock root under it
  for (const isle of islands) {
    const top = new THREE.Mesh(new THREE.BoxGeometry(isle.width, .5, isle.depth), grass());
    top.position.set(isle.x, -.25, isle.z); top.receiveShadow = true; top.castShadow = true;
    const root = islandRoot(isle.width, isle.depth, rnd);
    root.position.set(isle.x, -.5, isle.z);
    group.add(top, root);
  }
  return {
    group,
    update(t) { sea.offset.set(t * .004, t * .0025); puffs.position.x = Math.sin(t * .05) * 3; },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
