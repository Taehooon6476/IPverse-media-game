// Car motion for any car body: wheels that roll with the speed (front ones steer) and a body that pitches on
// throttle and brakes, rolls in turns and bounces a little on the road.
//   kit cars    have separate wheel nodes (wheel-front-left …): they are given pivots and spun
//   generated   cars (one Hunyuan3D mesh, from race.js carBody) are split: the triangles inside the four wheel
//               cylinders at the bottom corners become their own meshes around their axles; the rest is the body
// Coordinates: the car group's local frame, forward −Z, axle along X, ground at y 0.
import { THREE, damp } from './world.js';

const tmp = new THREE.Vector3(), e0 = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

/** Build the rig on a car group (call once, after its visual is in place). Returns the rig (also group.userData.rig). */
export function rigCar(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const named = [];
  group.traverse((n) => { if (/wheel/i.test(n.name) && n.children.length + (n.isMesh ? 1 : 0) > 0) named.push(n); });
  const body = new THREE.Group(); // pitch/roll pivot: everything that is not a wheel moves under it
  const wheels = [];
  if (named.length >= 2) {
    // kit car: pivot each wheel node at its own centre, keep everything else under the body group
    for (const node of named) {
      const box = new THREE.Box3().setFromObject(node);
      const c = box.getCenter(new THREE.Vector3()).applyMatrix4(inv);
      const steer = new THREE.Group(), spin = new THREE.Group();
      steer.position.copy(c); steer.add(spin);
      node.updateMatrixWorld(true);
      const m = new THREE.Matrix4().multiplyMatrices(inv, node.matrixWorld);
      node.removeFromParent();
      m.premultiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      m.decompose(node.position, node.quaternion, node.scale);
      spin.add(node);
      wheels.push({ steer, spin, front: /front/i.test(node.name), radius: Math.max(.2, (box.max.y - box.min.y) / 2) });
    }
    for (const child of [...group.children]) body.add(child);
    group.add(body);
    for (const w of wheels) group.add(w.steer);
  } else {
    splitGenerated(group, body, wheels, inv);
  }
  const rig = { body, wheels, pitch: 0, roll: 0, phase: Math.random() * 6, lastSpeed: 0, lastYaw: null };
  group.userData.rig = rig;
  return rig;
}

