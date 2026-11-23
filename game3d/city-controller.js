// Framework-independent arcade vehicle physics. No DOM, Three.js, asset loading
// or debug position setters. The game owns occupancy, actor/camera and E input.
//
// Coordinate convention matches CameraRig: yaw 0 faces -Z; positive steer means
// right, so forward steering decreases yaw. Render body.rotation.y = yaw and
// front-wheel pivot.rotation.y = -steeringAngle.
//
// collide(candidate, radius, previous): true = blocked; false/undefined = free;
// a returned {x,z} or mutation of candidate resolves contact. clampBounds uses
// the same convention. Adapters receive fresh plain objects, never live state.
// cars(): the other cars [{id, x, z, yaw, length, width}]. They are not walls:
// this car slides off them and loses the speed it drove into them, and it never
// moves deeper into one, so an overlap the other car caused never pins it.

const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = .25;
const MAX_SWEEP_DISTANCE = .18;
const EPSILON = 1e-10;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const wrap = (value) => Math.atan2(Math.sin(value), Math.cos(value));
const towardZero = (value, amount) => Math.sign(value) * Math.max(0, Math.abs(value) - amount);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const copy = (point) => ({ x: point.x, z: point.z });
const point = (value) => value != null && Number.isFinite(value.x) && Number.isFinite(value.z);
function finite(value, name, lo, hi) {
  if (!Number.isFinite(value) || value < lo || value > hi) throw new RangeError(`${name} must be finite in ${lo}..${hi}`);
  return value;
}

/** A car's footprint as a capsule: the segment a-b along its length, round ends of radius = half its width. */
export function footprint({ x, z, yaw = 0, length = 4.4, width = 1.9 }) {
  const r = width / 2, h = Math.max(0, length / 2 - r), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  return { ax: x + fx * h, az: z + fz * h, bx: x - fx * h, bz: z - fz * h, r, x, z };
}

/** How deep footprint a sits in footprint b (<= 0: apart) and the unit normal (nx, nz) that pushes a out of b. */
export function carOverlap(a, b) {
  // closest points of the two segments (Ericson, Real-Time Collision Detection 5.1.9)
  const d1x = a.bx - a.ax, d1z = a.bz - a.az, d2x = b.bx - b.ax, d2z = b.bz - b.az, rx = a.ax - b.ax, rz = a.az - b.az;
  const aa = d1x * d1x + d1z * d1z, e = d2x * d2x + d2z * d2z, f = d2x * rx + d2z * rz;
  let s = 0, t = 0;
  if (aa <= EPSILON && e > EPSILON) t = clamp(f / e, 0, 1);
  else if (aa > EPSILON) {
    const c = d1x * rx + d1z * rz;
    if (e <= EPSILON) s = clamp(-c / aa, 0, 1);
    else {
      const bb = d1x * d2x + d1z * d2z, denom = aa * e - bb * bb;
      s = denom > EPSILON ? clamp((bb * f - c * e) / denom, 0, 1) : 0;
      t = (bb * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / aa, 0, 1); } else if (t > 1) { t = 1; s = clamp((bb - c) / aa, 0, 1); }
    }
  }
  let nx = a.ax + d1x * s - (b.ax + d2x * t), nz = a.az + d1z * s - (b.az + d2z * t);
  let d = Math.hypot(nx, nz);
  const depth = a.r + b.r - d;
  if (d < 1e-6) { // crossing segments: push apart along the line between the centres (or sideways)
    nx = a.x - b.x; nz = a.z - b.z; d = Math.hypot(nx, nz);
    if (d < 1e-6) { nx = -d1z; nz = d1x; d = Math.hypot(nx, nz) || 1; if (!aa) { nx = 1; nz = 0; d = 1; } }
  }
  return { depth, nx: nx / d, nz: nz / d };
}

/** Which end of a generated car's long axis is its nose: +1 the + end, -1 the - end, 0 no clear cue. positions is a
 * flat [x, y, z, ...] list (+Y up). The tail is the taller end (a spoiler, the roof line falling to a boot or hatch);
 * the nose is the low, sloping end. A mesh's build orientation says nothing: image-to-3D models come out either way. */
