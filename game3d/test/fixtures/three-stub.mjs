// Just enough of three.js for AuthoredMode's gameplay methods and World.makeActor's cutout billboard to run in Node:
// real Vector3 math, a Group that holds children, a plane mesh. Everything else (loaders, post passes) is an empty class;
// rendering never runs here.
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setY(y) { this.y = y; return this; }
  setScalar(s) { return this.set(s, s, s); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return this.multiplyScalar(1 / s); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { return this.divideScalar(this.length() || 1); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  distanceToSquared(v) { return (this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2; }
  fromArray(a) { [this.x, this.y, this.z] = a; return this; }
  toArray() { return [this.x, this.y, this.z]; }
  /** About the upright axis only (authored.js moveEntities turns a moving platform's travel by its rotation). */
  applyAxisAngle(axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), { x, z } = this;
    return this.set(x * c + z * s, this.y, z * c - x * s);
  }
}
export class Object3D {
  constructor() { this.position = new Vector3(); this.rotation = new Vector3(); this.scale = new Vector3(1, 1, 1); this.children = []; this.visible = true; }
  add(...objects) { this.children.push(...objects); return this; }
  remove(...objects) { this.children = this.children.filter((o) => !objects.includes(o)); return this; }
  traverse(visit) { visit(this); for (const child of this.children) child.traverse?.(visit); }
}
export class Group extends Object3D {}
// a cutout billboard (world.js makeActor): a plane that remembers how far it was moved, on a mesh
export class PlaneGeometry {
  constructor(width, height) { this.parameters = { width, height }; this.offset = new Vector3(); }
  translate(x, y, z) { this.offset.add(new Vector3(x, y, z)); return this; }
  rotateX() { return this; }
}
export class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.quaternion = { setFromUnitVectors() { return this; } }; }
}
export class MeshStandardMaterial { constructor(params = {}) { Object.assign(this, params); } dispose() {} }
export class MeshBasicMaterial extends MeshStandardMaterial {}
export const DoubleSide = 2;
export class Color { constructor(value) { this.value = value; } clone() { return new Color(this.value); } lerp() { return this; } multiplyScalar() { return this; } }
// world.js makeActor's model path: the bounds of a stand-in scene that says its own size ({size: [x, y, z]} metres at
// scale 1, standing on its origin)
export class Box3 {
  setFromObject(o) {
    const [x, y, z] = (o.size ?? [0, 0, 0]).map((side, i) => side * o.scale.toArray()[i]);
    this.min = new Vector3(-x / 2, 0, -z / 2).add(o.position);
    this.max = new Vector3(x / 2, y, z / 2).add(o.position);
    return this;
  }
  getSize(v) { return v.copy(this.max).sub(this.min); }
  getCenter(v) { return v.copy(this.min).add(this.max).multiplyScalar(.5); }
}
// anim.js Animator: a mixer that computes no pose. It keeps each action's weight, and `updates` lists, per update, the
// weight of every playing action (what a real mixer would write to the bones then).
export const LoopOnce = 2200, LoopRepeat = 2201;
export class AnimationMixer {
  constructor(root) { this.root = root; this.actions = new Map(); this.updates = []; }
  clipAction(clip) {
    if (!this.actions.has(clip)) {
      this.actions.set(clip, { clip, weight: 1, time: 0, playing: false, setLoop() { return this; },
        setEffectiveWeight(weight) { this.weight = weight; return this; }, play() { this.playing = true; return this; },
        stop() { this.playing = false; return this; }, reset() { this.time = 0; return this; } });
    }
    return this.actions.get(clip);
  }
  update() { this.updates.push(Object.fromEntries([...this.actions.values()].filter((a) => a.playing).map((a) => [a.clip.name, a.weight]))); }
  stopAllAction() {}
  uncacheRoot() {}
}
// a fight in an authored world (authored.js enemyShoot, updateBolts, blocked, warn): a ray with the two tests the
// bolts and the line of sight use, and the shapes a bolt and a wind-up ring are drawn with
export class Ray {
  constructor(origin = new Vector3(), direction = new Vector3(0, 0, -1)) { this.origin = origin; this.direction = direction; }
  /** Where the ray enters `box` ({min, max}), or null (the slab test, as three.js answers it). */
  intersectBox(box, target) {
    let near = -Infinity, far = Infinity;
    for (const k of ['x', 'y', 'z']) {
      const o = this.origin[k], d = this.direction[k];
      if (Math.abs(d) < 1e-12) { if (o < box.min[k] || o > box.max[k]) return null; continue; }
      const a = (box.min[k] - o) / d, b = (box.max[k] - o) / d;
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
      if (near > far) return null;
    }
    return far < 0 ? null : target.copy(this.origin).addScaledVector(this.direction, near >= 0 ? near : far);
  }
  closestPointToPoint(point, target) {
    return target.copy(this.origin).addScaledVector(this.direction, Math.max(0, point.clone().sub(this.origin).dot(this.direction)));
  }
}
class Shape { constructor(...args) { this.parameters = args; } rotateX() { return this; } dispose() {} }
export class RingGeometry extends Shape {}
export class SphereGeometry extends Shape {}
export class CapsuleGeometry extends Shape {}
export class OctahedronGeometry extends Shape {}
export class BoxGeometry extends Shape {}
export class RoomEnvironment {}
export class RoundedBoxGeometry {}
export class GLTFLoader {}
export class DRACOLoader {}
export class EffectComposer {}
export class RenderPass {}
export class UnrealBloomPass {}
export class ShaderPass {}
export class OutputPass {}
export class RGBELoader {}
// biome.js applySky and applyIndoor: the dome is a mesh that keeps what it was made of, the fog its numbers
export class GroundedSkybox extends Mesh { constructor(map, height, radius) { super({ parameters: { height, radius }, dispose() {} }, { map, dispose() {} }); } }
export class FogExp2 { constructor(color, density) { this.color = color; this.density = density; } }
export const clone = (o) => o;
export class CylinderGeometry { constructor(...args) { this.parameters = args; } }
export class PointLight extends Object3D { constructor(color, intensity = 1) { super(); this.color = color; this.intensity = intensity; } }
export class TorusGeometry { constructor(...args) { this.parameters = args; } }
export class ConeGeometry { constructor(...args) { this.parameters = args; } }
// race.js (the rivals' steering) and the modes a round is run on without a browser (fixtures/headless.mjs)
export const MathUtils = { clamp: (value, lo, hi) => Math.max(lo, Math.min(hi, value)) };
export class Sky {}
export const mergeGeometries = () => null;
