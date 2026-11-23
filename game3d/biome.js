// Photoreal environment for authored worlds (spec.artDirection.biome): a Poly Haven CC0 kit served at
// /games/env-kit/v1/ (scripts/acquire_env_kit.py, optimize_env_kit.py, env_kit_backdrops.py).
//   sky      the biome's HDRI lights the scene; its tonemapped panorama is projected on a ground dome
//            (GroundedSkybox) so the real horizon continues past the play area
//   ground   tiling PBR (diffuse, normal, roughness) on a floor that fades out into the dome
//   solids   world entities keep their declared size and collision, with real materials or real models:
//            tree → tree models, spire/crystal → rocks (glowing crystals stay in night-city), box/building/arch/
//            platform/cylinder → wall PBR
//   dressing seeded scatter: small debris and props inside (no collision, away from paths and targets),
//            rocks and trees in a ring outside the bounds
// The runtime never invents gameplay geometry: everything walkable or blocking still comes from world.entities.
import { THREE } from './world.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';

export const KIT = '/games/env-kit/v1/';
export const BIOMES = ['forest', 'desert', 'snow', 'ruins', 'industrial', 'volcanic', 'night-city', 'crypt', 'temple'];
export const INDOOR = new Set(['crypt']); // no sky: walls, ceiling and torches (indoorShell)
const SKY_HEIGHT = 14; // HDRI capture height above ground, in metres, for the dome projection

let catalogPromise = null;
export function loadCatalog(base = KIT) {
  catalogPromise ??= fetch(base + 'catalog.json').then((r) => {
    if (!r.ok) throw new Error(`환경 키트 목록을 불러오지 못했습니다 (${r.status})`);
    return r.json();
  });
  return catalogPromise;
}

const loaded = new Map(); // per page: a restarted round reuses the downloaded kit
export function loadBiome(world, name, base = KIT) {
  const key = base + name;
  if (!loaded.has(key)) loaded.set(key, fetchBiome(world, name, base).catch((e) => { loaded.delete(key); throw e; }));
  return loaded.get(key);
}

async function fetchBiome(world, name, base) {
  const catalog = await loadCatalog(base);
  const b = catalog.biomes?.[name];
  if (!b) throw new Error(`알 수 없는 환경: ${name}`);
  const tl = new THREE.TextureLoader();
  const tex = async (rel, srgb) => {
    if (!rel) return null;
    const t = await tl.loadAsync(base + rel);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = world.renderer.capabilities.getMaxAnisotropy?.() ?? 4;
    return t;
  };
  const set = async (s) => {
    const [map, normalMap, roughnessMap] = await Promise.all([tex(s.map, true), tex(s.normalMap), tex(s.roughnessMap)]);
    return { map, normalMap, roughnessMap };
  };
  const model = async (m) => {
    try {
      const gltf = await world.gltf(base + m.path); // (the kit's bytes are counted for the loading screen too)
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = o.receiveShadow = true;
        // glass with transmission makes three.js draw every opaque object a second time each frame (a full-size
        // 4x MSAA pass); its own alpha blend (glTF alphaMode BLEND) is the look without it
        for (const mat of [o.material].flat()) if (mat.transmission > 0) mat.transmission = 0;
      });
      const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
      return { id: m.id, scene: gltf.scene, size };
    } catch { return null; } // one missing model only thins the dressing
  };
  const roles = Object.entries(b.models ?? {});
  const [hdr, backdrop, ground, wall, ...modelSets] = await Promise.all([
    world.meter.watch(base + b.hdri, (onProgress) => new RGBELoader().loadAsync(base + b.hdri, onProgress)),
    b.backdrop ? tex(b.backdrop, true) : null,
    set(b.ground), set(b.wall),
    ...roles.map(([, list]) => Promise.all(list.map(model))),
  ]);
  const models = Object.fromEntries(roles.map(([role], i) => [role, modelSets[i].filter(Boolean)]));
  return { name, fog: b.fog, hdr, backdrop, ground, wall, models, disposables: [] };
}