function splitGenerated(group, body, wheels, inv) {
  // bake every mesh into the group's frame, then cut the four wheel cylinders out of the triangle soup
  const meshes = [];
  group.traverse((n) => { if (n.isMesh) meshes.push(n); });
  const baked = meshes.map((m) => {
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    return { g, material: m.material };
  });
  for (const child of [...group.children]) group.remove(child);
  const box = new THREE.Box3();
  for (const { g } of baked) { g.computeBoundingBox(); box.union(g.boundingBox); }
  const size = box.getSize(new THREE.Vector3());
  const r = Math.min(size.y * .24, size.z * .1), tire = size.x * .16;
  const axles = [box.min.z + size.z * .19, box.max.z - size.z * .19]; // front (−Z) and rear
  const centres = [];
  for (const z of axles) for (const side of [-1, 1]) centres.push(new THREE.Vector3(side > 0 ? box.max.x - tire / 2 : box.min.x + tire / 2, box.min.y + r, z));
  // the guess above is only near the real wheel: recentre each on the tyre it found (a pivot off the hub makes the
  // wheel wobble). The tyre's bottom sits on the ground, so its height comes from its length (no arch above it).
  const radii = centres.map((c) => {
    let z0 = Infinity, z1 = -Infinity;
    for (const { g } of baked) {
      const P = g.attributes.position;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        if (Math.abs(x - c.x) < tire * .6 && y < box.min.y + r * .25 && Math.abs(z - c.z) < r * 1.3) { z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      }
    }
    if (!(z1 > z0)) return r;
    // the bottom quarter-radius slice spans a chord of the tyre (0.66 r half-length), not its full length
    const half = (z1 - z0) / 2 / Math.sqrt(1 - .75 * .75), rr = THREE.MathUtils.clamp(half, r * .7, r * 1.35);
    c.z = (z0 + z1) / 2; c.y = box.min.y + rr;
    return rr;
  });
  const parts = centres.map(() => baked.map(() => ({ pos: [], uv: [], nor: [] })));
  const rest = baked.map(() => ({ pos: [], uv: [], nor: [] }));
  baked.forEach(({ g }, gi) => {
    const P = g.attributes.position, U = g.attributes.uv, N = g.attributes.normal;
    for (let t = 0; t < P.count; t += 3) {
      tmp.set(0, 0, 0);
      for (let k = 0; k < 3; k++) tmp.x += P.getX(t + k) / 3, tmp.y += P.getY(t + k) / 3, tmp.z += P.getZ(t + k) / 3;
      // a flat face at the very bottom is the generator's floor slab, not tyre: it stays with the body
      e1.fromBufferAttribute(P, t + 1).sub(e0.fromBufferAttribute(P, t)); e2.fromBufferAttribute(P, t + 2).sub(e0);
      const flat = Math.abs(e1.cross(e2).normalize().y) > .9 && tmp.y < box.min.y + r * .3;
      const wi = flat ? -1 : centres.findIndex((c, ci) => Math.abs(tmp.x - c.x) < tire * .6 && Math.hypot(tmp.y - c.y, tmp.z - c.z) < radii[ci] * .98);
      const out = wi >= 0 ? parts[wi][gi] : rest[gi];
      for (let k = 0; k < 3; k++) {
        const c = wi >= 0 ? centres[wi] : null;
        out.pos.push(P.getX(t + k) - (c?.x ?? 0), P.getY(t + k) - (c?.y ?? 0), P.getZ(t + k) - (c?.z ?? 0));
        if (U) out.uv.push(U.getX(t + k), U.getY(t + k));
        if (N) out.nor.push(N.getX(t + k), N.getY(t + k), N.getZ(t + k));
      }
    }
  });
  const meshOf = (d, material) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
    if (d.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
    if (d.nor.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(d.nor, 3)); else g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, material); mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  };
  rest.forEach((d, gi) => { if (d.pos.length) body.add(meshOf(d, baked[gi].material)); });
  group.add(body);
  centres.forEach((c, wi) => {
    const tris = parts[wi].reduce((n, d) => n + d.pos.length / 9, 0);
    if (tris < 24) { parts[wi].forEach((d, gi) => { if (d.pos.length) { const m = meshOf(d, baked[gi].material); m.position.copy(c); body.add(m); } }); return; }
    const steer = new THREE.Group(), spin = new THREE.Group();
    steer.position.copy(c); steer.add(spin); group.add(steer);
    parts[wi].forEach((d, gi) => { if (d.pos.length) spin.add(meshOf(d, baked[gi].material)); });
    wheels.push({ steer, spin, front: wi < 2, radius: radii[wi] });
  });
}

/** Per frame: speed m/s (+ forward), steer −1…1 or a steering angle in radians, the car's yaw. */
export function driveRig(rig, dt, { speed = 0, steer = 0, yaw = null }) {
  if (!rig || dt <= 0) return;
  for (const w of rig.wheels) {
    w.spin.rotation.x -= speed / w.radius * dt; // rolling forward (−Z) turns the top of the wheel forward
    if (w.front) w.steer.rotation.y = damp(w.steer.rotation.y, -steer, 12, dt); // steer: the wheel angle in radians, + = right
  }
  const accel = (speed - rig.lastSpeed) / dt;
  rig.lastSpeed = speed;
  const yawRate = yaw == null || rig.lastYaw == null ? 0 : Math.atan2(Math.sin(yaw - rig.lastYaw), Math.cos(yaw - rig.lastYaw)) / dt;
  rig.lastYaw = yaw;
  rig.pitch = damp(rig.pitch, THREE.MathUtils.clamp(accel * .006, -.06, .05), 6, dt); // nose up on throttle, dips on brakes
  rig.roll = damp(rig.roll, THREE.MathUtils.clamp(-yawRate * Math.abs(speed) * .004, -.07, .07), 6, dt); // leans out of the turn
  rig.phase += dt * (4 + Math.abs(speed) * .6);
  rig.body.rotation.x = rig.pitch;
  rig.body.rotation.z = rig.roll;
  rig.body.position.y = Math.abs(speed) > .5 ? Math.sin(rig.phase) * .012 : 0; // road shimmer
}
