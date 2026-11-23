// RPG landscape (rpg-explore, rpg-quest): seeded noise terrain with vertex-colored grass/rock/sand/path, instanced
// trees, rocks and grass, a lake, a small village with the quest giver, items to pick up, and monsters from
// spec.enemies that patrol, chase and attack with a telegraph. Rules follow game/README.md (RPG, rules 2 and 3).
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  THREE, PlayerController, mulberry32, makeNoise, canvasTexture, damp, clamp, color, angleDamp, animateBody,
  playAction, proceduralHero, disposeTree, releaseDrawn, PICKUP_MAX,
} from './world.js';
import { fadeOut } from './anim.js';
import { clock } from './arpg-data.js';

const SRGB = THREE.SRGBColorSpace; // Color.setHSL defaults to the linear working space
const TILE = 3; // one 2D tile = 3 m
const WATER = -0.35;
const START_GRACE = 3;
const HURT_SEC = 2;
const MONSTER_PACE = { easy: 1.4, normal: 1, hard: 0.7 };
const CHASE_TILES = { easy: 2, normal: 3, hard: 4 };
const KNOCKBACK_NEAR = 4; // tiles
const TALK_RANGE = 2.8;
const STRIKE_RANGE = 2.3;
const MELEE_IMPACT = 0.42; // impact frame of the attack clip, as a fraction of it (sf.js uses the same)
// Player attacks by held weapon: seconds per attack, impact fraction, reach (m) and the clip role.
const ATTACK = {
  melee: { sec: 0.55, impact: MELEE_IMPACT, range: 2.4, role: 'attack_melee' },
  unarmed: { sec: 0.5, impact: 0.45, range: 1.6, role: 'punch' },
  gun: { sec: 0.3, impact: 0, range: 25, role: 'attack_gun' },
};
const PLAYER_BOLT_SPEED = 40;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const tmp = new THREE.Vector3();

export async function createRpg(world, spec, hud, playerActor) {
  const mode = new RpgMode(world, spec, hud, playerActor);
  await mode.build();
  return mode;
}

export class RpgMode {
  constructor(world, spec, hud, playerActor) {
    Object.assign(this, { world, spec, hud, playerActor });
    this.root = new THREE.Group();
    world.scene.add(this.root);
    this.accent = color(spec.palette.accent);
    const seed = spec.map.seed ?? 1234;
    this.rnd = mulberry32(seed);
    this.noise = makeNoise(seed);
    this.W = spec.map.width * TILE;
    this.D = spec.map.height * TILE;
    Object.assign(this, {
      lives: 3, hurtFor: 0, elapsed: 0, lines: null, lineIndex: 0, heard: false, talkDone: false, hasItem: false,
      collected: 0, ended: false, trees: [], boxes: [], items: [], monsters: [],
      score: 0, kills: 0, attackCd: 0, faceFor: 0, pendingHit: null, bolts: [], dyingMonsters: [], padFire: false,
    });
  }

  // ── layout ──────────────────────────────────────────────────────────────

  layout() {
    const { W, D, rnd } = this;
    this.start = new THREE.Vector2(-W / 2 + 6, D / 2 - 6);
    // NPC: far from the start (>= 6 tiles), picked among the farthest third of candidates.
    const cands = Array.from({ length: 60 }, () => new THREE.Vector2((rnd() - 0.5) * (W - 14), (rnd() - 0.5) * (D - 14)))
      .filter((p) => p.distanceTo(this.start) >= 6 * TILE)
      .sort((a, b) => b.distanceTo(this.start) - a.distanceTo(this.start));
    this.npcPos = cands.length ? cands[Math.floor(rnd() * Math.max(1, cands.length / 3))] : new THREE.Vector2(W / 2 - 6, -D / 2 + 6);
    // Path: a bent curve from the start to the village.
    const mid = this.start.clone().add(this.npcPos).multiplyScalar(0.5);
    const along = this.npcPos.clone().sub(this.start);
    const perp = new THREE.Vector2(-along.y, along.x).normalize();
    const bend = (rnd() - 0.5) * 0.5 * along.length();
    const ctrl = mid.clone().addScaledVector(perp, bend);
    this.path = Array.from({ length: 41 }, (_, i) => {
      const t = i / 40, u = 1 - t;
      return new THREE.Vector2(u * u * this.start.x + 2 * u * t * ctrl.x + t * t * this.npcPos.x, u * u * this.start.y + 2 * u * t * ctrl.y + t * t * this.npcPos.y);
    });
    // Lake on the outer side of the bend, kept clear of the start and the village.
    const side = bend >= 0 ? -1 : 1;
    this.lakeR = clamp(Math.min(W, D) * 0.16, 6, 11);
    const lake = mid.clone().addScaledVector(perp, side * Math.min(W, D) * 0.3);
    lake.x = clamp(lake.x, -W / 2 + this.lakeR + 2, W / 2 - this.lakeR - 2);
    lake.y = clamp(lake.y, -D / 2 + this.lakeR + 2, D / 2 - this.lakeR - 2);
    this.lake = lake;
    this.baseAtStart = this.rawHeight(this.start.x, this.start.y);
    this.baseAtNpc = this.rawHeight(this.npcPos.x, this.npcPos.y);
  }