/** The biome's light, sky dome and fog. `radius`: dome radius in metres (well beyond the play area). */
export function applySky(world, biome, radius, fogDensity = .008) {
  const { scene } = world;
  disposeBiome(biome, world); // the previous round's dome and light probe
  biome.hdr.mapping = THREE.EquirectangularReflectionMapping;
  // the probe is kept as its render target: that is what dispose() frees (a render target's texture.dispose() frees
  // nothing)
  const probe = world.pmrem.fromEquirectangular(biome.hdr);
  scene.environment = probe.texture;
  scene.environmentIntensity = 1;
  const pano = biome.backdrop ?? biome.hdr;
  pano.mapping = THREE.EquirectangularReflectionMapping;
  pano.wrapS = THREE.ClampToEdgeWrapping;
  scene.background = pano;
  const sky = new GroundedSkybox(pano, SKY_HEIGHT, radius);
  sky.position.y = SKY_HEIGHT - .02;
  sky.material.fog = false;
  sky.renderOrder = -2; // first, without depth: it is the background (a harbor's water lies below its flat floor)
  scene.add(sky);
  biome.sky = sky;
  scene.fog = new THREE.FogExp2(biome.fog, fogDensity);
  biome.disposables.push(probe, sky.geometry, sky.material);
  return sky;
}

/** The time of day the request asked for (artDirection.timeOfDay) over a biome photographed in daylight: the dome,
 * reflections and fog darken and cool for night (warm and dimmer for dusk). The night city is shot at dusk already.
 * → the sun's {color, intensity} (moonlight at night), or null for day. */
export const SKY_TIME = {
  dusk: { dome: '#b9886a', env: .65, fog: '#4a3a3a', sun: ['#ffb27a', 1.4] },
  night: { dome: '#27324c', env: .28, fog: '#0b1020', sun: ['#9fb4ff', .55] },
};
export function applyNight(world, biome, timeOfDay) {
  const look = SKY_TIME[timeOfDay];
  if (!look) return null;
  const k = nightStrength(biome.name, timeOfDay);
  const dome = new THREE.Color('#ffffff').lerp(new THREE.Color(look.dome), k);
  if (biome.sky) biome.sky.material.color = dome;
  world.scene.backgroundIntensity = (dome.r + dome.g + dome.b) / 3;
  world.scene.environmentIntensity = 1 - (1 - look.env) * k;
  if (world.scene.fog) world.scene.fog.color = new THREE.Color(biome.fog).lerp(new THREE.Color(look.fog), k);
  if (timeOfDay === 'night' && biome.sky) biome.sky.add(nightSky(biome)); // removed with the dome
  return { color: look.sun[0], intensity: 2.2 - (2.2 - look.sun[1]) * k };
}

/** How far a requested time of day darkens the biome photo, 0-1. The night city is an evening street: dusk there only
 * darkens it a little, but a requested night is night. */
export function nightStrength(biome, timeOfDay) {
  if (!SKY_TIME[timeOfDay]) return 0;
  return biome === 'night-city' && timeOfDay === 'dusk' ? .45 : 1;
}

/** A night sky over the daylight photo: an inner dome, dark navy overhead, clear at the horizon, so the photo's bright
 * clouds go black while its street level (lit windows, the skyline) still shows, dimmed, below. */
function nightSky(biome) {
  const radius = biome.sky.geometry.parameters.radius;
  const fade = document.createElement('canvas');
  fade.width = 4; fade.height = 256;
  const ctx = fade.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256); // top = zenith, bottom = horizon
  grad.addColorStop(0, 'rgba(3,6,16,.97)'); grad.addColorStop(.72, 'rgba(6,10,24,.9)');
  grad.addColorStop(.9, 'rgba(10,16,34,.45)'); grad.addColorStop(1, 'rgba(10,16,34,0)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(fade);
  tex.colorSpace = THREE.SRGBColorSpace;
  const shell = new THREE.Mesh(new THREE.SphereGeometry(radius * .9, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false }));
  shell.name = 'night-sky';
  shell.position.y = -biome.sky.position.y; // centred on the ground, not on the dome's capture height
  shell.renderOrder = -1;
  shell.frustumCulled = false;
  biome.disposables.push(shell.geometry, shell.material, tex);
  return shell;
}

/** The floor under the requested light and weather: darker at night (and a little at dusk), and in the rain darker
 * still and glossy, so lamps and neon streak across it. → {tint (colour multiplier), roughness, envMapIntensity} */
