// Skeletal animation for rigged characters (docs/rig-contract.md): every humanoid IP is rigged on the Quaternius
// Universal Animation Library (UAL) skeleton, and one shared clip library (assets/ual.glb) drives all of them by
// bone name. Per character this module builds an Animator: speed-synced locomotion blending (idle, walk, run,
// sprint) with foot speed matched to ground speed, an air layer (jump, fall), one-shot actions (attack, hit, land,
// death) on the upper body or the full body, and a right-hand weapon attachment with a muzzle at its +Z tip.
// Unrigged models never get here; world.js keeps its procedural motion for them.
import * as THREE from 'three';
import { BONES, resolveRoles } from './ualclips.js';

export function isUalRig(obj) {
  let pelvis = false, hand = false, spine = false;
  obj.traverse((o) => {
    if (o.name === BONES.pelvis) pelvis = true;
    else if (o.name === BONES.handR) hand = true;
    else if (o.name === BONES.upperRoot) spine = true;
  });
  return pelvis && hand && spine;
}

// ── retargeting by name ───────────────────────────────────────────────────────

// Rotation tracks bind by bone name as-is (same rest orientation by contract). The only translation kept is the
// pelvis, scaled by this character's pelvis height over the library's, so a taller or shorter rig does not float or
// sink. Each clip is split into an upper-body copy (spine_01 and below it) and a lower-body copy (the rest), so
// actions can own the arms while the legs keep running.
function retarget(clip, model, upper, ratio) {
  const up = [], low = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const node = track.name.slice(0, dot), prop = track.name.slice(dot + 1);
    if (!model.has(node)) continue;
    let t = track;
    if (prop === 'position') {
      if (node !== BONES.pelvis) continue;
      t = track.clone();
      for (let i = 0; i < t.values.length; i++) t.values[i] *= ratio;
    } else if (prop !== 'quaternion') continue;
    (upper.has(node) ? up : low).push(t);
  }
  return {
    upper: new THREE.AnimationClip(`${clip.name}.upper`, clip.duration, up),
    lower: new THREE.AnimationClip(`${clip.name}.lower`, clip.duration, low),
    duration: clip.duration,
  };
}

const boneMap = (root) => {
  const m = new Map();
  root.traverse((o) => { if (o.name && !m.has(o.name)) m.set(o.name, o); });
  return m;
};

// Foot-planted speed of a locomotion clip: while a foot is on the ground (within 3% of the height of its lowest
// point) it moves backwards relative to the pelvis at exactly the ground speed. Returns {speed (world m/s), offset
// (phase where the left foot is furthest forward, 0..1)}. Measured on the actual character, so its proportions count.
function measureStride(obj, clip, bones, height) {
  const footL = bones.get(BONES.footL), footR = bones.get(BONES.footR), pelvis = bones.get(BONES.pelvis);
  if (!footL || !footR || !pelvis) return null;
  const rest = [...bones.values()].map((b) => [b, b.position.clone(), b.quaternion.clone()]);
  const mixer = new THREE.AnimationMixer(obj);
  const action = mixer.clipAction(clip);
  action.play();
  obj.updateMatrixWorld(true);
  const inv = obj.matrixWorld.clone().invert();
  const scale = obj.getWorldScale(new THREE.Vector3()).x;
  const n = 64, dt = clip.duration / n;
  const samples = [[], []];
  const v = new THREE.Vector3(), pv = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    mixer.setTime(i * dt);
    obj.updateMatrixWorld(true);
    pelvis.getWorldPosition(pv).applyMatrix4(inv);
    [footL, footR].forEach((f, k) => {
      f.getWorldPosition(v).applyMatrix4(inv);
      samples[k].push({ y: v.y * scale, z: (v.z - pv.z) * scale });
    });
  }
  action.stop();
  mixer.uncacheRoot(obj);
  for (const [b, pos, q] of rest) { b.position.copy(pos); b.quaternion.copy(q); }
  obj.updateMatrixWorld(true);
  const speeds = [];
  for (const s of samples) {
    const floor = Math.min(...s.map((p) => p.y)) + 0.03 * height;
    for (let i = 0; i < n; i++) if (s[i].y < floor && s[i + 1].y < floor) speeds.push(-(s[i + 1].z - s[i].z) / dt);
  }
  speeds.sort((a, b) => a - b);
  const speed = speeds.length >= 4 ? speeds[Math.floor(speeds.length / 2)] : null;
  const zs = samples[0].map((p) => p.z);
  const offset = zs.indexOf(Math.max(...zs)) / n;
  return speed > 0.2 ? { speed, offset } : { speed: null, offset };
}

