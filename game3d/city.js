// Executable city mode: licensed modular models, generated road/district data,
// streamed instance chunks, real vehicle input and selected-IP pedestrians.
import { Sky } from 'three/addons/objects/Sky.js';
import { AuthoredMode } from './authored.js';
import { THREE, canvasTexture, clamp, damp, mulberry32 } from './world.js';
import { VehicleController, carOverlap, footprint } from './city-controller.js';
import { cityPlan, SpatialGrid, districtAt, loopPose, patrolRoute, roadDistance, roundedLoop } from './city-layout.js';
import { RaceMixin, carBody, carSize, holdKeys } from './race.js';
import { driveRig, rigCar } from './carrig.js';

const KIT_URL = '/games/city-kit/v1/city-assets/commonassetcatalog.json';
const CHUNK_SIZE = 128, CHUNK_RADIUS = 260;
const chunksFor = (x, z) => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const flatPosition = (p) => new THREE.Vector3(p.x, 0, p.z);
const temp = new THREE.Object3D();
export async function createCity(world, spec, hud, actor) {
  const mode = new CityMode(world, spec, hud, actor);
  try { await mode.loadKit(); await mode.build(); return mode; }
  catch (error) { mode.dispose(); throw error; }
}

export class CityMode extends AuthoredMode {
  constructor(world, spec, hud, actor) {
    super(world, spec, hud, actor);
    this.city = spec.world.city;
    this.plan = cityPlan(spec.world);
    this.spatial = new SpatialGrid();
    this.chunkRecords = new Map();
    this.liveChunks = new Map();
    this.loadedChunkHistory = new Set();
    this.unloadedChunks = 0;
    this.cars = [];
    this.traffic = [];
    this.pedestrians = [];
    this.enterCount = this.exitCount = 0;
    this.walkedDistance = 0;
    this.visitedDistricts = new Set();
    this.kit = new Map();
    this.kitLoadCount = 0;
    this.roadMaterials = [];
    // ?autoplay=1 (the live broadcast): the built-in player walks (runtime3d.js) and drives (botDrive) its deliveries
    this.bot = typeof location !== 'undefined' && new URLSearchParams(location.search).get('autoplay') === '1';
    this.botReverse = this.botSlow = 0;
    this.navRadius = 2.2; // its walk grid keeps a car's width off the buildings
  }
  /** The built-in player keeps to the streets: every block between them counts as a wall on its walk grid (a car cut
   * through a block's courtyards wedges between buildings). Its goals snap to the nearest street cell. */
  navRects() {
    const { width, depth } = this.spec.world;
    const spans = (roads, extent) => {
      const cuts = [{ coordinate: -extent / 2, width: 0 }, ...roads, { coordinate: extent / 2, width: 0 }];
      return cuts.slice(1).map((r, i) => [cuts[i].coordinate + cuts[i].width / 2, r.coordinate - r.width / 2]).filter(([a, b]) => b > a);
    };
    const blocks = [];
    for (const [minX, maxX] of spans(this.plan.roadsX, width)) for (const [minZ, maxZ] of spans(this.plan.roadsZ, depth)) blocks.push({ minX, maxX, minZ, maxZ });
    return [...super.navRects(), ...blocks];
  }
  // while it drives, the runtime's walking bot stands aside
  get selfDriven() { return this.bot && !!this.activeCar; }
  /** A stage done by car (an address to arrive at by car, a drive, a race) on foot: walk to the nearest car and get in
   * (E is held there); a drive counts its own car only (mission.js). */
  autoGoal() {
    const stage = this.director.stage;
    if (!(stage?.vehicle || ['drive', 'race'].includes(stage?.type)) || this.activeCar) return super.autoGoal();
    this.autoInteract = true;
    const p = this.player.pos, own = stage.type === 'drive' ? this.cars.filter((c) => stage.entityIds?.includes(c.id)) : [];
    return (own.length ? own : this.cars).reduce((a, c) => !a || c.group.position.distanceTo(p) < a.distanceTo(p) ? c.group.position : a, null);
  }
  /** The goal arrow of a stage done by car, on foot: the car to take (a drive counts its own only), not the address,
   * which only counts at the wheel. It hides where the E prompt shows (4.2 m). */
  arrowGoal(stage) {
    if (this.activeCar || !(stage?.vehicle || ['drive', 'race'].includes(stage?.type))) return super.arrowGoal(stage);
    const own = stage.type === 'drive' ? this.cars.filter((c) => stage.entityIds?.includes(c.id)) : [];
    return { list: (own.length ? own : this.cars).map((c) => c.group.position), reach: 4, word: '차 ' };
  }
  /** Where a drive stage's metres go: toward the place the mission goes next (the first address or pickup of the
   * stages after it), and with that near (or none) on to the street crossing farthest away; kept until it is near. */
  driveGoal(at) {
    const far = (g) => Math.hypot(g.x - at.x, g.z - at.z) > 30;
    if (this.botWay && far(this.botWay)) return this.botWay;
    const places = [];
    for (const s of this.spec.mission.stages.slice(this.director.index + 1)) {
      places.push(...this.targets.filter((t) => s.entityIds?.includes(t.id)), ...this.pickups.filter((p) => p.stage === s.id).map((p) => p.group.position));
      if (places.length) break;
    }
    const crossings = this.plan.roadsX.flatMap((rx) => this.plan.roadsZ.map((rz) => ({ x: rx.coordinate, z: rz.coordinate })));
    const way = places.find(far) ?? crossings.reduce((a, c) => !a || Math.hypot(c.x - at.x, c.z - at.z) > Math.hypot(a.x - at.x, a.z - at.z) ? c : a, null);
    return this.botWay = way && flatPosition(way);
  }
  /** The built-in driver: steers along the walk grid's way to the stage's target, brakes on it, backs out of a wall;
   * a stage on foot stops the car and gets out. A race is driven gate to gate and a drive toward driveGoal, both
   * without stopping there. Keys go through the same input as a player's. */
  botDrive(dt) {
    const car = this.activeCar, input = this.world.input;
    if (!this.bot || !car || this.phase !== 'playing') return;
    const s = car.controller.stateSnapshot(), want = new Set();
    const stage = this.director.stage, gate = stage?.type === 'race' ? this.raceRoute?.[this.director.raceNext] : null;
    const drive = stage?.type === 'drive' && (!stage.entityIds?.length || stage.entityIds.includes(car.id)); // in its own car
    const goal = gate ? flatPosition(gate) : drive ? this.driveGoal(s.position) : stage?.vehicle ? super.autoGoal() : null;
    if (gate && this.raceHold > 0) return holdKeys(input, want); // the countdown: hands off
    if (!goal) {
      want.add('Space');
      if (Math.abs(s.speed) < 1 && (this.botExit = !this.botExit)) want.add('KeyE'); // tapped until it gets out
    } else {
      const next = this.navToward(goal);
      const d = Math.atan2(-(next.x - s.position.x), -(next.z - s.position.z)) - s.yaw;
      const err = Math.atan2(Math.sin(d), Math.cos(d)); // > 0: turn toward a larger yaw, which is left (A)
      const dist = Math.hypot(goal.x - s.position.x, goal.z - s.position.z);
      this.botSlow = Math.abs(s.speed) < .6 ? this.botSlow + dt : 0;
      if (this.botSlow > 1.5 && this.botReverse <= 0) { this.botReverse = 1.2; this.botSlow = 0; } // against a wall
      if (this.botReverse > 0) {
        this.botReverse -= dt;
        want.add('KeyS'); if (err > .1) want.add('KeyD'); if (err < -.1) want.add('KeyA'); // reversing turns the other way
      } else {
        if (err > .08) want.add('KeyA'); if (err < -.08) want.add('KeyD');
        // slow for the next corner of the way (the furthest point in sight), the address and sharp turns; a gate
        // where the race turns to the gate after it is a corner too
        const after = gate && this.raceRoute[(this.director.raceNext + 1) % this.raceRoute.length];
        const turn = after ? Math.atan2(after.x - gate.x, after.z - gate.z) - Math.atan2(gate.x - s.position.x, gate.z - s.position.z) : 0;
        const corner = Math.min(Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) > .5 ? dist : Infinity,
          Math.hypot(next.x - goal.x, next.z - goal.z) > .1 ? Math.hypot(next.x - s.position.x, next.z - s.position.z) : Infinity);
        const through = !!gate || drive, top = gate ? 21 : 16; // a race is driven flat out on the straights
        const slow = (!through && dist < 20 && s.speed > 7) || (corner < s.speed * 1.6 && s.speed > 8) || (Math.abs(err) > .6 && s.speed > 6) || s.speed > top;
        if ((!through && dist < 4) || (slow && s.speed > 11)) want.add('Space');
        else if (!slow) want.add('KeyW');
      }
    }
    holdKeys(input, want);
  }
  async loadKit() {
    const url = new URL(KIT_URL, location.origin);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`도시 에셋 카탈로그를 불러오지 못했습니다 (${response.status}).`);
    const catalog = await response.json();
    if (catalog.version !== 1 || !Array.isArray(catalog.assets) || catalog.assets.length > 80)
      throw new Error('도시 에셋 카탈로그가 유효하지 않습니다.');
    await Promise.all(catalog.assets.map(async (asset) => {
      if (!/^[a-zA-Z0-9_./-]+$/.test(asset.path) || asset.path.includes('..') || asset.path.startsWith('/')
        || asset.license !== 'CC0' && asset.license !== 'CC0-1.0')
        throw new Error('도시 에셋 출처 또는 경로가 유효하지 않습니다.');
      const model = await this.world.loadModel(new URL(asset.path, new URL('../', url)).href);
      if (!model) throw new Error(`실제 도시 모델을 불러오지 못했습니다: ${asset.id}`);
      model.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model.scene);
      const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
      if (![size.x, size.y, size.z].every((n) => finite(n) && n > .0001))
        throw new Error(`도시 모델 크기가 잘못되었습니다: ${asset.id}`);
      const parts = [];
      model.scene.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = node.receiveShadow = true;
        parts.push({ geometry: node.geometry, material: node.material, matrix: node.matrixWorld.clone() });
      });
      this.kit.set(asset.id, { ...asset, scene: model.scene, parts, size, center, bottom: box.min.y });
      this.kitLoadCount++;
    }));
    this.buildingKit = [...this.kit.values()].filter((a) => a.category === 'building');
    this.carKit = [...this.kit.values()].filter((a) => ['vehicle', 'car'].includes(a.category));
    this.streetKit = [...this.kit.values()].filter((a) => a.category === 'streetlight');
    if (!this.buildingKit.length || !this.carKit.length) throw new Error('실제 건물·차량 도시 에셋이 필요합니다.');
  }
  async build() {
    await super.build();
    const originalWalk = this.player.update.bind(this.player);
    this.player.update = (dt, input, rig) => {
      if (this.phase === 'playing' && input.hit('KeyE')) this.toggleCar();
      if (!this.activeCar) {
        const before = this.player.pos.clone();
        originalWalk(dt, input, rig);
        this.walkedDistance += before.distanceTo(this.player.pos);
        return;
      }
      this.drive(dt, input, rig);
    };
    for (const v of this.city.vehicles) this.addCar(v);
    await Promise.all(this.city.pedestrians.map(async (p) => {
      const data = this.spec.props[p.propIndex];
      const actor = await this.world.makeActor(data, 1.65, () => { throw new Error('보행자 IP가 없습니다.'); });
      this.strictActor(actor, data, '보행자');
      actor.root.position.set(p.x, 0, p.z);
      this.root.add(actor.root);
      this.pedestrians.push({ ...p, actor, routeIndex: 0, walked: 0 });
      this.targets.push({ ...p, name: data.name, radius: this.mechanics.interactRadius });
    }));
    this.buildTraffic();
    await this.spawnPatrols();
    if (this.night) this.nightWindows();
    // the first stage was activated by super.build() before any car existed
    if (this.director.stage?.type === 'race') this.startRace(this.director.stage);
    this.world.rig.pitch = .25;
    this.minimap = document.createElement('canvas');
    this.minimap.width = this.minimap.height = 190;
    this.minimap.className = 'city-minimap';
    this.minimap.setAttribute('aria-label', '도시 도로와 임무 위치 지도');
    this.minimap.style.cssText = 'position:absolute;right:20px;bottom:68px;width:160px;height:160px;border:1px solid #ffffff40;border-radius:16px;z-index:12;pointer-events:none;background:#101822dd';
    document.getElementById('stage').append(this.minimap);
    this.streamChunks(this.player.pos, true);
    this.refreshHud(); // a race starts at the wheel: a walker's gauges (the dash, a crosshair) are off under the briefing too
  }
  /** The car the player sits in for a frame, in place of the hero's walk: W/S the throttle, A/D the steering, Space the
   * brake; the metres it covers count for a drive stage. */
  drive(dt, input, rig) {
    const car = this.activeCar;
    const before = car.controller.stateSnapshot();
    const s = car.controller.step(dt, {
      throttle: this.raceHold > 0 ? 0 : Number(input.down('KeyW', 'ArrowUp')) - Number(input.down('KeyS', 'ArrowDown')),
      steer: Number(input.down('KeyD')) - Number(input.down('KeyA')),
      brake: input.down('Space'),
    });
    car.group.position.set(s.position.x, .06, s.position.z);
    car.group.rotation.y = s.yaw;
    driveRig(car.group.userData.rig, dt, { speed: s.speed, steer: s.steeringAngle, yaw: s.yaw });
    this.player.pos.set(s.position.x, 0, s.position.z);
    rig.yaw = damp(rig.yaw, s.yaw, 5, dt);
    this.director.record({ type: 'drive', entityId: car.id, distanceMeters: s.distance - before.distance });
    this.lastVehicleSpeed = s.speed;
  }
  buildEnvironment() {
    const { world, spec } = this;
    const a = spec.artDirection ?? {};
    const night = ['night', 'space'].includes(spec.environment?.sky);
    this.night = night;
    world.scene.fog = new THREE.FogExp2(a.fogColor ?? (night ? '#354058' : '#b8c9d6'), a.fogDensity ?? .0018);
    world.scene.background = new THREE.Color(a.skyColor ?? (night ? '#111c34' : '#b9d9ec'));
    world.renderer.toneMappingExposure = a.exposure ?? (night ? 1.05 : 1);
    world.bloom.strength = a.bloomStrength ?? (night ? .55 : .12);
    world.bloom.threshold = night ? .85 : 1.1;
    world.camera.far = 6000; world.camera.updateProjectionMatrix();
    const sky = new Sky();
    sky.scale.setScalar(6000);
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = night ? 12 : 3;
    uniforms.rayleigh.value = night ? .25 : 1.5;
    uniforms.mieCoefficient.value = .005;
    uniforms.mieDirectionalG.value = .8;
    const sunPos = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(night ? 87 : 65), THREE.MathUtils.degToRad(135));
    uniforms.sunPosition.value.copy(sunPos);
    this.envTarget = world.pmrem.fromScene(sky); // (its render target: AuthoredMode.dispose() frees it)
    sky.geometry.dispose(); sky.material.dispose();
    world.scene.environment = this.envTarget.texture;
    world.scene.environmentIntensity = night ? .45 : .75;
    const backdrop = new THREE.Mesh(new THREE.SphereGeometry(2000, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(a.skyColor ?? (night ? '#111c34' : '#b9d9ec')) },
        horizon: { value: new THREE.Color(a.fogColor ?? (night ? '#354058' : '#b8c9d6')) } },
      vertexShader: 'varying float h;void main(){h=normalize(position).y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'uniform vec3 top;uniform vec3 horizon;varying float h;void main(){gl_FragColor=vec4(mix(horizon,top,smoothstep(-.05,.7,h)),1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
    }));
    if (spec.world.background?.mode !== 'image') this.root.add(backdrop);
    else { backdrop.geometry.dispose(); backdrop.material.dispose(); }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(spec.world.width + 100, spec.world.depth + 100).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: spec.world.groundColor, roughness: 1 }));
    ground.receiveShadow = true; ground.position.y = -.07; this.root.add(ground);
    // night: a dark blue moon, lit windows and street lamps carry the scene
    const hemi = new THREE.HemisphereLight(night ? 0x5878b0 : 0xb7d8f5, night ? 0x1f1c18 : 0x55503f, night ? .6 : 1.9);
    const sun = new THREE.DirectionalLight(night ? 0x85abed : 0xffedd1, night ? .55 : 3.3);
    sun.position.copy(sunPos).multiplyScalar(90);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -65, right: 65, top: 65, bottom: -65, near: 1, far: 240 });
    sun.shadow.bias = -.0003; sun.shadow.normalBias = .08;
    this.citySun = sun;
    this.sunOffset = sun.position.clone();
    this.root.add(hemi, sun, sun.target);
    this.streetLights = [];
    if (night) for (let i = 0; i < 8; i++) {
      const light = new THREE.PointLight(0xffae65, 60, 20, 2);
      this.root.add(light); this.streetLights.push(light);
    }
    this.asphaltTex = canvasTexture(256, (ctx, size) => {
      ctx.fillStyle = '#323940'; ctx.fillRect(0, 0, size, size);
      const rnd = mulberry32(821);
      for (let i = 0; i < 5000; i++) {
        ctx.fillStyle = `rgba(${rnd() > .5 ? '255,255,255' : '0,0,0'},${.03 + rnd() * .08})`;
        ctx.fillRect(rnd() * size, rnd() * size, 1, 1);
      }
    }, { repeat: 1 });
    const asphalt = new THREE.MeshStandardMaterial({ map: this.asphaltTex, roughness: .93 });
    const pavement = new THREE.MeshStandardMaterial({ color: night ? '#5d5f63' : '#c2bdb3', roughness: 1 });
    const lineMaterial = new THREE.MeshBasicMaterial({ color: '#e8d58a' });
    this.roadMaterials.push(asphalt, pavement, lineMaterial);
    const dashMatrices = [];
    for (const road of this.city.streets) {
      const horizontal = road.axis === 'x', extent = horizontal ? spec.world.width : spec.world.depth;
      const strip = (width, offset, material, y) => {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(horizontal ? extent : width, horizontal ? width : extent).rotateX(-Math.PI / 2), material);
        mesh.position.set(horizontal ? 0 : road.coordinate + offset, y, horizontal ? road.coordinate + offset : 0);
        mesh.receiveShadow = true; this.root.add(mesh);
      };
      strip(road.width + 7, 0, pavement, -.025);
      strip(road.width, 0, asphalt, 0);
      for (let at = -extent / 2 + 4; at < extent / 2; at += 12) {
        if (this.city.streets.some((s) => s.axis !== road.axis && Math.abs(at - s.coordinate) < s.width / 2 + 1)) continue;
        temp.position.set(horizontal ? at : road.coordinate, .013, horizontal ? road.coordinate : at);
        temp.rotation.set(0, horizontal ? 0 : Math.PI / 2, 0); temp.scale.set(1, 1, 1); temp.updateMatrix();
        dashMatrices.push(temp.matrix.clone());
      }
    }
    const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(5, .12).rotateX(-Math.PI / 2), lineMaterial, dashMatrices.length);
    dashMatrices.forEach((matrix, i) => dashes.setMatrixAt(i, matrix));
    dashes.computeBoundingSphere(); this.root.add(dashes);
    for (const building of this.plan.buildings) {
      this.spatial.insert({ minX: building.x - building.width / 2, maxX: building.x + building.width / 2,
        minZ: building.z - building.depth / 2, maxZ: building.z + building.depth / 2 });
      const key = chunksFor(building.x, building.z);
      if (!this.chunkRecords.has(key)) this.chunkRecords.set(key, []);
      this.chunkRecords.get(key).push(building);
    }
    for (const p of this.plan.props) {
      const key = chunksFor(p.x, p.z);
      if (!this.chunkRecords.has(key)) this.chunkRecords.set(key, []);
      this.chunkRecords.get(key).push(p);
    }
  }
  buildingAsset(record) {
    const prefer = this.buildingKit.filter((a) => record.style === 'downtown' ? /sky|high|large|tower/i.test(a.id)
      : record.style === 'industrial' ? /industrial|factory|warehouse/i.test(a.id)
        : record.style === 'residential' ? /house|small|low|residential/i.test(a.id) : /medium|office|apartment/i.test(a.id));
    const list = prefer.length ? prefer : this.buildingKit;
    return list[record.variant % list.length];
  }
  matrixFor(asset, record) {
    const scale = record.category ? new THREE.Vector3(1, 1, 1).multiplyScalar(7 / asset.size.y)
      : new THREE.Vector3(record.width / asset.size.x, record.height / asset.size.y, record.depth / asset.size.z);
    temp.position.set(record.x, .02, record.z); temp.rotation.set(0, record.yaw ?? 0, 0); temp.scale.copy(scale); temp.updateMatrix();
    const base = new THREE.Matrix4().makeTranslation(-asset.center.x, -asset.bottom, -asset.center.z);
    return temp.matrix.clone().multiply(base);
  }
  streamChunks(position, force = false) {
    if (!force && this.lastChunkPosition && position.distanceToSquared(this.lastChunkPosition) < 100) return;
    this.lastChunkPosition = position.clone();
    for (const [key, records] of this.chunkRecords) {
      const [cx, cz] = key.split(',').map(Number);
      const near = Math.hypot((cx + .5) * CHUNK_SIZE - position.x, (cz + .5) * CHUNK_SIZE - position.z) < CHUNK_RADIUS;
      if (!near && this.liveChunks.has(key)) {
        const group = this.liveChunks.get(key);
        group.traverse((n) => { if (n.isInstancedMesh) n.dispose(); });
        this.root.remove(group); this.liveChunks.delete(key); this.unloadedChunks++;
      }
      if (!near || this.liveChunks.has(key)) continue;
      const batches = new Map(), group = new THREE.Group();
      for (const record of records) {
        const asset = record.category ? this.streetKit[0] : this.buildingAsset(record);
        if (!asset) continue;
        if (!batches.has(asset.id)) batches.set(asset.id, { asset, matrices: [] });
        batches.get(asset.id).matrices.push(this.matrixFor(asset, record));
      }
      for (const { asset, matrices } of batches.values()) for (const part of asset.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
        matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix.clone().multiply(part.matrix)));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
      this.root.add(group); this.liveChunks.set(key, group); this.loadedChunkHistory.add(key);
    }
  }
  collide(p, radius) {
    super.collide(p, radius);
    if (p.y < 30) this.spatial.resolve(p, radius);
    // a walker (or an enemy) is kept out of every car's real footprint, nose and tail included
    for (const o of this.otherCars(this.activeCar?.id)) {
      const f = footprint(o), dx = f.bx - f.ax, dz = f.bz - f.az, l2 = dx * dx + dz * dz;
      const t = l2 > 1e-9 ? clamp(((p.x - f.ax) * dx + (p.z - f.az) * dz) / l2, 0, 1) : 0;
      const cx = f.ax + dx * t, cz = f.az + dz * t, d = Math.hypot(p.x - cx, p.z - cz), r = radius + f.r;
      if (d < r && d > .001) { p.x = cx + (p.x - cx) / d * r; p.z = cz + (p.z - cz) / d * r; }
    }
  }
  /** Every car but `id` as a footprint {id, x, z, yaw, length, width, speed}: parked and driven city cars, traffic,
   * race rivals. A driven car slides off these (city-controller.js cars adapter) instead of passing through. */
  otherCars(id) {
    const out = [];
    for (const c of this.cars) if (c.id !== id) {
      const s = c.controller.stateSnapshot();
      out.push({ id: c.id, x: s.position.x, z: s.position.z, yaw: s.yaw, speed: s.speed, ...c.group.userData.size });
    }
    for (const c of this.traffic) if (c.id !== id)
      out.push({ id: c.id, x: c.group.position.x, z: c.group.position.z, yaw: c.yaw, speed: c.speed, ...c.size });
    for (const r of this.rivalCars()) if (r.id !== id) out.push(r);
    return out;
  }
  carAsset(kind) {
    return this.carKit.find((a) => a.id.toLowerCase().includes(kind))
      ?? this.carKit.find((a) => /sedan|hatchback|car/i.test(a.id)) ?? this.carKit[0];
  }
  makeCarGroup(kind) {
    const a = this.carAsset(kind), group = new THREE.Group(), visual = a.scene.clone(true);
    const scale = 1.65 / a.size.y;
    visual.scale.setScalar(scale);
    visual.position.set(-a.center.x * scale, -a.bottom * scale, -a.center.z * scale);
    visual.rotation.y = Math.PI - (a.nativeForwardYaw ?? 0);
    group.add(visual); this.root.add(group);
    rigCar(group); // the kit's wheel nodes roll and steer
    group.userData.size = carSize(group);
    return group;
  }
  addCar(v) {
    // the selected IP car's 3D model is the body when the vehicle names one (modelId), else the kit car of its kind
    const scene = v.modelId ? this.setPieces.get(v.modelId) : null;
    const group = scene ? carBody(scene) : this.makeCarGroup(v.kind);
    if (scene) this.root.add(group);
    group.position.set(v.x, .06, v.z); group.rotation.y = v.yaw;
    const adapters = {
      collide: (p, radius) => this.spatial.blocked(p.x, p.z, radius),
      clampBounds: (p, radius) => {
        p.x = clamp(p.x, -this.spec.world.width / 2 + radius, this.spec.world.width / 2 - radius);
        p.z = clamp(p.z, -this.spec.world.depth / 2 + radius, this.spec.world.depth / 2 - radius);
      },
      cars: () => this.otherCars(v.id), // parked cars, traffic and rivals are slid off, never walls that pin the driver
    };
    const controller = new VehicleController({ id: v.id, position: { x: v.x, z: v.z }, yaw: v.yaw, ...group.userData.size }, adapters);
    const ip = scene ? this.spec.world.entities.find((e) => e.id === v.modelId)?.ipId : null;
    this.cars.push({ ...v, group, controller, adapters, customBody: !!scene, assetId: ip ?? this.carAsset(v.kind).id });
  }
  // (its words are tips: a hud.notice() would be gone in the frame it was set)
  toggleCar() {
    if (this.activeCar) {
      const car = this.activeCar;
      if (Math.abs(car.controller.stateSnapshot().speed) > 1.5) { this.tip('차를 멈춘 뒤 E를 눌러 내려요'); return; }
      const positions = car.controller.getExitCandidates({ isBlocked: (p, r) =>
        this.spatial.blocked(p.x, p.z, r) || Math.abs(p.x) > this.spec.world.width / 2 - 1 || Math.abs(p.z) > this.spec.world.depth / 2 - 1 });
      if (!positions.length) { this.tip('내릴 자리가 없어요 · 차를 조금 옮겨 주세요'); return; }
      this.player.place(positions[0].x, positions[0].z);
      this.activeCar = null; this.actor.root.visible = true; this.exitCount++;
      Object.assign(this.world.rig, { distance: 6.2, height: 1.5, first: true });
      this.tip('차에서 내렸어요 · W A S D로 걸어요');
      return;
    }
    const near = this.cars.find((c) => Math.hypot(c.group.position.x - this.player.pos.x, c.group.position.z - this.player.pos.z) < 4.2);
    if (!near) return;
    this.activeCar = near; this.enterCount++; this.actor.root.visible = false;
    Object.assign(this.world.rig, { distance: 10.5, height: 1.8, pitch: .22, yaw: near.yaw, first: true });
    this.tip('운전 · W 가속 · S 후진 · A D 방향 · Space 브레이크 · 멈춘 뒤 E로 내려요', 6);
  }
  buildTraffic() {
    if (this.spec.mission.stages.some((s) => s.type === 'race')) return; // ambient cars would block the circuit
    const xs = this.plan.roadsX.map((r) => r.coordinate), zs = this.plan.roadsZ.map((r) => r.coordinate);
    // the right-hand lane of the outer ring, corners rounded so the cars turn through them
    this.trafficLoop = roundedLoop([{ x: xs[0] + 3, z: zs[0] + 3 }, { x: xs.at(-1) - 3, z: zs[0] + 3 },
      { x: xs.at(-1) - 3, z: zs.at(-1) - 3 }, { x: xs[0] + 3, z: zs.at(-1) - 3 }], 8);
    for (let i = 0; i < this.city.trafficCount; i++) {
      const group = this.makeCarGroup(i % 3 === 0 ? 'taxi' : 'sedan');
      const s = this.trafficLoop.total * i / this.city.trafficCount, pose = loopPose(this.trafficLoop, s);
      group.position.set(pose.x, .06, pose.z); group.rotation.y = pose.yaw;
      this.traffic.push({ id: `traffic_${i}`, group, s, yaw: pose.yaw, speed: 0, size: group.userData.size, moved: 0 });
    }
  }
  // Enemies no combat stage calls up (no kills/boss/survive stage uses their spawn) patrol their street from the
  // start, so a city's police drones or guards are really out there; in range they chase and shoot as in any stage.
  async spawnPatrols() {
    const { stages } = this.spec.mission;
    const fought = (p) => stages.some((s) => ['kills', 'boss', 'survive'].includes(s.type) && (!p.stageId || p.stageId === s.id)
      && (!s.entityIds?.length || s.entityIds.includes(p.id)) && (s.enemyIndex == null || s.enemyIndex === p.enemyIndex));
    const patrols = this.spec.world.enemySpawns.filter((p) => !fought(p));
    await Promise.all(patrols.map((p) => this.spawnEnemy({ ...p, minion: true }))); // a street patrol is never the boss
    for (const e of this.enemies) if (patrols.some((p) => p.id === e.id))
      e.patrol = { route: patrolRoute(e, this.city.streets, this.spec.world), leg: 1 };
  }
  updateEnemies(dt) {
    const far = (e) => e.patrol && Math.hypot(e.pos.x - this.player.pos.x, e.pos.z - this.player.pos.z) >= 32; // nearer: it fights
    for (const e of this.enemies) {
      if (!far(e)) continue;
      const t = e.patrol.route[e.patrol.leg], d = Math.hypot(t.x - e.pos.x, t.z - e.pos.z);
      if (d < .5) { e.patrol.leg = 1 - e.patrol.leg; continue; }
      const step = Math.min(d, e.speed * .7 * dt);
      e.pos.x += (t.x - e.pos.x) / d * step; e.pos.z += (t.z - e.pos.z) / d * step;
      e.patrol.heading = Math.atan2(t.x - e.pos.x, t.z - e.pos.z);
    }
    super.updateEnemies(dt);
    for (const e of this.enemies) if (far(e) && e.patrol.heading != null && !e.actor.billboard) e.actor.root.rotation.y = e.patrol.heading;
  }
  /** Traffic drives its lane by arc length at up to 8 m/s, brakes for whatever is ahead in the lane (a car, the
   * player on foot) and never moves into another car: it waits instead, so a stopped player is never shoved. */
  updateTraffic(dt) {
    const walker = this.activeCar ? null : { id: 'walker', x: this.player.pos.x, z: this.player.pos.z, yaw: 0, length: .8, width: .8 };
    for (const c of this.traffic) {
      const p = c.group.position, fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
      const others = this.otherCars(c.id);
      let want = 8;
      for (const o of walker ? [...others, walker] : others) {
        const ox = o.x - p.x, oz = o.z - p.z, along = ox * fx + oz * fz, lateral = Math.abs(ox * fz - oz * fx);
        if (along <= 0 || along > 18 || lateral > (c.size.width + o.width) / 2 + .5) continue;
        want = Math.min(want, Math.max(0, along - (c.size.length + o.length) / 2 - 1.5) * .9);
      }
      c.speed = c.speed < want ? Math.min(want, c.speed + 4 * dt) : Math.max(want, c.speed - 12 * dt);
      const pose = loopPose(this.trafficLoop, c.s + c.speed * dt), next = footprint({ ...pose, ...c.size }), now = footprint({ x: p.x, z: p.z, yaw: c.yaw, ...c.size });
      if (c.speed > 0 && others.some((o) => { const f = footprint(o); return carOverlap(next, f).depth > Math.max(0, carOverlap(now, f).depth) + 1e-6; })) c.speed = 0;
      else {
        const step = c.speed * dt, turn = Math.atan2(Math.sin(pose.yaw - c.yaw), Math.cos(pose.yaw - c.yaw));
        c.s = (c.s + step) % this.trafficLoop.total; c.moved += step;
        p.set(pose.x, .06, pose.z); c.yaw = pose.yaw; c.group.rotation.y = c.yaw;
        c.steer = clamp(-Math.atan(2.7 * turn / Math.max(step, 1e-3)), -.5, .5); // the front wheels follow the arc
      }
      driveRig(c.group.userData.rig, dt, { speed: c.speed, steer: c.speed > 0 ? c.steer ?? 0 : 0, yaw: c.yaw });
    }
  }
  updateCityLife(dt) {
    this.npc?.actor.animator?.update(dt, { speed: 0, grounded: true });
    for (const p of this.pedestrians) {
      const destination = p.route[p.routeIndex], pos = p.actor.root.position;
      const d = Math.hypot(destination.x - pos.x, destination.z - pos.z), step = Math.min(d, dt * 1.05);
      if (d < .15) p.routeIndex = (p.routeIndex + 1) % p.route.length;
      else if (Math.hypot(pos.x - this.player.pos.x, pos.z - this.player.pos.z) > 1.4) {
        pos.x += (destination.x - pos.x) / d * step; pos.z += (destination.z - pos.z) / d * step;
        p.actor.root.rotation.y = Math.atan2(destination.x - pos.x, destination.z - pos.z);
        p.walked += step;
      }
      p.actor.animator?.update(dt, { speed: step / Math.max(dt, .001), moving: d > .15, sprint: false, grounded: true });
      const target = this.targets.find((t) => t.id === p.id);
      if (target) { target.x = pos.x; target.z = pos.z; }
    }
    if (this.traffic.length) this.updateTraffic(dt);
  }
  update(dt) {
    const racing = this.director.stage?.type === 'race' ? this.director.stage.id : null;
    this.botDrive(dt);
    super.update(dt);
    this.raceFinish(racing);
    this.updateRace(dt);
    this.updateCityLife(dt);
    this.actor.root.visible = !this.activeCar;
    this.streamChunks(this.player.pos);
    if (this.streetLights.length) {
      const nearest = [...this.plan.props].sort((a, b) => Math.hypot(a.x - this.player.pos.x, a.z - this.player.pos.z)
        - Math.hypot(b.x - this.player.pos.x, b.z - this.player.pos.z)).slice(0, this.streetLights.length);
      this.streetLights.forEach((light, i) => {
        const p = nearest[i]; light.visible = !!p;
        if (p) {
          light.position.set(p.x, 5.7, p.z);
          light.color.set(districtAt(this.city, p.x, p.z).style === 'industrial' ? '#ffae65' : this.spec.palette.accent);
        }
      });
    }
    this.world.rig.blockers = this.spatial.nearby(this.player.pos.x, this.player.pos.z, 14)
      .map((b) => new THREE.Box3(new THREE.Vector3(b.minX, 0, b.minZ), new THREE.Vector3(b.maxX, 50, b.maxZ)));
    this.citySun.target.position.copy(this.player.pos);
    this.citySun.position.copy(this.player.pos).add(this.sunOffset);
    const district = districtAt(this.city, this.player.pos.x, this.player.pos.z);
    if (this.phase === 'playing') this.visitedDistricts.add(district.id);
    this.drawMinimap();
    // at the wheel the speed, with a race's place and time (race.js raceHud) in the district's place
    if (this.activeCar) this.hud.status(`${this.raceHud ?? district.name} · ${Math.round(Math.abs(this.lastVehicleSpeed ?? 0) * 3.6)} km/h`);
    else this.hud.status(`${district.name} · 도보`);
    const stage = this.director.stage;
    if (stage?.type === 'drive') this.hud.objective(`${this.director.index + 1}/${this.spec.mission.stages.length} · ${stage.label} (${Math.floor(this.director.driveDistance)}/${stage.distanceMeters}m)`);
    // where the hero stands on foot; a tip just given (getting out, a refused exit) is read first
    const onFoot = !this.activeCar && this.phase === 'playing' && !this.tipUp;
    if (onFoot && this.cars.some((c) => c.group.position.distanceTo(this.player.pos) < 4.2)) this.hud.notice('E · 차량 탑승');
    else if (onFoot && stage?.vehicle && this.targets.some((t) => stage.entityIds?.includes(t.id)
      && Math.hypot(t.x - this.player.pos.x, t.z - this.player.pos.z) < (t.radius ?? 3) + 4)) this.hud.notice('차에 탄 채로 도착해야 해요');
  }
  updatePickups(dt) { if (!this.activeCar) super.updatePickups(dt); }
  driving() { return !!this.activeCar; }
  end(won) {
    won = this.raceVerdict(won);
    super.end(won);
    if (!won && this.failure) this.hud.objective(this.failure); // not the mission's success text
  }

  // the kit's window glass (bluish texels of its shared colormap) glows warm at night
  nightWindows() {
    const done = new Set();
    for (const a of this.buildingKit) for (const part of a.parts) {
      const m = part.material, img = m?.map?.image;
      if (!img || done.has(m) || !img.width) continue;
      done.add(m);
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height), px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const glass = px[i + 2] > 140 && px[i + 2] > px[i] + 25 && px[i + 1] > px[i] - 10;
        px[i] = glass ? 255 : 0; px[i + 1] = glass ? 190 : 0; px[i + 2] = glass ? 115 : 0;
      }
      ctx.putImageData(data, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = m.map.flipY;
      Object.assign(m, { emissiveMap: tex, emissiveIntensity: 1.0 }); m.emissive = new THREE.Color('#ffffff');
      m.needsUpdate = true;
      this.roadMaterials.push({ dispose: () => tex.dispose() });
    }
  }

  /** A rival done racing pulls over at the kerb of the street it runs along (inside the carriageway, never into a
   * block), past the finish or ahead of where it was when the race ended, alternating kerbs. */
  parkSpot(r, order) {
    const p = this.raceParkSpot(r, order, 0), from = r.finishedAt != null ? this.raceRoute.at(-1) : r.pos;
    const axis = Math.abs(p.x - from.x) >= Math.abs(p.z - from.z) ? 'x' : 'z'; // an x street runs along x
    const street = this.city.streets.filter((s) => s.axis === axis)
      .reduce((best, s) => !best || roadDistance(p, s) < roadDistance(p, best) ? s : best, null);
    if (!street) return null;
    const kerb = street.coordinate + (order % 2 ? -1 : 1) * Math.max(0, street.width / 2 - 1.4);
    return axis === 'x' ? { x: p.x, z: kerb } : { x: kerb, z: p.z };
  }
  // race: the player starts in the car, a 3 s countdown, glowing gates, AI rivals on the checkpoint loop
  activateStage() {
    super.activateStage();
    const stage = this.director.stage;
    if (stage?.type === 'race' && this.raceStage !== stage.id) this.startRace(stage);
  }
  drawMinimap() {
    if (!this.minimap) return;
    const ctx = this.minimap.getContext('2d'), size = this.minimap.width;
    const { width, depth } = this.spec.world;
    const px = (x) => size * (x / width + .5), pz = (z) => size * (z / depth + .5);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#152a25'; ctx.fillRect(0, 0, size, size);
    for (const d of this.city.districts) {
      ctx.fillStyle = { downtown: '#38434f', residential: '#354b39', industrial: '#5b4a38', waterfront: '#2b4855' }[d.style];
      ctx.fillRect(px(d.x - d.width / 2), pz(d.z - d.depth / 2), size * d.width / width, size * d.depth / depth);
    }
    ctx.strokeStyle = '#9eaaac'; ctx.lineWidth = 2;
    for (const s of this.city.streets) {
      ctx.beginPath();
      if (s.axis === 'x') { ctx.moveTo(0, pz(s.coordinate)); ctx.lineTo(size, pz(s.coordinate)); }
      else { ctx.moveTo(px(s.coordinate), 0); ctx.lineTo(px(s.coordinate), size); }
      ctx.stroke();
    }
    const dot = (p, color, radius) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px(p.x), pz(p.z), radius, 0, Math.PI * 2); ctx.fill();
    };
    for (const p of this.pickups.filter((p) => !p.taken && p.group.visible)) dot(p.group.position, '#ffc756', 3);
    for (const t of this.targets.filter((t) => this.director.stage?.entityIds?.includes(t.id))) dot(t, '#ffc756', 4);
    for (const c of this.cars) dot(c.group.position, '#78c3ed', 2);
    for (const e of this.enemies) dot(e.pos, '#ff4668', 2.5);
    dot(this.player.pos, '#ffffff', 4);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px(this.player.pos.x), pz(this.player.pos.z));
    const yaw = this.activeCar?.controller.stateSnapshot().yaw ?? this.world.rig.yaw;
    ctx.lineTo(px(this.player.pos.x) - Math.sin(yaw) * 10, pz(this.player.pos.z) - Math.cos(yaw) * 10); ctx.stroke();
  }
  debugState() {
    return { ...super.debugState(), city: {
      width: this.spec.world.width, depth: this.spec.world.depth, buildings: this.plan.buildings.length,
      cameraYaw: this.world.rig.yaw,
      streets: this.city.streets.length, districts: this.city.districts.map((d) => ({ id: d.id, name: d.name, style: d.style })),
      visitedDistricts: [...this.visitedDistricts], activeChunks: this.liveChunks.size,
      loadedChunkHistory: [...this.loadedChunkHistory], unloadedChunks: this.unloadedChunks,
      assetModelsLoaded: this.kitLoadCount, walkedDistance: +this.walkedDistance.toFixed(2),
      npcKind: this.npc?.actor.kind,
      npcAnimationSeconds: this.npc?.actor.animator?.mixer.time ?? null,
      activeVehicle: this.activeCar?.id ?? null, enterCount: this.enterCount, exitCount: this.exitCount,
      race: this.raceState(),
      vehicles: this.cars.map((c) => ({ ...c.controller.stateSnapshot(), assetId: c.assetId, customBody: !!c.customBody,
        nose: c.group.userData.nose ?? null, size: c.group.userData.size })),
      traffic: this.traffic.map((c) => ({ id: c.id, x: +c.group.position.x.toFixed(2), z: +c.group.position.z.toFixed(2),
        yaw: +c.yaw.toFixed(4), speed: +c.speed.toFixed(2), moved: +c.moved.toFixed(2) })),
      patrols: this.enemies.filter((e) => e.patrol).map((e) => ({ id: e.id, x: +e.pos.x.toFixed(2), z: +e.pos.z.toFixed(2) })),
      pedestrians: this.pedestrians.map((p) => ({ id: p.id, propIndex: p.propIndex, kind: p.actor.kind, position: p.actor.root.position.toArray(), walked: +p.walked.toFixed(2),
        animationSeconds: p.actor.animator?.mixer.time ?? null })),
    } };
  }
  dispose() {
    this.minimap?.remove();
    for (const group of this.liveChunks.values()) {
      group.traverse((n) => { if (n.isInstancedMesh) n.dispose(); });
      this.root.remove(group);
    }
    this.liveChunks.clear();
    super.dispose();
    this.asphaltTex?.dispose();
  }
}
Object.assign(CityMode.prototype, RaceMixin);