export function groundLook({ timeOfDay, weather } = {}) {
  const rain = weather === 'rain';
  const tint = (timeOfDay === 'night' ? .55 : timeOfDay === 'dusk' ? .8 : 1) * (rain ? .7 : 1);
  return { tint: +tint.toFixed(3), roughness: rain ? .3 : 1, envMapIntensity: rain ? 1.3 : 1 };
}

/** Falling rain streaks or snow flakes (artDirection.weather) in a box that follows the camera; each drop keeps its
 * world position and wraps around inside the box, so walking through the rain looks right. → { object, update } */
export const WEATHER = { rain: { count: 1800, fall: [16, 22], streak: .6, wind: .12 }, snow: { count: 1400, fall: [.8, 1.6], streak: 0, wind: .3 } };
const WEATHER_BOX = { x: 40, y: 18, z: 40 };
export function makeWeather(kind, rnd = Math.random) {
  const w = WEATHER[kind];
  if (!w) return null;
  const B = WEATHER_BOX, rain = w.streak > 0;
  const drops = Array.from({ length: w.count }, () => ({ x: (rnd() - .5) * B.x, y: rnd() * B.y, z: (rnd() - .5) * B.z,
    v: w.fall[0] + rnd() * (w.fall[1] - w.fall[0]), sway: rnd() * 6.3 }));
  const positions = new Float32Array(w.count * (rain ? 6 : 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const object = rain
    ? new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#b4c6dc', transparent: true, opacity: .45, depthWrite: false }))
    : new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#ffffff', size: .09, transparent: true, opacity: .85, depthWrite: false }));
  object.frustumCulled = false; object.renderOrder = 3;
  const wrap = (v, c, size) => c + ((((v - c) % size) + size * 1.5) % size) - size / 2;
  let t = 0;
  const update = (dt, center) => {
    t += dt;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      d.y -= d.v * dt;
      if (d.y < 0) d.y += B.y;
      d.x += w.wind * d.v * dt + (rain ? 0 : Math.sin(t + d.sway) * .3 * dt);
      const x = wrap(d.x, center.x, B.x), z = wrap(d.z, center.z, B.z), y = center.y - 4 + d.y;
      if (rain) positions.set([x, y, z, x - w.wind * w.streak, y + w.streak, z], i * 6);
      else positions.set([x, y, z], i * 3);
    }
    geometry.attributes.position.needsUpdate = true;
  };
  return { kind, object, drops, positions, update, dispose() { geometry.dispose(); object.material.dispose(); } };
}

/** Indoor biome light: the HDRI only as a dim reflection probe, a black void instead of a sky, close dark fog. */
export function applyIndoor(world, biome, fogDensity = .035) {
  const { scene } = world;
  disposeBiome(biome, world);
  biome.hdr.mapping = THREE.EquirectangularReflectionMapping;
  const probe = world.pmrem.fromEquirectangular(biome.hdr); // (its render target, as applySky)
  scene.environment = probe.texture;
  scene.environmentIntensity = .22;
  scene.background = new THREE.Color('#050403');
  scene.fog = new THREE.FogExp2(biome.fog, fogDensity);
  biome.disposables.push(probe);
}

/**
 * The room around an indoor world: brick walls on the bounds, a ceiling (seen from below only, so a top-down
 * camera looks through it) and wall torches with flickering warm light. → { group, colliders, torches, walls }.
 * ponytail: torch lights capped at 10 (forward-rendered point lights cost per pixel), the rest are flames only.
 */
export function indoorShell(biome, { width, depth, height = 7, rnd = Math.random }) {
  const group = new THREE.Group(), colliders = [], torches = [], walls = [];
  const wallAt = (w, d, x, z) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), pbr(biome.wall, Math.max(w, d), height, 2));
    wall.position.set(x, height / 2, z); wall.receiveShadow = true;
    group.add(wall); wall.updateMatrixWorld(true);
    colliders.push(new THREE.Box3().setFromObject(wall)); walls.push(wall);
  };
  const t = 1;
  wallAt(width + 2 * t, t, 0, -depth / 2 - t / 2); wallAt(width + 2 * t, t, 0, depth / 2 + t / 2);
  wallAt(t, depth, -width / 2 - t / 2, 0); wallAt(t, depth, width / 2 + t / 2, 0);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(width + 2, depth + 2).rotateX(Math.PI / 2),
    pbr(biome.wall, width, depth, 3, { color: '#6d625a' }));
  ceiling.position.y = height; group.add(ceiling);
  const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb257', toneMapped: false });
  const iron = new THREE.MeshStandardMaterial({ color: '#2a2622', metalness: .7, roughness: .5 });
  const spots = [];
  for (let x = -width / 2 + 5; x < width / 2 - 2; x += 10) spots.push([x, -depth / 2 + .15, 0], [x, depth / 2 - .15, Math.PI]);
  for (let z = -depth / 2 + 5; z < depth / 2 - 2; z += 10) spots.push([-width / 2 + .15, z, Math.PI / 2], [width / 2 - .15, z, -Math.PI / 2]);
  spots.forEach(([x, z, yaw], i) => {
    const torch = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(.05, .08, .6, 6), iron);
    arm.rotation.x = .5; arm.position.set(0, 0, .2);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(.12, .35, 8), flameMat);
    flame.position.set(0, .35, .32);
    torch.add(arm, flame); torch.position.set(x, 2.6, z); torch.rotation.y = yaw;
    group.add(torch);
    if (i % Math.ceil(spots.length / 10) === 0) {
      const light = new THREE.PointLight('#ff9a4a', 42, 22, 1.5);
      light.position.set(x + Math.sin(yaw) * .7, 3, z + Math.cos(yaw) * .7);
      group.add(light); torches.push({ light, flame, base: 42, phase: rnd() * 10 });
    }
  });
  return { group, colliders, torches, walls };
}