const DEFAULT_SPEED = { walk: 1.5, run: 3.6, sprint: 6.2 }; // m/s at 1.8 m, when a clip cannot be measured

// Everything an Animator needs for one character model, cached per model URL: retargeted clips and stride data.
export function bindLibrary(libClips, obj, height, { zombie = false } = {}) {
  const bones = boneMap(obj);
  const upper = new Set();
  bones.get(BONES.upperRoot)?.traverse((o) => upper.add(o.name));
  const pelvis = bones.get(BONES.pelvis);
  const libPelvisY = libClips.pelvisRestY;
  let hips = null; // the rigging step records the pelvis scale as a glTF extra (docs/rig-contract.md)
  obj.traverse((o) => { if (hips == null && Number.isFinite(o.userData?.ualHipsScale)) hips = o.userData.ualHipsScale; });
  const ratio = hips ?? (pelvis && libPelvisY ? pelvis.position.length() / libPelvisY : 1);
  const roles = resolveRoles(libClips.clips);
  if (zombie) {
    roles.idle = roles.zombie_idle ?? roles.idle;
    roles.walk = roles.zombie_walk ?? roles.walk;
    roles.attack_melee = roles.zombie_attack ?? roles.attack_melee;
  }
  const parts = {};
  for (const [role, clip] of Object.entries(roles)) if (clip) parts[role] = retarget(clip, bones, upper, ratio);
  const loco = [];
  for (const role of ['walk', 'run', 'sprint']) {
    const p = parts[role];
    if (!p || loco.some((l) => l.clip === roles[role])) continue; // a fallback that repeats a clip
    const m = measureStride(obj, new THREE.AnimationClip(role, p.duration, [...p.upper.tracks, ...p.lower.tracks]), bones, height);
    const speed = m?.speed ?? DEFAULT_SPEED[role] * (height / 1.8);
    loco.push({ role, clip: roles[role], speed, offset: m?.offset ?? 0, cycle: speed * p.duration });
  }
  loco.sort((a, b) => a.speed - b.speed);
  return { parts, loco, bones };
}

// Library = the clips of assets/ual.glb plus the library skeleton's pelvis rest offset (for the ratio above).
export function libraryFrom(gltf) {
  let pelvisRestY = null;
  gltf.scene.traverse((o) => { if (o.name === BONES.pelvis && pelvisRestY == null) pelvisRestY = o.position.length(); });
  return { clips: gltf.animations, pelvisRestY };
}

// ── animator ──────────────────────────────────────────────────────────────────

const LOOP_ROLES = new Set(['idle', 'walk', 'run', 'sprint', 'fall', 'aim_gun', 'idle_gun', 'idle_melee', 'zombie_walk', 'zombie_idle']);