export function noseSign(positions, axis = 'z') {
  const k = axis === 'x' ? 0 : 2, n = Math.floor((positions?.length ?? 0) / 3);
  if (n < 8) return 0;
  let lo = Infinity, hi = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = positions[i * 3 + k], y = positions[i * 3 + 1];
    lo = Math.min(lo, a); hi = Math.max(hi, a); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (!(hi - lo > EPSILON && y1 - y0 > EPSILON)) return 0;
  const minus = [], plus = [];
  for (let i = 0; i < n; i++) {
    const t = (positions[i * 3 + k] - lo) / (hi - lo), h = (positions[i * 3 + 1] - y0) / (y1 - y0);
    if (t < .25) minus.push(h); else if (t > .75) plus.push(h);
  }
  const top = (list) => list.sort((p, q) => p - q)[Math.floor(list.length * .9)] ?? 0; // the end's roof line
  const diff = top(minus) - top(plus);
  return Math.abs(diff) < .04 ? 0 : diff > 0 ? 1 : -1;
}

export class VehicleController {
  constructor({
    id, position, yaw = 0, maxSpeed = 22, reverseMaxSpeed = 6.5,
    collisionRadius = 2.25, wheelRadius = .34, wheelBase = 2.7, length = 4.4, width = 1.9,
    acceleration = 8.5, reverseAcceleration = 5, brakeDeceleration = 18,
    rollingResistance = 1.1, drag = .009, maxSteeringAngle = .58,
    maxLateralAcceleration = 8, steeringResponse = 10,
  } = {}, { collide, clampBounds, cars } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('Vehicle id is required');
    if (!point(position)) throw new TypeError('Vehicle position requires finite x,z');
    Object.assign(this, {
      id, position: copy(position), yaw: wrap(finite(yaw, 'yaw', -1e6, 1e6)),
      maxSpeed: finite(maxSpeed, 'maxSpeed', .1, 60),
      reverseMaxSpeed: finite(reverseMaxSpeed, 'reverseMaxSpeed', .1, 20),
      collisionRadius: finite(collisionRadius, 'collisionRadius', .1, 10),
      wheelRadius: finite(wheelRadius, 'wheelRadius', .05, 2),
      wheelBase: finite(wheelBase, 'wheelBase', .5, 8),
      length: finite(length, 'length', .5, 12), width: finite(width, 'width', .3, 5),
      acceleration: finite(acceleration, 'acceleration', .1, 40),
      reverseAcceleration: finite(reverseAcceleration, 'reverseAcceleration', .1, 30),
      brakeDeceleration: finite(brakeDeceleration, 'brakeDeceleration', .1, 80),
      rollingResistance: finite(rollingResistance, 'rollingResistance', 0, 10),
      drag: finite(drag, 'drag', 0, .5),
      maxSteeringAngle: finite(maxSteeringAngle, 'maxSteeringAngle', .05, 1),
      maxLateralAcceleration: finite(maxLateralAcceleration, 'maxLateralAcceleration', .5, 30),
      steeringResponse: finite(steeringResponse, 'steeringResponse', .1, 40),
      collide, clampBounds, cars,
    });
    for (const [name, callback] of [['collide', collide], ['clampBounds', clampBounds], ['cars', cars]])
      if (callback != null && typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
    this.speed = 0;
    this.distance = 0;
    this.wheelRotation = 0;
    this.steeringAngle = 0;
    this.accumulator = 0;
    this.collided = false;
    this.contacts = [];
    this.simulatedSeconds = 0;
    this.droppedSeconds = 0; // explicit hitch cap; never counted as driven distance
  }

  step(dt, { throttle = 0, steer = 0, brake = false } = {}) {
    finite(dt, 'dt', 0, 1e6);
    if (!Number.isFinite(throttle) || !Number.isFinite(steer)) throw new TypeError('Vehicle inputs must be finite');
    const input = { throttle: clamp(throttle, -1, 1), steer: clamp(steer, -1, 1), brake: !!brake };
    const elapsed = Math.min(dt, MAX_FRAME_DT);
    this.droppedSeconds += dt - elapsed;
    this.accumulator += elapsed;
    this.collided = false;
    this.contacts = [];
    // the other cars stand still during this car's substeps; their footprints are taken once per frame
    this.others = (this.cars?.() ?? []).filter((o) => o && point(o)).map((o) => ({ id: o.id, shape: footprint(o) }));
    while (this.accumulator + EPSILON >= FIXED_DT) {
      this.integrate(FIXED_DT, input);
      this.accumulator = Math.max(0, this.accumulator - FIXED_DT);
      this.simulatedSeconds += FIXED_DT;
    }
    return this.stateSnapshot();
  }

  integrate(dt, input) {
    const oldSpeed = this.speed;
    if (input.brake) {
      this.speed = towardZero(this.speed, this.brakeDeceleration * dt);
    } else if (input.throttle * this.speed < 0 && Math.abs(this.speed) > .15) {
      // Opposite input first brakes; it cannot instantly flip into reverse.
      this.speed = towardZero(this.speed, this.brakeDeceleration * Math.abs(input.throttle) * dt);
    } else {
      const force = input.throttle * (input.throttle < 0 ? this.reverseAcceleration : this.acceleration);
      this.speed += force * dt;
    }
    this.speed = towardZero(this.speed, (this.rollingResistance + this.drag * this.speed * this.speed) * dt);
    this.speed = clamp(this.speed, -this.reverseMaxSpeed, this.maxSpeed);
    if (Math.abs(this.speed) < .015 && input.throttle === 0) this.speed = 0;
    // Reduce available steering at speed; the vehicle cannot pivot in place.
    const limit = Math.min(this.maxSteeringAngle,
      Math.atan(this.maxLateralAcceleration * this.wheelBase / Math.max(1, this.speed * this.speed)));
    const desiredSteering = input.steer * limit;
    this.steeringAngle += (desiredSteering - this.steeringAngle) * (1 - Math.exp(-this.steeringResponse * dt));
    const velocity = (oldSpeed + this.speed) / 2;
    const travel = velocity * dt;
    if (Math.abs(travel) < EPSILON) return;
    const turn = -velocity / this.wheelBase * Math.tan(this.steeringAngle) * dt;
    const subdivisions = Math.max(1, Math.ceil(Math.abs(travel) / MAX_SWEEP_DISTANCE));
    const segment = travel / subdivisions, segmentTurn = turn / subdivisions;
    for (let i = 0; i < subdivisions; i++) {
      const previous = copy(this.position);
      const midpointYaw = this.yaw + segmentTurn / 2;
      const requested = {
        x: previous.x - Math.sin(midpointYaw) * segment,
        z: previous.z - Math.cos(midpointYaw) * segment,
      };
      // other cars first (slide off them), then walls and bounds stay authoritative
      const slid = this.slide(requested, previous, this.yaw, this.yaw + segmentTurn);
      const contact = this.resolveMovement(slid, previous, this.collisionRadius);
      if (contact.blocked) {
        this.speed = 0;
        this.collided = true;
        break;
      }
      const accepted = distance(previous, contact.position);
      // Only accepted motion turns the chassis. Contact cannot turn a parked car.
      const steered = segmentTurn * Math.min(1, accepted / Math.abs(segment));
      if (slid !== requested) this.bump(requested, previous, contact.position, steered);
      this.position = contact.position;
      this.distance += accepted;
      this.wheelRotation = wrap(this.wheelRotation + Math.sign(segment) * accepted / this.wheelRadius);
      this.yaw = wrap(this.yaw + steered);
      if (contact.adjusted) {
        this.speed = 0;
        this.collided = true;
        break;
      }
    }
  }

  /** A hit on another car. Glancing (under 45°): the car is deflected along it and keeps the speed that points
   * along it, so it scrapes past instead of nosing in again every substep; the deflection may not swing it deeper
   * into anything. Square on: that speed is gone. */
  bump(requested, previous, got, steered) {
    const mx = requested.x - previous.x, mz = requested.z - previous.z, ax = got.x - previous.x, az = got.z - previous.z;
    const wanted = Math.hypot(mx, mz), moved = Math.hypot(ax, az);
    const cos = moved > EPSILON ? (mx * ax + mz * az) / (wanted * moved) : 0;
    const deflect = wrap(Math.atan2(-ax, -az) - Math.atan2(-mx, -mz)); // forward is (-sin, -cos)
    const after = footprint({ x: got.x, z: got.z, yaw: this.yaw + deflect + steered, length: this.length, width: this.width });
    if (cos > Math.SQRT1_2 && this.near.every((o) => carOverlap(after, o.shape).depth <= o.allowed + 1e-9)) {
      this.yaw = wrap(this.yaw + deflect);
      this.speed *= cos;
    } else this.speed *= clamp((mx * ax + mz * az) / (wanted * wanted), 0, 1);
    this.collided = true;
  }

  /** The candidate slides along the other cars' footprints and never ends deeper in one than it already was. */
  slide(candidate, previous, fromYaw, toYaw) {
    if (!this.others?.length) return candidate;
    const self = (p, yaw) => footprint({ x: p.x, z: p.z, yaw, length: this.length, width: this.width });
    const reach = this.length + 6, from = self(previous, fromYaw);
    this.near = this.others.filter((o) => Math.hypot(o.shape.x - previous.x, o.shape.z - previous.z) < reach)
      .map((o) => ({ ...o, allowed: Math.max(0, carOverlap(from, o.shape).depth) }));
    let p = candidate;
    for (let pass = 0; pass < 2; pass++) for (const o of this.near) {
      const hit = carOverlap(self(p, toYaw), o.shape);
      if (hit.depth <= o.allowed + 1e-9) continue;
      p = { x: p.x + hit.nx * (hit.depth - o.allowed), z: p.z + hit.nz * (hit.depth - o.allowed) };
      if (!this.contacts.includes(o.id)) this.contacts.push(o.id);
    }
    return p;
  }

  resolveMovement(requested, previous, radius) {
    let candidate = copy(requested);
    let adjusted = false;
    for (const callback of [this.clampBounds, this.collide]) {
      if (!callback) continue;
      const before = copy(candidate);
      const result = callback(candidate, radius, copy(previous));
      if (result === true) return { blocked: true };
      if (result != null && typeof result === 'object') {
        if (!point(result)) throw new TypeError('Collision adapter must return finite x,z');
        candidate = copy(result);
      }
      if (!point(candidate)) throw new TypeError('Collision adapter produced a nonfinite position');
      adjusted ||= distance(before, candidate) > EPSILON;
    }
    // An adapter may resolve a small wall/bounds contact, never teleport the car.
    if (distance(previous, candidate) > distance(previous, requested) + 1e-6) return { blocked: true };
    return { blocked: false, adjusted, position: candidate };
  }

  getExitCandidates({ distance: requestedDistance = 2.8, playerRadius = .45,
    maxExitSpeed = .8, isBlocked } = {}) {
    finite(requestedDistance, 'exit distance', 0, 20);
    finite(playerRadius, 'playerRadius', .05, 3);
    finite(maxExitSpeed, 'maxExitSpeed', 0, 10);
    if (isBlocked != null && typeof isBlocked !== 'function') throw new TypeError('isBlocked must be a function');
    if (Math.abs(this.speed) > maxExitSpeed) return [];
    const separation = Math.max(requestedDistance, this.collisionRadius + playerRadius + .15);
    const forward = { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
    const right = { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) };
    const directions = [
      { side: 'left', x: -right.x, z: -right.z },
      { side: 'right', ...right },
      { side: 'rear', x: -forward.x, z: -forward.z },
      { side: 'front', ...forward },
    ];
    return directions.flatMap((direction) => {
      const candidate = {
        x: this.position.x + direction.x * separation,
        z: this.position.z + direction.z * separation,
      };
      for (const callback of [this.clampBounds, this.collide]) {
        if (!callback) continue;
        const probe = copy(candidate);
        const result = callback(probe, playerRadius, copy(candidate));
        if (result === true) return [];
        if (result != null && typeof result === 'object') {
          if (!point(result) || distance(candidate, result) > EPSILON) return [];
        }
        if (!point(probe) || distance(candidate, probe) > EPSILON) return [];
      }
      if (isBlocked?.(copy(candidate), playerRadius)) return [];
      return [{ ...candidate, side: direction.side }];
    });
  }

  canExit(options) { return this.getExitCandidates(options).length > 0; }

  stateSnapshot() {
    return {
      id: this.id, position: copy(this.position), yaw: this.yaw, speed: this.speed,
      distance: this.distance, wheelRotation: this.wheelRotation,
      steeringAngle: this.steeringAngle, collided: this.collided, contacts: [...this.contacts],
      simulatedSeconds: this.simulatedSeconds, droppedSeconds: this.droppedSeconds,
    };
  }
}