/** Torch flicker: call every frame with the elapsed seconds. */
export function flicker(torches, t) {
  for (const k of torches) {
    const n = Math.sin(t * 9.7 + k.phase) * .5 + Math.sin(t * 23.1 + k.phase * 2) * .3;
    k.light.intensity = k.base * (.85 + .15 * n);
    k.flame.scale.y = 1 + .18 * n;
  }
}

/** A PBR material from a texture set, tiled every `meters` over a surface of `w` x `h` metres. */
export function pbr(set, w, h, meters = 2.5, extra = {}) {
  const tile = (t) => {
    if (!t) return null;
    const c = t.clone();
    c.repeat.set(Math.max(1, w / meters), Math.max(1, h / meters));
    c.needsUpdate = true;
    return c;
  };
  return new THREE.MeshStandardMaterial({ map: tile(set.map), normalMap: tile(set.normalMap),
    roughnessMap: tile(set.roughnessMap), roughness: 1, metalness: 0, ...extra });
}

/** The outer dressing ring starts this far outside the bounds: past the camera's reach (the authored rig sits up to
 * ~6.3 m behind a hero at the edge, the ARPG's 6.4 m), so an orbiting camera never ends up inside a rock. */
export const RING_GAP = 7;
/** How far past RING_GAP the ring reaches (its farthest object's edge). */
export const RING_DEPTH = 13; // a big boulder (up to ~12 m across) still fits
/** Opaque floor radius around the centre: past the bounds' corners and the whole outer ring, so every dressing object
 * stands on real ground (beyond it the floor fades into the sky dome's photo, where rocks seemed to hang in the air). */
export function groundReach(width, depth) {
  return Math.hypot(width / 2 + RING_GAP + RING_DEPTH, depth / 2 + RING_GAP + RING_DEPTH) + 2;
}

/** A floor that tiles the ground set, opaque out to `reach` metres from the centre, then fading into the sky dome. */
export function groundPlane(biome, reach) {
  const fade = document.createElement('canvas');
  fade.width = fade.height = 256;
  const ctx = fade.getContext('2d');
  const size = reach * 2 / .7; // the fade takes the outer 30% of the plane's half-size
  const grad = ctx.createRadialGradient(128, 128, 128 * .7, 128, 128, 128);
  grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#000');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 256, 256);
  const mat = pbr(biome.ground, size, size, 3, { transparent: true, alphaMap: new THREE.CanvasTexture(fade) });
  mat.depthWrite = true;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), mat);
  floor.position.y = .002;
  floor.receiveShadow = true;
  return floor;
}

