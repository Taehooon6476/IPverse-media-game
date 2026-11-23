// Open-track racing (world.track): a race on a photoreal biome (desert canyon, snow, volcanic, temple, forest…),
// not in the city grid. A smooth closed road runs through the race stage's ordered checkpoints, with curbs; the
// player drives from the grid on it (the user's own car model when an entity has car: 'player', else a kit car);
// rivals, the grid, gates, contact and the rank HUD come from race.js. Off the road a car loses grip (half throttle).
// Solid set pieces stand clear of the road (race.js clearRoad), and the rivals collide with them as the player's car does.
import { AuthoredMode } from './authored.js';
import { THREE, canvasTexture, clamp, damp } from './world.js';
import { VehicleController } from './city-controller.js';
import { RaceMixin, SAND, carBody, carSize, holdKeys } from './race.js';
import { driveRig, rigCar } from './carrig.js';

const KIT_URL = '/games/city-kit/v1/city-assets/commonassetcatalog.json';

export async function createTrack(world, spec, hud, actor) {
  const mode = new TrackMode(world, spec, hud, actor);
  try { await mode.loadCars(); await mode.build(); return mode; }
  catch (error) { mode.dispose(); throw error; }
}

export class TrackMode extends AuthoredMode {
  constructor(world, spec, hud, actor) {
    super(world, spec, hud, actor);
    this.track = spec.world.track;
    this.cars = []; this.rivals = []; this.kitCars = [];
    this.enterCount = 0;
    // ?autoplay=1 (the live broadcast): the built-in player races the car (botDrive)
    this.bot = typeof location !== 'undefined' && new URLSearchParams(location.search).get('autoplay') === '1';
    this.botReverse = this.botSlow = 0;
  }
  // the runtime's walking bot (runtime3d.js) stands aside: its fight keys would steer the car off the road
  get selfDriven() { return this.bot; }
  /** The built-in driver: the race's keys (race.js raceKeys) go through the same input as a player's. */
  botDrive(dt) {
    if (!this.bot || this.phase !== 'playing' || !this.activeCar) return;
    holdKeys(this.world.input, this.director.stage?.type === 'race' ? this.raceKeys(dt) : new Set());
  }
  /** The watchdog's unstick (runtime3d.js: 10 s without a gain): the car backs out of whatever holds it. */
  autoUnstick() { this.botReverse = 1.4; }
  // kit cars (CC0) are the fallback bodies when the design names no car model
  async loadCars() {
    try {
      const url = new URL(KIT_URL, location.origin);
      const catalog = await (await fetch(url)).json();
      const cars = (catalog.assets ?? []).filter((a) => ['vehicle', 'car'].includes(a.category)).slice(0, 6);
      this.kitCars = (await Promise.all(cars.map(async (a) => {
        const m = await this.world.loadModel(new URL(a.path, new URL('../', url)).href);
        return m ? { id: a.id, scene: m.scene, nativeForwardYaw: a.nativeForwardYaw ?? 0 } : null;
      }))).filter(Boolean);
    } catch { this.kitCars = []; }
  }
  makeCarGroup(kind) {
    const a = this.kitCars.find((k) => k.id.toLowerCase().includes(kind)) ?? this.kitCars[0];
    const group = new THREE.Group();
    if (a) {
      const visual = a.scene.clone(true), box = new THREE.Box3().setFromObject(visual), size = box.getSize(new THREE.Vector3());
      const scale = 1.65 / size.y; visual.scale.setScalar(scale);
      const c = box.getCenter(new THREE.Vector3());
      visual.position.set(-c.x * scale, -box.min.y * scale, -c.z * scale);
      visual.rotation.y = Math.PI - a.nativeForwardYaw;
      group.add(visual);
    } else {
      group.add(new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.1, 4.4), new THREE.MeshStandardMaterial({ color: this.accent })));
    }
    this.root.add(group);
    rigCar(group);
    group.userData.size = carSize(group);
    return group;
  }
  driving() { return true; }

  async build() {
    // the road first, through the race's checkpoints as the spec places them (the beacons and coins it targets), so
    // the solid set pieces are built clear of it (buildEntity)
    const stage = this.spec.mission.stages.find((s) => s.type === 'race');
    const byId = new Map(this.spec.world.entities.map((e) => [e.id, e]));
    this.buildRoad(stage ? stage.entityIds.map((id) => byId.get(id)).filter((e) => e && (e.kind === 'beacon' || e.pickup)) : []);
    this.roadside = this.clearRoad(this.spec.world.entities, this.spec.world);
    await super.build();
    this.raceSolids = this.boxes.filter((b) => b.min.y < 1.2); // what the cars hit (the collide adapter below), rivals too
    // the player's car, the user's model if one is cast as the player's car: at the spawn until startRace puts it on
    // the grid on the road
    const spawn = this.spec.world.spawn;
    const body = this.raceCarScene('player');
    const group = body ? carBody(body) : this.makeCarGroup('sedan');
    if (body) this.root.add(group);
    group.position.set(spawn.x, .06, spawn.z);
    const adapters = this.carAdapters();
    const car = { id: 'player_car', group, adapters, customBody: !!body,
      controller: new VehicleController({ id: 'player_car', position: { x: spawn.x, z: spawn.z }, yaw: 0, ...group.userData.size }, adapters) };
    this.cars.push(car);
    this.activeCar = car; this.actor.root.visible = false;
    this.player.update = (dt, input, rig) => this.drive(dt, input, rig);
    if (stage) this.startRace(stage);
    this.refreshHud(); // at the wheel now: the gauges a walker has (the dash, a crosshair) are off under the briefing too
  }
  /** What the player's car touches (city-controller.js adapters): a solid set piece stops it, the world's edge holds it
   * in, the rivals are cars to slide off. */
  carAdapters() {
    return {
      collide: (p, radius) => this.boxes.some((b) => p.x > b.min.x - radius && p.x < b.max.x + radius
        && p.z > b.min.z - radius && p.z < b.max.z + radius && b.min.y < 1.2),
      clampBounds: (p, radius) => {
        p.x = clamp(p.x, -this.spec.world.width / 2 + radius, this.spec.world.width / 2 - radius);
        p.z = clamp(p.z, -this.spec.world.depth / 2 + radius, this.spec.world.depth / 2 - radius);
      },
      cars: () => this.rivalCars(), // rivals are cars to slide off, not walls that pin the player
    };
  }
  /** The player's car for a frame, in place of the hero's walk: W/S the throttle (half of it off the asphalt), A/D the
   * steering, Space the brake. */
  drive(dt, input, rig) {
    const car = this.activeCar;
    const before = car.controller.stateSnapshot();
    const offRoad = this.offRoad(before.position);
    const s = car.controller.step(dt, {
      throttle: this.raceHold > 0 ? 0 : (Number(input.down('KeyW', 'ArrowUp')) - Number(input.down('KeyS', 'ArrowDown'))) * (offRoad ? SAND : 1),
      steer: Number(input.down('KeyD')) - Number(input.down('KeyA')),
      brake: input.down('Space'),
    });
    car.group.position.set(s.position.x, .06, s.position.z);
    car.group.rotation.y = s.yaw;
    driveRig(car.group.userData.rig, dt, { speed: s.speed, steer: s.steeringAngle, yaw: s.yaw });
    // dust off the rear tyres when the car slides through a fast corner or leaves the road
    if (Math.abs(s.speed) > 9 && (Math.abs(s.steeringAngle) > .22 || offRoad) && Math.random() < .5) {
      const back = new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw)).multiplyScalar(2);
      this.world.particles.emit(car.group.position.clone().add(back).setY(.3), { count: 3, color: offRoad ? '#4a3d2c' : '#3a3a3a', speed: 1.2, size: .35, life: .6 });
    }
    this.player.pos.set(s.position.x, 0, s.position.z);
    rig.yaw = damp(rig.yaw, s.yaw, 5, dt);
    this.lastVehicleSpeed = s.speed;
  }
  /** A solid set piece stands where clearRoad put it, clear of the road (moved, or left out with no room). */
  buildEntity(e) {
    const spot = this.roadside?.get(e.id);
    if (spot !== null) super.buildEntity(spot ? { ...e, ...spot } : e);
  }

  /** A closed Catmull-Rom road through the checkpoints, with red-white curbs and a centre line. */
  buildRoad(route) {
    this.roadPoints = [];
    if (route.length < 3) return;
    const width = this.track.roadWidth ?? 14;
    const curve = new THREE.CatmullRomCurve3(route.map((t) => new THREE.Vector3(t.x, 0, t.z)), true, 'centripetal');
    const n = Math.max(120, Math.round(curve.getLength() / 2));
    const pts = curve.getSpacedPoints(n);
    this.roadPoints = pts;
    const strip = (half, y, material, uvScale) => {
      const pos = [], uv = [], idx = [];
      pts.forEach((p, i) => {
        const t = curve.getTangentAt(Math.min(1, i / n)), side = new THREE.Vector3(-t.z, 0, t.x).normalize();
        const [a0, a1] = half;
        pos.push(p.x + side.x * a0, y, p.z + side.z * a0, p.x + side.x * a1, y, p.z + side.z * a1);
        uv.push(0, i * uvScale, 1, i * uvScale);
        if (i < pts.length - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, material); mesh.receiveShadow = true;
      this.root.add(mesh);
      return mesh;
    };
    this.roadTex = canvasTexture(128, (ctx, size) => {
      ctx.fillStyle = '#2d3036'; ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 900; i++) { ctx.fillStyle = `rgba(255,255,255,${Math.random() * .05})`; ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1); }
      ctx.fillStyle = '#e8d58a'; ctx.fillRect(size / 2 - 2, 0, 4, size / 2); // a dashed centre line
    }, { repeat: 1 });
    this.roadTex.wrapT = THREE.RepeatWrapping;
    this.curbTex = canvasTexture(32, (ctx, size) => {
      ctx.fillStyle = '#d8242b'; ctx.fillRect(0, 0, size, size / 2);
      ctx.fillStyle = '#bdbdbd'; ctx.fillRect(0, size / 2, size, size / 2);
    }, { repeat: 1 });
    this.curbTex.wrapT = THREE.RepeatWrapping;
    strip([-width / 2, width / 2], .03, new THREE.MeshStandardMaterial({ map: this.roadTex, roughness: .92 }), .25);
    const curb = new THREE.MeshStandardMaterial({ map: this.curbTex, roughness: .95 });
    strip([-width / 2 - 1.1, -width / 2], .05, curb, .5);
    strip([width / 2, width / 2 + 1.1], .05, curb, .5);
    this.roadHalf = width / 2 + 1.1;
    this.raceAside = this.roadHalf + 3.5; // a rival done racing parks this far from the road's centre line
  }
  /** A rival done racing parks off the asphalt beside the road: past the finish (or ahead of where it was when the
   * race ended), one spot per car on alternating sides, never on another stretch of the circuit or by a solid set piece
   * (where its contact circle could not reach the spot). */
  parkSpot(r, order) {
    const pts = this.roadPoints, n = pts?.length ?? 0;
    if (n < 3) return null;
    const from = r.finishedAt != null ? this.raceRoute.at(-1) : r.pos;
    let k = 0, best = Infinity;
    pts.forEach((q, i) => { const d = (q.x - from.x) ** 2 + (q.z - from.z) ** 2; if (d < best) { best = d; k = i; } });
    const spacing = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z) || 2; // the points run in checkpoint order
    const half = { x: this.spec.world.width / 2 - 3, z: this.spec.world.depth / 2 - 3 };
    const spots = [];
    for (const ahead of [22, 34, 14, 48]) for (const side of order % 2 ? [-1, 1] : [1, -1]) {
      const i = (k + Math.round((ahead + 9 * order) / spacing)) % n, a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
      const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1; // right of travel is (-tz, tx)
      spots.push({ x: clamp(pts[i].x - tz / tl * side * this.raceAside, -half.x, half.x),
        z: clamp(pts[i].z + tx / tl * side * this.raceAside, -half.z, half.z) });
    }
    const room = (p) => !this.solidNear(p, Math.max(r.size.length, r.size.width) / 2 + .5);
    return spots.find((p) => this.offRoad(p) && room(p)) ?? spots.find(room) ?? spots[0];
  }

  update(dt) {
    const racing = this.director.stage?.type === 'race' ? this.director.stage.id : null;
    this.botDrive(dt);
    super.update(dt);
    this.raceFinish(racing);
    this.updateRace(dt);
    this.actor.root.visible = false;
    // the race's place and time (race.js raceHud), then the speed
    this.hud.status(`${this.raceHud ? `${this.raceHud} · ` : ''}${Math.round(Math.abs(this.lastVehicleSpeed ?? 0) * 3.6)} km/h`);
  }
  end(won) {
    won = this.raceVerdict(won);
    super.end(won);
    if (!won && this.failure) this.hud.objective(this.failure);
  }
  debugState() {
    const car = this.activeCar, rig = this.world.rig;
    return { ...super.debugState(), track: { race: this.raceState(),
      car: car ? { ...car.controller.stateSnapshot(), nose: car.group.userData.nose ?? null, size: car.group.userData.size } : null,
      roadside: Object.fromEntries(this.roadside ?? []), // solid set pieces clearRoad moved ({x, z}) or left out (null)
      camera: { dist: +rig.dist.toFixed(2), at: rig.camera.position.toArray().map((n) => +n.toFixed(2)) } } };
  }
  dispose() {
    super.dispose();
    this.roadTex?.dispose(); this.curbTex?.dispose();
  }
}
Object.assign(TrackMode.prototype, RaceMixin);