export class Animator {
  constructor(obj, bound) {
    this.obj = obj;
    this.mixer = new THREE.AnimationMixer(obj);
    this.parts = bound.parts;
    this.bones = bound.bones;
    this.phase = 0;
    this.speed = 0;
    this.dead = false;
    this.airborne = 0;
    this.airTime = 0;
    this.aimW = 0;
    this.aimTarget = 0;
    this.oneShots = []; // newest first: {role, actions, w, parts, fadeIn, fadeOut, ts, hold, fading, onEnd}
    const pair = (role, timeScale = 1) => {
      const p = this.parts[role];
      if (!p) return null;
      const make = (clip) => {
        const a = this.mixer.clipAction(clip);
        a.setLoop(LOOP_ROLES.has(role) ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        a.clampWhenFinished = true;
        a.timeScale = timeScale;
        a.setEffectiveWeight(0);
        return a;
      };
      return { upper: make(p.upper), lower: make(p.lower), duration: p.duration };
    };
    this.pair = pair;
    this.idle = pair('idle');
    this.loco = bound.loco.map((l) => ({ ...l, actions: pair(l.role, 0), w: 0 }));
    this.air = { jump: pair('jump'), fall: pair('fall'), w: 0, jw: 0 };
    this.aim = pair('aim_gun');
    for (const p of [this.idle, ...this.loco.map((l) => l.actions), this.air.jump, this.air.fall, this.aim]) {
      if (p) { p.upper.play(); p.lower.play(); }
    }
    this.idleW = 1;
    // the weights above reach the bones with the first update only: without it the rig stands in its bind pose (the
    // UAL T-pose) for as long as nobody ticks it (the hero behind the briefing, a round held for the viewer's first
    // input, an NPC an authored world never ticks)
    this.update(0);
  }

  has(role) { return !!this.parts[role]; }
  duration(role) { return this.parts[role]?.duration ?? 0; }

  // A one-shot clip. parts: 'upper' (legs keep moving), 'full', or 'auto' (full when standing, upper when moving).
  // timeScale stretches it, e.g. to land an attack's impact on a gameplay beat. Returns the clip length in seconds.
  play(role, { parts = 'auto', timeScale = 1, fadeIn = 0.08, fadeOut = 0.18, hold = false, onEnd = null } = {}) {
    const p = this.parts[role];
    if (!p || this.dead) return 0;
    for (const s of this.oneShots) s.fading = true;
    const actions = { upper: this.mixer.clipAction(p.upper), lower: this.mixer.clipAction(p.lower) };
    for (const a of [actions.upper, actions.lower]) {
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.timeScale = timeScale;
      a.setEffectiveWeight(0);
      a.play();
    }
    // the same clip restarted: reuse its slot instead of fading an action that is also the new one
    this.oneShots = this.oneShots.filter((s) => s.actions.upper !== actions.upper);
    this.oneShots.unshift({ role, actions, w: 0, parts, fadeIn, fadeOut, ts: timeScale, hold, fading: false, onEnd, duration: p.duration });
    return p.duration / timeScale;
  }

  // Death: full-body clip held on its last frame. Returns its length (s) so the caller can fade the body after.
  die() {
    if (this.dead) return 0;
    const len = this.play('death', { parts: 'full', fadeIn: 0.1, hold: true });
    this.dead = true;
    return len;
  }

  // Back to idle for a pooled actor that died: one-shots dropped, opacity restored.
  revive() {
    for (const s of this.oneShots) { s.actions.upper.stop(); s.actions.lower.stop(); }
    this.oneShots = [];
    this.dead = false;
    this.speed = 0;
    fadeOut(this.obj, 1);
  }

  // Aim pose on the upper body (gun weapons) while the player fires.
  setAiming(on) { this.aimTarget = on && this.aim ? 1 : 0; }

  update(dt, { speed = 0, grounded = true, vy = 0 } = {}) {
    const k = (rate) => 1 - Math.exp(-rate * dt);
    this.speed = speed;
    // locomotion weights: piecewise-linear in speed between the clips' natural speeds
    const target = new Array(this.loco.length).fill(0);
    let idleT = 0;
    if (this.dead || !this.loco.length) idleT = 1;
    else if (speed <= this.loco[0].speed) {
      const f = speed / this.loco[0].speed;
      target[0] = f; idleT = 1 - f;
    } else {
      let i = 0;
      while (i < this.loco.length - 1 && speed > this.loco[i + 1].speed) i++;
      if (i === this.loco.length - 1) target[i] = 1;
      else {
        const f = (speed - this.loco[i].speed) / (this.loco[i + 1].speed - this.loco[i].speed);
        target[i] = 1 - f; target[i + 1] = f;
      }
    }
    this.idleW += (idleT - this.idleW) * k(9);
    this.loco.forEach((l, i) => { l.w += (target[i] - l.w) * k(9); });
    // shared phase: advance by distance over the blended cycle length, so planted feet match the ground speed
    const mw = this.loco.reduce((s, l) => s + l.w, 0);
    if (mw > 1e-3) this.phase = (this.phase + (dt * speed) / (this.loco.reduce((s, l) => s + l.w * l.cycle, 0) / mw)) % 1;
    for (const l of this.loco) {
      const t = ((this.phase + l.offset) % 1) * l.actions.duration;
      l.actions.upper.time = l.actions.lower.time = t;
    }
    // air
    this.airTime = grounded ? 0 : this.airTime + dt;
    const inAir = !this.dead && !grounded && this.airTime > 0.08;
    if (this.air.wasInAir && grounded && !this.dead && this.air.peakFall > 4) this.play('land', { parts: 'auto', fadeIn: 0.03, fadeOut: 0.25 });
    this.air.peakFall = inAir ? Math.max(this.air.peakFall ?? 0, -vy) : 0;
    this.air.wasInAir = inAir;
    this.air.w += ((inAir && (this.air.jump || this.air.fall) ? 1 : 0) - this.air.w) * k(inAir ? 14 : 10);
    this.air.jw += ((vy > 0.5 ? 1 : 0) - this.air.jw) * k(10);
    if (!this.air.jump) this.air.jw = 0;
    if (!this.air.fall) this.air.jw = 1;
    if (this.wasGrounded && !grounded && vy > 0.5 && this.air.jump) for (const a of [this.air.jump.upper, this.air.jump.lower]) a.reset().play();
    this.wasGrounded = grounded;
    // aim
    this.aimW += (this.aimTarget - this.aimW) * k(14);
    // one-shots: fade in, hold, fade out before the end
    for (const s of this.oneShots) {
      const time = s.actions.upper.time;
      const ending = !s.hold && time >= s.duration - s.fadeOut * s.ts;
      if (s.fading || ending) s.w = Math.max(0, s.w - dt / s.fadeOut);
      else s.w = Math.min(1, s.w + dt / s.fadeIn);
      if (s.w <= 0 && (s.fading || ending)) {
        s.done = true;
        if (!s.fading) s.onEnd?.();
      }
    }
    for (const s of this.oneShots) if (s.done) { s.actions.upper.stop(); s.actions.lower.stop(); }
    this.oneShots = this.oneShots.filter((s) => !s.done);
    this.applyWeights();
    this.mixer.update(dt);
  }

  // Per body part, layers take what they want of the weight that is left, top layer first: one-shots (newest
  // first), aim, air; locomotion gets the rest, split by its blend weights. Every part sums to exactly 1.
  applyWeights() {
    const still = this.loco.length ? 1 - Math.min(1, this.speed / this.loco[0].speed) : 1;
    for (const part of ['upper', 'lower']) {
      let rest = 1;
      const layer = (pairs) => { // [[action pair, weight]] sharing one slice of what is left
        const total = Math.min(1, pairs.reduce((s, [, w]) => s + w, 0));
        const slice = rest * total;
        for (const [pr, w] of pairs) pr?.[part].setEffectiveWeight(total > 0 ? slice * (w / Math.max(total, pairs.reduce((s, [, x]) => s + x, 0))) : 0);
        rest -= slice;
      };
      for (const s of this.oneShots) layer([[s.actions, s.w * (part === 'upper' || s.parts === 'full' ? 1 : s.parts === 'auto' ? still : 0)]]);
      layer([[this.aim, part === 'upper' ? this.aimW : 0]]);
      layer([[this.air.jump, this.air.w * this.air.jw], [this.air.fall, this.air.w * (1 - this.air.jw)]]);
      const sum = this.idleW + this.loco.reduce((s, l) => s + l.w, 0) || 1;
      layer([[this.idle, this.idleW / sum], ...this.loco.map((l) => [l.actions, l.w / sum])]);
    }
  }

  dispose() { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.obj); }
}