/** A clone of a kit model scaled uniformly so its height (or, if flat, its footprint) matches the target. */
export function placeModel(entry, { width = 2, depth = 2, height = 2 }, yaw = 0) {
  const obj = entry.scene.clone(true);
  const s = entry.size;
  const byHeight = height / Math.max(s.y, .01);
  const byFoot = Math.max(width, depth) / Math.max(s.x, s.z, .01);
  const scale = s.y < .25 * Math.max(s.x, s.z) ? byFoot : Math.min(byHeight, byFoot * 1.6);
  obj.scale.setScalar(scale);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y -= box.min.y; // rest on the ground
  const g = new THREE.Group();
  g.add(obj);
  g.rotation.y = yaw;
  return g;
}

/** Seeded dressing: `inner` small items inside the bounds (kept off `blocked(x, z, r)` areas), `outer` rocks and
 * trees in a ring outside them. Pure decoration: nothing here collides or counts for a mission. */
export function scatter(biome, { width, depth, rnd, blocked, inner = 36, outer = 28 }) {
  const group = new THREE.Group();
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const small = [...(biome.models.debris ?? []), ...(biome.models.prop ?? [])];
  for (let i = 0, tries = 0; i < inner && small.length && tries < inner * 8; tries++) {
    const x = (rnd() - .5) * (width - 4), z = (rnd() - .5) * (depth - 4);
    if (blocked(x, z, 2.2)) continue;
    const m = pick(small);
    const h = Math.min(1.4, Math.max(.35, m.size.y));
    const obj = placeModel(m, { width: 1.2, depth: 1.2, height: h }, rnd() * Math.PI * 2);
    obj.position.set(x, 0, z);
    group.add(obj); i++;
  }
  // the outer ring: outside the rectangle, past the camera's reach and on the opaque floor (ringSpot), trees taller
  const rocks = biome.models.rock ?? [], trees = biome.models.tree ?? [];
  for (let i = 0; i < outer && (rocks.length || trees.length); i++) {
    const t = rnd(), u = rnd();
    const tree = trees.length && (!rocks.length || rnd() < .55);
    const m = pick(tree ? trees : rocks);
    const h = tree ? 6 + rnd() * 7 : 1.5 + rnd() * 4;
    const obj = placeModel(m, { width: h, depth: h, height: h }, rnd() * Math.PI * 2);
    const box = new THREE.Box3().setFromObject(obj); // its footprint, yaw included
    const at = ringSpot(t, u, { width, depth }, Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2);
    obj.position.set(at.x, 0, at.z);
    group.add(obj);
  }
  return group;
}

/** Where an outer-ring object of footprint radius `r` stands: `t` (0-1) picks a point along the perimeter, `u` (0-1)
 * how far out. Its near edge is at least RING_GAP past the bounds, its far edge within RING_GAP + RING_DEPTH where it
 * fits (a big one sits right at the gap). → {x, z} */
export function ringSpot(t, u, { width, depth }, r) {
  const along = t * 2 * (width + depth);
  const out = RING_GAP + r + u * Math.max(0, RING_DEPTH - 2 * r);
  if (along < width) return { x: along - width / 2, z: -depth / 2 - out };
  if (along < width + depth) return { x: width / 2 + out, z: along - width - depth / 2 };
  if (along < 2 * width + depth) return { x: along - width - depth - width / 2, z: depth / 2 + out };
  return { x: -width / 2 - out, z: along - 2 * width - depth - depth / 2 };
}

/** Removes what applySky added for one round (dome, light probe); the downloaded kit stays cached. */
export function disposeBiome(biome, world) {
  if (!biome) return;
  if (biome.sky) world?.scene.remove(biome.sky);
  for (const d of biome.disposables) d.dispose?.();
  biome.disposables = [];
  biome.sky = null;
}

// ---- harbor (artDirection.setting 'harbor', server/gamespec.py apply_setting) ----
// Past one edge of the play area: a concrete quay wall with bollards, water out to the horizon, gantry cranes
// standing in it; container stacks replace the outer ring on the land sides. All of it lies outside the bounds the
// hero walks in, so nothing here collides or counts for a mission.

const DOCK = /dock|pier|quay|wharf|harbou?r|\bport|부두|선착장|잔교|안벽|항구/i;
const EDGES = ['north', 'south', 'west', 'east'];
const edgeGap = (side, p, { width, depth }) => ({ north: p.z + depth / 2, south: depth / 2 - p.z, west: p.x + width / 2,
  east: width / 2 - p.x })[side];
/** The edge the water lies past: the one nearest the dock entities (id or label dock, pier, 부두 …), else the one
 * farthest from the spawn, so the hero starts with the water ahead. → 'north' (-Z) | 'south' | 'west' (-X) | 'east' */
