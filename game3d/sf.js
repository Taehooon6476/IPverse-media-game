// SF arena (sf-shooter, sf-survival): neon arena with pillars and cover, procedural drones built from
// spec.enemies (shape/color/hp/speed), projectiles toward the camera aim, pickups from spec.props.
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  THREE, PlayerController, mulberry32, canvasTexture, damp, clamp, color, disposeTree, releaseDrawn, REDUCED_MOTION, angleDamp, animateBody, PICKUP_MAX,
} from './world.js';
import { fadeOut } from './anim.js';
import { clock } from './arpg-data.js';

// ponytail: one mode lives at a time, so the arena half-size is module state set per spec (environment.size).
let HALF = 30; // arena half-size (m)
// spec.environment.theme -> look. floor = ground colour, grid = emissive grid strength, obstacle = cover style.
const THEMES = {
  'neon-arena': { floor: 0x1a2030, grid: 0.75, fog: 0.017, sky: 'space', obstacle: 'block', sun: 0xdfe8ff, sunI: 2.1, hemi: 0.45, wall: 0x2a3140 },
  'ruined-city': { floor: 0x45403a, grid: 0.1, fog: 0.022, sky: 'dusk', obstacle: 'ruin', sun: 0xffc896, sunI: 2.6, hemi: 0.7, wall: 0x5a534b },
  'desert-outpost': { floor: 0xb08a5a, grid: 0.04, fog: 0.007, sky: 'day', obstacle: 'rock', sun: 0xfff1d6, sunI: 3.4, hemi: 1.0, wall: 0x8a6a45 },
  'ice-station': { floor: 0xa9c4d6, grid: 0.3, fog: 0.03, sky: 'storm', obstacle: 'ice', sun: 0xdaeaff, sunI: 2.3, hemi: 0.9, wall: 0x7d97a8 },
  'lava-forge': { floor: 0x2a1410, grid: 1.1, fog: 0.02, sky: 'night', obstacle: 'rock', sun: 0xff8a50, sunI: 1.5, hemi: 0.4, wall: 0x3a2018, lava: 0xff4a10 },
  'jungle-ruins': { floor: 0x2f4a2a, grid: 0.04, fog: 0.03, sky: 'day', obstacle: 'ruin', sun: 0xfff3d0, sunI: 2.7, hemi: 0.9, wall: 0x4a5a3a },
};
const SKIES = {  // top, horizon (null = derive from the palette), stars, planet
  space: { top: null, horizon: null, stars: 2200, planet: true },
  day: { top: 0x3f7fd6, horizon: 0xcfe3f5, stars: 0, planet: false },
  dusk: { top: 0x2b2550, horizon: 0xf29a5a, stars: 300, planet: false },
  storm: { top: 0x3a4250, horizon: 0x9aa6b4, stars: 0, planet: false },
  night: { top: 0x05070f, horizon: 0x1b2440, stars: 1400, planet: false },
};
const BOSS_SCALE = 2.2;
const REACH_HOLD = 1.5; // s standing in a beacon to activate it
const REACH_RADIUS = 2.4;
const CORES_ON_MAP = 3;
const START_GRACE = 5; // s without spawns
// A playable ad's round has no opening wait: its first enemies come up in front of the camera (openNow) instead
// of flying in from the rim after the grace
const OPENING = 3; // enemies
const OPEN_DIST = [11, 9, 13]; // m ahead of the player: the first that is clear of the cover
const OPEN_FAN = 0.38; // rad between two of them, seen from the player (the auto-fire cone is ~12°: the middle one is in it)
/** Where the i-th of a playable round's n first enemies comes up: `yaw` is the camera's (CameraRig: forward is
 * (-sin yaw, 0, -cos yaw)), half the arena's half-size, blocked(x, z) says a spot is inside cover. → {x, z} */
export function openingSpot(i, n, player, yaw, half, blocked = () => false) {
  const a = yaw + (i - (n - 1) / 2) * OPEN_FAN, lim = half - 3;
  const at = (dist) => ({ x: clamp(player.x - Math.sin(a) * dist, -lim, lim), z: clamp(player.z - Math.cos(a) * dist, -lim, lim) });
  return OPEN_DIST.map(at).find((spot) => !blocked(spot.x, spot.z)) ?? at(OPEN_DIST[0]);
}
const SPAWN_SEC = { easy: 1.6, normal: 1.15, hard: 0.8 };
const MAX_ALIVE = { easy: 7, normal: 10, hard: 13 };
const FIRE_SEC = 0.11;
const BOLT_SPEED = 64;
const DROP_CHANCE = 0.2;
const PICKUP_RESPAWN = 14;
// Demo-friendly lethality per difficulty: damage and enemy fire-rate multipliers, how many drones may attack at
// once (the rest hold back at range), i-frames after a hit, and regen after REGEN_DELAY s without damage.
// Tuned so an idle player on normal survives > 60 s (dev/autotest.js ?test=sf-idle).
const TUNE = {
  easy: { damage: 0.3, fireRate: 0.4, attackers: 2, iframes: 1.2, regen: 8 },
  normal: { damage: 0.5, fireRate: 0.5, attackers: 3, iframes: 1.0, regen: 5 },
  hard: { damage: 0.8, fireRate: 0.8, attackers: 3, iframes: 0.6, regen: 2 },
};
const REGEN_DELAY = 4;
const ENGAGE_DELAY = 2.5; // a drone promoted to attacker hesitates this long first
const RETREAT_SEC = 4; // after ramming, a drone falls back this long
const AUTO_CONE_COS = 0.978; // ~12 deg: auto-fire when a drone is this close to the aim
const KILL_TARGET_CAP = 20; // sf-shooter kills objectives above this play as 20 (2–3 min of real play)
const DAMAGE = { triangle: 15, circle: 12, square: 25, bolt: 10 };
// Enemies with an IP model (spec.enemies[].modelUrl): pooled actors, at most this many alive at once in total, so
// ~8 animated characters (with the player) keep 60 fps. Humanoids walk on the floor and swing; others hover.
const MODEL_POOL = 6;
const WALKER_HEIGHT = 1.8;
const WALK_SPEED = [0, 1.7, 2.8, 4.2]; // m/s by enemy.speed
const STRIKE_RANGE = 1.7;
const GUN_ANIM_SEC = 0.28; // the recoil clip restarts at most this often while firing
const MELEE_SEC = 0.5; // one sword swing; the slash wave leaves the blade at its impact frame
const MELEE_IMPACT = 0.42; // impact, as a fraction of the attack clip
const EFFECT_COLOR = { heal: 0x6dff9c, score: 0xffd166, shield: 0x6fd8ff, key: 0xc89bff };
const EFFECTS = {
  score: (m) => { m.score += 100; return '+100'; },
  heal: (m) => { m.hp = Math.min(m.maxHp, m.hp + 30); return '+30 HP'; },
  shield: (m) => { m.shield = 5; return '방어막 5초'; },
  key: (m) => { m.score += 250; return '+250'; },
};
const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

export async function createSf(world, spec, hud, playerActor) {
  const mode = new SfMode(world, spec, hud, playerActor);
  await mode.build();
  return mode;
}

export class SfMode {
  constructor(world, spec, hud, playerActor) {
    Object.assign(this, { world, spec, hud, playerActor });
    this.root = new THREE.Group();
    world.scene.add(this.root);
    this.accent = color(spec.palette.accent);
    this.rnd = mulberry32(spec.map?.seed ?? 1234);
    Object.assign(this, {
      hp: 100, score: 0, kills: 0, elapsed: 0, shield: 0, hurtFor: 0, spawnIn: START_GRACE, grace: START_GRACE, opening: 0, fireIn: 0,
      aimHold: 0, drones: [], bolts: [], enemyBolts: [], pickups: [], boxes: [], ended: false, sinceHurt: 99,
    });
    this.tune = TUNE[spec.difficulty];
    const { type, target } = spec.objective;
    this.target = type === 'kills' && spec.genre === 'sf-shooter' ? Math.min(target, KILL_TARGET_CAP) : target;
    const env = spec.environment ?? {};
    HALF = env.size ?? 30;
    this.theme = THEMES[env.theme] ?? THEMES['neon-arena'];
    this.skyKind = env.sky ?? this.theme.sky;
    this.layout = env.layout ?? 'pillars';
    this.obstacles = env.obstacles ?? 10;
    const rules = spec.rules ?? {};
    this.maxHp = rules.playerHp ?? 100;
    this.hp = this.maxHp;
    this.timeLimit = rules.timeLimitSec || 0;
    this.enemyRate = rules.enemyRate ?? 1;
    Object.assign(this, { collected: 0, cores: [], beacons: 0, beacon: null, boss: null, bossDone: false });
  }