// ── weapons ───────────────────────────────────────────────────────────────────

const WEAPON_LENGTH = { melee: 1.0, gun: 0.7 }; // m, for a 1.8 m character (a carbine; 0.42 read as a pistol)

// A weapon GLB scene in a holder whose origin is the grip and whose +Z is the blade/barrel, `length` long.
// Contract-shaped GLBs (long axis +Z, grip near z = 0) are kept; raw Hunyuan meshes of the upright weapon image
// (long axis Y, grip at the bottom) are turned so +Y becomes +Z.
export function prepareWeapon(scene, type = 'melee') {
  const holder = new THREE.Group();
  const turn = new THREE.Group();
  turn.add(scene);
  holder.add(turn);
  scene.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const long = size.z >= size.x && size.z >= size.y ? 'z' : size.y >= size.x ? 'y' : 'x';
  const contract = long === 'z' && box.min.z > -0.2 * size.z;
  if (!contract) {
    if (long === 'y') turn.rotation.x = Math.PI / 2; // +Y -> +Z, the grip (bottom) at -Z
    else if (long === 'x') turn.rotation.y = -Math.PI / 2; // +X -> +Z
    else turn.rotation.y = Math.PI; // grip at the far end
  }
  turn.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(turn);
  const len = Math.max(1e-3, box.max.z - box.min.z);
  const c = box.getCenter(new THREE.Vector3());
  const grip = contract ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(c.x, c.y, box.min.z + len * (type === 'gun' ? 0.22 : 0.09));
  const s = WEAPON_LENGTH[type] / len;
  turn.position.copy(grip).multiplyScalar(-s);
  turn.scale.setScalar(s);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, (box.max.z - grip.z) * s);
  holder.add(muzzle);
  scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  return { holder, muzzle };
}