export function harborSide({ world }) {
  const docks = world.entities.filter((e) => DOCK.test(`${e.id} ${e.label ?? ''}`));
  const score = docks.length ? (side) => -docks.reduce((sum, e) => sum + edgeGap(side, e, world), 0)
    : (side) => edgeGap(side, world.spawn, world);
  return EDGES.reduce((best, side) => (score(side) > score(best) ? side : best));
}

const QUAY_OUT = 1.2; // the quay edge stands this far past the bounds (the hero stops .6 m inside them)
const BOX = { x: 6.06, y: 2.59, z: 2.44 }; // a 20 ft ISO container, metres
export const CONTAINER_COLORS = ['#b8412f', '#1f5f8b', '#2f7d5b', '#c9892a', '#6d6f73', '#7a2f4f'];

/** Where the harbor's pieces go. Local frame: the water at -Z, the waterfront along X; `yaw` turns it to the world
 * (north is the identity). `quay` is the quay edge's local z. Cranes and stacks are in world coordinates. */
export function harborPlan(spec, rnd) {
  const side = harborSide(spec);
  const { width, depth } = spec.world;
  const across = side === 'north' || side === 'south';
  const along = across ? width : depth, half = across ? depth / 2 : width / 2;
  const yaw = { north: 0, south: Math.PI, west: Math.PI / 2, east: -Math.PI / 2 }[side];
  const world = (x, z) => ({ x: +(x * Math.cos(yaw) + z * Math.sin(yaw)).toFixed(3), z: +(-x * Math.sin(yaw) + z * Math.cos(yaw)).toFixed(3) });
  const quay = -half - QUAY_OUT;
  const cranes = (along >= 70 ? [-.32, .06, .4] : [-.25, .25]).map((f) => ({ ...world(f * along, quay - 14), yaw })); // out in the water
  // stacks in the outer ring band of the three land sides, one or two rows deep, long side along the edge
  const stacks = [];
  const row = (x0, z0, dx, dz, length, turn) => {
    for (let s = 0; s + BOX.x <= length; s += BOX.x + .8 + rnd() * 1.6) {
      if (rnd() < .18) continue; // gaps, so it reads as a yard rather than a wall
      const levels = 1 + Math.floor(rnd() * 3);
      const colors = Array.from({ length: levels }, () => CONTAINER_COLORS[Math.floor(rnd() * CONTAINER_COLORS.length)]);
      const at = world(x0 + dx * (s + BOX.x / 2), z0 + dz * (s + BOX.x / 2));
      stacks.push({ ...at, yaw: yaw + turn, levels, colors });
    }
  };
  for (const deep of [RING_GAP + BOX.z / 2, RING_GAP + BOX.z * 1.5 + .6]) {
    row(-along / 2 - 8, half + deep, 1, 0, along + 16, 0); // the far side, behind the spawn
    for (const sign of [-1, 1]) row(sign * (along / 2 + deep), quay + 4, 0, 1, half - quay - 4, Math.PI / 2); // the ends
  }
  return { side, yaw, along, half, quay, cranes, stacks };
}

/** A box entity standing for a shipping container (id or label container / 컨테이너): drawn as corrugated steel. */
export const isContainer = (e) => e.kind === 'box' && /container|컨테이너/i.test(`${e.id} ${e.label ?? ''}`);

let ribs = null; // the shared corrugation: a grey rib pattern (map) and its normals, 16 ribs per tile
function ribTextures() {
  if (ribs) return ribs;
  const make = (paint) => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    paint(c.getContext('2d'));
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.userData.shared = true; // disposeTree keeps it for the next round
    return t;
  };
  const map = make((ctx) => {
    for (let x = 0; x < 256; x++) {
      const v = 180 + 50 * Math.cos((x / 16) * Math.PI * 2);
      ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, 0, 1, 64);
    }
    ctx.fillStyle = 'rgba(40,30,25,.55)'; ctx.fillRect(0, 0, 256, 4); ctx.fillRect(0, 60, 256, 4); // top and bottom rails
  });
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = make((ctx) => {
    for (let x = 0; x < 256; x++) {
      const nx = Math.round(128 + 110 * Math.sin((x / 16) * Math.PI * 2));
      ctx.fillStyle = `rgb(${nx},128,${Math.round(128 + 127 * Math.abs(Math.cos((x / 16) * Math.PI * 2)))})`; ctx.fillRect(x, 0, 1, 64);
    }
  });
  return (ribs = { map, normalMap });
}