  distToPath(x, z) {
    let best = Infinity;
    const p = this.path;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i].x, az = p[i].y, bx = p[i + 1].x - ax, bz = p[i + 1].y - az;
      const t = clamp(((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz), 0, 1);
      const dx = x - ax - bx * t, dz = z - az - bz * t;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  rawHeight(x, z) {
    const { fbm } = this.noise;
    let h = fbm(x * 0.03, z * 0.03, 4) * 6 + fbm(x * 0.11 + 40, z * 0.11 - 13, 3) * 0.9 + 1.1;
    const ox = Math.max(0, Math.abs(x) - this.W / 2), oz = Math.max(0, Math.abs(z) - this.D / 2);
    const out = Math.hypot(ox, oz);
    if (out > 0) h += Math.pow(smooth(0, 26, out), 1.25) * (13 + fbm(x * 0.05, z * 0.05, 3) * 10);
    return h;
  }

  height(x, z) {
    let h = this.rawHeight(x, z);
    const dl = Math.hypot(x - this.lake.x, z - this.lake.y) / this.lakeR;
    if (dl < 1.7) h = THREE.MathUtils.lerp(h, -2.2 + this.noise.noise(x * 0.3, z * 0.3) * 0.3, 1 - smooth(0.55, 1.7, dl));
    const dp = this.distToPath(x, z);
    if (dp < 5) h = THREE.MathUtils.lerp(h, Math.max(h * 0.6 + 0.3, WATER + 0.6), (1 - smooth(1.2, 5, dp)) * 0.75);
    for (const [c, base] of [[this.start, this.baseAtStart], [this.npcPos, this.baseAtNpc]]) {
      const d = Math.hypot(x - c.x, z - c.y);
      if (d < 9) h = THREE.MathUtils.lerp(h, Math.max(base * 0.6 + 0.3, WATER + 0.7), 1 - smooth(4, 9, d));
    }
    return h;
  }

  land(x, z, margin = 0.3) { return this.height(x, z) > WATER + margin; }

  randomLand(minFrom = [], tries = 80) {
    const { W, D, rnd } = this;
    for (let i = 0; i < tries; i++) {
      const x = (rnd() - 0.5) * (W - 8), z = (rnd() - 0.5) * (D - 8);
      if (!this.land(x, z, 0.45)) continue;
      if (minFrom.every(([p, r]) => Math.hypot(x - p.x, z - (p.y ?? p.z)) >= r)) return new THREE.Vector2(x, z);
    }
    return null;
  }

  // ── build ───────────────────────────────────────────────────────────────

  async build() {
    const { world, spec } = this;
    this.layout();
    this.buildSky();
    this.buildTerrain();
    this.buildWater();
    this.buildVillage();
    await this.buildItemsAndNpc();
    await this.buildMonsters();
    this.buildFoliage();

    const player = this.playerActor;
    this.root.add(player.root);
    this.player = new PlayerController(world, player, {
      speed: spec.player.speed,
      groundAt: (x, z) => this.height(x, z),
      collide: (p, r, prev) => this.collide(p, r, prev),
      bounds: { minX: -this.W / 2 + 1, maxX: this.W / 2 - 1, minZ: -this.D / 2 + 1, maxZ: this.D / 2 - 1 },
    });
    this.player.dashColor = this.accent;
    this.weaponType = player.weapon?.type ?? 'unarmed';
    this.hadMonsters = this.monsters.length > 0;
    this.player.place(this.start.x, this.start.y);
    const toNpc = this.npcPos.clone().sub(this.start);
    this.player.yaw = Math.atan2(toNpc.x, toNpc.y);
    Object.assign(world.rig, {
      yaw: Math.atan2(-toNpc.x, -toNpc.y), pitch: 0.38, distance: 7, shoulder: 0, height: 1.5, first: true, blockers: this.boxes,
      minY: (x, z) => this.height(x, z),
    });
    this.hud.say(null);
    this.refreshHud();
  }

  buildSky() {
    const { world } = this;
    const sky = new Sky();
    sky.scale.setScalar(1200);
    const u = sky.material.uniforms;
    u.turbidity.value = 5.5; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 24), THREE.MathUtils.degToRad(215));
    u.sunPosition.value.copy(this.sunDir);
    this.root.add(sky);
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(100);
    Object.assign(envSky.material.uniforms.sunPosition.value, this.sunDir);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) envSky.material.uniforms[k].value = u[k].value;
    envScene.add(envSky);
    this.envTarget = world.pmrem.fromScene(envScene); // (kept as its render target: only that frees it, in dispose())
    world.scene.environment = this.envTarget.texture;
    world.scene.environmentIntensity = 0.55;
    world.scene.background = null;
    world.renderer.toneMappingExposure = 0.72;
    world.bloom.strength = 0.45; world.bloom.radius = 0.6; world.bloom.threshold = 0.92;
    const fog = new THREE.Color(0xb9c9d6).lerp(color(this.spec.palette.bg), 0.08).lerp(this.accent, 0.04);
    world.scene.fog = new THREE.Fog(fog, 45, 230);

    const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x4a5a32, 0.9);
    const sun = new THREE.DirectionalLight(0xfff0d6, 3.4);
    const reach = Math.max(this.W, this.D) / 2 + 8;
    sun.position.copy(this.sunDir).multiplyScalar(90);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 10, far: 200 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = 3;
    this.root.add(hemi, sun, sun.target);
  }

  buildTerrain() {
    const { W, D } = this;
    const SW = W + 90, SD = D + 90;
    const sx = Math.round(SW / 0.6), sz = Math.round(SD / 0.6);
    const geom = new THREE.PlaneGeometry(SW, SD, sx, sz).rotateX(-Math.PI / 2);
    const pos = geom.attributes.position;
    const heights = new Float32Array(pos.count);
    const pathT = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      heights[i] = this.height(x, z);
      pos.setY(i, heights[i]);
      pathT[i] = 1 - smooth(0.9, 2.4, this.distToPath(x, z) + this.noise.noise(x * 0.8, z * 0.8) * 0.5);
    }
    geom.computeVertexNormals();
    const nrm = geom.attributes.normal;
    const cols = new Float32Array(pos.count * 3);
    const grassA = new THREE.Color(0x4b7a34), grassB = new THREE.Color(0x7a9443), dirt = new THREE.Color(0x8b6d4a);
    const rock = new THREE.Color(0x77736b), sand = new THREE.Color(0xcdbb8a), dark = new THREE.Color(0x3a5a2a);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), h = heights[i], ny = nrm.getY(i);
      const n = this.noise.fbm(x * 0.09 + 7, z * 0.09, 3);
      c.copy(grassA).lerp(grassB, clamp(n * 1.4 + 0.45, 0, 1));
      c.lerp(dark, clamp(this.noise.noise(x * 0.35, z * 0.35) * 0.5, 0, 0.35));
      c.lerp(this.accent, 0.03);
      c.lerp(sand, 1 - smooth(WATER + 0.25, WATER + 0.9, h));
      c.lerp(dirt, pathT[i] * 0.9);
      c.lerp(rock, smooth(0.86, 0.72, ny));
      c.lerp(rock.clone().multiplyScalar(0.8), smooth(8, 14, h));
      cols.set([c.r, c.g, c.b], i * 3);
    }
    geom.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const detail = canvasTexture(256, (g, s) => {
      const img = g.createImageData(s, s);
      const r = mulberry32(99);
      for (let i = 0; i < s * s; i++) {
        const v = 200 + r() * 55;
        img.data.set([v, v, v, 255], i * 4);
      }
      g.putImageData(img, 0, 0);
      g.globalAlpha = 0.25;
      for (let i = 0; i < 400; i++) { g.fillStyle = r() < 0.5 ? '#fff' : '#999'; g.fillRect(r() * s, r() * s, 1 + r() * 3, 1 + r() * 2); }
    }, { srgb: false, repeat: SW / 5 });
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.94, metalness: 0 });
    const terrain = new THREE.Mesh(geom, mat);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    this.root.add(terrain);
  }

  buildWater() {
    const SIZE = 256;
    // Tileable normal map from integer-frequency waves.
    const waves = [[3, 1, 0.5], [1, 4, 0.4], [5, -2, 0.25], [-7, 3, 0.15], [9, 8, 0.08]];
    const normalTex = canvasTexture(SIZE, (g, s) => {
      const img = g.createImageData(s, s);
      const hgt = (x, y) => waves.reduce((sum, [kx, ky, a]) => sum + a * Math.sin(((kx * x + ky * y) / s) * Math.PI * 2), 0);
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const dx = hgt(x + 1, y) - hgt(x - 1, y), dy = hgt(x, y + 1) - hgt(x, y - 1);
        const nx = -dx * 2.2, ny = -dy * 2.2, l = Math.hypot(nx, ny, 1);
        img.data.set([(nx / l * 0.5 + 0.5) * 255, (ny / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255, 255], (y * s + x) * 4);
      }
      g.putImageData(img, 0, 0);
    }, { srgb: false, repeat: 1 });
    normalTex.repeat.set((this.W + 90) / 7, (this.D + 90) / 7);
    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0x2d6f7a).lerp(this.accent, 0.05), roughness: 0.08, metalness: 0, transparent: true, opacity: 0.86,
      normalMap: normalTex, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.4, clearcoat: 1, clearcoatRoughness: 0.12,
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(this.W + 90, this.D + 90).rotateX(-Math.PI / 2), mat);
    this.water.position.y = WATER;
    this.water.receiveShadow = true;
    this.root.add(this.water);
  }

  buildVillage() {
    const { npcPos } = this;
    const y = this.height(npcPos.x, npcPos.y);
    const stone = new THREE.MeshStandardMaterial({ color: 0x9a948a, roughness: 0.9 });
    const plaza = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.4, 0.25, 40), stone);
    plaza.position.set(npcPos.x, y + 0.02, npcPos.y);
    plaza.receiveShadow = true;
    this.root.add(plaza);
    // Lanterns: dim until the quest is done (the story is about bringing the light back).
    this.lanterns = [];
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 0.85 });
    for (const a of [0.6, 2.4, 4.1]) {
      const x = npcPos.x + Math.cos(a) * 3.8, z = npcPos.y + Math.sin(a) * 3.8, h = this.height(x, z);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 8), wood);
      post.position.set(x, h + 1.3, z);
      post.castShadow = true;
      const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: this.accent, emissiveIntensity: 0.15, roughness: 0.4 });
      const lamp = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.42, 0.34, 2, 0.05), lampMat);
      lamp.position.set(x, h + 2.75, z);
      const light = new THREE.PointLight(this.accent, 0, 12, 1.5);
      light.position.copy(lamp.position);
      this.root.add(post, lamp, light);
      post.updateMatrixWorld();
      this.boxes.push(new THREE.Box3().setFromObject(post).expandByScalar(0.08));
      this.lanterns.push({ lampMat, light });
    }
    // Two huts behind the plaza, facing it.
    const wall = new THREE.MeshStandardMaterial({ color: 0xa8957a, roughness: 0.95, envMapIntensity: 0.5 });
    const roof = new THREE.MeshStandardMaterial({ color: 0x8c3b2a, roughness: 0.75 });
    const toStart = this.start.clone().sub(npcPos).normalize();
    const back = Math.atan2(toStart.y, toStart.x) + Math.PI;
    for (const off of [-0.75, 0.75]) {
      const a = back + off;
      const x = npcPos.x + Math.cos(a) * 9, z = npcPos.y + Math.sin(a) * 9;
      if (!this.land(x, z, 0.6)) continue;
      const h = this.height(x, z);
      const hut = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(4, 2.6, 3.4), wall);
      body.position.y = 1.3;
      const top = new THREE.Mesh(new THREE.ConeGeometry(3.4, 2, 4), roof);
      top.position.y = 3.6;
      top.rotation.y = Math.PI / 4;
      top.scale.set(1, 1, 0.85);
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.06), wood);
      door.position.set(0, 0.8, 1.72);
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.06), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: this.accent, emissiveIntensity: 0.6 }));
      win.position.set(1.2, 1.6, 1.72);
      hut.add(body, top, door, win);
      hut.position.set(x, h - 0.3, z);
      hut.lookAt(npcPos.x, h - 0.3, npcPos.y);
      hut.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.root.add(hut);
      hut.updateMatrixWorld(true);
      this.boxes.push(new THREE.Box3().setFromObject(body));
    }
  }

  async buildItemsAndNpc() {
    const { spec, world } = this;
    const { props, objective, quest } = spec;
    const collect = objective.type === 'collect';
    this.needsItem = spec.genre === 'rpg-quest' && !collect && quest !== null;
    const questIndex = this.needsItem ? quest.itemPropIndex : -1;
    // Rule 2 (game/README.md): NPC = first prop with a usable model or sprite that is neither the quest item nor
    // drawn with the player's sprite; under `collect` every prop is an item and the NPC is a stand-in.
    const npcProp = collect ? -1 : props.findIndex((p, i) => i !== questIndex && (p.modelUrl || p.spriteUrl) && p.spriteUrl !== spec.player.spriteUrl);
    const kinds = collect
      ? Array.from({ length: objective.target }, (_, i) => ({ prop: props.length ? i % props.length : -1 }))
      : props.map((_, i) => ({ prop: i, quest: i === questIndex })).filter((k) => k.prop !== npcProp);
    if (this.needsItem && !kinds.some((k) => k.quest)) kinds.push({ prop: -1, quest: true });
    this.itemName = quest?.itemName || props[questIndex]?.name || '퀘스트 아이템';
    this.npcName = quest?.giverName || props[npcProp]?.name || 'NPC';

    const npcActor = await world.makeActor(npcProp >= 0 ? props[npcProp] : null, 1.85, () => proceduralHero(this.accent));
    const ny = this.height(this.npcPos.x, this.npcPos.y);
    npcActor.root.position.set(this.npcPos.x, ny, this.npcPos.y);
    this.npc = { actor: npcActor, yaw: Math.atan2(this.start.x - this.npcPos.x, this.start.y - this.npcPos.y), phase: 0 };
    this.root.add(npcActor.root);

    const templates = new Map();
    const actorFor = async (i) => {
      if (!templates.has(i)) templates.set(i, await world.makeActor(i >= 0 ? props[i] : null, 0.7, () => orb(this.accent), { maxExtent: PICKUP_MAX }));
      return templates.get(i);
    };
    const avoid = [[this.start, 9], [this.npcPos, 6]];
    for (const kind of kinds) {
      const at = this.randomLand([...avoid, ...this.items.map((it) => [it.pos, 7])], 120)
        ?? this.randomLand([...avoid, ...this.items.map((it) => [it.pos, 3])], 120);
      if (!at) break;
      const template = await actorFor(kind.prop);
      const group = new THREE.Group();
      const visual = template.root.clone(true);
      group.add(visual);
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: this.accent, emissiveIntensity: 2.2 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.03, 8, 40), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.08;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 14, 16, 1, true), beamMaterial(this.accent));
      beam.position.y = 7;
      group.add(ring, beam);
      group.position.set(at.x, this.height(at.x, at.y), at.y);
      this.root.add(group);
      this.items.push({ ...kind, pos: at, group, visual, t: this.rnd() * 6, billboard: template.kind === 'billboard' });
    }
    this.goal = collect ? this.items.length : 1;
  }

  async buildMonsters() {
    const { spec, world } = this;
    const pace = MONSTER_PACE[spec.difficulty];
    // enemies with an IP model: its GLB (rigged humanoids animate with the zombie clips), else a procedural monster
    const actors = await Promise.all(spec.enemies.map((e) => (e.modelUrl
      ? world.makeActor(e, e.humanoid ? 1.85 : 1.4, () => new THREE.Group(), { zombie: true }) : null)));
    for (const [k, enemy] of spec.enemies.entries()) {
      const at = this.randomLand([[this.start, 5 * TILE], [this.npcPos, 7], ...this.monsters.map((m) => [m.spawn, 6])], 120);
      if (!at) break;
      const actor = actors[k]?.kind === 'procedural' ? null : actors[k];
      const m = actor ? modelMonster(enemy, actor) : buildMonster(enemy);
      m.spawn = at.clone();
      m.pos = new THREE.Vector3(at.x, this.height(at.x, at.y), at.y);
      m.speed = (1.5 + 1.0 * enemy.speed) / pace;
      m.windupSec = 0.75 * pace;
      m.hp = m.maxHp = enemy.hp;
      m.state = 'wander';
      m.timer = 0;
      m.goal = null;
      m.yaw = this.rnd() * Math.PI * 2;
      m.phase = this.rnd() * 10;
      m.restFor = 0;
      m.group.position.copy(m.pos);
      const tele = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 0.18, 0.12).multiplyScalar(3), transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
      }));
      const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 0.2, 0.1), transparent: true, opacity: 0, depthWrite: false,
      }));
      m.tele = tele; m.teleFill = fill;
      this.root.add(m.group, tele, fill);
      this.monsters.push(m);
    }
  }

  buildFoliage() {
    const { W, D, rnd } = this;
    const pineGeom = mergeGeometries([
      new THREE.ConeGeometry(1.5, 2.2, 7).translate(0, 1.1, 0),
      new THREE.ConeGeometry(1.15, 1.9, 7).translate(0, 2.1, 0),
      new THREE.ConeGeometry(0.75, 1.6, 7).translate(0, 3.0, 0),
    ]);
    const leafGeom = jitter(new THREE.IcosahedronGeometry(1.5, 1), 0.22, 3).translate(0, 1.2, 0);
    const trunkGeom = new THREE.CylinderGeometry(0.13, 0.22, 1.8, 7).translate(0, 0.9, 0);
    const leafMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true, envMapIntensity: 0.35 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4330, roughness: 0.95 });
    const spots = [];
    const ok = (x, z, inPlay) => {
      if (!this.land(x, z, 0.5)) return false;
      if (inPlay && this.distToPath(x, z) < 3) return false;
      if (Math.hypot(x - this.start.x, z - this.start.y) < 6 || Math.hypot(x - this.npcPos.x, z - this.npcPos.y) < 7) return false;
      if (this.items.some((it) => Math.hypot(x - it.pos.x, z - it.pos.y) < 2.5)) return false;
      if (this.monsters.some((m) => Math.hypot(x - m.spawn.x, z - m.spawn.y) < 2)) return false;
      if (this.boxes.some((b) => b.distanceToPoint(tmp.set(x, b.min.y + 0.5, z)) < 1.5)) return false;
      return true;
    };
    for (let i = 0; i < (W * D) / 20; i++) {
      const x = (rnd() - 0.5) * (W - 2), z = (rnd() - 0.5) * (D - 2);
      if (ok(x, z, true) && this.noise.fbm(x * 0.06, z * 0.06, 2) > -0.08) spots.push([x, z, true]);
    }
    for (let i = 0; i < 520; i++) { // hills around the play area
      const x = (rnd() - 0.5) * (W + 70), z = (rnd() - 0.5) * (D + 70);
      if (Math.abs(x) < W / 2 && Math.abs(z) < D / 2) continue;
      if (this.height(x, z) < 12) spots.push([x, z, false]);
    }
    const pines = spots.filter(() => rnd() < 0.55);
    const broad = spots.filter((s) => !pines.includes(s));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const trunks = new THREE.InstancedMesh(trunkGeom, trunkMat, spots.length);
    const pineIM = new THREE.InstancedMesh(pineGeom, leafMat, pines.length);
    const broadIM = new THREE.InstancedMesh(leafGeom, leafMat, broad.length);
    const c = new THREE.Color();
    let ti = 0;
    const place = (im, list, base, hue) => list.forEach(([x, z, play], i) => {
      const sc = 0.8 + rnd() * 0.7;
      const h = this.height(x, z);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI * 2);
      m4.compose(p.set(x, h - 0.15, z), q, s.set(sc, sc * (0.9 + rnd() * 0.3), sc));
      trunks.setMatrixAt(ti++, m4);
      m4.compose(p.set(x, h - 0.15 + 1.5 * sc, z), q, s.set(sc, sc, sc));
      im.setMatrixAt(i, m4);
      im.setColorAt(i, c.setHSL(hue + (rnd() - 0.5) * 0.05, 0.45 + rnd() * 0.15, base + rnd() * 0.07, SRGB));
      if (play) this.trees.push({ x, z, r: 0.35 * sc + 0.1 });
    });
    place(pineIM, pines, 0.2, 0.36);
    place(broadIM, broad, 0.27, 0.26);
    for (const im of [trunks, pineIM, broadIM]) { im.castShadow = true; im.receiveShadow = true; this.root.add(im); }

    // rocks
    const rockGeom = jitter(new THREE.DodecahedronGeometry(1, 1), 0.25, 7);
    const rockIM = new THREE.InstancedMesh(rockGeom, new THREE.MeshStandardMaterial({ color: 0x8a867e, roughness: 0.9, flatShading: true }), 60);
    let ri = 0;
    for (let i = 0; i < 200 && ri < 60; i++) {
      const x = (rnd() - 0.5) * (W + 30), z = (rnd() - 0.5) * (D + 30);
      const inPlay = Math.abs(x) < W / 2 && Math.abs(z) < D / 2;
      if (inPlay && !ok(x, z, true)) continue;
      const sc = 0.3 + rnd() ** 2 * 1.1;
      q.setFromEuler(new THREE.Euler(rnd(), rnd() * 6, rnd()));
      m4.compose(p.set(x, this.height(x, z) - sc * 0.3, z), q, s.set(sc * (1 + rnd() * 0.6), sc * 0.7, sc));
      rockIM.setMatrixAt(ri, m4);
      rockIM.setColorAt(ri++, c.setHSL(0.08, 0.06, 0.45 + rnd() * 0.2, SRGB));
      if (inPlay && sc > 0.6) this.trees.push({ x, z, r: sc * 0.9 });
    }
    rockIM.count = ri;
    rockIM.castShadow = rockIM.receiveShadow = true;
    this.root.add(rockIM);

    // grass tufts with a little wind
    const blade = new THREE.BufferGeometry();
    const verts = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      const dx = Math.cos(a) * 0.07, dz = Math.sin(a) * 0.07;
      verts.push(-dx, 0, -dz, dx, 0, dz, 0, 0.36, 0);
    }
    blade.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    blade.setAttribute('normal', new THREE.Float32BufferAttribute(verts.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3)); // lit like the ground
    const grassMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 1, envMapIntensity: 0.4 });
    this.windUniform = { value: 0 };
    grassMat.onBeforeCompile = (shader) => {
      shader.uniforms.uWind = this.windUniform;
      shader.vertexShader = 'uniform float uWind;\n' + shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvec4 wp = instanceMatrix * vec4(0.0,0.0,0.0,1.0);\ntransformed.x += sin(uWind * 1.7 + wp.x * 0.35 + wp.z * 0.2) * 0.12 * position.y;');
    };
    const N = Math.round(W * D * 1.6);
    const grass = new THREE.InstancedMesh(blade, grassMat, N);
    let gi = 0;
    for (let i = 0; i < N * 2 && gi < N; i++) {
      const x = (rnd() - 0.5) * W, z = (rnd() - 0.5) * D;
      const h = this.height(x, z);
      if (h < WATER + 0.6 || this.distToPath(x, z) < 1.6 || Math.hypot(x - this.npcPos.x, z - this.npcPos.y) < 4.8) continue;
      if (this.boxes.some((b) => b.distanceToPoint(tmp.set(x, b.min.y + 0.5, z)) < 0.4)) continue;
      const sc = 0.7 + rnd() * 0.9;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * 6.28);
      m4.compose(p.set(x, h - 0.03, z), q, s.set(sc, sc * (0.7 + rnd() * 0.8), sc));
      grass.setMatrixAt(gi, m4);
      grass.setColorAt(gi++, c.setHSL(0.22 + rnd() * 0.06, 0.5, 0.26 + rnd() * 0.1, SRGB));
    }
    grass.count = gi;
    grass.receiveShadow = true;
    this.root.add(grass);
  }

  // ── movement & collisions ───────────────────────────────────────────────

  collide(p, r, prev) {
    for (const t of this.trees) {
      const dx = p.x - t.x, dz = p.z - t.z, d = Math.hypot(dx, dz), min = t.r + r;
      if (d < min && d > 1e-4) { p.x = t.x + (dx / d) * min; p.z = t.z + (dz / d) * min; }
    }
    const nd = Math.hypot(p.x - this.npcPos.x, p.z - this.npcPos.y), nmin = 0.6 + r;
    if (nd < nmin && nd > 1e-4) { p.x = this.npcPos.x + ((p.x - this.npcPos.x) / nd) * nmin; p.z = this.npcPos.y + ((p.z - this.npcPos.y) / nd) * nmin; }
    for (const b of this.boxes) {
      const cx = clamp(p.x, b.min.x, b.max.x), cz = clamp(p.z, b.min.z, b.max.z);
      const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
      if (d < r && d > 1e-4) { p.x = cx + (dx / d) * r; p.z = cz + (dz / d) * r; }
      else if (d <= 1e-4 && prev) { p.x = prev.x; p.z = prev.z; }
    }
    if (prev && !this.land(p.x, p.z, -0.3)) { // deep water: slide along the shore
      if (this.land(p.x, prev.z, -0.3)) p.z = prev.z;
      else if (this.land(prev.x, p.z, -0.3)) p.x = prev.x;
      else { p.x = prev.x; p.z = prev.z; }
    }
  }

  // ── frame ───────────────────────────────────────────────────────────────

  update(dt) {
    const { world, player } = this;
    const input = world.input;
    this.windUniform.value += dt;
    this.water.material.normalMap.offset.x += dt * 0.012;
    this.water.material.normalMap.offset.y += dt * 0.007;
    if (this.lines) { // dialogue pauses the world
      if (input.hit('KeyE', 'Space', 'Enter')) this.act();
      world.rig.update(dt, player.pos, input);
      this.animateNpc(dt, true);
      this.refreshHud();
      return;
    }
    this.elapsed += dt;
    this.hurtFor = Math.max(0, this.hurtFor - dt);
    player.update(dt, input, world.rig);
    world.rig.update(dt, player.pos, input);
    player.actor.root.visible = this.hurtFor <= 0 || Math.sin(this.elapsed * 40) > 0;
    if (player.grounded && player.pos.y < WATER + 0.05 && Math.hypot(player.vel.x, player.vel.z) > 1 && this.rnd() < 0.5) {
      world.particles.emit(tmp.copy(player.pos).setY(WATER + 0.05), { count: 2, color: 0xcfefff, speed: 2, size: 0.18, life: 0.35, gravity: 9, dir: THREE.Object3D.DEFAULT_UP, spread: 0.8, intensity: 1 });
    }
    if (input.hit('KeyE', 'Enter')) this.act();
    this.animateNpc(dt, false);
    this.updateItems(dt);
    this.updateCombat(dt);
    this.updateMonsters(dt);
    this.refreshHud();
    if (this.lives <= 0) this.end(false);
  }

  idle(dt) {
    this.windUniform.value += dt;
    this.player.actor.animator?.update(dt, { speed: 0 });
    for (const m of this.monsters) m.actor?.animator?.update(dt, { speed: 0 });
    this.updatePlayerBolts(dt);
    this.updateDyingMonsters(dt);
    this.world.rig.yaw += dt * 0.15;
    this.world.rig.update(dt, this.player.pos, { look: { x: 0, y: 0 }, down: () => false, pad: null });
    this.animateNpc(dt, true);
    if (this.celebrate > 0) {
      this.celebrate -= dt;
      if (this.rnd() < dt * 6) {
        const a = this.rnd() * Math.PI * 2;
        const at = new THREE.Vector3(this.npcPos.x + Math.cos(a) * 4, this.height(this.npcPos.x, this.npcPos.y) + 7 + this.rnd() * 4, this.npcPos.y + Math.sin(a) * 4);
        this.world.particles.emit(at, { count: 60, color: this.rnd() < 0.5 ? this.accent : 0xffffff, speed: 8, size: 0.4, life: 1.2, gravity: 3, drag: 1.5 });
      }
    }
  }

  animateNpc(dt, talking) {
    const { npc, player } = this;
    npc.phase += dt;
    const a = npc.actor;
    const dx = player.pos.x - this.npcPos.x, dz = player.pos.z - this.npcPos.y;
    const near = Math.hypot(dx, dz) < 7;
    if (near || talking) npc.yaw = angleDamp(npc.yaw, Math.atan2(dx, dz), 5, dt);
    a.root.rotation.y = a.billboard ? this.world.rig.yaw : npc.yaw;
    animateBody(a, dt, { phase: npc.phase * 3 });
    if (a.animator) a.animator.update(dt, { speed: 0 });
    else if (a.mixer) { playAction(a, 'idle'); a.mixer.update(dt); }
    const head = tmp.set(this.npcPos.x, a.root.position.y + 2.25, this.npcPos.y);
    const mark = this.talkDone ? '' : this.needsItem && this.hasItem ? ' ?' : ' !';
    this.hud.float('npc', `${this.npcName}${mark}`, head);
    const inRange = Math.hypot(dx, dz) < TALK_RANGE;
    this.hud.float('prompt', inRange && !this.lines && !this.ended ? 'E 대화' : null, tmp.set(this.npcPos.x, a.root.position.y + 1.2, this.npcPos.y), 'prompt');
  }

  updateItems(dt) {
    const p = this.player.pos;
    for (const it of this.items) {
      if (it.taken) continue;
      it.t += dt;
      it.visual.position.y = 0.6 + Math.sin(it.t * 2) * 0.12;
      it.visual.rotation.y = it.billboard ? this.world.rig.yaw : it.t * 1.2;
      if (Math.hypot(p.x - it.pos.x, p.z - it.pos.y) < 1.4 && p.y - it.group.position.y < 1.6) this.pickUp(it);
    }
  }

  pickUp(it) {
    it.taken = true;
    this.root.remove(it.group);
    this.collected += 1;
    if (it.quest) this.hasItem = true;
    const at = it.group.position.clone().setY(it.group.position.y + 0.8);
    this.world.particles.emit(at, { count: 40, color: this.accent, speed: 5, size: 0.35, life: 0.8, dir: THREE.Object3D.DEFAULT_UP, spread: 0.9 });
    this.world.flash(at, this.accent, 25, 8);
    const name = it.prop >= 0 ? this.spec.props[it.prop].name : this.itemName;
    this.hud.popup(it.quest ? `${this.itemName} 획득!` : `${name || '아이템'} +1`, at, 'pickup');
    if (this.spec.objective.type === 'collect' && this.collected >= this.goal) this.win();
  }

  // E: talk next to the NPC, or advance the open dialogue. The last line of a finished talk wins.
  act() {
    if (this.lines) {
      this.lineIndex += 1;
      if (this.lineIndex < this.lines.length) return this.hud.say(this.lines[this.lineIndex]);
      this.lines = null;
      this.hud.say(null);
      if (this.talkDone) this.win();
      return;
    }
    if (Math.hypot(this.player.pos.x - this.npcPos.x, this.player.pos.z - this.npcPos.y) > TALK_RANGE) return;
    this.lines = this.talkLines();
    this.lineIndex = 0;
    this.hud.say(this.lines[0]);
    if (this.npc.actor.actions.wave) playAction(this.npc.actor, 'wave');
  }

  talkLines() {
    const { dialogue, quest, objective } = this.spec;
    const story = this.heard ? [] : dialogue;
    this.heard = true;
    if (objective.type === 'collect') return story.length ? story : [{ speaker: this.npcName, text: `아이템 ${this.goal}개를 모아 줘!` }];
    if (this.needsItem && !this.hasItem) return [...story, { speaker: this.npcName, text: `${this.itemName}, 찾아다 줄래?` }];
    this.talkDone = true;
    return [...story, { speaker: this.npcName, text: quest?.completeText || '고마워!' }];
  }

  win() {
    for (const l of this.lanterns) { l.lampMat.emissiveIntensity = 5; l.light.intensity = 25; }
    this.celebrate = 4;
    this.end(true);
  }

  updateMonsters(dt) {
    const { player } = this;
    const grace = this.elapsed < START_GRACE;
    const chaseR = CHASE_TILES[this.spec.difficulty] * TILE;
    for (const m of this.monsters) {
      m.phase += dt;
      m.timer -= dt;
      const toP = new THREE.Vector2(player.pos.x - m.pos.x, player.pos.z - m.pos.z);
      const dist = toP.length();
      let move = 0, goal = null;
      if (m.restFor > 0) {
        m.restFor -= dt;
        m.group.visible = Math.sin(m.phase * 30) > -0.2;
        if (m.restFor <= 0) { m.group.visible = true; m.state = 'wander'; }
      } else if (grace) {
        m.state = 'wander';
      } else if (m.state === 'windup') {
        const k = 1 - Math.max(0, m.timer) / m.windupSec;
        m.tele.material.opacity = 0.35 + 0.65 * k;
        m.tele.scale.setScalar(0.3 + k * STRIKE_RANGE);
        m.teleFill.material.opacity = 0.18 * k;
        m.teleFill.scale.setScalar(k * STRIKE_RANGE);
        m.yaw = angleDamp(m.yaw, Math.atan2(toP.x, toP.y), 6, dt);
        if (m.timer <= 0) {
          m.state = 'strike'; m.timer = 0.18;
          this.world.particles.emit(tmp.copy(m.pos).setY(m.pos.y + 0.2), { count: 26, color: m.color, speed: 6, size: 0.35, life: 0.5, gravity: 8 });
          if (Math.hypot(player.pos.x - m.strike.x, player.pos.z - m.strike.y) < STRIKE_RANGE && player.pos.y - m.pos.y < 1.5) this.hurt(m);
        }
      } else if (m.state === 'strike') {
        move = 9; goal = m.strike;
        m.tele.material.opacity *= 0.8; m.teleFill.material.opacity *= 0.8;
        if (m.timer <= 0) { m.state = 'recover'; m.timer = 0.9; }
      } else if (m.state === 'recover') {
        m.tele.material.opacity = m.teleFill.material.opacity = 0;
        if (m.timer <= 0) m.state = 'wander';
      } else if (dist < chaseR && this.hurtFor <= 0) {
        m.state = 'chase';
        if (dist < STRIKE_RANGE * 0.85) {
          m.state = 'windup'; m.timer = m.windupSec;
          m.onWindup?.(m);
          m.strike = new THREE.Vector2(player.pos.x, player.pos.z);
          m.tele.position.set(m.pos.x + toP.x * 0.5, 0, m.pos.z + toP.y * 0.5);
          m.tele.position.y = this.height(m.tele.position.x, m.tele.position.z) + 0.06;
          m.teleFill.position.copy(m.tele.position).setY(m.tele.position.y - 0.01);
          m.strike.set(m.tele.position.x, m.tele.position.z);
        } else { move = m.speed; goal = new THREE.Vector2(player.pos.x, player.pos.z); }
      } else {
        m.state = 'wander';
        if (!m.goal || m.timer < -4 || Math.hypot(m.goal.x - m.pos.x, m.goal.y - m.pos.z) < 0.6) {
          if (m.timer < 0) {
            const a = this.rnd() * Math.PI * 2, r = 2 + this.rnd() * 6;
            const gx = clamp(m.spawn.x + Math.cos(a) * r, -this.W / 2 + 2, this.W / 2 - 2);
            const gz = clamp(m.spawn.y + Math.sin(a) * r, -this.D / 2 + 2, this.D / 2 - 2);
            m.goal = this.land(gx, gz, 0.2) ? new THREE.Vector2(gx, gz) : null;
            m.timer = 1 + this.rnd() * 2;
          }
        } else { move = m.speed * 0.45; goal = m.goal; }
      }
      if (goal && move > 0) {
        const dir = new THREE.Vector2(goal.x - m.pos.x, goal.y - m.pos.z);
        const len = dir.length();
        if (len > 0.05) {
          dir.divideScalar(len);
          const step = Math.min(len, move * dt);
          const next = new THREE.Vector3(m.pos.x + dir.x * step, m.pos.y, m.pos.z + dir.y * step);
          const before = m.pos.clone();
          this.collide(next, 0.5, before);
          m.pos.x = next.x; m.pos.z = next.z;
          if (m.state !== 'strike') m.yaw = angleDamp(m.yaw, Math.atan2(dir.x, dir.y), 8, dt);
        }
      }
      m.pos.y = this.height(m.pos.x, m.pos.z);
      m.animate(m, dt, move, m.state === 'windup' ? 1 - Math.max(0, m.timer) / m.windupSec : 0);
      m.group.position.copy(m.pos).add(m.offset);
      m.group.rotation.y = m.yaw;
      if (m.state !== 'windup' && m.state !== 'strike') m.tele.material.opacity = m.teleFill.material.opacity = 0;
    }
  }

  // ── player combat ─────────────────────────────────────────────────────────
  // Click or F attacks with the held weapon: a melee swing or a punch hits monsters in a 120° cone in front on the
  // clip's impact frame; a gun fires a bolt at once. The player turns to the nearest monster in reach first.
  // Monsters have spec hp, flinch (and lose their telegraphed strike) when hit, then die, fade and give score.
  // Killing is optional: the quest objective is unchanged.

  nearestMonster(range) {
    let best = null, bestD = range;
    for (const m of this.monsters) {
      const d = Math.hypot(m.pos.x - this.player.pos.x, m.pos.z - this.player.pos.z);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  updateCombat(dt) {
    const { world, player } = this;
    const input = world.input;
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.faceFor = Math.max(0, this.faceFor - dt);
    if (this.faceFor <= 0) player.faceYaw = null;
    player.actor.animator?.setAiming(this.weaponType === 'gun' && this.faceFor > 0);
    const padFire = !!input.pad?.fire;
    const want = input.clicked || input.down('KeyF') || (padFire && !this.padFire);
    this.padFire = padFire;
    if (want && this.attackCd <= 0 && !this.ended) this.attack();
    if (this.pendingHit) {
      this.pendingHit.t -= dt;
      if (this.pendingHit.t <= 0) { this.meleeHit(this.pendingHit.range); this.pendingHit = null; }
    }
    this.updatePlayerBolts(dt);
    this.updateDyingMonsters(dt);
  }

  attack() {
    const { player } = this;
    const cfg = ATTACK[this.weaponType];
    const anim = player.actor.animator;
    const target = this.nearestMonster(this.weaponType === 'gun' ? 25 : cfg.range * 2.2);
    const cam = this.world.camera.getWorldDirection(tmp);
    player.faceYaw = target ? Math.atan2(target.pos.x - player.pos.x, target.pos.z - player.pos.z) : Math.atan2(cam.x, cam.z);
    this.faceFor = cfg.sec + 0.2;
    this.attackCd = cfg.sec;
    if (this.weaponType === 'gun') {
      anim?.play('attack_gun', { parts: 'upper', fadeIn: 0.03, fadeOut: 0.15 });
      this.shootBolt(target);
      return;
    }
    const len = anim?.duration(cfg.role) ?? 0;
    if (len) anim.play(cfg.role, { parts: 'auto', timeScale: len / cfg.sec, fadeIn: 0.05, fadeOut: 0.12 });
    this.pendingHit = { t: cfg.sec * cfg.impact, range: cfg.range };
  }

  meleeHit(range) {
    const p = this.player;
    const fwd = new THREE.Vector2(Math.sin(p.yaw), Math.cos(p.yaw));
    const at = tmp.set(p.pos.x + fwd.x * 0.9, p.pos.y + 1.1, p.pos.z + fwd.y * 0.9);
    this.world.particles.emit(at, { count: 10, color: this.accent, speed: 3, size: 0.25, life: 0.25 });
    for (const m of [...this.monsters]) {
      const to = new THREE.Vector2(m.pos.x - p.pos.x, m.pos.z - p.pos.z);
      const d = to.length();
      if (d < range + 0.4 && Math.abs(m.pos.y - p.pos.y) < 1.6 && (d < 0.6 || to.divideScalar(d).dot(fwd) > 0.5)) this.hitMonster(m, to);
    }
  }

  shootBolt(target) {
    const p = this.player;
    const from = p.actor.weapon ? p.actor.weapon.muzzle.getWorldPosition(new THREE.Vector3()) : p.pos.clone().setY(p.pos.y + 1.3);
    const aim = target ? target.pos.clone().setY(target.pos.y + 0.9) : from.clone().addScaledVector(this.world.camera.getWorldDirection(new THREE.Vector3()), 30);
    const vel = aim.sub(from).normalize().multiplyScalar(PLAYER_BOLT_SPEED);
    this.boltGeom ??= new THREE.CapsuleGeometry(0.05, 0.6, 2, 6).rotateX(Math.PI / 2);
    this.boltMat ??= new THREE.MeshBasicMaterial({ color: this.accent.clone().multiplyScalar(6), toneMapped: false });
    const mesh = new THREE.Mesh(this.boltGeom, this.boltMat);
    mesh.position.copy(from);
    mesh.lookAt(from.clone().add(vel));
    this.root.add(mesh);
    this.bolts.push({ mesh, vel, life: 1.2 });
    this.world.particles.emit(from, { count: 5, color: this.accent, speed: 3, size: 0.25, life: 0.12 });
  }

  updatePlayerBolts(dt) {
    for (const b of this.bolts) {
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;
      const q = b.mesh.position;
      const hit = this.monsters.find((m) => Math.hypot(q.x - m.pos.x, q.y - (m.pos.y + 0.9), q.z - m.pos.z) < 0.85);
      if (hit) { b.life = 0; this.hitMonster(hit, new THREE.Vector2(b.vel.x, b.vel.z)); }
      else if (q.y < this.height(q.x, q.z)) {
        b.life = 0;
        this.world.particles.emit(q, { count: 6, color: this.accent, speed: 3, size: 0.2, life: 0.3, gravity: 8 });
      }
      if (b.life <= 0) this.root.remove(b.mesh);
    }
    this.bolts = this.bolts.filter((b) => b.life > 0);
  }

  hitMonster(m, dir) {
    m.hp -= 1;
    const at = tmp.set(m.pos.x, m.pos.y + 1, m.pos.z);
    this.world.particles.emit(at, { count: 18, color: m.color, speed: 6, size: 0.3, life: 0.45, gravity: 6 });
    this.world.flash(at, m.color, 18, 6);
    if (m.hp <= 0) return this.killMonster(m);
    m.actor?.animator?.play('hit', { parts: 'upper', fadeIn: 0.04, fadeOut: 0.2 });
    const push = dir.clone().normalize().multiplyScalar(1.2);
    const next = new THREE.Vector3(m.pos.x + push.x, m.pos.y, m.pos.z + push.y);
    this.collide(next, 0.5, m.pos.clone());
    m.pos.x = next.x; m.pos.z = next.z;
    if (m.state === 'windup' || m.state === 'strike') { m.state = 'recover'; m.timer = 0.7; }
    m.tele.material.opacity = m.teleFill.material.opacity = 0;
  }

  killMonster(m) {
    this.monsters = this.monsters.filter((x) => x !== m);
    this.kills += 1;
    const gain = 10 * m.maxHp;
    this.score += gain;
    const at = new THREE.Vector3(m.pos.x, m.pos.y + 1.4, m.pos.z);
    this.hud.popup(`+${gain}`, at, 'kill');
    this.world.particles.emit(at, { count: 40, color: m.color, speed: 7, size: 0.35, life: 0.7, gravity: 4 });
    this.root.remove(m.tele, m.teleFill);
    m.group.visible = true;
    m.deathLen = m.actor?.animator?.die() ?? 0;
    m.deadFor = 0;
    this.dyingMonsters.push(m);
  }

  // Death clip (rigged) or a sink (procedural), then fade and remove.
  updateDyingMonsters(dt) {
    for (const m of this.dyingMonsters) {
      m.deadFor += dt;
      m.actor?.animator?.update(dt, { speed: 0 });
      const fade = clamp((m.deadFor - m.deathLen) / 0.8, 0, 1);
      if (!m.actor?.animator) m.group.position.y = m.pos.y - fade * 1.2;
      if (fade > 0) fadeOut(m.group, 1 - fade);
      if (fade >= 1) { this.root.remove(m.group); m.gone = true; releaseDrawn(m.group); } // (a rigged one's bone texture)
    }
    this.dyingMonsters = this.dyingMonsters.filter((m) => !m.gone);
  }

  // One life per HURT_SEC at most. The monster that hit is knocked back (rule 3) and rests for HURT_SEC.
  hurt(m) {
    if (this.hurtFor > 0 || this.player.invulnerableFromDash || this.ended) return;
    this.lives -= 1;
    this.hurtFor = HURT_SEC;
    this.world.hurt = 0.9;
    this.world.rig.shake(0.55);
    const away = new THREE.Vector3(this.player.pos.x - m.pos.x, 0, this.player.pos.z - m.pos.z).normalize().multiplyScalar(8);
    this.player.impulse(away.setY(4.5));
    const near = Math.hypot(m.spawn.x - this.player.pos.x, m.spawn.y - this.player.pos.z) <= KNOCKBACK_NEAR * TILE;
    let to = m.spawn;
    if (near) {
      let best = null, bestD = -1;
      for (let i = 0; i < 40; i++) {
        const c = this.randomLand([[this.npcPos, 3]], 10);
        if (!c) continue;
        const d = Math.hypot(c.x - this.player.pos.x, c.y - this.player.pos.z);
        if (d > bestD) { bestD = d; best = c; }
      }
      if (best) to = best;
    }
    this.world.particles.emit(tmp.copy(m.pos).setY(m.pos.y + 0.6), { count: 30, color: m.color, speed: 4, size: 0.4, life: 0.6 });
    m.pos.set(to.x, this.height(to.x, to.y), to.y);
    m.restFor = HURT_SEC;
    m.state = 'rest';
    m.goal = null;
  }

  end(won) {
    if (this.ended) return;
    this.ended = true;
    this.hud.float('prompt', null);
    this.hud.end(won);
  }
  /** What the end screen says of this round (runtime3d.js hud.end, arpg-data.js endCard) →
   * { reason, result, resumeStage } */
  endSummary(won) {
    const collect = this.spec.objective.type === 'collect';
    return { reason: won ? (collect ? '아이템을 모두 모았어요.' : `${this.npcName}의 부탁을 들어줬어요.`) : '목숨을 모두 잃었어요.',
      result: [...(collect ? [`아이템 ${this.collected}/${this.goal}개`] : []), ...(this.score ? [`점수 ${this.score}`] : []), clock(this.elapsed)],
      resumeStage: 0 };
  }

  refreshHud() {
    const objective = this.spec.objective.type === 'collect'
      ? `목표: 아이템 ${this.goal}개 수집 (${this.collected}/${this.goal})`
      : this.needsItem && !this.hasItem ? `목표: ${this.itemName} 찾기` : `목표: ${this.npcName}와 대화`;
    this.hud.objective(objective);
    this.hud.status(this.score ? `점수 ${this.score}` : '');
    this.hud.lives(this.hadMonsters ? this.lives : null);
    this.hud.dash(1 - this.player.dashCooldown / 0.9);
    this.hud.notice(this.monsters.length && this.elapsed < START_GRACE ? '몬스터가 곧 움직입니다' : '');
  }

  debugState() {
    return {
      genre: this.spec.genre, lives: this.lives, collected: this.collected, goal: this.goal, hasItem: this.hasItem, talkDone: this.talkDone,
      dialogue: !!this.lines, ended: this.ended, npc: [this.npcPos.x, this.npcPos.y].map((v) => +v.toFixed(2)),
      items: this.items.filter((i) => !i.taken).map((i) => ({ quest: !!i.quest, at: [+i.pos.x.toFixed(2), +i.pos.y.toFixed(2)] })),
      monsters: this.monsters.map((m) => ({ state: m.state, hp: m.hp, at: [+m.pos.x.toFixed(1), +m.pos.z.toFixed(1)] })),
      kills: this.kills, score: this.score, dying: this.dyingMonsters.length, weapon: this.weaponType,
      oneShots: this.player.actor.animator?.oneShots.map((o) => o.role) ?? [],
      player: this.player.pos.toArray().map((v) => +v.toFixed(2)),
    };
  }
  debugTeleport(x, z) { this.player.place(x, z); }
  // Dev: the first monster with an IP model (else the first) next to the player in the open start clearing.
  debugStage() {
    const m = this.monsters.find((x) => x.actor) ?? this.monsters[0];
    if (!m) return null;
    const { x, y } = this.start;
    this.player.place(x, y);
    m.spawn.set(x + 1.8, y);
    m.pos.set(x + 1.8, this.height(x + 1.8, y), y);
    m.state = 'recover'; m.timer = 1.5; m.restFor = 0; m.group.visible = true;
    return [x, y, x + 1.8, y];
  }

  dispose() {
    this.root.remove(this.playerActor.root);
    this.world.scene.remove(this.root);
    disposeTree(this.root);
    this.envTarget.dispose();
    this.world.particles.clear();
    this.hud.say(null);
    this.hud.float('npc', null);
    this.hud.float('prompt', null);
  }
}

// ── procedural meshes ─────────────────────────────────────────────────────

function jitter(geom, amount, seed) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const pos = g.attributes.position;
  const r = mulberry32(seed);
  const moved = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    if (!moved.has(key)) moved.set(key, [(r() - 0.5) * amount * 2, (r() - 0.5) * amount * 2, (r() - 0.5) * amount * 2]);
    const [dx, dy, dz] = moved.get(key);
    pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
  }
  g.computeVertexNormals();
  return g;
}