  async build() {
    const { world, spec } = this;
    const { scene, renderer } = world;
    const bg = color(spec.palette.bg);
    scene.background = null;
    const sky = SKIES[this.skyKind] ?? SKIES.space;
    const fogColor = sky.horizon != null ? new THREE.Color(sky.horizon).multiplyScalar(0.8) : bg.clone().lerp(this.accent, 0.05);
    scene.fog = new THREE.FogExp2(fogColor, this.theme.fog);
    // the light probe is kept as its render target: that is what dispose() frees (a render target's texture.dispose()
    // frees nothing)
    this.envTarget = world.pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = 0.3;
    renderer.toneMappingExposure = 1.05;
    world.bloom.strength = 0.65; world.bloom.radius = 0.45; world.bloom.threshold = 0.85;

    this.buildSky(bg);
    this.buildArena(bg);
    this.buildLights();

    // player
    const player = this.playerActor;
    this.root.add(player.root);
    this.player = new PlayerController(world, player, {
      speed: spec.player.speed,
      groundAt: () => 0,
      collide: (p, r) => this.collide(p, r),
      bounds: { minX: -HALF + 1.2, maxX: HALF - 1.2, minZ: -HALF + 1.2, maxZ: HALF - 1.2 },
    });
    this.player.dashColor = this.accent;
    this.melee = player.weapon?.type === 'melee';
    this.pendingSlash = -1;
    this.player.place(0, 6);
    this.player.yaw = Math.PI; // away from the camera
    Object.assign(world.rig, { yaw: 0, pitch: 0.22, distance: 5.2, shoulder: 0.75, height: 1.45, first: true, blockers: this.boxes, minY: () => 0.3 });
    this.shieldMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 3), new THREE.MeshBasicMaterial({
      color: this.accent.clone().multiplyScalar(0.5), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true,
    }));
    this.shieldMesh.visible = false;
    this.root.add(this.shieldMesh);

    // shared bolt assets
    this.boltGeom = new THREE.CapsuleGeometry(0.05, 0.7, 2, 6).rotateX(Math.PI / 2);
    this.boltMat = new THREE.MeshBasicMaterial({ color: this.accent.clone().multiplyScalar(6), toneMapped: false });
    this.enemyBoltGeom = new THREE.SphereGeometry(0.16, 12, 8);

    // pooled actors for enemies with an IP model
    const modelled = spec.enemies.map((e, i) => (e.modelUrl ? i : -1)).filter((i) => i >= 0);
    this.pools = new Map();
    this.pooled = new Set(); // enemies whose IP model loaded: they never fall back to a procedural stand-in
    await Promise.all(modelled.map(async (i, k) => {
      const enemy = spec.enemies[i];
      const n = Math.max(1, Math.floor(MODEL_POOL / modelled.length) + (k < MODEL_POOL % modelled.length ? 1 : 0));
      const h = enemy.humanoid ? WALKER_HEIGHT : 1.3;
      const actors = await Promise.all(Array.from({ length: n }, () => world.makeActor(enemy, h, () => new THREE.Group(), { zombie: true })));
      this.pools.set(i, actors.filter((a) => a.kind !== 'procedural'));
      this.pooled.add(i);
    }));
    this.dying = [];

    // pickups on pads + templates for drops
    this.propActors = await Promise.all(spec.props.map((p) => world.makeActor(p, 0.75, () => crystal(EFFECT_COLOR[p.effect]), { maxExtent: PICKUP_MAX })));
    this.pads = spec.props.length ? [0, 1, 2, 3].map((k) => {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      return { x: Math.cos(a) * 13, z: Math.sin(a) * 13, prop: k % spec.props.length, pickup: null, respawnIn: 0 };
    }) : [];
    for (const pad of this.pads) {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.25, 0.12, 32), new THREE.MeshStandardMaterial({ color: 0x1b2029, metalness: 0.8, roughness: 0.3 }));
      base.position.set(pad.x, 0.06, pad.z);
      base.receiveShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.03, 8, 48), glow(EFFECT_COLOR[spec.props[pad.prop].effect], 3));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(pad.x, 0.14, pad.z);
      this.root.add(base, ring);
      pad.pickup = this.spawnPickup(pad.prop, pad.x, pad.z, pad);
    }
    this.hud.crosshair(true);
    this.refreshHud();
  }

  buildSky(bg) {
    const kind = SKIES[this.skyKind] ?? SKIES.space;
    const top = kind.top != null ? new THREE.Color(kind.top) : bg.clone().multiplyScalar(0.25);
    const horizon = kind.horizon != null ? new THREE.Color(kind.horizon) : bg.clone().lerp(this.accent, 0.07);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: top }, horizon: { value: horizon } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y, -1.0, 1.0); float t = pow(1.0 - abs(h), 5.0);
          gl_FragColor = vec4(mix(top, horizon, t), 1.0); }`,
    }));
    sky.renderOrder = -1;
    const n = Math.max(1, kind.stars), pos = new Float32Array(n * 3), tint = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = this.rnd() * 2 - 1, a = this.rnd() * Math.PI * 2;
      const y = Math.abs(u) * 0.95 + 0.05, r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(a) * r * 600, y * 600, Math.sin(a) * r * 600], i * 3);
      const b = 0.5 + this.rnd() * 1.8;
      tint.set([b, b, b * (1 + this.rnd() * 0.3)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(tint, 3));
    const dot = canvasTexture(32, (c2, n) => {
      const grd = c2.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      grd.addColorStop(0, '#fff'); grd.addColorStop(0.4, 'rgba(255,255,255,.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      c2.fillStyle = grd; c2.fillRect(0, 0, n, n);
    });
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 3, map: dot, transparent: true, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    // a ringed planet low on the horizon
    const planet = new THREE.Mesh(new THREE.SphereGeometry(70, 64, 32), new THREE.MeshStandardMaterial({
      color: this.accent.clone().offsetHSL(0.45, -0.35, -0.25), roughness: 0.9, fog: false,
    }));
    planet.position.set(-300, 150, -520);
    const ring = new THREE.Mesh(new THREE.RingGeometry(95, 140, 96), new THREE.MeshBasicMaterial({
      color: this.accent.clone().offsetHSL(0.45, -0.3, -0.1), side: THREE.DoubleSide, transparent: true, opacity: 0.25, fog: false, depthWrite: false,
    }));
    ring.position.copy(planet.position);
    ring.rotation.set(1.2, 0.3, 0.2);
    this.root.add(sky);
    if (kind.stars) this.root.add(stars);
    if (kind.planet) this.root.add(planet, ring);
  }

  buildArena(bg) {
    const accentCss = this.spec.palette.accent;
    const th = this.theme;
    const base = new THREE.Color(th.floor).lerp(bg, th === THEMES['neon-arena'] ? 0.4 : 0.1);
    const panel = canvasTexture(512, (g, s) => {
      g.fillStyle = '#' + base.getHexString(); g.fillRect(0, 0, s, s);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const l = 0.9 + ((i * 7 + j * 3) % 5) * 0.03;
        g.fillStyle = `rgba(255,255,255,${(l - 0.9) * 0.6})`;
        g.fillRect(i * 128 + 3, j * 128 + 3, 122, 122);
      }
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3;
      for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, s); g.moveTo(0, i * 128); g.lineTo(s, i * 128); g.stroke(); }
    }, { repeat: 8 });
    const lines = canvasTexture(512, (g, s) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, s, s);
      g.strokeStyle = '#fff';
      g.globalAlpha = 0.18; g.lineWidth = 2;
      for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, s); g.moveTo(0, i * 128); g.lineTo(s, i * 128); g.stroke(); }
      g.globalAlpha = 0.55; g.lineWidth = 2;
      g.strokeRect(1, 1, s - 2, s - 2);
      g.globalAlpha = 1; g.fillStyle = '#fff';
      for (const [x, y] of [[0, 0], [s, 0], [0, s], [s, s]]) g.fillRect(x - 6, y - 6, 12, 12);
    }, { repeat: 8, srgb: false });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2 + 4, HALF * 2 + 4).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
      map: panel, emissiveMap: lines, emissive: th.lava != null ? new THREE.Color(th.lava) : this.accent, emissiveIntensity: th.grid,
      roughness: th.grid > 0.3 ? 0.42 : 0.9, metalness: th.grid > 0.3 ? 0.5 : 0.05,
    }));
    floor.receiveShadow = true;
    const apron = new THREE.Mesh(new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.4), roughness: 0.6, metalness: 0.5 }));
    apron.position.y = -0.6;
    this.root.add(floor, apron);

    const metal = new THREE.MeshStandardMaterial({ color: new THREE.Color(th.wall), roughness: th.grid > 0.3 ? 0.42 : 0.85,
      metalness: th.grid > 0.3 ? 0.7 : 0.1 });
    const strip = glow(accentCss, 1.7);
    const addBox = (mesh, w, h, d) => {
      mesh.castShadow = mesh.receiveShadow = true;
      this.root.add(mesh);
      mesh.updateMatrixWorld();
      this.boxes.push(new THREE.Box3().setFromObject(mesh).expandByScalar(0.02));
      return mesh;
    };
    // perimeter wall with a light strip
    for (const [x, z, w, d] of [[0, -HALF - 0.5, HALF * 2 + 2, 1], [0, HALF + 0.5, HALF * 2 + 2, 1], [-HALF - 0.5, 0, 1, HALF * 2], [HALF + 0.5, 0, 1, HALF * 2]]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, d), metal);
      wall.position.set(x, 1.1, z);
      addBox(wall);
      const s = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.08, d + 0.02), strip);
      s.position.set(x, 2.0, z);
      this.root.add(s);
    }
    // pillars
    const pillarGeom = new RoundedBoxGeometry(2.2, 9, 2.2, 3, 0.18);
    const edgeGeom = new THREE.BoxGeometry(0.045, 8.2, 0.045);
    const capGeom = new THREE.TorusGeometry(1.3, 0.05, 8, 4);
    for (let k = 0; k < (this.layout === 'pillars' ? 8 : 0); k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      const x = Math.cos(a) * Math.min(19, HALF - 6), z = Math.sin(a) * Math.min(19, HALF - 6);
      const p = new THREE.Mesh(pillarGeom, metal);
      p.position.set(x, 4.5, z);
      addBox(p);
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const e = new THREE.Mesh(edgeGeom, strip);
        e.position.set(x + dx * 1.08, 4.5, z + dz * 1.08);
        this.root.add(e);
      }
      const cap = new THREE.Mesh(capGeom, strip);
      cap.rotation.set(Math.PI / 2, 0, Math.PI / 4);
      cap.position.set(x, 9.1, z);
      this.root.add(cap);
    }
    // maze: wall segments on a grid with gaps; ring: a broken circular wall around the middle
    if (this.layout === 'maze') {
      const step = 8;
      for (let gx = -HALF + step; gx < HALF - 2; gx += step) for (let gz = -HALF + step; gz < HALF - 2; gz += step) {
        if (Math.hypot(gx, gz) < 7 || this.rnd() < 0.35) continue;
        const along = this.rnd() < 0.5;
        const w = new THREE.Mesh(new THREE.BoxGeometry(along ? 6 : 0.8, 2.6, along ? 0.8 : 6), metal);
        w.position.set(gx, 1.3, gz);
        addBox(w);
      }
    } else if (this.layout === 'ring') {
      const r = Math.min(16, HALF - 6);
      for (let k = 0; k < 12; k++) {
        if (k % 3 === 0) continue; // gaps
        const a = (k / 12) * Math.PI * 2;
        const w = new THREE.Mesh(new THREE.BoxGeometry(2 * r * Math.sin(Math.PI / 12) + 0.2, 2.4, 0.9), metal);
        w.position.set(Math.cos(a) * r, 1.2, Math.sin(a) * r);
        w.rotation.y = -a + Math.PI / 2;
        addBox(w);
      }
    }
    // cover, seeded, kept off the center and pickup pads; the theme picks its shape
    const coverGeom = {
      block: new RoundedBoxGeometry(3.2, 1.25, 1.3, 2, 0.12),
      rock: new THREE.DodecahedronGeometry(1.3, 0).scale(1.4, 0.8, 1.1),
      ruin: new THREE.BoxGeometry(1.4, 2.6, 1.4),
      ice: new THREE.OctahedronGeometry(1.4, 0).scale(0.8, 1.6, 0.8),
    }[th.obstacle];
    if (th.obstacle === 'ice') metal.setValues({ color: new THREE.Color(0xbfe6ff), roughness: 0.1, metalness: 0, transparent: true, opacity: 0.85 });
    const lipGeom = new THREE.BoxGeometry(3.0, 0.05, 0.05);
    let placed = 0;
    for (let tries = 0; tries < 300 && placed < this.obstacles; tries++) {
      const x = (this.rnd() * 2 - 1) * (HALF - 5), z = (this.rnd() * 2 - 1) * (HALF - 5);
      const r = Math.hypot(x, z);
      if (r < 7 || Math.abs(r - 13) < 2.5 || Math.abs(r - 19) < 3) continue;
      if (this.boxes.some((b) => b.distanceToPoint(tmp.set(x, 0.6, z)) < 3)) continue;
      const c = new THREE.Mesh(coverGeom, metal);
      const tall = th.obstacle === 'ruin' ? 0.6 + this.rnd() * 1.2 : 1;
      c.scale.y = tall;
      c.position.set(x, th.obstacle === 'block' ? 0.625 : th.obstacle === 'ruin' ? 1.3 * tall : 0.9, z);
      c.rotation.y = th.obstacle === 'block' ? (this.rnd() < 0.5 ? 0 : Math.PI / 2) : this.rnd() * Math.PI;
      addBox(c);
      if (th.obstacle === 'block') {
        const lip = new THREE.Mesh(lipGeom, strip);
        lip.position.set(0, 0.55, 0.66);
        c.add(lip);
      }
      placed++;
    }
    // center spawn ring
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.35, 64).rotateX(-Math.PI / 2), glow(accentCss, 2));
    ring.position.y = 0.02;
    this.root.add(ring);
  }

  buildLights() {
    const hemi = new THREE.HemisphereLight(this.accent.clone().lerp(new THREE.Color(0x8899cc), 0.8), 0x07080b, this.theme.hemi);
    const sun = new THREE.DirectionalLight(this.theme.sun, this.theme.sunI);
    sun.position.set(22, 38, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -HALF - 4, right: HALF + 4, top: HALF + 4, bottom: -HALF - 4, near: 5, far: 110 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    this.root.add(hemi, sun, sun.target);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 8;
      const light = new THREE.PointLight(this.accent, 6, 12, 1.8);
      light.position.set(Math.cos(a) * 10, 2.5, Math.sin(a) * 10);
      this.root.add(light);
    }
  }

  // Circle (player) vs box footprints, for boxes taller than the point.
  collide(p, r) {
    for (const b of this.boxes) {
      if (p.y > b.max.y - 0.05) continue;
      const cx = clamp(p.x, b.min.x, b.max.x), cz = clamp(p.z, b.min.z, b.max.z);
      const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
      if (d >= r) continue;
      if (d > 1e-4) { p.x = cx + (dx / d) * r; p.z = cz + (dz / d) * r; }
      else { // inside: push out along the shallowest axis
        const opts = [[b.min.x - r - p.x, 0], [b.max.x + r - p.x, 0], [0, b.min.z - r - p.z], [0, b.max.z + r - p.z]];
        const [ox, oz] = opts.reduce((a, c) => (Math.hypot(...c) < Math.hypot(...a) ? c : a));
        p.x += ox; p.z += oz;
      }
    }
  }

  // ── drones ──────────────────────────────────────────────────────────────

  poolFilled(i) { // at least one model of enemy i loaded (a pool that never filled keeps the procedural fallback)
    return this.drones.some((d) => d.pool === i) || this.dying.some((w) => w.pool === i);
  }

  // A playable ad's round (runtime3d.js, ?playable=): the enemies are there at its first frame. No grace, the rim's
  // spawns start at once, and the first OPENING come up in front of the camera (spawnOpening). The HUD build() wrote
  // (적 출현까지 5초, the design's time limit) is written again: it shows while the round holds for the first input
  openNow() {
    this.grace = 0;
    this.spawnIn = 0;
    this.opening = OPENING;
    this.refreshHud();
  }

  spawnOpening() {
    const n = this.opening;
    this.opening = 0;
    const blocked = (x, z) => this.boxes.some((b) => b.distanceToPoint(tmp.set(x, 0.6, z)) < 1.5);
    for (let i = 0; i < n; i++) this.spawnDrone(openingSpot(i, n, this.player.pos, this.world.rig.yaw, HALF, blocked));
  }

  // at: {x, z} (a playable round's opening); else somewhere on the rim, away from the player
  spawnDrone(at = null) {
    const { spec, player } = this;
    const i = Math.floor(Math.random() * spec.enemies.length);
    const enemy = spec.enemies[i];
    let x = at?.x, z = at?.z;
    for (let t = 0; !at && t < 12; t++) {
      const a = Math.random() * Math.PI * 2;
      x = Math.cos(a) * (HALF - 3); z = Math.sin(a) * (HALF - 3);
      if (Math.hypot(x - player.pos.x, z - player.pos.z) > 14) break;
    }
    const actor = this.pools.get(i)?.pop();
    // every pooled model is already out: wait for one to come back rather than spawn a procedural drone, so the
    // game shows only the IPs it was made with (출연 IP)
    if (!actor && this.pools.get(i)?.length === 0 && this.pooled.has(i) && this.poolFilled(i)) return null;
    if (actor && enemy.humanoid) return this.spawnWalker(enemy, actor, x, z, i);
    const drone = buildDrone(enemy, actor);
    drone.actor = actor;
    drone.pool = actor ? i : null;
    drone.center = drone.group.position;
    drone.group.position.set(x, drone.hover + 2, z);
    drone.speed = (2.4 + 1.6 * enemy.speed) * (enemy.shape === 'triangle' ? 1.3 : enemy.shape === 'square' ? 0.7 : 1);
    drone.hp = enemy.hp;
    drone.fireIn = 1.5 + Math.random() * 2;
    drone.phase = Math.random() * 10;
    drone.vel = new THREE.Vector3();
    this.root.add(drone.group);
    this.drones.push(drone);
    this.world.particles.emit(drone.group.position, { count: 30, color: enemy.color, speed: 6, size: 0.4, life: 0.6 });
    this.world.flash(drone.group.position, enemy.color, 25, 9);
    return drone;
  }

  // A humanoid enemy from its IP model: walks on the floor (zombie clips when rigged), strikes in melee.
  spawnWalker(enemy, actor, x, z, i = this.spec.enemies.indexOf(enemy)) {
    actor.animator?.revive();
    actor.root.visible = true;
    actor.root.position.set(x, 0, z);
    actor.root.rotation.y = Math.atan2(-x, -z);
    const c = new THREE.Color(enemy.color);
    const w = {
      walker: true, actor, pool: i, group: actor.root, center: new THREE.Vector3(x, 1.1, z), radius: 0.5, color: c,
      shape: enemy.shape, hp: enemy.hp, maxHp: enemy.hp, speed: WALK_SPEED[enemy.speed], vel: new THREE.Vector3(),
      yaw: actor.root.rotation.y, phase: Math.random() * 10, strikeCd: 0, striking: 0, glowMats: [], flash: 0, fireIn: 99,
    };
    this.root.add(actor.root);
    this.drones.push(w);
    this.world.particles.emit(w.center, { count: 30, color: c, speed: 5, size: 0.4, life: 0.6, dir: UP, spread: 0.8 });
    this.world.flash(w.center, c, 25, 9);
    return w;
  }

  // ── objective helpers: boss, cores, beacons ─────────────────────────────

  spawnBoss() {
    const d = this.spawnDrone();
    if (!d) return;
    d.boss = true;
    d.hp = d.maxHp = this.target;
    d.speed *= 0.7;
    d.group.scale.multiplyScalar(BOSS_SCALE);
    if (d.radius) d.radius *= BOSS_SCALE; // hit sphere grows with the model
    if (d.walker) d.hitHalf = 0.75 * BOSS_SCALE;
    this.boss = d;
    this.world.rig.shake(0.6);
    this.hud.popup('보스 등장!', d.center.clone().setY(3), 'kill');
  }

  freeSpot(minFromPlayer = 10) {
    for (let t = 0; t < 40; t++) {
      const x = (Math.random() * 2 - 1) * (HALF - 4), z = (Math.random() * 2 - 1) * (HALF - 4);
      if (Math.hypot(x - this.player.pos.x, z - this.player.pos.z) < minFromPlayer) continue;
      if (this.boxes.some((b) => b.distanceToPoint(tmp.set(x, 0.6, z)) < 2)) continue;
      return { x, z };
    }
    return { x: 0, z: -HALF / 2 };
  }

  marker(x, z, hex) {
    const g = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 14, 12, 1, true), new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex).multiplyScalar(2), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    beam.position.y = 7;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(REACH_RADIUS, 0.06, 8, 48), glow(hex, 3));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;
    g.add(beam, ring);
    g.position.set(x, 0, z);
    this.root.add(g);
    return g;
  }

  updateObjective(dt) {
    const type = this.spec.objective.type;
    const p = this.player.pos;
    if (type === 'boss' && !this.boss && !this.bossDone && this.elapsed > this.grace) this.spawnBoss();
    if (type === 'collect') {
      while (this.cores.length < Math.min(CORES_ON_MAP, this.target - this.collected)) {
        const { x, z } = this.freeSpot(8);
        const g = this.marker(x, z, 0xffd166);
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), glow(0xffd166, 4));
        gem.position.y = 1.2;
        g.add(gem);
        this.cores.push({ g, gem, t: Math.random() * 6 });
      }
      for (const c of this.cores) {
        c.t += dt;
        c.gem.rotation.y = c.t * 2;
        c.gem.position.y = 1.2 + Math.sin(c.t * 2.5) * 0.2;
        this.hud.float(c, '코어', c.g.position.clone().setY(2.4), 'tag');
        if (Math.hypot(p.x - c.g.position.x, p.z - c.g.position.z) < 1.5) {
          c.taken = true;
          this.collected += 1;
          this.score += 150;
          const at = c.g.position.clone().setY(1.4);
          this.hud.popup('+코어', at, 'pickup');
          this.world.particles.emit(at, { count: 40, color: 0xffd166, speed: 5, size: 0.35, life: 0.7, dir: UP, spread: 0.9 });
          this.hud.float(c, null);
          this.root.remove(c.g);
        }
      }
      this.cores = this.cores.filter((c) => !c.taken);
    }
    if (type === 'reach') {
      if (!this.beacon && this.beacons < this.target) {
        const { x, z } = this.freeSpot(15);
        this.beacon = { g: this.marker(x, z, 0x6fd8ff), hold: 0 };
      }
      const b = this.beacon;
      if (b) {
        this.hud.float(b, `목표 지점 ${this.beacons + 1}/${this.target}`, b.g.position.clone().setY(3), 'tag');
        const inside = Math.hypot(p.x - b.g.position.x, p.z - b.g.position.z) < REACH_RADIUS;
        b.hold = inside ? b.hold + dt : Math.max(0, b.hold - dt);
        b.g.children[1].scale.setScalar(1 - Math.min(1, b.hold / REACH_HOLD) * 0.6);
        if (b.hold >= REACH_HOLD) {
          this.beacons += 1;
          this.score += 200;
          this.hud.popup('지점 확보!', b.g.position.clone().setY(2), 'pickup');
          this.hud.float(b, null);
          this.root.remove(b.g);
          this.beacon = null;
        }
      }
    }
  }

  updateWalker(w, dt) {
    const p = this.player.pos;
    const g = w.group;
    const to = new THREE.Vector3(p.x - g.position.x, 0, p.z - g.position.z);
    const dist = to.length();
    to.normalize();
    w.engageIn = Math.max(0, (w.engageIn ?? 0) - dt);
    w.strikeCd = Math.max(0, w.strikeCd - dt);
    const anim = w.actor.animator;
    const desired = new THREE.Vector3();
    if (w.striking > 0) { // rooted while the swing plays; the hit lands on the clip's impact frame
      w.striking -= dt;
      if (!w.struck && w.striking <= w.impactAt) {
        w.struck = true;
        if (dist < STRIKE_RANGE + 0.5 && p.y < 1.2) this.damagePlayer(DAMAGE[w.shape], w.center);
      }
      w.yaw = angleDamp(w.yaw, Math.atan2(to.x, to.z), 6, dt);
    } else if (!w.attacker || w.engageIn > 0) { // hold at 9–13 m, sidestepping
      const side = new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(w.phase % 10 < 5 ? 0.6 : -0.6);
      desired.copy(to).multiplyScalar(dist > 13 ? 1 : dist < 9 ? -1 : 0).addScaledVector(side, 1);
    } else if (dist < STRIKE_RANGE && w.strikeCd <= 0) {
      const len = anim?.play('attack_melee', { parts: 'full', timeScale: 1.15, fadeIn: 0.1 }) || 0.8;
      w.striking = len;
      w.impactAt = len * (1 - MELEE_IMPACT);
      w.struck = false;
      w.strikeCd = len + 0.9;
    } else if (dist > STRIKE_RANGE * 0.8) desired.copy(to);
    for (const b of this.boxes) { // walk around pillars and cover
      b.getCenter(tmp2);
      const dx = g.position.x - tmp2.x, dz = g.position.z - tmp2.z, dd = Math.hypot(dx, dz);
      const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2 + 1.2;
      if (dd < r && dd > 1e-3 && r < 6) desired.add(new THREE.Vector3(dx / dd, 0, dz / dd).multiplyScalar((r - dd) * 1.5));
    }
    for (const o of this.drones) {
      if (o === w || !o.walker) continue;
      const dx = g.position.x - o.group.position.x, dz = g.position.z - o.group.position.z, dd = Math.hypot(dx, dz);
      if (dd < 1.4 && dd > 1e-3) desired.add(new THREE.Vector3(dx / dd, 0, dz / dd).multiplyScalar(0.9));
    }
    if (desired.lengthSq() > 1) desired.normalize();
    desired.multiplyScalar(w.striking > 0 ? 0 : w.speed);
    w.vel.lerp(desired, 1 - Math.exp(-6 * dt));
    const next = g.position.clone().addScaledVector(w.vel, dt);
    this.collide(next, 0.4);
    g.position.set(clamp(next.x, -HALF + 1, HALF - 1), 0, clamp(next.z, -HALF + 1, HALF - 1));
    const flat = Math.hypot(w.vel.x, w.vel.z);
    if (flat > 0.3 && w.striking <= 0) w.yaw = angleDamp(w.yaw, Math.atan2(w.vel.x, w.vel.z), 8, dt);
    g.rotation.y = w.yaw;
    w.center.set(g.position.x, 1.1 * g.scale.y, g.position.z); // a scaled boss stands taller
    if (anim) anim.update(dt, { speed: flat });
    else animateBody(w.actor, dt, { speed01: flat / 4, phase: (w.phase += dt * (6 + flat * 1.5)) });
  }

  // Dead walkers play their death clip, then fade and go back to the pool.
  updateDying(dt) {
    for (const w of this.dying) {
      w.deadFor += dt;
      w.actor.animator?.update(dt, { speed: 0 });
      const fade = clamp((w.deadFor - w.deathLen) / 0.8, 0, 1);
      if (fade > 0) fadeOut(w.actor.root, 1 - fade);
      if (!w.actor.animator) w.group.position.y = -fade * 1.8;
      if (fade >= 1) {
        this.root.remove(w.group);
        w.actor.root.scale.setScalar(1); // a boss returns its actor at normal size
        this.pools.get(w.pool).push(w.actor);
        w.released = true;
      }
    }
    this.dying = this.dying.filter((w) => !w.released);
  }

  updateDrones(dt) {
    const chest = tmp2.copy(this.player.pos).setY(this.player.pos.y + 1.1);
    // The nearest drones (at most tune.attackers) attack; the others circle at range and hold fire.
    const ranked = [...this.drones].sort((a, b) => a.center.distanceToSquared(chest) - b.center.distanceToSquared(chest));
    ranked.forEach((d, i) => {
      const attack = i < this.tune.attackers;
      if (attack && !d.attacker) d.engageIn = ENGAGE_DELAY;
      d.attacker = attack;
    });
    const fireScale = 1 / this.tune.fireRate;
    for (const d of this.drones) {
      if (d.walker) { d.phase += dt; this.updateWalker(d, dt); continue; }
      const g = d.group;
      d.phase += dt;
      const to = tmp.copy(chest).sub(g.position);
      const dist = to.length();
      to.normalize();
      const desired = new THREE.Vector3();
      d.engageIn = Math.max(0, (d.engageIn ?? 0) - dt);
      if (!d.attacker || d.engageIn > 0) { // hold at 12–16 m and strafe
        const side = new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(d.phase % 12 < 6 ? 0.8 : -0.8);
        desired.copy(to).multiplyScalar(dist > 16 ? 1 : dist < 12 ? -1 : 0).addScaledVector(side, 1);
        d.fireIn = Math.max(d.fireIn, 0.8 * fireScale);
      } else if (d.shape === 'circle') { // keep range and strafe; shoots
        const side = new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(Math.sin(d.phase * 0.5) > 0 ? 1 : -1);
        desired.copy(to).multiplyScalar(dist > 10 ? 1 : dist < 7 ? -0.8 : 0).addScaledVector(side, 0.9);
        d.fireIn -= dt;
        if (d.fireIn <= 0 && dist < 26) { d.fireIn = (2.1 + Math.random() * 1.2) * fireScale; this.fireEnemyBolt(d, chest); }
      } else if (d.shape === 'triangle') { // weaving dive
        const side = new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(Math.sin(d.phase * 3) * 0.6);
        desired.copy(to).add(side);
      } else { // square: heavy ram, fires a slow pair when far
        desired.copy(to);
        d.fireIn -= dt;
        if (d.fireIn <= 0 && dist > 9 && dist < 24) { d.fireIn = 3.2 * fireScale; this.fireEnemyBolt(d, chest); }
      }
      // avoid pillars and each other
      for (const b of this.boxes) {
        if (b.max.y < 3) continue;
        b.getCenter(tmp);
        const dx = g.position.x - tmp.x, dz = g.position.z - tmp.z, dd = Math.hypot(dx, dz);
        if (dd < 3.2) desired.add(new THREE.Vector3(dx / dd, 0, dz / dd).multiplyScalar((3.2 - dd) * 1.2));
      }
      for (const o of this.drones) {
        if (o === d) continue;
        const dx = g.position.x - o.group.position.x, dz = g.position.z - o.group.position.z, dd = Math.hypot(dx, dz);
        if (dd < 1.8 && dd > 1e-3) desired.add(new THREE.Vector3(dx / dd, 0, dz / dd).multiplyScalar(0.8));
      }
      desired.normalize().multiplyScalar(d.speed);
      d.vel.lerp(desired, 1 - Math.exp(-2.6 * dt));
      g.position.addScaledVector(d.vel, dt);
      const hoverY = (d.shape === 'triangle' && dist < 6 ? chest.y : d.hover) + Math.sin(d.phase * 2) * 0.15;
      g.position.y = damp(g.position.y, hoverY, 3, dt);
      g.position.x = clamp(g.position.x, -HALF + 1, HALF - 1);
      g.position.z = clamp(g.position.z, -HALF + 1, HALF - 1);
      // face travel, bank into turns
      const yaw = Math.atan2(d.vel.x, d.vel.z);
      g.rotation.y = yaw;
      d.body.rotation.z = damp(d.body.rotation.z, clamp(-d.vel.dot(new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))) * 0.2, -0.6, 0.6), 4, dt);
      d.body.rotation.x = 0.15;
      d.spin?.(dt);
      // engine trail
      d.trailAcc = (d.trailAcc ?? 0) + dt;
      if (d.trailAcc > 0.03) {
        d.trailAcc = 0;
        const back = tmp.set(0, 0, -d.radius).applyQuaternion(g.quaternion).add(g.position);
        this.world.particles.emit(back, { count: 1, color: d.color, speed: 0.3, size: 0.32, life: 0.4, drag: 4, intensity: 2.5 });
      }
      // hit flash decays
      if (d.flash > 0) {
        d.flash -= dt;
        for (const m of d.glowMats) m.emissive.copy(d.flash > 0 ? WHITE : d.color);
      }
      if (d.actor) d.body.scale.setScalar(1 + Math.max(0, d.flash) * 2);
      // ram: hurts, then the drone bounces off and falls back to range before its next run
      if (d.attacker && d.engageIn <= 0 && g.position.distanceTo(chest) < 0.75 + d.radius) {
        this.damagePlayer(DAMAGE[d.shape], g.position);
        d.vel.copy(to).multiplyScalar(-12);
        d.engageIn = RETREAT_SEC;
        this.world.particles.emit(g.position, { count: 20, color: d.color, speed: 6, size: 0.3, life: 0.4 });
      }
    }
    this.drones = this.drones.filter((d) => !d.dead);
  }

  fireEnemyBolt(d, chest) {
    const mesh = new THREE.Mesh(this.enemyBoltGeom, new THREE.MeshBasicMaterial({ color: d.color.clone().multiplyScalar(5), toneMapped: false }));
    mesh.position.copy(d.group.position);
    const lead = tmp.copy(this.player.vel).multiplyScalar(0.35);
    const vel = chest.clone().add(lead).sub(mesh.position).normalize().multiplyScalar(13);
    this.root.add(mesh);
    this.enemyBolts.push({ mesh, vel, life: 4, color: d.color });
    this.world.particles.emit(mesh.position, { count: 8, color: d.color, speed: 2, size: 0.3, life: 0.3 });
  }

  hitDrone(d, at) {
    d.hp -= 1;
    d.flash = 0.07;
    if (d.walker && d.hp > 0) { // flinch: hit reaction on the upper body and a small shove
      d.actor.animator?.play('hit', { parts: 'upper', fadeIn: 0.04, fadeOut: 0.2 });
      d.vel.addScaledVector(tmp.copy(d.center).sub(this.player.pos).setY(0).normalize(), 2.5);
    }
    for (const m of d.glowMats) m.emissive.copy(WHITE);
    this.world.particles.emit(at, { count: 10, color: d.color, speed: 7, size: 0.18, life: 0.35, gravity: 6 });
    if (d.hp <= 0) this.killDrone(d, true);
  }

  killDrone(d, byPlayer) {
    if (d.dead) return;
    d.dead = true;
    const at = d.center.clone();
    this.world.particles.emit(at, { count: d.walker ? 25 : 55, color: d.color, speed: d.walker ? 6 : 11, size: 0.38, life: 0.8, gravity: 4 });
    this.world.particles.emit(at, { count: 20, color: 0xffffff, speed: 5, size: 0.5, life: 0.35 });
    this.world.flash(at, d.color, d.walker ? 30 : 60, 12);
    this.world.rig.shake(byPlayer ? 0.22 : 0.45);
    if (d.walker) { // death clip, then fade (updateDying)
      d.deathLen = d.actor.animator?.die() ?? 0;
      d.deadFor = 0;
      this.dying.push(d);
    } else {
      this.root.remove(d.group);
      if (d.actor) { d.body.remove(d.actor.root); this.pools.get(d.pool).push(d.actor); }
      disposeTree(d.group);
    }
    if (d.boss) { this.bossDone = true; this.boss = null; }
    if (!byPlayer) return;
    this.kills += 1;
    this.score += 10 * d.maxHp;
    this.hud.popup(`+${10 * d.maxHp}`, at, 'kill');
    if (this.spec.props.length && Math.random() < DROP_CHANCE) {
      this.spawnPickup(Math.floor(Math.random() * this.spec.props.length), at.x, at.z, null, 12);
    }
  }

  // ── player weapons ──────────────────────────────────────────────────────

  // The drone closest to the camera aim within the ~6.5 deg assist cone (and 70 m), or null.
  coneTarget(minCos = 0.9935) {
    const cam = this.world.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    let best = null, bestCos = minCos;
    for (const d of this.drones) {
      const to = tmp.copy(d.center).sub(cam.position);
      const len = to.length();
      if (len > 70) continue;
      const c = to.divideScalar(len).dot(dir);
      if (c > bestCos) { bestCos = c; best = d; }
    }
    return best;
  }

  aim() {
    const cam = this.world.camera;
    const origin = cam.position;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const best = this.coneTarget(AUTO_CONE_COS);
    if (best) {
      const t = best.center.distanceTo(origin) / BOLT_SPEED;
      return best.center.clone().addScaledVector(best.vel, t);
    }
    const ray = new THREE.Ray(origin, dir);
    let far = 80;
    for (const b of this.boxes) { const hit = ray.intersectBox(b, tmp); if (hit) far = Math.min(far, hit.distanceTo(origin)); }
    if (dir.y < -0.01) far = Math.min(far, -origin.y / dir.y);
    return origin.clone().addScaledVector(dir, Math.max(far, 4));
  }

  // Click/F: a gun (or no weapon) fires at once with the recoil clip; a melee weapon swings and the slash wave
  // leaves the blade on the swing's impact frame.
  fire() {
    const p = this.player;
    const camFwd = this.world.camera.getWorldDirection(tmp);
    p.faceYaw = Math.atan2(camFwd.x, camFwd.z);
    const anim = p.actor.animator;
    if (this.melee && anim) {
      this.aimHold = MELEE_SEC + 0.2;
      const len = anim.duration('attack_melee');
      const ts = len / MELEE_SEC;
      anim.play('attack_melee', { parts: 'auto', timeScale: ts, fadeIn: 0.05, fadeOut: 0.12 });
      this.pendingSlash = MELEE_SEC * MELEE_IMPACT;
      return;
    }
    if (anim && this.elapsed - (this.lastRecoil ?? -9) > GUN_ANIM_SEC) {
      anim.play('attack_gun', { parts: 'upper', fadeIn: 0.03, fadeOut: 0.15 });
      this.lastRecoil = this.elapsed;
    }
    this.shoot();
    this.aimHold = 0.45;
  }

  shoot(spread = 0) {
    const p = this.player;
    const target = this.aim();
    const fwd = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const weapon = p.actor.weapon;
    const muzzle = weapon
      ? weapon.muzzle.getWorldPosition(new THREE.Vector3())
      : p.pos.clone().add(new THREE.Vector3(0, 1.25, 0)).addScaledVector(fwd, 0.45).addScaledVector(right, -0.3);
    if (spread) target.addScaledVector(right, spread);
    const vel = target.sub(muzzle).normalize().multiplyScalar(BOLT_SPEED);
    const mesh = new THREE.Mesh(this.boltGeom, this.boltMat);
    mesh.position.copy(muzzle);
    mesh.lookAt(tmp.copy(muzzle).add(vel));
    this.root.add(mesh);
    this.bolts.push({ mesh, vel, life: 1.4 });
    this.world.particles.emit(muzzle, { count: 4, color: this.accent, speed: 3, size: 0.28, life: 0.12, dir: vel.clone().normalize(), spread: 0.5 });
  }

  updateBolts(dt) {
    const seg = new THREE.Ray();
    for (const b of this.bolts) {
      const step = b.vel.length() * dt;
      seg.set(b.mesh.position, tmp.copy(b.vel).normalize());
      let hitAt = null, hitDrone = null, nearest = step;
      for (const d of this.drones) {
        if (d.dead) continue;
        const pt = seg.closestPointToPoint(d.center, new THREE.Vector3());
        const along = pt.distanceTo(b.mesh.position);
        // walkers: a vertical capsule around the chest point (knees to head); drones: a sphere
        const r = d.walker ? (Math.abs(pt.y - d.center.y) < (d.hitHalf ?? 0.75) ? d.radius : 0) : d.radius + 0.15;
        const off = Math.hypot(pt.x - d.center.x, pt.z - d.center.z, d.walker ? 0 : pt.y - d.center.y);
        if (along <= nearest && off < r) { nearest = along; hitDrone = d; hitAt = pt; }
      }
      for (const box of this.boxes) {
        const hit = seg.intersectBox(box, new THREE.Vector3());
        if (hit && hit.distanceTo(b.mesh.position) <= nearest) { nearest = hit.distanceTo(b.mesh.position); hitDrone = null; hitAt = hit; }
      }
      if (!hitAt && b.mesh.position.y + b.vel.y * dt < 0) hitAt = b.mesh.position.clone().addScaledVector(b.vel, -b.mesh.position.y / b.vel.y).setY(0.02);
      if (hitAt) {
        b.life = 0;
        if (hitDrone) this.hitDrone(hitDrone, hitAt);
        else this.world.particles.emit(hitAt, { count: 8, color: this.accent, speed: 4, size: 0.18, life: 0.3, gravity: 9 });
        continue;
      }
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;
    }
    for (const b of this.bolts) if (b.life <= 0) this.root.remove(b.mesh);
    this.bolts = this.bolts.filter((b) => b.life > 0);

    const chest = tmp2.copy(this.player.pos).setY(this.player.pos.y + 1.0);
    for (const b of this.enemyBolts) {
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.mesh.position.distanceTo(chest) < 0.6) { b.life = 0; this.damagePlayer(DAMAGE.bolt, b.mesh.position); }
      else if (this.boxes.some((box) => box.containsPoint(b.mesh.position)) || b.mesh.position.y < 0) {
        b.life = 0;
        this.world.particles.emit(b.mesh.position, { count: 8, color: b.color, speed: 3, size: 0.2, life: 0.3 });
      }
      if (b.life <= 0) { this.root.remove(b.mesh); b.mesh.material.dispose(); }
    }
    this.enemyBolts = this.enemyBolts.filter((b) => b.life > 0);
  }

  damagePlayer(amount, from) {
    if (this.ended || this.hurtFor > 0 || this.player.invulnerableFromDash) return;
    if (this.shield > 0) {
      this.world.particles.emit(from, { count: 16, color: this.accent, speed: 4, size: 0.3, life: 0.4 });
      return;
    }
    this.hp = Math.max(0, this.hp - amount * this.tune.damage);
    this.hurtFor = this.tune.iframes;
    if (this.hp > 0) this.player.actor.animator?.play('hit', { parts: 'upper', fadeIn: 0.04, fadeOut: 0.2 });
    this.sinceHurt = 0;
    this.world.hurt = 0.85;
    this.world.rig.shake(0.5);
    const away = tmp.copy(this.player.pos).sub(from).setY(0).normalize().multiplyScalar(6);
    this.player.impulse(away.setY(2.5));
  }

  // ── pickups ─────────────────────────────────────────────────────────────

  spawnPickup(propIndex, x, z, pad = null, ttl = Infinity) {
    const template = this.propActors[propIndex];
    const effect = this.spec.props[propIndex].effect;
    const group = new THREE.Group();
    const visual = template.root.clone(true);
    group.add(visual);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.025, 8, 40), glow(EFFECT_COLOR[effect], 3.5));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.2;
    group.add(ring);
    group.position.set(x, 0, z);
    this.root.add(group);
    const pickup = { group, visual, effect, propIndex, pad, ttl, t: Math.random() * 6, billboard: template.kind === 'billboard' };
    this.pickups.push(pickup);
    return pickup;
  }

  updatePickups(dt) {
    const p = this.player.pos;
    for (const k of this.pickups) {
      k.t += dt;
      k.ttl -= dt;
      k.visual.position.y = 0.55 + Math.sin(k.t * 2.2) * 0.12;
      k.visual.rotation.y = k.billboard ? this.world.rig.yaw : k.t * 1.4;
      if (k.ttl < 3) k.group.visible = Math.sin(k.t * 20) > -0.3;
      const near = Math.hypot(p.x - k.group.position.x, p.z - k.group.position.z) < 1.3 && p.y < 2;
      if (near) {
        const label = EFFECTS[k.effect](this);
        const at = k.group.position.clone().setY(1.2);
        this.hud.popup(label, at, 'pickup');
        this.world.particles.emit(at, { count: 30, color: EFFECT_COLOR[k.effect], speed: 4, size: 0.35, life: 0.6, dir: UP, spread: 0.9 });
        this.world.flash(at, EFFECT_COLOR[k.effect], 20, 6);
        k.ttl = 0;
        if (k.pad) { k.pad.pickup = null; k.pad.respawnIn = PICKUP_RESPAWN; }
      }
      if (k.ttl <= 0) this.root.remove(k.group);
    }
    this.pickups = this.pickups.filter((k) => k.ttl > 0);
    for (const pad of this.pads) {
      if (pad.pickup) continue;
      pad.respawnIn -= dt;
      if (pad.respawnIn <= 0) pad.pickup = this.spawnPickup(pad.prop, pad.x, pad.z, pad);
    }
  }

  // ── frame ───────────────────────────────────────────────────────────────

  update(dt) {
    const { world, player } = this;
    const input = world.input;
    this.elapsed += dt;
    this.hurtFor = Math.max(0, this.hurtFor - dt);
    this.shield = Math.max(0, this.shield - dt);
    this.aimHold -= dt;
    if (this.aimHold <= 0) player.faceYaw = null;
    player.update(dt, input, world.rig);
    world.rig.update(dt, player.pos, input);
    player.actor.root.visible = this.hurtFor <= 0 || Math.sin(this.elapsed * 50) > 0;

    this.sinceHurt += dt;
    if (this.sinceHurt > REGEN_DELAY && this.hp > 0) this.hp = Math.min(this.maxHp, this.hp + this.tune.regen * dt);
    this.fireIn -= dt;
    // Auto-fire while a drone sits in the aim cone; click / F / RT fire anywhere.
    const firing = input.fireHeld || input.down('KeyF') || input.pad?.fire || !!this.coneTarget(AUTO_CONE_COS);
    if (firing && this.fireIn <= 0) { this.fireIn = this.melee && player.actor.animator ? MELEE_SEC : FIRE_SEC; this.fire(); }
    if (this.pendingSlash >= 0) {
      this.pendingSlash -= dt;
      if (this.pendingSlash < 0) for (const s of [-1.6, 0, 1.6]) this.shoot(s);
    }
    player.actor.animator?.setAiming(!this.melee && this.aimHold > 0);

    if (this.opening) this.spawnOpening();
    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      const ramp = this.spec.objective.type === 'survive' ? Math.max(0.5, 1 - this.elapsed / 120) : 1;
      this.spawnIn = (SPAWN_SEC[this.spec.difficulty] * ramp) / this.enemyRate * (this.spec.objective.type === 'boss' && this.boss ? 2 : 1);
      if (this.drones.length < MAX_ALIVE[this.spec.difficulty]) this.spawnDrone();
    }
    this.updateDrones(dt);
    this.updateDying(dt);
    this.updateBolts(dt);
    this.updatePickups(dt);
    this.updateObjective(dt);
    this.shieldMesh.visible = this.shield > 0;
    if (this.shield > 0) {
      this.shieldMesh.position.copy(player.pos).setY(player.pos.y + 0.95);
      this.shieldMesh.rotation.y += dt * 0.8;
    }

    const progress = this.refreshHud();
    if (this.hp <= 0) {
      this.end(false);
      world.particles.emit(tmp.copy(player.pos).setY(1), { count: 80, color: this.accent, speed: 9, size: 0.45, life: 1 });
      if (player.actor.animator) { player.actor.animator.setAiming(false); player.actor.animator.die(); player.actor.root.visible = true; }
      else player.actor.root.visible = false;
    } else if (progress >= this.target) this.end(true);
    else if (this.timeLimit && this.spec.objective.type !== 'survive' && this.elapsed >= this.timeLimit) this.end(false);
  }

  // Ended: keep the scene alive with a slow orbit.
  idle(dt) {
    const { world } = this;
    world.rig.yaw += dt * (REDUCED_MOTION ? 0.05 : 0.18);
    world.rig.update(dt, this.player.pos, { look: { x: 0, y: 0 }, down: () => false, pad: null });
    this.player.actor.animator?.update(dt, { speed: 0 });
    for (const d of this.drones) if (d.walker) d.actor.animator?.update(dt, { speed: 0 });
    this.updateDying(dt);
    this.updateBolts(dt);
  }

  end(won) {
    if (this.ended) return;
    this.ended = true;
    this.hud.end(won);
  }
  /** What the end screen says of this round (runtime3d.js hud.end, arpg-data.js endCard) →
   * { reason, result, resumeStage } */
  endSummary(won) {
    const { type } = this.spec.objective, { target } = this, of = (n) => `${Math.min(n, target)}/${target}`;
    const count = { kills: `적 ${of(this.kills)}명 격파`, survive: `${of(Math.floor(this.elapsed))}초 생존`, collect: `코어 ${of(this.collected)}개 회수`,
      reach: `목표 지점 ${of(this.beacons)}곳 확보`,
      boss: this.bossDone ? '보스 처치' : this.boss ? `보스 체력 ${Math.max(0, Math.ceil(this.boss.hp))} 남음` : '보스 등장 전' }[type];
    return { reason: won ? '목표를 달성했어요.' : this.hp <= 0 ? '체력이 다했어요.' : '제한 시간이 끝났어요.',
      result: [count, `점수 ${this.score}`, clock(this.elapsed)], resumeStage: 0 };
  }

  refreshHud() {
    const { type, label } = this.spec.objective;
    const { target } = this;
    const progress = {
      kills: this.kills, survive: Math.floor(this.elapsed), collect: this.collected, reach: this.beacons,
      boss: this.bossDone ? target : this.boss ? target - Math.max(0, Math.ceil(this.boss.hp)) : 0,
    }[type] ?? 0;
    const shown = `${Math.min(progress, target)}/${target}`;
    const text = {
      kills: `적 ${target}명 격파`, survive: `${target}초 생존`, collect: `코어 ${target}개 회수`,
      reach: `목표 지점 ${target}곳 확보`, boss: this.boss ? `보스 처치 (HP ${Math.max(0, Math.ceil(this.boss.hp))})` : '보스를 쓰러뜨려라',
    }[type];
    const left = this.timeLimit && type !== 'survive' ? ` · 남은 시간 ${Math.max(0, Math.ceil(this.timeLimit - this.elapsed))}초` : '';
    // the design's own sentence, unless its number is not the one played (KILL_TARGET_CAP)
    const said = target === this.spec.objective.target ? label || text : text;
    this.hud.objective(`목표: ${said} (${type === 'boss' ? (this.bossDone ? '완료' : text.includes('HP') ? '진행 중' : '대기') : shown})${left}`);
    this.hud.status(`점수 ${this.score}`);
    this.hud.health(Math.ceil(this.hp) / this.maxHp, this.shield);
    this.hud.dash(1 - this.player.dashCooldown / 0.9);
    if (this.spawnIn > 0 && this.elapsed < this.grace) this.hud.notice(`적 출현까지 ${Math.ceil(this.grace - this.elapsed)}초`);
    else this.hud.notice('');
    return progress;
  }

  // Dev hooks (localhost only, used by the browser smoke test).
  debugState() {
    const anim = this.player.actor.animator;
    return { genre: this.spec.genre, hp: this.hp, kills: this.kills, target: this.target, score: this.score, drones: this.drones.length, ended: this.ended,
      walkers: this.drones.filter((d) => d.walker).length, dying: this.dying.length, rigged: !!anim,
      walkersNear: this.drones.filter((d) => d.walker && d.center.distanceTo(this.player.pos) < 12).length,
      dyingAt: this.dying[0]?.group.position.toArray(),
      walkerAt: this.drones.filter((d) => d.walker).sort((a, b) => a.center.distanceTo(this.player.pos) - b.center.distanceTo(this.player.pos))[0]?.group.position.toArray(),
      anim: anim && { speed: +anim.speed.toFixed(2), loco: anim.loco.map((l) => [l.role, +l.speed.toFixed(2), +l.w.toFixed(2)]), oneShots: anim.oneShots.map((o) => o.role) },
      player: this.player.pos.toArray().map((v) => +v.toFixed(2)),
      weaponSize: this.player.actor.weapon && new THREE.Box3().setFromObject(this.player.actor.weapon.holder).getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)),
      bodySize: new THREE.Box3().setFromObject(this.player.actor.root).getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)) };
  }
  debugTeleport(x, z) { this.player.place(x, z); }
  // Autoplay (broadcaster): where the objective wants the player to walk, or null (boss/kills/survive: fight).
  autoGoal() {
    const p = this.player.pos;
    if (this.spec.objective.type === 'collect' && this.cores.length) {
      return this.cores.reduce((a, c) => (!a || c.g.position.distanceTo(p) < a.distanceTo(p) ? c.g.position : a), null);
    }
    if (this.spec.objective.type === 'reach' && this.beacon) return this.beacon.g.position;
    return null;
  }

  // Face a world point (camera yaw; the controller moves relative to it). Returns the flat distance.
  debugFacePoint(at) {
    const to = at.clone().sub(this.player.pos);
    this.world.rig.yaw = Math.atan2(-to.x, -to.z);
    this.world.rig.pitch = 0.22;
    return Math.hypot(to.x, to.z);
  }

  debugFaceNearest() {
    const p = this.player.pos;
    const d = this.drones.reduce((a, b) => (!a || b.center.distanceTo(p) < a.center.distanceTo(p) ? b : a), null);
    if (!d) return false;
    const to = d.center.clone().sub(p);
    this.world.rig.yaw = Math.atan2(-to.x, -to.z);
    this.world.rig.pitch = clamp(Math.atan2(1.4 - to.y, Math.hypot(to.x, to.z)) + 0.05, -0.25, 1.1);
    return true;
  }

  dispose() {
    for (const k of this.pickups) this.root.remove(k.group);
    this.root.remove(this.playerActor.root);
    this.world.scene.remove(this.root);
    disposeTree(this.root);
    for (const pool of this.pools.values()) for (const actor of pool) releaseDrawn(actor.root); // the walkers at rest: not under the root
    this.envTarget.dispose();
    this.world.particles.clear();
    this.hud.crosshair(false);
  }
}

// ── procedural meshes ─────────────────────────────────────────────────────

const WHITE = new THREE.Color(4, 4, 4);

function glow(hex, intensity) {
  return new THREE.MeshStandardMaterial({ color: 0x000000, emissive: hex, emissiveIntensity: intensity, roughness: 1, metalness: 0 });
}

function crystal(hex) {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), new THREE.MeshStandardMaterial({
    color: hex, emissive: hex, emissiveIntensity: 1.6, roughness: 0.15, metalness: 0.2, flatShading: true,
  }));
  m.scale.y = 1.4;
  m.position.y = 0.3;
  return m;
}

// Drone from an enemy entry: dart (triangle), orb (circle) or tank (square). Hull is dark metal; glow parts use
// the enemy color and flash white on hit.
function buildDrone(enemy, actor = null) {
  const c = new THREE.Color(enemy.color);
  const hull = new THREE.MeshStandardMaterial({ color: 0x1c2029, roughness: 0.28, metalness: 0.9 });
  const glowMat = () => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c.clone(), emissiveIntensity: 3.2 });
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const glowMats = [];
  const add = (geom, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geom, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    body.add(m);
    if (mat !== hull) glowMats.push(mat);
    return m;
  };
  const scale = 0.85 + enemy.hp * 0.15;
  let radius = 0.55, hover = 1.6, spin = null;
  if (actor) { // a non-humanoid IP model (drone, beast) hovering with procedural bank and bob; no glow parts
    actor.root.position.y = -0.65;
    body.add(actor.root);
    return { group, body, glowMats, color: c, shape: enemy.shape, radius: 0.75, hover: enemy.shape === 'circle' ? 2.1 : 1.4, spin: null, maxHp: enemy.hp, flash: 0 };
  }
  if (enemy.shape === 'triangle') {
    const nose = add(new THREE.ConeGeometry(0.32, 1.25, 4), hull);
    nose.rotation.x = Math.PI / 2;
    nose.rotation.y = Math.PI / 4;
    for (const s of [-1, 1]) {
      const fin = add(new THREE.BoxGeometry(0.9, 0.04, 0.42), hull, s * 0.42, 0, -0.25);
      fin.rotation.z = s * 0.25;
      add(new THREE.BoxGeometry(0.75, 0.02, 0.04), glowMat(), s * 0.42, 0.03, -0.05).rotation.z = s * 0.25;
    }
    add(new THREE.SphereGeometry(0.13, 12, 8), glowMat(), 0, 0, -0.62);
    add(new THREE.BoxGeometry(0.06, 0.06, 0.5), glowMat(), 0, 0.17, 0.05);
    radius = 0.6; hover = 1.5;
  } else if (enemy.shape === 'circle') {
    add(new THREE.SphereGeometry(0.42, 32, 16), hull);
    const eye = add(new THREE.SphereGeometry(0.14, 16, 12), glowMat(), 0, 0, 0.36);
    eye.scale.z = 0.5;
    const ring = add(new THREE.TorusGeometry(0.62, 0.035, 8, 48), glowMat());
    const ring2 = add(new THREE.TorusGeometry(0.5, 0.02, 6, 40), glowMat());
    ring.rotation.x = Math.PI / 2;
    spin = (dt) => { ring.rotation.z += dt * 2.4; ring2.rotation.y += dt * 3.1; ring2.rotation.x += dt * 1.3; };
    radius = 0.62; hover = 2.3;
  } else {
    add(new RoundedBoxGeometry(0.95, 0.6, 1.05, 2, 0.08), hull);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.04, 0.18, 0.7), glowMat(), s * 0.48, 0.05, 0);
    add(new THREE.BoxGeometry(0.5, 0.08, 0.04), glowMat(), 0, 0.08, 0.53);
    for (const [x, z] of [[0.38, 0.4], [-0.38, 0.4], [0.38, -0.4], [-0.38, -0.4]]) {
      add(new THREE.CylinderGeometry(0.11, 0.14, 0.12, 12), hull, x, -0.34, z);
      add(new THREE.CircleGeometry(0.1, 16).rotateX(Math.PI / 2), glowMat(), x, -0.41, z);
    }
    radius = 0.75; hover = 1.25;
  }
  body.scale.setScalar(scale);
  return { group, body, glowMats, color: c, shape: enemy.shape, radius: radius * scale, hover, spin, maxHp: enemy.hp, flash: 0 };
}