/** Corrugated, painted steel in `hex`, ribs every ~0.3 m along a side `length` metres long. */
export function containerMaterial(hex, length = BOX.x) {
  const { map, normalMap } = ribTextures();
  const tile = (t) => { const c = t.clone(); c.repeat.set(Math.max(1, length / 4.8), 1); c.needsUpdate = true; return c; };
  return new THREE.MeshStandardMaterial({ color: hex, map: tile(map), normalMap: tile(normalMap), roughness: .55, metalness: .45 });
}

let ripple = null;
function rippleTexture() {
  if (ripple) return ripple;
  const size = 128, c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = (x / size) * Math.PI * 2, b = (y / size) * Math.PI * 2; // tiling waves
    const dx = Math.cos(a * 3 + b) * .5 + Math.cos(a * 7 - b * 2) * .3, dy = Math.cos(b * 4 + a) * .5 + Math.cos(b * 9 + a * 3) * .25;
    const i = (y * size + x) * 4;
    img.data[i] = 128 + dx * 70; img.data[i + 1] = 128 + dy * 70; img.data[i + 2] = 240; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ripple = new THREE.CanvasTexture(c);
  ripple.wrapS = ripple.wrapT = THREE.RepeatWrapping;
  ripple.userData.shared = true;
  return ripple;
}

/** A box between two points (a crane's struts and stays). */
function strut(material, a, b, thick) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(thick, thick, a.distanceTo(b)), material);
  m.position.copy(a).add(b).multiplyScalar(.5);
  m.lookAt(b);
  return m;
}

/** A ship-to-shore gantry crane: four legs in the water, a boom reaching out to sea, its lights. Local -Z is the sea. */
function gantryCrane(steel, lamp, red) {
  const g = new THREE.Group(), V = (x, y, z) => new THREE.Vector3(x, y, z);
  const H = 24, gauge = 12, span = 16, deck = H + 2;
  for (const x of [-gauge / 2, gauge / 2]) {
    for (const z of [0, -span]) g.add(strut(steel, V(x, -1.5, z), V(x, deck, z), 1.1));
    g.add(strut(steel, V(x, deck, 0), V(x, deck, -span), 1)); // the sill beams on top
    g.add(strut(steel, V(x, H * .4, 0), V(x, H * .4, -span), .7));
    g.add(strut(steel, V(x, H * .4, 0), V(x, deck, -span), .45)); // a brace
    g.add(strut(steel, V(x, deck, -span / 2), V(x, deck + 14, -span / 2), .8)); // the A-frame
    g.add(strut(steel, V(x, deck + 14, -span / 2), V(x * .3, deck + 2, -span - 42), .3)); // its stays to the boom tip
    g.add(strut(steel, V(x, deck + 14, -span / 2), V(x * .3, deck + 2, 14), .3));
  }
  for (const z of [0, -span]) g.add(strut(steel, V(-gauge / 2, deck, z), V(gauge / 2, deck, z), 1));
  g.add(strut(steel, V(-gauge / 2, deck + 14, -span / 2), V(gauge / 2, deck + 14, -span / 2), .7));
  for (const x of [-1.6, 1.6]) g.add(strut(steel, V(x, deck + 2, 16), V(x, deck + 2, -span - 44), 1.4)); // the boom
  const house = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 8), steel);
  house.position.set(0, deck + 4.2, 8); g.add(house); // no shadows: out past the sun's shadow box anyway
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 2.4), lamp);
  cab.position.set(0, deck - .2, -span - 6); g.add(cab);
  for (let z = 10; z > -span - 44; z -= 7) { // floodlights under the boom
    const l = new THREE.Mesh(new THREE.BoxGeometry(.7, .25, .7), lamp);
    l.position.set(0, deck + 1, z); g.add(l);
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(.45, 10, 8), red);
  beacon.position.set(0, deck + 14.8, -span / 2); g.add(beacon);
  return g;
}

/**
 * The harbor's meshes for a plan (harborPlan): the quay wall and its capstone, bollards, water to `radius`, cranes,
 * container stacks. The floor is cut at the quay edge (a clipping plane on `ground`), so the water lies 1.3 m below
 * it. → { group, update(t) } (t: seconds, ripples the water)
 */