function beamMaterial(accent) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { tint: { value: accent.clone().multiplyScalar(1.2) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 tint; varying vec2 vUv; void main(){ float a = pow(1.0 - vUv.y, 2.0) * 0.35; gl_FragColor = vec4(tint * a, 1.0); }',
  });
}

function orb(accent) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 0), new THREE.MeshStandardMaterial({
    color: accent, emissive: accent, emissiveIntensity: 1.8, roughness: 0.2, flatShading: true,
  }));
  core.position.y = 0.3;
  g.add(core);
  return g;
}

// Monster from an IP model. Rigged: zombie walk/run by ground speed and an attack clip stretched over the telegraph,
// so its impact frame lands on the strike. Unrigged: the model with procedural bob and lean (world.js animateBody).
function modelMonster(enemy, actor) {
  const offset = new THREE.Vector3();
  const anim = actor.animator;
  return {
    group: actor.root, body: actor.body, actor, color: new THREE.Color(enemy.color), offset,
    onWindup: (m) => {
      if (!anim) return;
      const len = anim.duration('attack_melee');
      anim.play('attack_melee', { parts: 'full', timeScale: Math.max(0.3, (len * MELEE_IMPACT) / m.windupSec), fadeIn: 0.12 });
    },
    animate: (m, dt, move, windup) => {
      if (anim) anim.update(dt, { speed: move });
      else animateBody(actor, dt, { speed01: move / 4, phase: m.phase * (5 + move), squash: windup * 0.15 });
    },
  };
}