// Puts a prepared weapon in the right palm. The grip frame comes from the hand's own finger bones, so it works on
// any UAL rig: melee blades leave the fist on the thumb side (across the knuckles), gun barrels point along the
// fingers with the top of the gun toward the index finger.
export function attachWeapon(obj, weapon, type = 'melee', height = 1.8) {
  const bones = boneMap(obj);
  const hand = bones.get(BONES.handR), mid = bones.get(BONES.middleR), idx = bones.get(BONES.indexR), pinky = bones.get(BONES.pinkyR);
  if (!hand || !mid || !idx || !pinky) return false;
  const f = mid.position.clone().normalize();
  const across = idx.position.clone().sub(pinky.position).normalize();
  const z = (type === 'gun' ? f : across).clone();
  const y0 = type === 'gun' ? across : f;
  const y = y0.clone().addScaledVector(z, -y0.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  const basis = new THREE.Matrix4().makeBasis(x, y, z);
  const mount = new THREE.Group();
  mount.quaternion.setFromRotationMatrix(basis);
  // palm centre: halfway to the middle knuckle, nudged toward the palm (the side the thumb bends to)
  const palmN = new THREE.Vector3().crossVectors(f, across).normalize();
  const thumb = bones.get(BONES.thumbR);
  if (thumb && palmN.dot(thumb.position) < 0) palmN.negate();
  mount.position.copy(mid.position).multiplyScalar(0.5).addScaledVector(palmN, mid.position.length() * 0.35);
  obj.updateMatrixWorld(true);
  const handScale = hand.getWorldScale(new THREE.Vector3()).x;
  mount.scale.setScalar((height / 1.8) / handScale);
  mount.add(weapon.holder);
  hand.add(mount);
  return true;
}

// Fades a model out (death): clones its materials once so shared clips/materials of other enemies stay opaque.
export function fadeOut(obj, alpha) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.fadeMats) {
      o.material = [o.material].flat().map((m) => { const c = m.clone(); c.transparent = true; c.depthWrite = true; return c; });
      if (o.material.length === 1) o.material = o.material[0];
      o.userData.fadeMats = true;
    }
    for (const m of [o.material].flat()) { m.opacity = alpha; m.transparent = alpha < 1; }
    o.castShadow = alpha >= 1;
  });
}