export function buildHarbor(world, biome, plan, { radius, reach, night, ground }) {
  const group = new THREE.Group();
  group.name = 'harbor';
  const local = new THREE.Group(); // the waterfront frame
  local.rotation.y = plan.yaw;
  group.add(local);
  const { quay } = plan;
  const length = reach * 2;
  // the floor ends at the quay edge
  if (ground) {
    world.renderer.localClippingEnabled = true;
    const n = new THREE.Vector3(Math.sin(plan.yaw), 0, Math.cos(plan.yaw)); // local +Z: from the water to the land
    ground.material.clippingPlanes = [new THREE.Plane(n, -quay)];
  }
  const wallMat = pbr(biome.wall, length, 2.6, 2.5, { color: night ? '#8a8d93' : '#c9c6bd' });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(length, 2.6, 1), wallMat);
  wall.position.set(0, -1.3, quay - .5); wall.receiveShadow = true; local.add(wall);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(length, .2, .6), new THREE.MeshStandardMaterial({ color: '#9a9890', roughness: .8 }));
  cap.position.set(0, .1, quay + .3); cap.receiveShadow = true; local.add(cap);
  const paint = new THREE.Mesh(new THREE.PlaneGeometry(length, .15).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#e0b21c', emissive: '#e0b21c', emissiveIntensity: night ? .25 : 0, roughness: .6 }));
  paint.position.set(0, .012, quay + .9); local.add(paint);
  const iron = new THREE.MeshStandardMaterial({ color: '#23262b', roughness: .45, metalness: .7 });
  const bollardGeo = new THREE.CylinderGeometry(.17, .22, .55, 12).translate(0, .475, 0);
  const n = Math.floor(length / 9);
  const bollards = new THREE.InstancedMesh(bollardGeo, iron, n);
  const o = new THREE.Object3D();
  for (let i = 0; i < n; i++) { o.position.set(-length / 2 + 4.5 + i * 9, 0, quay + .35); o.updateMatrix(); bollards.setMatrixAt(i, o.matrix); }
  bollards.castShadow = true; local.add(bollards);
  // the water: dark, glossy, rippling; fog takes it into the horizon
  const normalMap = rippleTexture().clone();
  normalMap.repeat.set(radius / 5, radius / 10); normalMap.needsUpdate = true;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * .9).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: night ? '#06101c' : '#1b3946', roughness: .1, metalness: .2, normalMap,
      normalScale: new THREE.Vector2(.5, .5), envMapIntensity: night ? 1.6 : 1 }));
  water.position.set(0, -1.3, quay - radius * .45);
  water.receiveShadow = true;
  local.add(water);
  // cranes
  const steel = new THREE.MeshStandardMaterial({ color: night ? '#8c2b22' : '#b63a2b', roughness: .55, metalness: .5 });
  const lamp = new THREE.MeshStandardMaterial({ color: '#ffd9a0', emissive: '#ffc070', emissiveIntensity: night ? 2.2 : .3, fog: false });
  const red = new THREE.MeshStandardMaterial({ color: '#ff3b2f', emissive: '#ff3b2f', emissiveIntensity: night ? 4 : .5, fog: false }); // lights shine through the fog and rain
  for (const c of plan.cranes) {
    const crane = gantryCrane(steel, lamp, red);
    crane.position.set(c.x, 0, c.z); crane.rotation.y = c.yaw;
    group.add(crane);
  }
  // container stacks: one instanced box per colour
  const byColor = new Map();
  for (const s of plan.stacks) s.colors.forEach((hex, level) => {
    if (!byColor.has(hex)) byColor.set(hex, []);
    byColor.get(hex).push({ ...s, level });
  });
  const boxGeo = new THREE.BoxGeometry(BOX.x, BOX.y, BOX.z);
  for (const [hex, list] of byColor) {
    const mesh = new THREE.InstancedMesh(boxGeo, containerMaterial(hex), list.length);
    list.forEach((s, i) => {
      o.position.set(s.x, BOX.y * (s.level + .5), s.z); o.rotation.set(0, s.yaw + (s.level % 2 ? .03 : -.02), 0);
      o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
    });
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, water, update(t) { normalMap.offset.set(t * .012, t * .02); } };
}