// Monster from an enemy entry: slime (circle), stone golem (square) or crystal wisp (triangle).
function buildMonster(enemy) {
  const c = new THREE.Color(enemy.color);
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 2.5 });
  const pupil = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3 });
  const shadowed = (m) => { m.castShadow = true; return m; };
  const s = 0.85 + enemy.hp * 0.15;
  let animate;
  const offset = new THREE.Vector3();
  if (enemy.shape === 'circle') {
    const mat = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.1, sheen: 0.5, sheenColor: c });
    const blob = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 20), mat));
    blob.position.y = 0.55;
    blob.scale.set(1, 0.8, 1);
    for (const x of [-0.2, 0.2]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), eyeMat);
      e.position.set(x, 0.72, 0.5);
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), pupil);
      p.position.set(x, 0.72, 0.6);
      body.add(e, p);
    }
    body.add(blob);
    animate = (m, dt, move, windup) => {
      const hop = move > 0 ? Math.abs(Math.sin(m.phase * 7)) : Math.abs(Math.sin(m.phase * 2)) * 0.25;
      offset.y = hop * 0.35;
      const sq = windup ? 0.25 * windup : (1 - hop) * 0.12;
      body.scale.set(s * (1 + sq), s * (1 - sq), s * (1 + sq));
    };
  } else if (enemy.shape === 'square') {
    const rock = new THREE.MeshStandardMaterial({ color: new THREE.Color(0x6f6a62).lerp(c, 0.18), roughness: 0.92, flatShading: true });
    const glowMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c, emissiveIntensity: 3 });
    const torso = shadowed(new THREE.Mesh(new RoundedBoxGeometry(1.1, 1.0, 0.8, 2, 0.12), rock));
    torso.position.y = 1.05;
    const head = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.5, 0.55, 2, 0.08), rock));
    head.position.set(0, 1.8, 0.05);
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), glowMat);
    core.position.set(0, 1.1, 0.42);
    const eyes = [-0.13, 0.13].map((x) => { const e = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.04), glowMat); e.position.set(x, 1.85, 0.33); return e; });
    const arms = [-1, 1].map((sd) => { const a = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.95, 0.38, 2, 0.08), rock)); a.position.set(sd * 0.75, 0.95, 0); return a; });
    const legs = [-1, 1].map((sd) => { const l = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.55, 0.4, 2, 0.06), rock)); l.position.set(sd * 0.3, 0.28, 0); return l; });
    body.add(torso, head, core, ...eyes, ...arms, ...legs);
    body.scale.setScalar(s);
    animate = (m, dt, move, windup) => {
      const w = Math.sin(m.phase * 6) * Math.min(1, move);
      legs[0].rotation.x = w * 0.5; legs[1].rotation.x = -w * 0.5;
      arms[0].rotation.x = -w * 0.4 - windup * 2.2; arms[1].rotation.x = w * 0.4 - windup * 2.2;
      body.rotation.x = windup * -0.25;
      offset.y = Math.abs(w) * 0.05;
    };
  } else {
    const crystal = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.6, roughness: 0.15, metalness: 0.3, flatShading: true });
    const core = shadowed(new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0), crystal));
    core.scale.y = 1.6;
    core.position.y = 1.3;
    const shards = Array.from({ length: 4 }, (_, i) => { const sh = new THREE.Mesh(new THREE.TetrahedronGeometry(0.14), crystal); sh.userData.a = (i / 4) * Math.PI * 2; return sh; });
    body.add(core, ...shards);
    body.scale.setScalar(s);
    animate = (m, dt, move, windup) => {
      offset.y = Math.sin(m.phase * 2.2) * 0.15;
      core.rotation.y += dt * (1.5 + windup * 12);
      for (const sh of shards) {
        const a = sh.userData.a + m.phase * (1.8 + windup * 6);
        const r = 0.75 - windup * 0.35;
        sh.position.set(Math.cos(a) * r, 1.3 + Math.sin(a * 2) * 0.2, Math.sin(a) * r);
        sh.rotation.x += dt * 3;
      }
      crystal.emissiveIntensity = 1.6 + windup * 4;
    };
  }
  return { group, body, color: c, animate, offset };
}
