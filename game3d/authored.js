// GameSpec v2. Authored geometry, selected-IP actors and ordered mission events are the game.
// The legacy arena/village is never substituted when this data or a selected asset is invalid.
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { THREE, PlayerController, PICKUP_MAX, canvasTexture, color, clamp, damp, animateBody, disposeTree, jumpApex, releaseDrawn, mulberry32 } from './world.js';
import { MissionDirector } from './mission.js';
import { loadBackground } from './background.js';
import { SKY, buildSky, climbNodes, climbStep, islandAt, islandRoot, nodeAt, skyIslands } from './sky.js';
import { Arpg } from './arpg.js';
import { BALANCE, RESUME_CLEARANCE, RESUME_GRACE_SEC, RESUME_SAFE_SEC, SPAWN_CLEARANCE, assistTarget, attackSlots, billboardPose,
  clearOf, clearSpawn, clock, enemyHit, fireInterval, navClear, navGrid, navNearest, navNext, navPath, toughness, wallEdge } from './arpg-data.js';
import { INDOOR, RING_DEPTH, RING_GAP, applyIndoor, applyNight, applySky, buildHarbor, containerMaterial, disposeBiome, flicker,
  groundLook, groundPlane, groundReach, harborPlan, indoorShell, isContainer, loadBiome, makeWeather, pbr, placeModel, scatter } from './biome.js';

const URBAN = new Set(['ruins', 'industrial', 'night-city']); // biomes whose buildings keep lit windows
// 다시 시작 resumes the last stage this page's run reached, with the score (and ARPG growth) it had then. Keyed by the
// spec object runtime3d.js keeps for every round; a clear forgets it. City and race rounds always start over.
const CHECKPOINTS = new WeakMap();
const STRIKE_SEC = .28; // a cutout enemy's lunge
const BOLT_SPEED = 42; // m/s, the hero's crossbow bolt
const LEAVE_SEC = 1.6; // a withdrawing enemy runs this long, shrinking away
const BOSS_REACH = 3.6; // m: a boss's blow lands on a hero within this (the built-in player steps out of it: autoDodge)
const FIGHT_NEAR = 12; // m: an enemy nearer than this is in the fight (the goal arrow hides, the built-in player stands)
const TALK_HOLD_SEC = 1.5; // a talk's next line while E is held down (a press passes it at once)
const WALLS = new Set(['box', 'building', 'cylinder', 'arch']); // what a place is walled with: these keep a low edge (edge)
let shadowTexture = null, poolTexture = null; // shared by every ground shadow (and pool) under a flat cutout
/** The page's box of a HUD element while it shows (the story box, the notice pill), else null. */
const shownBox = (id) => {
  const node = document.getElementById(id);
  return node && node.hidden === false && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
};

const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
const tmpObj = new THREE.Object3D();
export const STEP_UP = .3; // groundAt lands within .32 m of a walkable top
const HEADROOM = 1.6; // collide: a body walks under a box whose underside is higher than this above its feet
const GLOW = (hex, intensity = 2) => new THREE.MeshStandardMaterial({
  color: hex, emissive: hex, emissiveIntensity: intensity, roughness: .3, metalness: .25,
});
const firstStageFor = (spec, placement, type) => spec.mission.stages.find((s) =>
  s.type === type && (!placement.stageId || placement.stageId === s.id)
  && (!s.entityIds?.length || s.entityIds.includes(placement.id))
  && (s.propIndex == null || s.propIndex === placement.propIndex)
  && (s.enemyIndex == null || s.enemyIndex === placement.enemyIndex));
/** The clips a rigged enemy moves with (World.makeActor options). Only a zombie, ghoul or mummy shambles hunched over;
 * every other humanoid and every boss walk upright with the UAL idle, walk and sword strike (a hunched figure reads
 * as a blob from the ARPG's high camera). */
const SHAMBLERS = /좀비|구울|미라|zombie|ghoul|mummy|walker/i;
export const enemyClips = (data, boss) => ({ zombie: !boss && (!data.humanoid || SHAMBLERS.test(data.name ?? '')) });

export async function createAuthored(world, spec, hud, actor) {
  const mode = new AuthoredMode(world, spec, hud, actor);
  try { await mode.build(); return mode; }
  catch (error) { mode.dispose(); throw error; }
}

export class AuthoredMode {
  constructor(world, spec, hud, actor) {
    Object.assign(this, { world, spec, hud, actor });
    this.root = new THREE.Group();
    world.scene.add(this.root);
    this.checkpoints = this.ownCamera = !spec.world.city && !spec.world.track; // city and race modes run their own
    // a checkpoint at the first stage is the mission's start: that round is a fresh one (no "from the checkpoint"
    // notice, no invulnerability)
    const checkpoint = this.checkpoints ? CHECKPOINTS.get(spec) : null;
    this.resumed = checkpoint?.stage > 0 ? checkpoint : null;
    this.director = new MissionDirector(spec.mission, { startAt: this.resumed?.stage ?? 0 });
    this.tune = BALANCE[spec.difficulty] ?? BALANCE.normal; // enemy blows, attack slots, i-frames (arpg-data.js)
    this.accent = color(spec.palette.accent);
    this.rnd = mulberry32(spec.map?.seed ?? 1234);
    this.boxes = [];
    this.walkable = [];
    this.movers = []; // entities with motion: their group and collider boxes move every frame
    this.entities = new Map();
    this.targets = [];
    this.pickups = [];
    this.enemies = [];
    this.dying = [];
    this.leaving = []; // a finished wave's horde (and a fallen boss's minions) running off, out of the fight
    this.bolts = [];
    this.enemyBolts = [];
    this.historySpawns = [];
    this.phase = 'ready';
    this.elapsed = 0;
    this.safeUntil = 0; // until this elapsed time enemies appear RESUME_CLEARANCE away (a checkpoint resume)
    this.hp = this.maxHp = spec.rules?.playerHp ?? 100;
    this.hurtFor = this.fireIn = this.sinceHurt = 0;
    this.kills = this.collected = this.score = 0;
    this.timeLimit = spec.rules?.timeLimitSec ?? 0;
    this.ended = false;
    this.stageSeen = -1;
    this.tipText = ''; this.tipUntil = 0; // a one-shot tip in the notice pill (tip)
    this.mechanics = { dash: true, jump: true, sprint: true, autoFire: false, regenPerSec: 0,
      weaponDamage: 1, fireIntervalSec: .22, interactRadius: 2.4, ...spec.mechanics };
    this.combatEnabled = spec.enemies.length > 0 || !!spec.player.weaponUrl || this.mechanics.autoFire === true;
    this.arpg = this.mechanics.style === 'arpg' ? new Arpg(this) : null; // Diablo-like layer (arpg.js)
    if (this.arpg) this.combatEnabled = true;
    // nothing in this game can hurt the hero (no enemy, no trap): it has no health bar
    this.harmless = !spec.enemies.length && !spec.world.entities.some((e) => e.kind === 'hazard');
    // sky islands over a cloud sea (sky.js): the floor is solid only on the ground islands
    this.islands = spec.artDirection?.setting === 'sky' ? skyIslands(spec.world) : null;
  }

  strictActor(actor, data, role) {
    // a rig dropped for uneven legs (world.js brokenRig) without its raw mesh in the folder stands as its cutout
    const dropped = actor.rigDropped && actor.kind === 'billboard';
    if (data?.modelUrl && !dropped && !['model', 'rigged'].includes(actor.kind)) throw new Error(`${role}: 선택한 GLB를 불러오지 못했습니다.`);
    if (data?.spriteUrl && actor.kind === 'procedural') throw new Error(`${role}: 선택한 IP 이미지를 불러오지 못했습니다.`);
    if (data?.weaponUrl && !actor.weapon) throw new Error(`${role}: 선택한 무기를 불러오지 못했습니다.`);
  }

  /** The enemies' files, asked for with the rest of the game so the loading screen counts them: a model and its weapon,
   * else the cutout. An enemy's actor is made when it first appears (spawnEnemy); the files wait in the world's caches,
   * and one that fails to load fails again where it is used, where spawnEnemy says which. → a promise for all of them */
  loadCast() {
    const { world } = this;
    return Promise.all(this.spec.enemies.flatMap((e) => (e.modelUrl ? [world.loadModel(e.modelUrl), e.weaponUrl && world.loadModel(e.weaponUrl)]
      : [e.spriteUrl && world.loadCutout(e.spriteUrl)])));
  }

  async build() {
    const { world, spec } = this;
    this.strictActor(this.actor, spec.player, spec.player.name ?? '플레이어');
    const cast = this.loadCast(); // (while the world is built: the round does not start before they are in)
    // photoreal biome kit and the user's AI-made set pieces load before anything is placed
    this.biome = spec.artDirection?.biome ? await loadBiome(world, spec.artDirection.biome) : null;
    this.setPieces = new Map(await Promise.all(spec.world.entities.filter((e) => e.kind === 'model').map(async (e) => {
      if (!e.modelUrl && e.spriteUrl) { // no 3D yet: the prop IP's own cutout stands there as a panel
        const cut = await world.loadCutout(e.spriteUrl);
        if (!cut) throw new Error(`${e.label ?? e.id}: 배경 사물 이미지를 불러오지 못했습니다.`);
        return [e.id, { cut }];
      }
      if (!e.modelUrl) throw new Error(`${e.label ?? e.id}: 배경 사물 GLB가 게임에 연결되지 않았습니다.`);
      try { return [e.id, (await world.gltf(e.modelUrl)).scene]; } // (its bytes counted for the loading screen)
      catch { throw new Error(`${e.label ?? e.id}: 배경 사물 GLB를 불러오지 못했습니다.`); }
    })));
    this.buildEnvironment();
    // rain or snow falls around the camera outdoors (biome.js makeWeather); a dungeon stays dry
    this.weather = this.biome && INDOOR.has(this.biome.name) ? null : makeWeather(spec.artDirection?.weather, this.rnd);
    if (this.weather) world.scene.add(this.weather.object);
    this.background = await loadBackground(this);
    if (this.background?.result?.mode === 'image' && this.biome?.sky) { this.world.scene.remove(this.biome.sky); this.biome.sky = null; }
    const tops = spec.world.entities.filter((e) => e.kind === 'platform');
    for (const e of spec.world.entities) if (e.kind === 'beacon' || e.pickup) {
      const under = tops.find((p) => Math.abs(e.x - p.x) <= (p.width ?? 2) / 2 && Math.abs(e.z - p.z) <= (p.depth ?? 2) / 2
        && (e.y ?? 0) >= (p.y ?? 0) - .05 && (e.y ?? 0) < (p.y ?? 0) + (p.height ?? 2));
      if (under) e.y = (under.y ?? 0) + (under.height ?? 2);
    }
    for (const entity of spec.world.entities) this.buildEntity(entity);
    // sky: every platform is a floating island, a rock root under its slab (it moves with a moving one)
    if (this.islands) for (const e of this.entities.values()) if (e.kind === 'platform') e.group.add(islandRoot(e.width, e.depth, this.rnd));
    for (const t of this.targets) if (t.pickup) { const seat = this.platformUnder(t.x, t.z, true); if (seat?.motion) t.rideId = seat.id; }
    if (this.biome && !this.islands) this.dress(); // sky: nothing stands on the air between the islands
    const { width, depth, spawn } = spec.world;
    this.root.add(this.actor.root);
    this.player = new PlayerController(world, this.actor, {
      speed: spec.player.speed, mechanics: this.mechanics,
      groundAt: (x, z, y = 0) => this.groundAt(x, z, y),
      collide: (p, r) => this.collide(p, r),
      bounds: { minX: -width / 2 + .6, maxX: width / 2 - .6, minZ: -depth / 2 + .6, maxZ: depth / 2 - .6 },
    });
    this.player.dashColor = this.accent;
    this.player.place(spawn.x, spawn.z);
    this.player.yaw = Math.PI;
    // Keep the focus inside the player's collision footprint. A shoulder offset
    // can place it inside neighbouring cover and retract the camera into the IP mesh.
    const thin = (b) => this.ownCamera && Math.max(b.max.x - b.min.x, b.max.z - b.min.z) < 3;
    Object.assign(world.rig, { yaw: 0, pitch: .25, distance: 6.2, shoulder: 0, height: 1.5,
      first: true, minY: () => .25,
      // thin floating platforms and moving pieces must not pull the camera in on every jump: walls only
      blockers: this.boxes.filter((b) => !thin(b) && !this.walkable.some((w) => w.box === b) && !this.movers.some((m) => m.boxes.includes(b))),
      // pillars and props fade instead of pulling in. A wall or container at the hero's back lifts the camera over it
      // at full distance (up to ~57°, world.js cameraBoom); one too tall pulls it in no closer than 3 m, no higher than
      // 0.9 m over the hero, and fades. City/race keep theirs
      ...(this.ownCamera ? { pullMin: 3, rise: 1, boost: 0, hover: 0, lift: .35, liftMax: .9, occluders: this.occluders() }
        : { rise: null, boost: 0, occluders: [] }) });
    this.propActors = await Promise.all(spec.props.map(async (p) => {
      const a = await world.makeActor(p, .85, () => gem(p.effect === 'heal' ? '#75eda1' : spec.palette.accent), { maxExtent: PICKUP_MAX });
      this.strictActor(a, p, p.name ?? '소품');
      return a;
    }));
    for (const placement of spec.world.propPlacements) {
      const template = this.propActors[placement.propIndex];
      const group = new THREE.Group();
      const visual = template.root.clone(true);
      visual.position.y = .65;
      group.add(visual);
      group.add(this.ring(.65));
      // a collectible over a platform sits on its top (and rides it): the climb is the way to it, not the floor below.
      // Under a bridge outside a platformer it stays on the floor, within the hero's reach (platformUnder)
      const seat = this.platformUnder(placement.x, placement.z);
      group.position.set(placement.x, seat ? seat.y + seat.height : this.groundAt(placement.x, placement.z), placement.z);
      this.root.add(group);
      this.pickups.push(this.pickupFor(placement, group, visual, template.kind, seat));
    }
    const npcData = spec.world.npc;
    if (npcData) {
      const data = npcData.propIndex == null ? null : spec.props[npcData.propIndex];
      const npcActor = await world.makeActor(data, 1.6, () => guide(this.accent));
      this.strictActor(npcActor, data, npcData.name ?? 'NPC');
      npcActor.root.position.set(npcData.x, 0, npcData.z);
      this.root.add(npcActor.root);
      this.npc = { ...npcData, actor: npcActor };
      this.targets.push({ ...npcData, radius: this.mechanics.interactRadius });
    }
    this.arpg?.setup();
    // a key light for the boss fight, added now at 0 (a light added mid-game would recompile every material)
    if (spec.mission.stages.some((s) => s.type === 'boss')) {
      this.bossLight = new THREE.PointLight('#ffe2c4', 0, 14, 1.2);
      this.root.add(this.bossLight);
    }
    await cast;
    if (this.resumed) this.resume(this.resumed);
    this.activateStage();
    this.faceFirstGoal();
    this.hud.say(null);
    this.refreshHud();
  }

  /** A placed prop as the round keeps it. One a collect stage asks for (firstStageFor) shows during that stage under a
   * tall light beam; one no stage asks for is a bonus pickup: on the map from the start, taken any time for its effect
   * (applyEffect), never counted for a stage. */
  pickupFor(placement, group, visual, kind, seat) {
    const stage = firstStageFor(this.spec, placement, 'collect')?.id;
    const record = { ...placement, group, visual, kind, taken: false, rideId: seat?.motion ? seat.id : null,
      stage, bonus: !stage, phase: this.rnd() * 6 };
    group.visible = record.bonus;
    if (!record.bonus) {
      const tint = this.spec.props[placement.propIndex]?.effect === 'heal' ? new THREE.Color('#75eda1') : this.accent;
      record.beam = new THREE.Mesh(new THREE.CylinderGeometry(.07, .26, 7, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(1.6), transparent: true, opacity: .32, depthWrite: false, toneMapped: false }));
      record.beam.position.y = 3.5;
      group.add(record.beam);
    }
    return record;
  }

  /** A prop's effect on the hero when taken: heal restores HP, shield blocks damage for 5 s, key and score score. */
  applyEffect(prop, at) {
    const effect = prop?.effect;
    this.score += effect === 'key' ? 250 : 100;
    let line = prop?.name ?? '';
    if (effect === 'heal') {
      const gain = Math.min(this.maxHp - this.hp, Math.max(25, Math.round(this.maxHp * (this.arpg ? .35 : .25))));
      this.hp += gain;
      line = `${line} +${Math.round(gain)} 체력`;
    } else if (effect === 'shield') {
      this.shieldFor = 5;
      line = `${line} · 방어막 5초`; // the HUD's word too
    }
    // a heal or a shield changes the hero: its line stands big over the hero's head for 2 s (a score popup at the item
    // is too small and short to read); the HUD counts the shield down (refreshHud)
    if (effect === 'heal' || effect === 'shield') this.hud.popup(line, this.player.pos.clone().setY(this.player.pos.y + 2.6), 'effect', 2000);
    else this.hud.popup(line, at.clone().setY(2), 'pickup');
  }

  buildEnvironment() {
    if (this.biome) return this.buildBiomeEnvironment();
    if (this.islands) return this.buildSkyWorld(1);
    const { world, spec } = this;
    const a = spec.artDirection ?? {};
    const sky = color(a.skyColor ?? spec.palette.bg);
    world.scene.background = sky;
    world.scene.fog = new THREE.FogExp2(a.fogColor ?? sky, a.fogDensity ?? .014);
    // the light probe is kept as its render target: that is what dispose() frees (a render target's texture.dispose()
    // frees nothing)
    this.envTarget = world.pmrem.fromScene(new RoomEnvironment(), .04);
    world.scene.environment = this.envTarget.texture;
    world.scene.environmentIntensity = .55;
    world.renderer.toneMappingExposure = a.exposure ?? 1.1;
    world.bloom.strength = a.bloomStrength ?? .45;
    world.bloom.radius = .35; world.bloom.threshold = 1.0;
    const { width, depth } = spec.world;
    const groundColor = spec.world.groundColor ?? spec.palette.bg;
    this.floorTex = canvasTexture(512, (ctx, size) => {
      ctx.fillStyle = groundColor; ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 1800; i++) {
        ctx.fillStyle = `rgba(255,255,255,${this.rnd() * .06})`;
        ctx.fillRect(this.rnd() * size, this.rnd() * size, 2, 2);
      }
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 3;
      ctx.strokeRect(1, 1, size - 2, size - 2);
    }, { repeat: 12 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: this.floorTex, roughness: .65, metalness: .18 }));
    floor.receiveShadow = true;
    this.root.add(floor);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(width + 1.5, 1.4, depth + 1.5),
      new THREE.MeshStandardMaterial({ color: groundColor, roughness: .9 }));
    skirt.position.y = -.75; this.root.add(skirt);
    const night = a.timeOfDay === 'night' ? .3 : a.timeOfDay === 'dusk' ? .65 : 1; // no photo sky: dimmer, cooler light
    const hemi = new THREE.HemisphereLight(0xbad5ff, 0x1c2330, 1.1 * night);
    const sun = new THREE.DirectionalLight(night < 1 ? 0xa9b8ff : 0xffe4c6, 3.0 * night);
    sun.position.set(-width * .35, 35, depth * .3);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -width / 2, right: width / 2, top: depth / 2, bottom: -depth / 2, near: 1, far: 120 });
    sun.shadow.normalBias = .04; sun.shadow.bias = -.0003;
    this.root.add(hemi, sun, sun.target);
    // Atmospheric mountains remain outside the playable authored bounds.
    const backdrop = new THREE.MeshStandardMaterial({ color: sky.clone().lerp(this.accent, .08), roughness: 1 });
    for (let i = 0; i < (spec.world.background ? 0 : 14); i++) {
      const angle = i / 14 * Math.PI * 2;
      const h = 12 + this.rnd() * 20;
      const mountain = new THREE.Mesh(new THREE.ConeGeometry(8 + this.rnd() * 8, h, 5), backdrop);
      mountain.position.set(Math.cos(angle) * (width * .9 + 12), h / 2 - 4, Math.sin(angle) * (depth * .9 + 12));
      mountain.rotation.y = this.rnd() * 6;
      this.root.add(mountain);
    }
    const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-width / 2, .03, -depth / 2), new THREE.Vector3(width / 2, .03, -depth / 2),
      new THREE.Vector3(width / 2, .03, depth / 2), new THREE.Vector3(-width / 2, .03, depth / 2),
    ]), new THREE.LineBasicMaterial({ color: this.accent, transparent: true, opacity: .6 }));
    this.root.add(border);
  }

  // photoreal biome: HDRI light + projected panorama, PBR ground fading into it, sun for shadows
  buildBiomeEnvironment() {
    const { world, spec, biome } = this;
    const a = spec.artDirection ?? {};
    const { width, depth } = spec.world;
    const span = Math.max(width, depth);
    if (INDOOR.has(biome.name)) return this.buildIndoor();
    applySky(world, biome, span * 3, a.fogDensity ?? Math.min(.012, 1.1 / span));
    if (this.islands) { // the kit's light and reflections, not its photo dome or its floor
      world.scene.remove(biome.sky); biome.sky = null;
      return this.buildSkyWorld(a.exposure ?? 1.05);
    }
    world.renderer.toneMappingExposure = a.exposure ?? 1;
    world.bloom.strength = a.bloomStrength ?? .25;
    world.bloom.radius = .35; world.bloom.threshold = 1.0;
    this.root.add(this.ground = groundPlane(biome, groundReach(width, depth)));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(-width * .35, 40, depth * .3);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    // the shadows reach the outer dressing ring too (biome.js RING_GAP/RING_DEPTH): a boulder there sits on its shadow
    const rim = Math.min(RING_GAP + RING_DEPTH, 20);
    Object.assign(sun.shadow.camera, { left: -width / 2 - rim, right: width / 2 + rim, top: depth / 2 + rim, bottom: -depth / 2 - rim, near: 1, far: 160 });
    sun.shadow.normalBias = .04; sun.shadow.bias = -.0003;
    this.root.add(sun, sun.target);
    // the request's time of day over a daylight photo (biome.js applyNight): moonlight, a darker dome, neon blooms
    const moon = applyNight(world, biome, a.timeOfDay);
    if (moon) {
      sun.color.set(moon.color); sun.intensity = moon.intensity;
      if (a.bloomStrength == null) world.bloom.strength = a.timeOfDay === 'night' ? .5 : .3;
    }
    // a dark floor at night, darker and glossy in the rain
    const floor = groundLook(a);
    this.ground.material.color.setScalar(floor.tint);
    Object.assign(this.ground.material, { roughness: floor.roughness, envMapIntensity: floor.envMapIntensity });
    if (a.setting === 'harbor') { // water past one edge, a quay, cranes, container stacks (biome.js harborPlan)
      this.harbor = buildHarbor(world, biome, harborPlan(spec, this.rnd),
        { radius: span * 3, reach: groundReach(width, depth), night: a.timeOfDay === 'night', ground: this.ground });
      this.root.add(this.harbor.group);
    }
  }

  /** Sky islands (sky.js buildSky): a cloud sea far below instead of a floor, the ground islands, sky light and a
   * warm sun. The platforms get their rock roots in build(). */
  buildSkyWorld(exposure) {
    const { world, spec } = this;
    const a = spec.artDirection ?? {};
    const { width, depth } = spec.world;
    const span = Math.max(width, depth);
    world.renderer.toneMappingExposure = exposure;
    world.bloom.strength = a.bloomStrength ?? .3;
    world.bloom.radius = .35; world.bloom.threshold = 1.0;
    this.skyLayer = buildSky(world, { islands: this.islands, span, rnd: this.rnd, hasBackdrop: spec.world.background?.mode === 'image' });
    this.root.add(this.skyLayer.group);
    const night = a.timeOfDay === 'night' ? .3 : a.timeOfDay === 'dusk' ? .65 : 1;
    const sun = new THREE.DirectionalLight(night < 1 ? 0xa9b8ff : 0xfff0d6, 2.8 * night);
    sun.position.set(-width * .35, 40, depth * .3);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -width / 2, right: width / 2, top: depth / 2, bottom: -depth / 2, near: 1, far: 160 });
    sun.shadow.normalBias = .04; sun.shadow.bias = -.0003;
    this.root.add(sun, sun.target);
  }

  // dungeon: a walled, roofed room lit by torches; the HDRI only reflects
  buildIndoor() {
    const { world, spec, biome } = this;
    const a = spec.artDirection ?? {};
    const { width, depth } = spec.world;
    applyIndoor(world, biome, a.fogDensity ?? .03);
    world.renderer.toneMappingExposure = a.exposure ?? 1.1;
    world.bloom.strength = a.bloomStrength ?? .35;
    world.bloom.radius = .4; world.bloom.threshold = .9;
    // indoors the whole floor is solid stone to the walls (the outdoor floor fades into the sky dome at its rim)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width + 2, depth + 2).rotateX(-Math.PI / 2), pbr(biome.ground, width, depth, 3));
    floor.position.y = .002; floor.receiveShadow = true; this.root.add(floor);
    const shell = indoorShell(biome, { width, depth, rnd: this.rnd });
    this.root.add(shell.group);
    this.boxes.push(...shell.colliders);
    this.torches = shell.torches;
    this.shellWalls = shell.walls; // faded by the camera when they hide the hero
    for (const wall of this.shellWalls) this.edge(new THREE.Box3().setFromObject(wall), wall.material);
    this.root.add(new THREE.HemisphereLight(0x8a7560, 0x120c08, .75));
    // the hero carries a warm light radius (big halls are dark away from the wall torches)
    this.heroLight = new THREE.PointLight('#ffb070', 36, 22, 1.4);
    this.root.add(this.heroLight);
    const key = new THREE.DirectionalLight(0xffd2a0, .5); // soft shadow caster from above
    key.position.set(-width * .2, 30, depth * .2); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -width / 2, right: width / 2, top: depth / 2, bottom: -depth / 2, near: 1, far: 80 });
    this.root.add(key, key.target);
  }

  // seeded decoration that never blocks: kept off entities, targets, placements, spawns and the start
  dress() {
    const { spec } = this;
    const keep = [{ x: spec.world.spawn.x, z: spec.world.spawn.z, r: 4 },
      ...[...this.entities.values()].map((e) => ({ x: e.x, z: e.z, r: Math.max(e.width, e.depth) / 2 + 1.5 })),
      ...spec.world.propPlacements.map((p) => ({ x: p.x, z: p.z, r: 2.5 })),
      ...spec.world.enemySpawns.map((p) => ({ x: p.x, z: p.z, r: 2.5 })),
      ...(spec.world.npc ? [{ x: spec.world.npc.x, z: spec.world.npc.z, r: 3 }] : [])];
    const blocked = (x, z, r) => keep.some((k) => Math.hypot(x - k.x, z - k.z) < k.r + r);
    const area = spec.world.width * spec.world.depth;
    this.root.add(scatter(this.biome, { width: spec.world.width, depth: spec.world.depth, rnd: this.rnd, blocked,
      // a harbor's container stacks take the outer ring (no rocks in its water)
      inner: Math.round(Math.min(70, area / 80)), outer: INDOOR.has(this.biome.name) || this.harbor ? 0 : URBAN.has(this.biome.name) ? 26 : 56 }));
  }

  ring(radius, tint = this.accent) {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, .035, 8, 48), GLOW(tint, 2.5));
    mesh.rotation.x = Math.PI / 2; mesh.position.y = .07;
    return mesh;
  }

  buildEntity(e) {
    if (e.kind === 'model' && e.car) { (this.carEntities ??= []).push(e); return; } // a car body for the race (race.js)
    const w = e.width ?? 2, d = e.depth ?? 2, h = e.height ?? 2;
    const g = new THREE.Group();
    g.position.set(e.x, e.y ?? 0, e.z); g.rotation.y = e.rotation ?? 0;
    const tint = color(e.color ?? this.spec.palette.accent);
    const biome = this.biome;
    const neon = biome?.name === 'night-city' || this.spec.artDirection?.timeOfDay === 'night';
    const container = isContainer(e); // corrugated painted steel in its colour, no neon trim
    const mat = container ? containerMaterial(tint, Math.max(w, d)) : biome && !['beacon', 'hazard', 'crystal'].includes(e.kind)
      ? pbr(biome.wall, Math.max(w, d), h, 2.5, { color: tint.clone().lerp(new THREE.Color('#ffffff'), paint(tint)),
        // a glowing wall reads as neon paint: only at night (the night city) it keeps it
        emissive: neon ? e.emissive ?? 0x000000 : 0x000000,
        emissiveIntensity: neon && e.emissive ? .5 : 0 })
      : new THREE.MeshStandardMaterial({ color: tint, roughness: .45, metalness: .35,
        emissive: e.emissive ?? 0x000000, emissiveIntensity: e.emissive ? .35 : 0 });
    const trim = GLOW(e.emissive ?? this.spec.palette.accent, 1.8);
    const mesh = (geometry, material = mat, x = 0, y = h / 2, z = 0, solid = false) => {
      const obj = new THREE.Mesh(geometry, material);
      obj.position.set(x, y, z); obj.castShadow = obj.receiveShadow = true;
      g.add(obj);
      if (solid) obj.userData.collider = true;
      return obj;
    };
    const solid = e.kind === 'platform' || (e.solid ?? !['beacon', 'hazard'].includes(e.kind)); // a ghost platform swallows the player
    // a real model in the entity's declared box; collision stays that box (narrowed for trunks)
    const asModel = (scene, footprint = 1) => {
      const placed = placeModel({ scene, size: new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3()) }, { width: w, depth: d, height: h });
      placed.position.y -= h * .15; // generated meshes have rounded undersides: seat them in the ground instead of hovering
      g.add(placed);
      if (solid) {
        const hit = mesh(new THREE.BoxGeometry(w * footprint, h, d * footprint), mat, 0, h / 2, 0, true);
        hit.visible = false;
      }
    };
    const kitModel = (role) => {
      const list = biome?.models[role] ?? [];
      return list.length ? list[Math.floor(this.rnd() * list.length)] : null;
    };
    if (e.kind === 'model' && this.setPieces.get(e.id).cut) {
      // the prop IP's image at the entity's size, turned to the camera like every cutout (facePanels); the entity's
      // box stays its collider, so cover still blocks movement and bolts
      const { cut } = this.setPieces.get(e.id);
      const fit = Math.min(1, Math.max(w, d) * 1.15 / (h * cut.aspect)), ph = h * fit, pw = ph * cut.aspect;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph).translate(0, ph / 2, 0), new THREE.MeshStandardMaterial({
        map: cut.texture, alphaTest: .45, side: THREE.DoubleSide, roughness: .8, emissive: 0xffffff, emissiveMap: cut.texture,
        emissiveIntensity: .18 }));
      panel.castShadow = true; g.add(panel, groundShadow(pw * .55, Math.max(d, .6) * .9));
      (this.panels ??= []).push({ panel, group: g });
      if (solid) { const hit = mesh(new THREE.BoxGeometry(w, h, d), mat, 0, h / 2, 0, true); hit.visible = false; }
    } else if (e.kind === 'model') {
      asModel(this.setPieces.get(e.id), .8);
    } else if (biome && e.kind === 'tree' && kitModel('tree')) {
      const m = kitModel('tree');
      g.add(placeModel(m, { width: w, depth: d, height: h }, this.rnd() * Math.PI * 2));
      if (solid) { const hit = mesh(new THREE.CylinderGeometry(w * .12, w * .12, h, 8), mat, 0, h / 2, 0, true); hit.visible = false; }
    } else if (e.pickup && e.kind === 'crystal') { // a gold coin, upright, spun by updateTargets
      const coin = mesh(new THREE.CylinderGeometry(.42, .42, .09, 28), new THREE.MeshStandardMaterial({ color: '#ffc93c', metalness: .85, roughness: .25,
        emissive: '#a86b00', emissiveIntensity: .45 }), 0, 1);
      coin.rotation.x = Math.PI / 2;
    } else if (biome && biome.name !== 'night-city' && (e.kind === 'spire' || e.kind === 'crystal') && kitModel('rock')) {
      g.add(placeModel(kitModel('rock'), { width: w, depth: d, height: h }, this.rnd() * Math.PI * 2));
      if (solid) { const hit = mesh(new THREE.BoxGeometry(w * .8, h, d * .8), mat, 0, h / 2, 0, true); hit.visible = false; }
    } else if (['box', 'platform', 'building'].includes(e.kind)) {
      mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(.15, h / 4)), mat, 0, h / 2, 0, solid);
      if (e.kind === 'building' && (!biome || URBAN.has(biome.name))) {
        // photoreal biomes: dark glass with a faint warm light, not neon squares on a brick wall
        const facade = biome
          ? new THREE.MeshStandardMaterial({ color: '#15181c', emissive: biome.name === 'night-city' ? tint : '#ffb35c',
            emissiveIntensity: biome.name === 'night-city' ? .6 : .08, roughness: .15, metalness: .6 })
          : new THREE.MeshStandardMaterial({ color: '#101b2d', emissive: tint, emissiveIntensity: .4, roughness: .35, metalness: .25 });
        const windows = Math.min(60, Math.floor(h / .9) * Math.max(1, Math.floor(w / .9)));
        for (let i = 0; i < windows; i++) {
          const columns = Math.max(1, Math.floor(w / .9));
          const x = -.5 * w + .5 + (i % columns) * .8;
          const y = .65 + Math.floor(i / columns) * .85;
          if (y > h - .3) continue;
          mesh(new THREE.BoxGeometry(.42, .38, .035), facade, x, y, d / 2 + .04);
        }
      } else {
        if (!container && (!biome || biome.name === 'night-city')) mesh(new THREE.BoxGeometry(w * .85, .04, .04), trim, 0, h * .8, d / 2 + .03); // neon trim only where neon belongs
      }
    } else if (e.kind === 'arch') {
      const leg = Math.max(.3, w * .16);
      mesh(new THREE.BoxGeometry(leg, h, d), mat, -w / 2 + leg / 2, h / 2, 0, solid);
      mesh(new THREE.BoxGeometry(leg, h, d), mat, w / 2 - leg / 2, h / 2, 0, solid);
      mesh(new THREE.BoxGeometry(w, leg, d), mat, 0, h - leg / 2, 0, solid);
      mesh(new THREE.BoxGeometry(w - leg, .05, d + .02), trim, 0, h - leg * 1.2);
    } else if (e.kind === 'tree') {
      mesh(new THREE.CylinderGeometry(w * .07, w * .12, h * .55, 8), mat, 0, h * .275, 0, solid);
      const canopy = new THREE.MeshStandardMaterial({ color: tint, roughness: .9 });
      mesh(new THREE.IcosahedronGeometry(1, 1), canopy, 0, h * .7).scale.set(w / 2, h * .4, d / 2);
    } else if (e.kind === 'spire' || e.kind === 'crystal') {
      const geom = e.kind === 'spire' ? new THREE.ConeGeometry(1, 1, 6) : new THREE.OctahedronGeometry(1, 0);
      const crystal = mesh(geom, e.kind === 'crystal' ? GLOW(tint, 1) : mat, 0, h / 2, 0, solid);
      crystal.scale.set(w / 2, h, d / 2);
      if (e.kind === 'crystal') crystal.scale.y = h / 2;
    } else if (e.kind === 'cylinder') {
      const barrel = mesh(new THREE.CylinderGeometry(1, 1, h, 20), mat, 0, h / 2, 0, solid);
      barrel.scale.set(w / 2, 1, d / 2);
      for (const y of [h * .15, h * .85]) {
        const band = mesh(new THREE.TorusGeometry(w / 2 + .03, .04, 6, 24), trim, 0, y);
        band.rotation.x = Math.PI / 2; band.scale.y = d / w;
      }
    } else if (e.kind === 'beacon') {
      mesh(new THREE.CylinderGeometry(.4, .65, .3, 20), mat, 0, .15);
      const core = mesh(new THREE.OctahedronGeometry(.36), trim, 0, 1.25);
      g.add(this.ring(Math.max(w / 2, 1.1)));
      this.targets.push({ id: e.id, x: e.x, z: e.z, y: e.y ?? 0, radius: Math.max(w / 2, this.mechanics.interactRadius), core });
    } else if (e.kind === 'hazard' && (biome?.name === 'volcanic' || /lava|magma|fire|용암|화염|마그마/i.test(`${e.id} ${e.label ?? ''}`))) {
      const lava = mesh(new THREE.PlaneGeometry(w, d, 1, 1), lavaMaterial(), 0, .1); // above its rim (top at .08)
      lava.rotation.x = -Math.PI / 2; lava.castShadow = false;
      const rim = mesh(new THREE.BoxGeometry(w + .4, .12, d + .4), new THREE.MeshStandardMaterial({ color: '#1a1210', roughness: .95 }), 0, .02);
      rim.castShadow = false; rim.renderOrder = -1;
      if ((this.lavaGlows = (this.lavaGlows ?? 0) + 1) <= 4) {
        const glow = new THREE.PointLight('#ff6a1a', 14, Math.max(w, d) * 1.4, 1.6); glow.position.set(0, 1.2, 0); g.add(glow);
      }
    } else if (e.kind === 'hazard') {
      // a bed of steel spikes on a dark plate, with a faint warning glow: reads as a trap, not a paint sheet
      const plate = mesh(new THREE.BoxGeometry(w, .08, d), new THREE.MeshStandardMaterial({ color: '#1b1a1c', roughness: .7, metalness: .4,
        emissive: tint, emissiveIntensity: .12 }), 0, .04);
      plate.castShadow = false;
      const steel = new THREE.MeshStandardMaterial({ color: '#9aa0a8', metalness: .9, roughness: .3 });
      const nx = Math.max(1, Math.min(12, Math.round(w / .7))), nz = Math.max(1, Math.min(12, Math.round(d / .7)));
      const spikes = new THREE.InstancedMesh(new THREE.ConeGeometry(.16, .55, 6), steel, nx * nz);
      for (let i = 0; i < nx * nz; i++) {
        tmpObj.position.set((i % nx + .5) * w / nx - w / 2, .35, (Math.floor(i / nx) + .5) * d / nz - d / 2);
        tmpObj.scale.setScalar(.8 + this.rnd() * .4); tmpObj.updateMatrix(); spikes.setMatrixAt(i, tmpObj.matrix);
      }
      spikes.castShadow = true; g.add(spikes);
    }
    this.root.add(g);
    g.updateMatrixWorld(true);
    const own = [];
    for (const obj of g.children) if (obj.userData.collider) {
      this.boxes.push(new THREE.Box3().setFromObject(obj)); own.push(this.boxes.at(-1));
      if (e.kind === 'platform') this.walkable.push({ box: this.boxes[this.boxes.length - 1] });
    }
    if (e.motion) this.movers.push({ e, group: g, base: g.position.clone(), boxes: own, offset: new THREE.Vector3(),
      view: new THREE.Box3().setFromObject(g), period: e.motion.periodSec ?? 4, phase: this.rnd() * Math.PI * 2 });
    // (a wall that stands still, square to the world: a turned one's collider is the box around it, wider than the wall)
    else if (WALLS.has(e.kind) && Math.abs(Math.sin(2 * (e.rotation ?? 0))) < 1e-3) for (const box of own) this.edge(box, mat, e.kind === 'cylinder');
    if (e.pickup) {
      // a coin: spins and bobs; touching it counts it for its reach stage and takes it away
      this.targets.push({ id: e.id, x: e.x, z: e.z, radius: Math.max(1.1, Math.max(w, d) / 2 + .5), pickup: true, group: g });
    }
    this.entities.set(e.id, { ...e, group: g, solid, width: w, depth: d, height: h });
    // ponytail: forward-rendered point lights cost every pixel; six landmarks at most, never platforms or traps
    if (e.emissive && !['platform', 'hazard'].includes(e.kind) && (this.lamps = (this.lamps ?? 0) + 1) <= 6) {
      const lamp = new THREE.PointLight(tint, 5, 7, 2);
      lamp.position.set(e.x, (e.y ?? 0) + h + 1, e.z); this.root.add(lamp);
    }
  }

  /** A wall's low edge (arpg-data.js wallEdge): its collider's footprint, knee-high, in the wall's own material. It is
   * drawn beside the wall, not in its group: the camera fades every mesh of the group it cuts away (world.js fadeTo),
   * and the edge is what stays to be seen. Only under the ARPG's camera. `round`: a pillar, whose edge is its own round
   * footprint and not the box around it. */
  edge(box, material, round = false) {
    if (!this.arpg) return;
    const at = wallEdge(box);
    if (!at) return;
    const edge = new THREE.Mesh(round ? new THREE.CylinderGeometry(at.width / 2, at.width / 2, at.height, 20)
      : new THREE.BoxGeometry(at.width, at.height, at.depth), material);
    if (round) edge.scale.z = at.depth / at.width; // (an oval pillar)
    edge.position.set(at.x, at.y, at.z); edge.receiveShadow = true; edge.name = 'wall-edge';
    this.root.add(edge);
  }

  groundAt(x, z, y = 0) {
    let floor = this.islands && !islandAt(this.islands, x, z) ? SKY.noFloor : 0;
    for (const { box: b } of this.walkable) if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= y + .32) floor = Math.max(floor, b.max.y);
    return floor;
  }
  /** What the camera fades instead of hiding the hero behind: every standing structure, and a dungeon's own walls. */
  occluders() {
    const list = [];
    for (const e of this.entities.values()) {
      if (['beacon', 'hazard'].includes(e.kind) || e.pickup) continue;
      const box = this.movers.find((m) => m.e.id === e.id)?.view ?? new THREE.Box3().setFromObject(e.group);
      list.push({ box, root: e.group, thin: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) < 3 });
    }
    for (const wall of this.shellWalls ?? []) list.push({ box: new THREE.Box3().setFromObject(wall), root: wall, thin: false });
    return list;
  }
  /** The highest platform whose (rotated) footprint holds (x, z), or null. Without jumping only a step-up top counts.
   * A collectible there sits on that top, but under a bridge (a platform the hero walks beneath) it keeps the floor:
   * only a platformer's climb (fallRespawn) seats it up there, as the server does. `bridges` counts them anyway (a coin
   * lifted onto one rides it). */
  platformUnder(x, z, bridges = false) {
    let best = null;
    for (const e of this.entities.values()) {
      if (e.kind !== 'platform') continue;
      const r = e.rotation ?? 0, dx = x - e.x, dz = z - e.z;
      const lx = dx * Math.cos(r) - dz * Math.sin(r), lz = dx * Math.sin(r) + dz * Math.cos(r);
      const top = (e.y ?? 0) + e.height;
      if (Math.abs(lx) > e.width / 2 || Math.abs(lz) > e.depth / 2 || (this.mechanics.jump === false && top > STEP_UP + .02)) continue;
      if (!bridges && !this.mechanics.fallRespawn && (e.y ?? 0) > HEADROOM) continue;
      if (!best || top > best.y + best.height) best = { ...e, y: e.y ?? 0 };
    }
    return best;
  }
  collide(p, radius) {
    for (const b of this.boxes) {
      // a walkable top within the step-up height is landed on (groundAt), not a wall to bounce off
      const ledge = this.walkable.some((w) => w.box === b) ? STEP_UP : .02;
      if (p.y >= b.max.y - ledge || p.y + HEADROOM < b.min.y) continue;
      const x = clamp(p.x, b.min.x, b.max.x), z = clamp(p.z, b.min.z, b.max.z);
      const dx = p.x - x, dz = p.z - z, distance = Math.hypot(dx, dz);
      if (distance >= radius) continue;
      if (distance > .0001) { p.x = x + dx / distance * radius; p.z = z + dz / distance * radius; }
      else {
        const options = [[b.min.x - radius - p.x, 0], [b.max.x + radius - p.x, 0], [0, b.min.z - radius - p.z], [0, b.max.z + radius - p.z]];
        const offset = options.reduce((a, b) => Math.hypot(...a) < Math.hypot(...b) ? a : b);
        p.x += offset[0]; p.z += offset[1];
      }
    }
  }

  /** Back at a checkpoint: where its stage began, with that run's score and growth; earlier stages stay done. */
  resume(cp) {
    this.player.pos.fromArray(cp.at); this.player.vel.set(0, 0, 0);
    this.actor.root.position.copy(this.player.pos);
    Object.assign(this, { score: cp.score, kills: cp.kills, collected: cp.collected });
    for (const stage of this.spec.mission.stages.slice(0, cp.stage)) for (const t of this.targets) {
      if (t.pickup && stage.type === 'reach' && stage.entityIds?.includes(t.id)) { t.taken = true; t.group.visible = false; }
    }
    this.arpg?.restore(cp.arpg);
    this.hp = this.maxHp;
  }

  activateStage() {
    if (this.director.index === this.stageSeen) return;
    this.stageSeen = this.director.index;
    const stage = this.director.stage;
    if (!stage) return;
    if (this.checkpoints) CHECKPOINTS.set(this.spec, { stage: this.director.index, at: this.player.pos.toArray(),
      score: this.score, kills: this.kills, collected: this.collected, arpg: this.arpg?.snapshot() });
    this.stageNotice = 2.5;
    this.talk = this.talkRead = null; // a talk belongs to its stage (updateTalk)
    this.hud.popup(stage.label, this.player.pos.clone().add(new THREE.Vector3(0, 2, 0)), 'pickup');
    if (stage.story) { this.hud.say({ speaker: stage.story.speaker, text: stage.story.text }); this.sayFor = 7; this.storyAt = this.elapsed; }
    for (const p of this.pickups) p.group.visible = !p.taken && (p.bonus || p.stage === stage.id);
    // Each enemy placement is instantiated once in its assigned combat stage.
    this.pendingSpawns = this.spec.world.enemySpawns.filter((p) => {
      const type = stage.type === 'boss' ? 'boss' : stage.type === 'kills' ? 'kills' : 'survive';
      return firstStageFor(this.spec, p, type)?.id === stage.id && !this.historySpawns.includes(`${stage.id}/${p.id}`);
    });
    if (this.arpg) this.pendingSpawns = this.pendingSpawns.flatMap((p) => [p, ...this.arpg.pack(p, stage.type === 'boss')]);
    this.spawnGrace = 1.2;
  }

  /** Where a placement's enemy appears: never within SPAWN_CLEARANCE of the hero (RESUME_CLEARANCE right after a
   * checkpoint resume), moved out along its bearing, inside the world and out of solid cover. */
  spawnPoint(placement) {
    const radius = this.elapsed < this.safeUntil ? RESUME_CLEARANCE : SPAWN_CLEARANCE;
    const { width, depth } = this.spec.world;
    const at = clearSpawn(placement, this.player.pos, radius,
      { minX: -width / 2 + 1, maxX: width / 2 - 1, minZ: -depth / 2 + 1, maxZ: depth / 2 - 1 });
    if (at.x === placement.x && at.z === placement.z) return at;
    if (this.islands && !islandAt(this.islands, at.x, at.z)) return { x: placement.x, z: placement.z }; // not into the air
    const p = new THREE.Vector3(at.x, 0, at.z);
    this.collide(p, .5);
    return { x: p.x, z: p.z };
  }

  async spawnEnemy(placement) {
    const data = this.spec.enemies[placement.enemyIndex];
    const stage = this.director.stage;
    const boss = stage?.type === 'boss' && !placement.minion && !placement.packMate;
    const champion = !boss && !!this.arpg?.isChampion(placement);
    // a flat cutout reads its tier by size too: a tougher template stands taller, pack mates a little smaller
    const flat = !data.modelUrl && !boss ? (.92 + .08 * data.hp) * (placement.packMate ? .9 : 1) : 1;
    // the ARPG's high camera flattens a 2.6 m boss into its cloak on the floor: it towers there
    const size = (boss ? (this.arpg ? 3.4 : 2.6) : data.humanoid ? 1.8 : 1.4) * (champion ? 1.25 : 1) * flat;
    const actor = await this.world.makeActor(data, size, () => drone(data.color), enemyClips(data, boss));
    if (this.ended) return;
    this.strictActor(actor, data, data.name ?? '적');
    if (stage !== this.director.stage && this.leaves(stage)) return; // its wave ended while it loaded: it never comes
    const at = this.spawnPoint(placement);
    const pos = new THREE.Vector3(at.x, 0, at.z);
    // arpg: combos and gear, not one-shot kills; a boss (and an elite) lasts against the hero's real damage per second,
    // so an auto-firing crossbow or a levelled knight cannot melt it before it reaches them
    const base = data.hp * (boss ? 8 : 1) * (this.arpg ? 3 : 1) * (champion ? 2.5 : 1);
    const dps = this.arpg ? this.arpg.dps : this.mechanics.weaponDamage / this.mechanics.fireIntervalSec;
    const maxHp = boss ? toughness(base, dps, this.arpg ? 10 : 15) : champion ? toughness(base, dps, 1.5) : base;
    this.dressEnemy(actor, data, { boss, champion });
    const enemy = { ...placement, actor, pos, hp: maxHp, maxHp, boss, champion, speed: (.9 + data.speed * .65) * (champion ? 1.15 : 1),
      humanoid: !!data.humanoid, phase: this.rnd() * 6, cooldown: 2, telegraph: 0, windup: .75, strikeT: 0, flash: 0 };
    actor.root.position.copy(pos); this.root.add(actor.root); this.enemies.push(enemy);
    this.world.particles.emit(pos.clone().setY(1), { color: data.color, count: 24, speed: 4, size: .2, life: .6 });
  }

  update(dt) {
    if (this.arpg) dt = this.arpg.frame(dt);
    if (this.phase === 'ready') {
      this.hud.notice('Enter · 임무 시작');
      this.world.rig.update(dt, this.player.pos, { look: { x: 0, y: 0 }, down: () => false, pad: null });
      // the hero is posed and turned by player.update, which runs only once the round is on: behind the briefing (and
      // on a broadcast's capture, which has no briefing card) it is animated here so it does not stand in its bind pose
      this.player.animate(dt, 0, this.world.rig);
      this.facePanels();
      this.weather?.update(dt, this.world.camera.position);
      if (!this.world.input.hit('Enter', 'Space') && !this.world.input.clicked && !this.world.input.pad?.a) return;
      this.begin();
    }
    this.elapsed += dt;
    this.stageNotice = Math.max(0, this.stageNotice - dt);
    this.hurtFor = Math.max(0, this.hurtFor - dt);
    this.sinceHurt += dt; this.fireIn -= dt;
    this.moveEntities(dt);
    this.player.update(dt, this.world.input, this.world.rig);
    this.updateCalm(dt);
    this.fallCheck(dt);
    if (this.torches) flicker(this.torches, this.elapsed);
    this.weather?.update(dt, this.world.camera.position);
    if (this.heroLight) this.heroLight.position.set(this.player.pos.x, this.player.pos.y + 4, this.player.pos.z);
    if (lavaMat) { lavaMat.map.offset.x = this.elapsed * .02; lavaMat.map.offset.y = this.elapsed * .013; }
    this.harbor?.update(this.elapsed);
    this.skyLayer?.update(this.elapsed);
    this.world.rig.update(dt, this.player.pos, this.world.input);
    this.facePanels();
    // the hit blink: the hero stays on screen two thirds of the time, and steadily for the second half of the i-frames
    this.actor.root.visible = this.hurtFor <= this.tune.iframes / 2 || Math.sin(this.elapsed * 40) > -.5;
    if (this.sinceHurt > 4) this.hp = Math.min(this.maxHp, this.hp + this.mechanics.regenPerSec * dt);
    const input = this.world.input;
    const nearest = this.nearestEnemy();
    const automatic = this.mechanics.autoFire && nearest && nearest.pos.distanceTo(this.player.pos) < 15;
    if (this.arpg) this.arpg.update(dt);
    else if (this.combatEnabled && (input.fireHeld || input.down('KeyF') || input.pad?.fire || automatic) && this.fireIn <= 0) {
      this.fireIn = fireInterval(this.mechanics, automatic);
      this.attack(automatic ? nearest : null);
    }
    this.surviveWaves(dt);
    this.spawnGrace -= dt;
    if (this.spawnGrace <= 0 && this.pendingSpawns?.length && !this.spawning) {
      const next = this.pendingSpawns.shift();
      this.historySpawns.push(`${this.director.stage.id}/${next.id}`);
      this.spawning = this.spawnEnemy(next).catch((error) => this.fail(error)).finally(() => { this.spawning = null; });
      this.spawnGrace = .35;
    }
    this.updateEnemies(dt);
    this.updateBossLight(dt);
    this.updateBolts(dt);
    this.updatePickups(dt);
    this.updateDying(dt);
    this.updateLeaving(dt);
    this.updateTargets(dt);
    for (const e of this.entities.values()) if (e.kind === 'hazard'
      && Math.abs(this.player.pos.x - e.group.position.x) < e.width / 2 && Math.abs(this.player.pos.z - e.group.position.z) < e.depth / 2
      && Math.abs(this.player.pos.y - e.group.position.y) < .6) this.hurt(12); // group: moving traps
    const completedStage = this.director.update(dt, {
      position: this.player.pos, targets: this.targets,
      // a talk counts once its person's lines are read (updateTalk), any other interaction while E is down
      interacting: this.director.stage?.type === 'talk' ? this.talkRead != null && this.talkRead === this.talkNear
        : input.down('KeyE') || input.hit('KeyE') || !!input.pad?.x,
      driving: this.driving(),
    });
    if (completedStage) this.completeStage(completedStage);
    if (this.hp <= 0 || (this.timeLimit > 0 && this.elapsed >= this.timeLimit)) this.end(false);
    this.refreshHud();
  }

  /** Enter: the run starts. Back at a checkpoint the hero blinks invulnerable for a moment and the stage's enemies
   * appear at a distance, so a restart never opens next to a blow already winding up. */
  begin() {
    this.phase = 'playing';
    const first = this.director.stage?.story; // the first beat waits for the briefing to close
    if (first) { this.hud.say({ speaker: first.speaker, text: first.text }); this.sayFor = 7; }
    // the first stage's enemies appear RESUME_CLEARANCE away and hold (updateCalm) until the story box closes, the
    // hero attacks or walks off, so a player reading the story is not ambushed. A wave keeps its clock (its horde
    // comes from afar anyway).
    this.storyAt = this.elapsed;
    this.calm = !!first && this.director.stage.type !== 'survive';
    this.calmFrom = this.player.pos.clone();
    this.safeUntil = Math.max(this.safeUntil, this.elapsed + RESUME_SAFE_SEC);
    if (!this.resumed) return;
    this.hurtFor = Math.max(this.hurtFor, RESUME_GRACE_SEC); // the hit blink shows it
    this.safeUntil = this.elapsed + RESUME_SAFE_SEC;
    this.hud.popup(`체크포인트 · ${this.director.index + 1}단계부터 다시 · 잠시 무적`, this.player.pos.clone().setY(this.player.pos.y + 2.6), 'kill');
    this.stageNotice = 3;
  }

  /** The stage story box closes on E or Enter (not on the Enter or click that started the mission); while the opening
   * one is up the first stage's enemies hold (begin), until it closes, the hero attacks or walks 4 m. */
  updateCalm() {
    const input = this.world.input, settled = this.elapsed - (this.storyAt ?? -Infinity) > .3;
    if (settled && this.sayFor > 0 && input.hit('KeyE', 'Enter')) { this.sayFor = 0; this.hud.say(null); }
    if (!this.calm) return;
    const attack = input.fireHeld || input.clicked || input.down('KeyF') || !!input.pad?.fire;
    if (this.sayFor <= 0 || (settled && attack) || this.player.pos.distanceTo(this.calmFrom) > 4) this.calm = false;
  }

  // the camera starts looking toward the first stage's goal (not at whatever wall stands behind the spawn)
  faceFirstGoal() {
    const stage = this.director.stage;
    if (!stage || this.arpg) return; // arpg keeps its fixed top-down angle
    const ids = stage.entityIds ?? [];
    const goal = this.targets.find((t) => !ids.length || ids.includes(t.id))
      ?? this.pickups.find((x) => x.stage === stage.id)?.group.position
      ?? this.spec.world.enemySpawns.find((e) => firstStageFor(this.spec, e, stage.type === 'boss' ? 'boss' : stage.type === 'kills' ? 'kills' : 'survive')?.id === stage.id);
    if (!goal) return;
    const p = this.player.pos;
    // a climb: the first step toward it, not the goal up out of reach. The top to step onto, not the point the step
    // is run up from: that point can be under the hero's feet, which gives no direction to look in
    const step = this.climbToward(goal);
    const onward = step?.next && step.left > 1 && (step.x !== goal.x || step.z !== goal.z); // (not a goal on this very top)
    const at = onward ? step.next : goal;
    if (Math.hypot(at.x - p.x, at.z - p.z) < 1) return;
    this.world.rig.yaw = Math.atan2(-(at.x - p.x), -(at.z - p.z));
    this.player.yaw = this.world.rig.yaw + Math.PI;
  }

  // survive: the stage's spawn points send a new wave every few seconds (rules.enemyRate), capped on screen
  surviveWaves(dt) {
    const stage = this.director.stage;
    if (stage?.type !== 'survive' || !this.spec.enemies.length || this.pendingSpawns?.length) return;
    this.waveIn = (this.waveIn ?? 6) - dt;
    if (this.waveIn > 0) return;
    const rate = this.spec.rules?.enemyRate ?? 1;
    this.waveIn = Math.max(2.5, 8 / rate - Math.min(4, this.director.elapsed / 30)); // denser as the clock runs
    this.wave = (this.wave ?? 0) + 1;
    const own = this.spec.world.enemySpawns.filter((p) => firstStageFor(this.spec, p, 'survive')?.id === stage.id);
    const p0 = this.player.pos;
    const points = (own.length ? own : this.spec.world.enemySpawns).slice() // the closest spawn points first
      .sort((a, b) => Math.hypot(a.x - p0.x, a.z - p0.z) - Math.hypot(b.x - p0.x, b.z - p0.z));
    const room = Math.max(0, (this.arpg ? 14 : 10) - this.enemies.length);
    this.pendingSpawns = points.slice(0, Math.min(room, 4)).map((p) => ({ ...p, id: `${p.id}~w${this.wave}` }));
  }

  // moving platforms and traps: the group and its colliders move together; a rider moves with them
  moveEntities(dt) {
    const p = this.player.pos;
    for (const m of this.movers) {
      const { axis, distance } = m.e.motion;
      const value = Math.sin(this.elapsed * 2 * Math.PI / m.period + m.phase) * distance / 2;
      const next = new THREE.Vector3(axis === 'x' ? value : 0, axis === 'y' ? Math.max(0, value + distance / 2) : 0, axis === 'z' ? value : 0)
        .applyAxisAngle(UP, axis === 'y' ? 0 : m.e.rotation ?? 0);
      const delta = next.clone().sub(m.offset);
      m.offset.copy(next);
      m.group.position.copy(m.base).add(next);
      const riding = this.player.grounded && m.boxes.some((b) => p.x >= b.min.x - .1 && p.x <= b.max.x + .1
        && p.z >= b.min.z - .1 && p.z <= b.max.z + .1 && Math.abs(p.y - b.max.y) < .12);
      for (const b of m.boxes) b.translate(delta);
      m.view.translate(delta);
      if (riding) p.add(delta);
      for (const item of this.pickups) if (item.rideId === m.e.id) item.group.position.add(delta);
      for (const t of this.targets) if (t.rideId === m.e.id) { t.group.position.add(delta); t.x = t.group.position.x; t.z = t.group.position.z; }
      const target = this.targets.find((t) => t.id === m.e.id);
      if (target) { target.x = m.group.position.x; target.z = m.group.position.z; }
    }
  }
  // platformer: touching the floor away from the start returns the player to the last platform stood on
  fallCheck(dt) {
    if (this.islands) return this.skyFall();
    if (!this.mechanics.fallRespawn) return;
    const p = this.player.pos;
    this.respawnGrace = Math.max(0, (this.respawnGrace ?? 0) - dt);
    if (!this.player.grounded) return;
    // standing on a platform: remember that platform (its centre, so a respawn never lands on an edge)
    const under = this.walkable.find(({ box: b }) => p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z
      && Math.abs(p.y - b.max.y) < .06);
    if (under) { this.safeBox = under.box; return; }
    if (p.y > .05) return;
    // on the floor: only a fall from a real height counts; the low first steps are simply walked back to
    if (this.respawnGrace > 0) return; // keep the platform: a second fall right after a respawn still returns
    const b = this.safeBox;
    this.safeBox = null;
    if (!b || b.max.y < .4) return;
    p.set((b.min.x + b.max.x) / 2, b.max.y + .05, (b.min.z + b.max.z) / 2);
    this.player.vel.set(0, 0, 0);
    this.safeBox = b; this.respawnGrace = 1;
    this.hp = Math.max(1, this.hp - 5); this.world.rig.shake(.2);
    this.hud.popup('추락! 마지막 발판에서 다시', p.clone().setY(p.y + 2), 'kill');
    this.fallTip();
  }
  /** A round's first fall says how to jump, with the keys this game has (Shift only where it sprints). */
  fallTip() {
    if (this.jumpTip || this.mechanics.jump === false) return;
    this.jumpTip = true;
    this.tip(`가장자리에서 Space로 점프해요${this.mechanics.sprint === false ? '' : ' · Shift로 달리면 더 멀리 뛰어요'}`);
  }
  /** A one-shot tip in the notice pill, up for `sec` seconds of the round. refreshHud shows it over the stage's label:
   * a hud.notice() written inside update() would be overwritten by refreshHud() at the end of the same update(). */
  tip(text, sec = 4, big = false) { this.tipText = text; this.tipUntil = this.elapsed + sec; this.tipBig = big; }
  get tipUp() { return this.elapsed < this.tipUntil; }

  /** Sky: off the islands the hero falls. Below SKY.fallY they are put back on the middle of the last top stood on (a
   * platform, else the ground island, else the start island). */
  skyFall() {
    const p = this.player.pos;
    if (this.player.grounded) {
      const under = this.walkable.find(({ box: b }) => p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z
        && Math.abs(p.y - b.max.y) < .06);
      const isle = !under && Math.abs(p.y) < .06 ? islandAt(this.islands, p.x, p.z) : null;
      if (under || isle) this.safe = under ? { box: under.box } : { isle };
      return;
    }
    if (p.y > SKY.fallY) return;
    const { box: b, isle } = this.safe ?? { isle: this.islands[0] };
    if (b) p.set((b.min.x + b.max.x) / 2, b.max.y + .05, (b.min.z + b.max.z) / 2);
    else p.set(isle.x, .05, isle.z);
    this.player.vel.set(0, 0, 0);
    this.skyFalls = (this.skyFalls ?? 0) + 1;
    this.hp = Math.max(1, this.hp - 5); this.world.rig.shake(.2);
    this.hud.popup('추락! 마지막 발판에서 다시', p.clone().setY(p.y + 2), 'kill');
    this.fallTip();
  }

  driving() { return true; } // city mode: only while in a car (race checkpoints)

  completeStage(done) {
    this.world.flash(this.player.pos.clone().setY(1), this.accent, 22, 9);
    if (this.director.completed) return this.end(true);
    if (this.leaves(done)) this.withdraw(done);
    this.activateStage();
  }
  /** Whether the enemies still on the field leave when `stage` completes: a wave's horde once its clock runs out, a
   * fallen boss's minions, leftover guards. An ARPG pack keeps fighting after its leaders fall (its kills are XP). */
  leaves(stage) {
    return stage?.type === 'survive' || stage?.type === 'boss' || (stage?.type === 'kills' && !this.arpg);
  }
  /** The field clears for the next stage (the supply run between waves): attacks stop, bolts in the air fizzle out
   * and the enemies run off (updateLeaving). A city's street patrols (city.js) are not part of that fight: they keep
   * their beat. */
  withdraw(stage) {
    const going = this.enemies.filter((e) => !e.patrol);
    if (!going.length) return;
    for (const e of going) {
      e.telegraph = 0; e.leaveFor = 0;
      if (e.warnRing) e.warnRing.visible = false;
      this.hud.float(e, null);
    }
    this.leaving.push(...going);
    this.enemies = this.enemies.filter((e) => e.patrol);
    for (const b of this.enemyBolts) { this.root.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
    this.enemyBolts = [];
    this.hud.popup(stage.type === 'survive' ? '웨이브 종료 · 남은 적이 물러난다' : '남은 적이 달아난다',
      this.player.pos.clone().setY(this.player.pos.y + 3.2), 'kill');
  }
  updateLeaving(dt) {
    for (const e of this.leaving) {
      e.leaveFor += dt;
      const away = e.pos.clone().sub(this.player.pos).setY(0);
      if (away.lengthSq() < 1e-6) away.set(1, 0, 0);
      const next = e.pos.clone().addScaledVector(away.normalize(), e.speed * 1.5 * dt);
      this.collide(next, .5);
      e.pos.copy(next); e.actor.root.position.copy(e.pos);
      e.actor.root.rotation.y = e.actor.billboard ? this.world.rig.yaw : Math.atan2(away.x, away.z);
      e.actor.animator?.update(dt, { speed: e.speed * 1.5 });
      const fade = clamp((e.leaveFor - LEAVE_SEC * .4) / (LEAVE_SEC * .6), 0, 1);
      e.actor.root.scale.setScalar(1 - fade * .85);
      if (fade < 1) continue;
      this.root.remove(e.actor.root); e.gone = true;
      releaseDrawn(e.actor.root); // (a rigged one's bone texture: it is not under the root when the round is disposed)
      this.world.particles.emit(e.pos.clone().setY(.8), { color: this.spec.enemies[e.enemyIndex]?.color ?? '#888888', count: 10, speed: 2, size: .2, life: .5 });
    }
    this.leaving = this.leaving.filter((e) => !e.gone);
  }

  fail(error) {
    this.failure = String(error.message ?? error);
    this.hud.notice(this.failure);
    this.end(false);
  }
  nearestEnemy() {
    return this.enemies.reduce((a, e) => !a || e.pos.distanceTo(this.player.pos) < a.pos.distanceTo(this.player.pos) ? e : a, null);
  }
  attack(automaticTarget) {
    if (!this.combatEnabled) return;
    const weapon = this.actor.weapon;
    const melee = weapon?.type === 'melee';
    this.actor.animator?.play(melee ? 'attack_melee' : 'attack_gun', { parts: 'upper', fadeIn: .05 });
    if (melee) {
      const forward = this.world.rig.forward();
      for (const e of [...this.enemies]) {
        const delta = e.pos.clone().sub(this.player.pos).setY(0);
        if (delta.length() < 3.4 && delta.normalize().dot(forward) > .1) this.hitEnemy(e, this.mechanics.weaponDamage);
      }
      const at = this.player.pos.clone().add(new THREE.Vector3(0, 1, 0));
      this.world.particles.emit(at, { count: 18, color: this.accent, speed: 6, size: .2, life: .2, dir: forward, spread: .6 });
    } else {
      const origin = weapon ? weapon.muzzle.getWorldPosition(new THREE.Vector3()) : this.player.pos.clone().add(new THREE.Vector3(0, 1.1, 0));
      const target = automaticTarget ?? this.assisted(origin);
      const direction = target ? this.leadAt(target, origin) : this.world.rig.forward().clone();
      const bolt = new THREE.Mesh(new THREE.CapsuleGeometry(.045, .42, 2, 6), new THREE.MeshBasicMaterial({ color: this.accent.clone().multiplyScalar(4), toneMapped: false }));
      bolt.position.copy(origin); bolt.quaternion.setFromUnitVectors(UP, direction);
      this.root.add(bolt);
      this.bolts.push({ mesh: bolt, velocity: direction.multiplyScalar(BOLT_SPEED), life: 1.4, damage: this.mechanics.weaponDamage });
      this.world.flash(origin, this.accent, 12, 4);
    }
    this.world.rig.shake(.08);
  }

  /** Aim assist for a shot the player fires: the enemy nearest the crosshair line (arpg-data.js assistTarget) that a
   * bolt can reach, or null (the bolt then flies straight down the crosshair). */
  assisted(origin) {
    const e = this.enemies[assistTarget(this.player.pos, this.world.rig.yaw, this.enemies.map((x) => ({ x: x.pos.x, z: x.pos.z, boss: x.boss })))];
    return e && !this.blocked(origin, e.pos.clone().setY(1)) ? e : null;
  }
  /** The direction from `origin` that meets enemy `e` at chest height, leading it by its pace over the bolt's flight. */
  leadAt(e, origin) {
    const aim = e.pos.clone().setY(1);
    if (e.vel) aim.addScaledVector(e.vel, origin.distanceTo(aim) / BOLT_SPEED);
    return aim.sub(origin).normalize();
  }

  updateEnemies(dt) {
    // only a few enemies wind up at the same time (the rest keep closing in); a boss never waits for a slot
    const slots = attackSlots(this.spec.difficulty, !!this.arpg);
    let winding = this.enemies.reduce((n, e) => n + (e.telegraph > 0 && !e.boss ? 1 : 0), 0);
    for (const e of this.enemies) {
      const delta = this.player.pos.clone().sub(e.pos).setY(0);
      const distance = delta.length(), direction = delta.normalize();
      if (this.calm && !e.patrol) { // the opening story is up (updateCalm): they stand their ground, facing the hero
        e.phase += dt;
        e.actor.root.rotation.y = e.actor.billboard ? this.world.rig.yaw : Math.atan2(direction.x, direction.z);
        e.actor.animator?.update(dt, { speed: 0 });
        continue;
      }
      e.cooldown -= dt; e.phase += dt;
      // survive: the horde hunts the player wherever they are; elsewhere enemies guard their area. A boss always
      // hunts and closes in faster on a hero who keeps away; anyone winding up plants their feet.
      const chase = this.director.stage?.type === 'survive' || e.boss ? Infinity : 32;
      const pace = e.speed * (e.boss ? 1 + clamp((distance - 7) / 6, 0, 1.4) : 1) * (e.telegraph > 0 ? .35 : 1);
      const move = distance > (this.arpg ? 1.6 : e.boss ? 2.6 : 2.1) && distance < chase ? pace : 0;
      let next = e.pos.clone().addScaledVector(direction, move * dt);
      this.collide(next, .5);
      if (move > 0 && next.distanceTo(e.pos) < move * dt * .4) { // pinned on cover: slide along it instead
        e.side ??= this.rnd() < .5 ? 1 : -1;
        const around = e.pos.clone().addScaledVector(new THREE.Vector3(-direction.z * e.side, 0, direction.x * e.side), move * dt);
        this.collide(around, .5);
        if (around.distanceTo(e.pos) < move * dt * .3) e.side = -e.side; else next = around;
      }
      if (this.islands && this.groundAt(next.x, next.z) < 0) next.copy(e.pos); // sky: enemies stop at the island edge
      e.vel = (e.vel ?? new THREE.Vector3()).copy(next).sub(e.pos).divideScalar(Math.max(dt, 1e-3));
      e.pos.copy(next);
      e.actor.root.position.copy(e.pos);
      e.actor.root.rotation.y = Math.atan2(direction.x, direction.z);
      if (e.actor.billboard) { e.actor.root.rotation.y = this.world.rig.yaw; this.poseBillboard(e, dt, move, direction); }
      else if (e.actor.animator) e.actor.animator.update(dt, { speed: move });
      else animateBody(e.actor, dt, { speed01: move / 4, phase: e.phase * 5, squash: e.telegraph > 0 ? .12 : 0 });
      if (!e.humanoid && !e.actor.animator && !e.actor.billboard) e.actor.body.position.y = .25 + Math.sin(e.phase * 2) * .12;
      if (e.actor.aura) e.actor.aura.scale.setScalar(1 + .07 * Math.sin(e.phase * 3));
      if (e.telegraph > 0) {
        e.telegraph -= dt;
        if (e.telegraph <= 0) {
          // the blow by tier and stage against the hero's HP (arpg-data.js enemyHit); a step out of reach dodges it
          const blow = { tier: e.boss ? 'boss' : e.champion ? 'champion' : 'regular', stage: this.director.index,
            maxHp: this.maxHp, difficulty: this.spec.difficulty, enraged: !!e.enraged };
          if (distance < (e.boss ? BOSS_REACH : 3)) this.hurt(enemyHit(blow), e.pos);
          else if (!this.arpg || e.boss) this.enemyShoot(e, direction, enemyHit({ ...blow, ranged: true })); // arpg: a horde fights hand to hand
          e.cooldown = 2.1; e.strikeT = 1;
        }
      } else if (e.cooldown <= 0 && distance < (this.arpg && !e.boss ? 2.8 : 17) && (e.boss || winding < slots)) {
        e.telegraph = e.windup = e.boss ? 1 : .75; // a boss's heavier blow shows a longer warning
        if (!e.boss) winding += 1;
        e.actor.animator?.play('attack_melee', { parts: 'upper' });
        this.world.particles.emit(e.pos.clone().setY(1.6), { count: 6, color: '#ff526c', speed: 1, size: .18, life: .65 });
      }
      this.warn(e, e.telegraph > 0 ? 1 - e.telegraph / e.windup : 0);
      const line = e.boss ? `${e.enraged ? '격노한 ' : ''}${this.spec.enemies[e.enemyIndex].name} · ${Math.ceil(e.hp)}/${e.maxHp}`
        : e.champion ? `정예 · ${this.spec.enemies[e.enemyIndex].name}` : null;
      this.hud.float(e, line, e.pos.clone().setY(e.boss ? 3.2 : 2.3), 'tag');
    }
  }
  /** The boss's key light: in front of it on the camera's side, head-high, so its face, crown and ribs read instead of a
   * dark cloak (a crypt is lit only by the wall torches and the hero's own light). Off when no boss is up. */
  updateBossLight(dt) {
    if (!this.bossLight) return;
    const boss = this.enemies.find((e) => e.boss);
    this.bossLight.intensity = damp(this.bossLight.intensity, boss ? 28 : 0, 4, dt);
    if (!boss) return;
    const yaw = this.world.rig.yaw;
    this.bossLight.position.set(boss.pos.x + Math.sin(yaw) * 1.8, (boss.actor.height ?? 2.6) * 1.3, boss.pos.z + Math.cos(yaw) * 1.8);
  }
  /** An energy bolt: big and slow enough to see coming and side-step. */
  enemyShoot(enemy, direction, damage) {
    const origin = enemy.pos.clone().setY(1.1);
    if (this.blocked(origin, this.player.pos.clone().setY(1))) return;
    const bolt = new THREE.Mesh(new THREE.SphereGeometry(.16, 10, 8), GLOW('#ff4668', 3));
    bolt.position.copy(origin); this.root.add(bolt);
    this.enemyBolts.push({ mesh: bolt, velocity: direction.clone().multiplyScalar(9.5), life: 2.8, damage });
  }
  /** The wind-up warning under an attacker: a red ring that tightens as the blow comes (a boss shows its full reach). */
  warn(e, t) {
    if (!e.warnRing && t <= 0) return;
    if (!e.warnRing) {
      e.warnRing = new THREE.Mesh(new THREE.RingGeometry(.8, 1, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#ff3b2f', transparent: true, depthWrite: false, toneMapped: false }));
      e.warnRing.position.y = .06; e.warnRing.renderOrder = 2; e.actor.root.add(e.warnRing);
    }
    e.warnRing.visible = t > 0;
    e.warnRing.scale.setScalar((e.boss ? 3.6 : 1.3) * (1.35 - .35 * t));
    e.warnRing.material.opacity = .25 + .6 * t;
  }
  /** Tiers at a glance: elites blue and bosses ember (tinted cutouts, aura rings), every cutout on a ground shadow. */
  dressEnemy(actor, data, { boss, champion }) {
    if (champion) actor.root.add(this.ring(1.2, new THREE.Color('#5fa8ff')));
    if (boss) actor.root.add(actor.aura = this.ring(2.1, new THREE.Color('#ff4a2f')));
    const plane = actor.billboard;
    if (!plane) return;
    const m = plane.material;
    m.color.lerp(new THREE.Color(boss ? '#ffb199' : champion ? '#a9ccff' : data.color), boss || champion ? .35 : .22);
    if (boss || champion) { m.emissive.set(boss ? '#ff7a55' : '#7fb2ff'); m.emissiveIntensity = .38; }
    actor.glow = m.emissiveIntensity;
    const w = plane.geometry.parameters.width, r = clamp(w * .3, .45, 1.8);
    // a figure cut off at the thighs (world.js CUT_SINK) rises out of a dark pool as wide as it is, not a floating torso
    actor.root.add(actor.cut ? groundShadow(clamp(w * .62, .6, 2.6), clamp(w * .42, .45, 1.8), true) : groundShadow(r, r * .65));
  }
  /** Cutout set pieces turn to the camera around their upright axis, like the cutout actors. */
  facePanels() {
    for (const p of this.panels ?? []) p.panel.rotation.y = this.world.rig.yaw - p.group.rotation.y;
  }
  /** A cutout enemy's walk, wind-up, lunge and hit flash (arpg-data.js billboardPose) in its camera-facing plane. */
  poseBillboard(e, dt, move, toHero) {
    const a = e.actor, h = a.height;
    e.strikeT = Math.max(0, e.strikeT - dt / STRIKE_SEC);
    e.flash = Math.max(0, e.flash - dt / .18);
    const pose = billboardPose({ time: e.phase, speed: move, windup: e.telegraph > 0 ? 1 - e.telegraph / e.windup : 0,
      strike: e.strikeT > 0 ? 1 - e.strikeT : 0, hit: e.flash });
    const side = toHero.dot(this.world.rig.right()) < 0 ? -1 : 1; // the hero's side of the screen
    a.body.position.y = pose.lift * h + (e.humanoid ? 0 : .25 + Math.sin(e.phase * 2) * .12);
    // leaning back towards a high camera (half its pitch, from the feet) keeps the figure from flattening into a strip
    a.body.rotation.set(-clamp(this.world.rig.pitch * .55, 0, .55), 0, -side * pose.tilt);
    a.body.scale.set(1 + pose.squash * .5, 1 - pose.squash, 1);
    a.root.position.addScaledVector(toHero, pose.lunge * h * .5);
    a.billboard.material.emissiveIntensity = a.glow * (e.boss ? .85 + .15 * Math.sin(e.phase * 3) : 1) + pose.flash * 1.2;
  }
  blocked(from, to) {
    const direction = to.clone().sub(from), length = direction.length();
    const ray = new THREE.Ray(from, direction.normalize());
    return this.boxes.some((b) => { const hit = ray.intersectBox(b, new THREE.Vector3()); return hit && hit.distanceTo(from) < length; });
  }
  updateBolts(dt) {
    for (const b of this.bolts) {
      const before = b.mesh.position.clone();
      b.mesh.position.addScaledVector(b.velocity, dt); b.life -= dt;
      const direction = b.mesh.position.clone().sub(before), length = direction.length();
      const ray = new THREE.Ray(before, direction.normalize());
      let nearest = length, victim = null, blocked = false;
      for (const box of this.boxes) {
        const point = ray.intersectBox(box, new THREE.Vector3());
        if (point && point.distanceTo(before) < nearest) { nearest = point.distanceTo(before); blocked = true; }
      }
      for (const e of this.enemies) {
        const center = e.pos.clone().setY(1);
        const point = ray.closestPointToPoint(center, new THREE.Vector3());
        const distance = point.distanceTo(before);
        if (distance <= nearest && point.distanceTo(center) < (e.boss ? 1.1 : .7)) {
          nearest = distance; victim = e; blocked = false;
        }
      }
      if (victim) { this.hitEnemy(victim, b.damage); b.life = 0; }
      else if (blocked) b.life = 0;
    }
    for (const b of this.enemyBolts) {
      const before = b.mesh.position.clone();
      b.mesh.position.addScaledVector(b.velocity, dt); b.life -= dt;
      if (this.blocked(before, b.mesh.position)) b.life = 0;
      if (b.mesh.position.distanceTo(this.player.pos.clone().setY(1)) < .7) {
        this.hurt(b.damage, { x: before.x - b.velocity.x, z: before.z - b.velocity.z }); // (from back along its flight)
        b.life = 0;
      }
    }
    for (const list of [this.bolts, this.enemyBolts]) for (const b of list) if (b.life <= 0) { this.root.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
    this.bolts = this.bolts.filter((b) => b.life > 0);
    this.enemyBolts = this.enemyBolts.filter((b) => b.life > 0);
  }
  // A hit interrupts a regular enemy's wind-up; elites shrug off light hits (a heavy blow staggers them) and a boss
  // finishes every attack, so steady or automatic fire does not mean no attacks at all.
  hitEnemy(e, damage, crit = false, stagger = false) {
    e.hp -= damage; e.flash = 1;
    if (!(e.boss || e.champion) || (stagger && !e.boss)) { e.telegraph = 0; e.cooldown = Math.max(e.cooldown, .8); }
    this.world.particles.emit(e.pos.clone().setY(1), { count: 12, color: this.spec.enemies[e.enemyIndex].color, speed: 4, size: .22, life: .3 });
    this.hud.popup(crit ? `치명타 −${damage}` : `−${damage}`, e.pos.clone().setY(crit ? 2.4 : 2), 'kill');
    e.actor.animator?.play('hit', { parts: 'full' });
    if (e.boss && !e.enraged && e.hp > 0 && e.hp <= e.maxHp / 2) this.enrage(e);
    if (e.hp > 0) return;
    if (e.warnRing) e.warnRing.visible = false;
    this.enemies = this.enemies.filter((enemy) => enemy !== e); this.kills += 1; this.score += e.boss ? 500 : 100;
    this.director.record({ type: e.boss ? 'boss' : 'kills', entityId: e.id, enemyIndex: e.enemyIndex });
    this.hud.float(e, null); e.deadFor = 0; e.deathLength = e.actor.animator?.die() ?? 0;
    this.arpg?.onKill(e);
    this.dying.push(e);
  }
  /** The boss's second phase: faster, attacks sooner, and calls two minions (other enemy types when there are any). */
  enrage(e) {
    e.enraged = true; e.speed *= 1.4; e.cooldown = Math.min(e.cooldown, .6);
    this.world.flash(e.pos.clone().setY(1.5), '#b44dff', 40, 14); this.world.rig.shake(.4);
    this.hud.popup('격노!', e.pos.clone().setY(3.4), 'kill');
    const others = this.spec.enemies.map((_, i) => i).filter((i) => i !== e.enemyIndex);
    (this.pendingSpawns ??= []).push(...[0, 1].map((k) => ({ id: `${e.id}~rage${k}`, minion: true,
      enemyIndex: others.length ? others[k % others.length] : e.enemyIndex,
      x: e.pos.x + (k ? 3 : -3), z: e.pos.z + 2 })));
  }
  updateDying(dt) {
    for (const e of this.dying) {
      e.deadFor += dt; e.actor.animator?.update(dt, { speed: 0 });
      const fade = clamp((e.deadFor - e.deathLength) / .6, 0, 1);
      e.actor.root.scale.setScalar(1 - fade * .75);
      if (fade === 1) { this.root.remove(e.actor.root); e.gone = true; releaseDrawn(e.actor.root); }
    }
    this.dying = this.dying.filter((e) => !e.gone);
  }
  /** `from`: where the blow came from ({x, z}), when it has a side. The picture's rim then reddens on that side only
   * (world.js hurtFrom), a wedge toward the attacker. The side is the bearing from the hero turned by where the camera
   * looks, as the goal arrow's: ahead is the top of the picture, behind (out of sight) the bottom. */
  hurt(damage, from = null) {
    if (this.hurtFor > 0 || this.player.invulnerableFromDash || this.shieldFor > 0) return;
    if (this.arpg) damage = this.arpg.mitigate(damage);
    this.hp = Math.max(0, this.hp - damage); this.hurtFor = this.tune.iframes; this.sinceHurt = 0;
    this.world.hurt = .9; this.world.rig.shake(.25);
    const bearing = from ? Math.atan2(from.x - this.player.pos.x, -(from.z - this.player.pos.z)) + this.world.rig.yaw : 0;
    this.world.hurtFrom = from ? { x: Math.sin(bearing), y: Math.cos(bearing) } : null;
  }
  updatePickups(dt) {
    const stage = this.director.stage;
    this.shieldFor = Math.max(0, (this.shieldFor ?? 0) - dt);
    for (const p of this.pickups) {
      if (p.taken || !(p.bonus || p.stage === stage?.id)) continue;
      p.phase += dt; p.visual.position.y = .7 + Math.sin(p.phase * 2) * .12;
      p.visual.rotation.y = p.kind === 'billboard' ? this.world.rig.yaw : p.phase * .8;
      const d = p.group.position.distanceTo(this.player.pos);
      // a stage's targets are always named; a bonus pickup once the hero is near (not a field of tags)
      this.hud.float(p, p.bonus && d > 14 ? null : this.spec.props[p.propIndex].name,
        p.group.position.clone().add(new THREE.Vector3(0, 1.8, 0)), 'tag');
      if (d > 1.35) continue;
      const prop = this.spec.props[p.propIndex];
      if (p.bonus) {
        if (prop.effect === 'heal' && this.hp >= this.maxHp) continue; // a spare potion waits until it is needed
      } else if (!this.director.record({ type: 'collect', entityId: p.id, propIndex: p.propIndex })) continue;
      p.taken = true; this.collected += 1;
      this.root.remove(p.group); this.hud.float(p, null);
      this.applyEffect(prop, p.group.position);
      this.world.particles.emit(p.group.position.clone().setY(1), { count: 32, color: this.accent, speed: 4, size: .25, life: .65 });
    }
  }
  /** What a talk stage's person says: the game's dialogue, each line under its own speaker (else the person's name).
   * In a mission with several talk stages a person says the lines that name them, and the first of them also those
   * that name none of the others. A game without dialogue: the stage's own sentence. → [{speaker, text}] */
  talkLines(stage, target) {
    const name = target.name ?? this.npc?.name ?? 'NPC', all = this.spec.dialogue ?? [];
    const talks = this.spec.mission.stages.filter((s) => s.type === 'talk');
    const others = talks.filter((s) => s !== stage).flatMap((s) => this.targets.filter((t) => !s.entityIds?.length || s.entityIds.includes(t.id)))
      .filter((t) => t.id !== target.id && t.name).map((t) => t.name);
    const says = (who, line) => !!line.speaker && (who.includes(line.speaker) || line.speaker.includes(who));
    const lines = talks.length < 2 ? all
      : all.filter((line) => says(name, line) || (talks[0] === stage && !others.some((who) => says(who, line))));
    return lines.length ? lines.map((line) => ({ speaker: line.speaker || name, text: line.text })) : [{ speaker: name, text: stage.label }];
  }
  /** A talk stage: E (or Enter) by its person opens the dialogue, each press passes a line, and the stage counts once
   * the last one is passed (`talkRead`, which update() hands the director as its interaction). E held down passes a
   * line every TALK_HOLD_SEC (the built-in player holds E at its target). Walking off closes the box unread. */
  updateTalk(dt, stage) {
    const input = this.world.input, p = this.player.pos;
    const near = stage?.type === 'talk' ? this.targets.find((t) => (!stage.entityIds?.length || stage.entityIds.includes(t.id))
      && Math.hypot(t.x - p.x, t.z - p.z) < t.radius) : null;
    this.talkNear = near?.id ?? null;
    if (this.talk && this.talk.id !== this.talkNear) { this.talk = null; this.hud.say(null); }
    if (!near) return;
    const press = input.hit('KeyE', 'Enter'), held = input.down('KeyE') || !!input.pad?.x;
    if (!this.talk) {
      if ((!press && !held) || this.talkRead === near.id) return;
      this.talk = { id: near.id, lines: this.talkLines(stage, near), index: 0, heldFor: 0 };
      this.sayFor = 0; // the dialogue has no timer: a line stays until it is passed
      this.hud.say(this.talk.lines[0]);
      return;
    }
    this.talk.heldFor = held ? this.talk.heldFor + dt : 0;
    if (!press && this.talk.heldFor < TALK_HOLD_SEC) return;
    this.talk.heldFor = 0;
    this.talk.index += 1;
    if (this.talk.index < this.talk.lines.length) { this.hud.say(this.talk.lines[this.talk.index]); return; }
    this.talk = null; this.talkRead = near.id;
    this.hud.say(null);
  }

  updateTargets(dt) {
    const stage = this.director.stage;
    this.updateTalk(dt, stage);
    for (const target of this.targets) {
      target.core?.rotateY(dt);
      if (target.pickup) {
        const live = !target.taken && stage?.type === 'reach' && (!stage.entityIds?.length || stage.entityIds.includes(target.id));
        target.group.visible = !target.taken;
        target.group.rotation.y += dt * 2.4;
        if (live && Math.hypot(target.x - this.player.pos.x, target.z - this.player.pos.z) < target.radius
          && Math.abs(this.player.pos.y - target.group.position.y) < 2.2) {
          target.taken = true; target.group.visible = false; this.collected += 1; this.score += 50;
          this.world.particles.emit(new THREE.Vector3(target.x, this.player.pos.y + 1, target.z), { count: 26, color: '#ffd34d', speed: 4, size: .22, life: .5 });
        }
        continue;
      }
      const active = stage && ['reach', 'interact', 'talk'].includes(stage.type)
        && (!stage.entityIds?.length || stage.entityIds.includes(target.id));
      const e = this.entities.get(target.id);
      const at = new THREE.Vector3(target.x, (e?.y ?? 0) + 2.1, target.z);
      this.hud.float(target, active ? (e?.label ?? target.name ?? stage.label) : null, at, 'tag');
      if (active && ['interact', 'talk'].includes(stage.type) && !this.talk
        && Math.hypot(target.x - this.player.pos.x, target.z - this.player.pos.z) < target.radius) {
        this.hud.float('authored-prompt', `E · ${stage.label}`, at.clone().setY(at.y - .8), 'prompt');
      }
    }
    this.pointToGoal(stage);
    const hasPrompt = stage && ['interact', 'talk'].includes(stage.type) && !this.talk && this.targets.some((t) =>
      (!stage.entityIds?.length || stage.entityIds.includes(t.id)) && Math.hypot(t.x - this.player.pos.x, t.z - this.player.pos.z) < t.radius);
    if (!hasPrompt) this.hud.float('authored-prompt', null);
    if (this.sayFor > 0) { this.sayFor -= dt; if (this.sayFor <= 0) this.hud.say(null); }
  }

  /** What the goal arrow names for the stage → { list: the places ({x, z}) it may point at (the nearest is taken),
   * reach: the metres from one within which it hides, word: what the place is, for its label ('' for a spot) }. */
  arrowGoal(stage) {
    // a race: the gate the director waits for next, in race order (the finish after the last gate), not the nearest
    // one, which is the gate just passed for half of every leg. It hides from where a gate counts as passed (mission.js,
    // which runs after this), so the frame that passes a gate never shows it, nor is the finish left on the end screen
    const gate = stage?.type === 'race' && this.targets.find((t) => t.id === stage.entityIds[this.director.raceNext]);
    if (gate) return { list: [gate], reach: Math.max(gate.radius ?? 0, 7), passing: true, word: '' };
    // a kills or boss stage: the enemies that count for it (not a pack mate, a minion or another stage's), once none of
    // them is near enough to be in the fight, so there is something to follow to the ones left far off
    if (['kills', 'boss'].includes(stage?.type)) {
      const counted = (this.enemies ?? []).filter((e) => this.director.matches({ type: e.boss ? 'boss' : 'kills', entityId: e.id, enemyIndex: e.enemyIndex }));
      return { list: counted.map((e) => e.pos), reach: FIGHT_NEAR, word: stage.type === 'boss' ? '보스 ' : '적 ' };
    }
    // a collect stage: the nearest of its pickups still on the map
    const list = stage?.type === 'collect'
      ? (this.pickups ?? []).filter((x) => !x.taken && x.stage === stage.id).map((x) => ({ x: x.group.position.x, z: x.group.position.z }))
      : stage && ['reach', 'interact', 'talk'].includes(stage.type)
        ? this.targets.filter((t) => !t.taken && (!stage.entityIds?.length || stage.entityIds.includes(t.id))) : [];
    return { list, reach: 6, word: '' };
  }

  /** The arrow's way on foot when the straight walk to the nearest of its goals is blocked: which of the goals is the
   * nearest to walk to, where that way first turns out of sight (the door of the room, the corner of the wall) and its
   * metres → { goal, turn: {x, z} (null once the goal itself is in sight), left }, or null: the nearest goal is in plain
   * sight, no way leads to any, or this is no walk on a floor (a car's road, a sky's or a platformer's climb).
   * The way is found on the walk grid the built-in player uses, twice a second (arpg-data.js navNearest), and is kept
   * apart from the built-in player's own plan (navToward: its goal, and what its watchdog counts). */
  arrowWay(near, list) {
    if (!this.boxes?.length || !this.ownCamera || this.islands || this.mechanics.fallRespawn) return null;
    const p = this.player.pos;
    this.nav ??= navGrid(this.navRects(), this.spec.world, { radius: this.navRadius ?? .55 });
    if (navClear(this.nav, p, near)) { this.arrowPlan = null; return null; }
    // (a goal that is gone, a felled enemy, is not walked to for the rest of the half second; a pickup's place is
    // listed anew every frame, so it is known by where it is)
    const plan = this.arrowPlan, still = (g) => g === plan.goal || (g.x === plan.goal.x && g.z === plan.goal.z);
    if (!plan || this.elapsed - plan.at > .5 || (plan.goal && !list.some(still))) {
      const found = navNearest(this.nav, p, list);
      this.arrowPlan = { goal: found ? list[found.index] : null, path: found?.path ?? null, at: this.elapsed };
    }
    const { goal, path } = this.arrowPlan;
    if (!path) return null;
    if (navClear(this.nav, p, goal)) return { goal, turn: null, left: Math.hypot(goal.x - p.x, goal.z - p.z) };
    while (path.length > 1 && Math.hypot(path[0].x - p.x, path[0].z - p.z) < this.nav.cell * .8) path.shift();
    let k = 0; // the last point of the way still in sight: straight to it, then along the way
    while (k + 1 < path.length && navClear(this.nav, p, path[k + 1])) k += 1;
    let left = Math.hypot(path[k].x - p.x, path[k].z - p.z);
    for (let n = k + 1; n < path.length; n++) left += Math.hypot(path[n].x - path[n - 1].x, path[n].z - path[n - 1].z);
    return { goal, turn: path[k], left };
  }

  pointToGoal(stage) {
    const { list, reach, passing, word } = this.arrowGoal(stage);
    const p = this.player.pos;
    const near = list.reduce((a, t) => !a || Math.hypot(t.x - p.x, t.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? t : a, null);
    if (!this.goalArrow) {
      this.goalArrow = document.createElement('div');
      this.goalArrow.className = 'goal-arrow';
      this.goalArrow.setAttribute('aria-hidden', 'true');
      this.goalArrow.style.cssText = 'position:absolute;left:50%;top:50%;width:0;height:0;z-index:11;pointer-events:none';
      this.goalArrow.innerHTML = '<div style="position:absolute;transform:translate(-50%,-50%);font:700 13px system-ui;color:#fff;text-shadow:0 1px 3px #000;white-space:nowrap"></div>';
      document.getElementById('stage').append(this.goalArrow);
    }
    // behind a wall: the arrow names the way round to the goal nearest on foot (arrowWay), and the metres are the
    // walk's, also for what counts as at hand (an enemy 10 m off through a wall is not in the fight)
    const way = near && this.phase === 'playing' ? this.arrowWay(near, list) : null;
    const goal = way?.goal ?? near, toward = way?.turn ?? goal;
    const d = goal ? way?.left ?? Math.hypot(goal.x - p.x, goal.z - p.z) : 0;
    this.goalArrow.hidden = !goal || (passing ? d <= reach : d < reach) || this.phase !== 'playing';
    if (this.goalArrow.hidden) return;
    // its bearing relative to where the camera looks (yaw 0 faces -Z)
    const bearing = Math.atan2(toward.x - p.x, -(toward.z - p.z)) + this.world.rig.yaw;
    const r = Math.min(innerWidth, innerHeight) * .32, midX = innerWidth / 2, midY = innerHeight / 2;
    const label = this.goalArrow.firstChild;
    // on its circle round the screen's middle, but never on the story box or the notice pill while they show
    const at = clearOf(midX + Math.sin(bearing) * r, midY - Math.cos(bearing) * r, ['say', 'notice'].map(shownBox).filter(Boolean), midY);
    label.style.left = `${at.x - midX}px`; label.style.top = `${at.y - midY}px`;
    label.textContent = `➤ ${word}${Math.round(d)}m`;
  }

  refreshHud() {
    const m = this.director.snapshot();
    const timer = this.timeLimit ? ` · ${Math.ceil(Math.max(0, this.timeLimit - this.elapsed))}초` : '';
    if (this.ended && this.failure) this.hud.objective(this.failure); // a loss is not the mission's success text
    // a cleared mission has no stage left to count: the success text stands alone
    else if (m.completed) this.hud.objective(m.label);
    else this.hud.objective(`${Math.min(m.stageIndex + 1, this.spec.mission.stages.length)}/${this.spec.mission.stages.length} · ${m.label} (${Math.min(Math.floor(m.progress), m.target)}/${m.target})${timer}`);
    // no score until the game scores, as the end card (endSummary) and a version-1 game's HUD (rpg.js)
    this.hud.status(this.score ? `점수 ${this.score}` : '');
    // only the gauges this game uses: no health where nothing hurts, no dash without one or at the wheel, a crosshair
    // only where the hero shoots along it
    this.hud.health(this.harmless ? null : this.hp / this.maxHp, this.shieldFor ?? 0);
    this.hud.dash(this.mechanics.dash && !this.activeCar ? 1 - this.player.dashCooldown / .9 : null);
    this.hud.crosshair(this.spec.genre.startsWith('sf-') && !this.arpg && this.combatEnabled && !this.activeCar);
    this.arpg?.refreshHud();
    if (this.phase === 'playing') this.hud.notice(this.failure ?? (this.tipUp ? this.tipText : this.stageNotice > 0 ? m.label : ''), this.tipUp && this.tipBig);
  }
  end(won) {
    if (this.ended) return;
    this.ended = true; this.phase = won ? 'won' : 'lost';
    if (won) CHECKPOINTS.delete(this.spec); // a cleared mission starts over from its first stage
    // refreshHud writes the notice only while the round is played, so it is cleared here: over the end screen the pill
    // says why the round was lost when there is a reason (fail, a race lost on place, the built-in player's watchdog
    // and cap in runtime3d.js), and nothing else
    this.hud.notice(won ? '' : this.failure ?? '');
    if (this.goalArrow) this.goalArrow.hidden = true; // (it is drawn over the end card: a death left "➤ 11m" on it)
    this.hud.float('authored-prompt', null); this.hud.end(won);
  }
  /** What the end screen says of this round (runtime3d.js hud.end, arpg-data.js endCard) →
   * { reason: the mission's success text, or on a loss the cause the mode knows (a failure text comes before it),
   *   result: its numbers (a race: its place and time; else the score, once there is one, and the round's time, and on
   *   a loss how far the mission got), resumeStage: the stage 다시 시작 goes on from (a checkpoint; 0: the mission's
   *   start; asked while the round is played too, for the pause card) } */
  endSummary(won) {
    const m = this.director.snapshot(), stages = this.spec.mission.stages.length;
    const reason = won ? m.label : this.hp <= 0 ? '체력이 다했어요.'
      : this.timeLimit > 0 && this.elapsed >= this.timeLimit ? '제한 시간이 끝났어요.' : null;
    const reached = !won && stages > 1 ? [`${stages}단계 중 ${Math.min(m.stageIndex + 1, stages)}단계`] : [];
    // a score of 0 is no result (as rpg.js): a game with nothing to score shows the time only
    const numbers = this.raceSummary?.() ?? [...(this.score ? [`점수 ${this.score}`] : []), clock(this.elapsed)];
    return { reason, result: [...reached, ...numbers],
      resumeStage: !won && this.checkpoints ? CHECKPOINTS.get(this.spec)?.stage ?? 0 : 0 };
  }
  idle(dt) {
    this.world.rig.update(dt, this.player.pos, { look: { x: 0, y: 0 }, down: () => false, pad: null });
    // the hero is still ticked once the round is over, so it eases into idle behind the end screen and does not stand
    // frozen mid-stride
    this.player.animate(dt, 0, this.world.rig);
    this.facePanels();
    this.weather?.update(dt, this.world.camera.position); // it keeps raining behind the end screen
    this.updateDying(dt);
    this.updateLeaving(dt);
  }
  debugState() {
    return { version: 2, genre: this.spec.genre, phase: this.phase, ended: this.ended, hp: +this.hp.toFixed(1), maxHp: this.maxHp,
      resumedAt: this.resumed?.stage ?? null,
      player: this.player.pos.toArray().map((n) => +n.toFixed(2)), kills: this.kills, collected: this.collected,
      mission: this.director.snapshot(), entities: [...this.entities.values()].map((e) => ({ id: e.id, kind: e.kind, x: e.x, z: e.z, solid: e.solid })),
      pickups: this.pickups.map((p) => ({ id: p.id, stage: p.stage, taken: p.taken, visible: p.group.visible, propIndex: p.propIndex,
        position: p.group.position.toArray().map((n) => +n.toFixed(2)) })),
      enemies: this.enemies.map((e) => ({ id: e.id, enemyIndex: e.enemyIndex, hp: e.hp, maxHp: e.maxHp, boss: e.boss,
        champion: e.champion, position: e.pos.toArray(), windup: +Math.max(0, e.telegraph).toFixed(2) })),
      // what a player sees coming: wind-up rings above, energy bolts here, and the hero's hit blink
      enemyBolts: this.enemyBolts.map((b) => ({ position: b.mesh.position.toArray(), velocity: b.velocity.toArray() })),
      leaving: this.leaving.length,
      iframes: +this.hurtFor.toFixed(2),
      mechanics: { ...this.mechanics }, actorKind: this.actor.kind, rigDropped: !!this.actor.rigDropped,
      bodyScale: this.actor.body.scale.toArray().map((n) => +n.toFixed(3)),
      bodyPose: [this.actor.body.position.y, ...this.actor.body.rotation.toArray().slice(0, 3)].map((n) => +n.toFixed(3)),
      sky: this.islands ? { islands: this.islands.length, falls: this.skyFalls ?? 0, next: this.climbNext?.id ?? null, jump: !!this.autoJump } : null, grounded: this.player.grounded, playerIpId: this.spec.player.ipId,
      propIpIds: this.spec.props.map((p) => p.ipId), pendingSpawns: this.pendingSpawns?.length ?? 0,
      background: this.background?.result ?? null,
      failure: this.failure ?? null, projectiles: this.bolts.length };
  }
  debugTeleport(x, z, y) { this.player.place(x, z); if (y != null) this.player.pos.y = y; }
  debugFaceNearest() {
    const e = this.nearestEnemy();
    if (!e) return false;
    const d = e.pos.clone().sub(this.player.pos);
    this.world.rig.yaw = Math.atan2(-d.x, -d.z); return true;
  }

  // ---- the built-in player (?autoplay=1): runtime3d.js and arpg.js drive it with these ----

  /** The stage's goal when it is not a fight: the nearest pickup to collect, or the target to reach / talk to.
   * `autoInteract` tells the bot to hold E there. → THREE.Vector3 or null */
  autoGoal() {
    const stage = this.director.stage, p = this.player.pos;
    this.autoInteract = ['talk', 'interact'].includes(stage?.type);
    const near = (list) => list.reduce((a, b) => !a || b.distanceTo(p) < a.distanceTo(p) ? b : a, null);
    if (stage?.type === 'collect') return near(this.pickups.filter((x) => !x.taken && x.stage === stage.id).map((x) => x.group.position));
    if (['kills', 'boss'].includes(stage?.type)) { // walk up to a far enemy (around the walls), fight a near one
      const e = this.nearestEnemy();
      return e && e.pos.distanceTo(p) > FIGHT_NEAR ? e.pos : null;
    }
    if (!['reach', 'talk', 'interact'].includes(stage?.type)) return null;
    return near(this.targets.filter((t) => !t.taken && (!stage.entityIds?.length || stage.entityIds.includes(t.id)))
      .map((t) => new THREE.Vector3(t.x, 0, t.z)));
  }
  /** Whether the built-in player should back away now: a boss is winding up a blow within two metres of its reach.
   * The camera is turned to face that boss, so S walks straight away from it (the fight's camera faces the nearest
   * enemy, which may be a minion beside the hero). The wind-up lasts a second and the hero walks 6 m/s: the blow lands
   * on nothing and the boss sends a bolt instead, three quarters of the blow. Only a boss's blow: a horde's are small
   * and many. */
  autoDodge() {
    const p = this.player.pos;
    const boss = this.enemies.find((e) => e.boss && e.telegraph > 0 && e.pos.distanceTo(p) < BOSS_REACH + 2);
    if (!boss) return false;
    this.world.rig.yaw = Math.atan2(-(boss.pos.x - p.x), -(boss.pos.z - p.z));
    return true;
  }
  /** The next point on a way around the walls to `goal` (a straight line when it is clear). → {x, z, left} with `left`
   * the metres still to walk. The grid is built once a round from the blocking boxes at body height. */
  navToward(goal) {
    const p = this.player.pos;
    this.nav ??= navGrid(this.navRects(), this.spec.world, { radius: this.navRadius ?? .55 });
    // a new goal (the next pickup, the car, then the address) starts its own closest-yet; only a new closest counts
    if (!this.navFor || Math.hypot(goal.x - this.navFor.x, goal.z - this.navFor.z) > 4) { this.navFor = { x: goal.x, z: goal.z }; this.navBest = Infinity; }
    const moved = !this.navGoal || Math.hypot(goal.x - this.navGoal.x, goal.z - this.navGoal.z) > 1.5;
    const age = this.elapsed - (this.navAt ?? -Infinity);
    let path = null;
    if (navClear(this.nav, p, goal)) this.navPath = null; // in plain sight: straight there
    else {
      if (!this.navPath || age > 1 || (moved && age > .3)) { // replanned at most ~3 times a second
        this.navPath = navPath(this.nav, p, goal); this.navGoal = { x: goal.x, z: goal.z }; this.navAt = this.elapsed;
      }
      path = this.navPath;
      while (path && path.length > 1 && Math.hypot(path[0].x - p.x, path[0].z - p.z) < this.nav.cell * .8) path.shift();
    }
    path ??= [{ x: goal.x, z: goal.z }];
    const next = this.unstickTo && this.elapsed < this.unstickUntil ? this.unstickTo : navNext(this.nav, p, path);
    let left = Math.hypot(path[0].x - p.x, path[0].z - p.z);
    for (let n = 1; n < path.length; n++) left += Math.hypot(path[n].x - path[n - 1].x, path[n].z - path[n - 1].z);
    if (left < this.navBest - 1) { if (this.navBest < Infinity) this.navGain = (this.navGain ?? 0) + 1; this.navBest = left; }
    return { x: next.x, z: next.z, left };
  }
  navRects() {
    const rects = this.boxes.filter((b) => b.max.y > STEP_UP + .05 && b.min.y < HEADROOM)
      .map((b) => ({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z }));
    for (const cell of this.spatial?.cells?.values() ?? []) rects.push(...cell); // the city's buildings
    return rects;
  }
  /** The grounds a climb starts from: a sky world's islands; a platformer's floor, the whole of it (its platforms stand
   * on it); null where the way is a walk. */
  get climbGrounds() {
    if (this.islands || !this.mechanics.fallRespawn) return this.islands;
    return this.floorIsle ??= [{ id: 'floor', x: 0, z: 0, width: this.spec.world.width, depth: this.spec.world.depth }];
  }
  /** A climb toward `goal` (sky.js climbStep): from the top the hero stands on (or last stood on, while in the air),
   * with the platforms where they are now. Null where the way is a walk: off the sky and a platformer, with no climb
   * there, or down on a platformer's floor (its walls are walked round: navToward). A step up beside the hero may be
   * as high as the hero really gets (canStep's reach). A step that is not there at this moment (a moving platform out
   * of reach) is waited for where the hero stands. */
  climbToward(goal) {
    const grounds = this.climbGrounds;
    if (!grounds) return null;
    const platforms = [...this.entities.values()].filter((e) => e.kind === 'platform')
      .map((e) => ({ ...e, x: e.group?.position.x ?? e.x, z: e.group?.position.z ?? e.z }));
    const nodes = climbNodes(grounds, platforms), p = this.player.pos;
    const under = this.player.grounded ? nodeAt(nodes, p.x, p.z, p.y) : null;
    if (under) this.climbFrom = under.id;
    const from = under ?? nodes.find((n) => n.id === this.climbFrom) ?? nodeAt(nodes, p.x, p.z, p.y);
    const step = climbStep(nodes, p, goal, from, this.climbState ??= {}, this.player.vel, jumpApex(this.mechanics) + STEP_UP - .1);
    if (!this.islands && (step ? step.next.id === 'floor' : from?.id === 'floor')) return null;
    if (!step && under && this.climbNext && this.movers?.length) return { x: p.x, z: p.z, left: this.climbBest ?? 0, jump: false, stop: true, next: this.climbNext };
    return step;
  }
  /** Face the next point toward `at` (the controller walks camera-relative). → metres still to walk. In the sky the
   * way is the climb, and `autoJump` tells the built-in player to jump at the edge. */
  debugFacePoint(at) {
    const climb = this.climbToward(at);
    this.autoJump = !!climb?.jump && this.player.grounded;
    this.autoStop = !!climb?.stop; // not running square at the edge yet: brake, then run up again
    this.autoClimb = !!climb; // no side-stepping around walls on a climb: it steps off the island
    if (climb) {
      const p = this.player.pos;
      if (Math.hypot(climb.x - p.x, climb.z - p.z) > 1e-3) this.world.rig.yaw = Math.atan2(-(climb.x - p.x), -(climb.z - p.z)); // (not while it waits where it stands)
      // the first reading after a start or an unstick (climbBest Infinity) is no gain, as on the floor above: counted, it
      // would tell the watchdog that a stalled climb had moved
      if (climb.left < (this.climbBest ?? Infinity) - 1) { if ((this.climbBest ?? Infinity) < Infinity) this.navGain = (this.navGain ?? 0) + 1; this.climbBest = climb.left; }
      if (climb.next !== this.climbNext) { this.climbNext = climb.next; this.climbBest = climb.left; } // a new step
      return climb.left;
    }
    const next = this.navToward(at), p = this.player.pos;
    this.world.rig.yaw = Math.atan2(-(next.x - p.x), -(next.z - p.z));
    return next.left;
  }
  /** What the watchdog watches: the stage, its count, kills, pickups, the damage dealt so far, the closest the hero
   * has come to its goal (each new closest by 1 m) and the line a talk is at. It stays the same only while the round
   * is stuck. */
  progressKey() {
    const m = this.director.snapshot();
    const hp = this.enemies.reduce((n, e) => n + e.hp, 0);
    return `${m.stageIndex}|${Math.floor(m.progress)}|${this.kills}|${this.collected}|${Math.round(hp)}|${this.navGain ?? 0}|${this.talk?.index ?? ''}`;
  }
  /** The watchdog's unstick: walk a few seconds to a random open spot nearby, then plan afresh. */
  autoUnstick() {
    if (this.climbGrounds) { this.climbBest = Infinity; return; } // a random walk on a climb walks off its island
    const p = this.player.pos;
    for (let n = 0; n < 20 && this.nav; n++) {
      const a = this.rnd() * Math.PI * 2, r = 3 + this.rnd() * 5;
      const to = { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
      if (navClear(this.nav, p, to)) { this.unstickTo = to; this.unstickUntil = this.elapsed + 3; break; }
    }
    this.navPath = null;
  }
  dispose() {
    this.arpg?.dispose();
    this.background?.dispose();
    this.skyLayer?.dispose();
    this.world.rig.occluders = []; // this round's meshes are about to be disposed
    disposeBiome(this.biome, this.world);
    if (this.weather) { this.world.scene.remove(this.weather.object); this.weather.dispose(); }
    this.world.scene.remove(this.root);
    this.root.remove(this.actor.root);
    disposeTree(this.root);
    this.envTarget?.dispose();
    this.floorTex?.dispose();
    this.world.particles.clear(); this.hud.say(null);
    this.hud.float('authored-prompt', null);
    this.goalArrow?.remove();
    for (const target of [...this.pickups, ...this.targets, ...this.enemies, ...this.leaving]) this.hud.float(target, null);
  }
}

let lavaMat = null;
/** One shared lava surface: a molten canvas texture that drifts (see AuthoredMode.update). */
function lavaMaterial() {
  if (lavaMat) return lavaMat;
  const tex = canvasTexture(256, (ctx, size) => {
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#ff3d00'); g.addColorStop(.5, '#ffb000'); g.addColorStop(1, '#ff4a00');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(30,8,0,${.25 + Math.random() * .45})`;
      ctx.beginPath(); ctx.ellipse(Math.random() * size, Math.random() * size, 4 + Math.random() * 18, 2 + Math.random() * 9, Math.random() * 3, 0, Math.PI * 2); ctx.fill();
    }
  }, { repeat: 3 });
  lavaMat = new THREE.MeshStandardMaterial({ map: tex, emissive: '#ff5a10', emissiveMap: tex, emissiveIntensity: 1.8, roughness: .6 });
  return lavaMat;
}

/** A soft dark ellipse on the floor (rx × rz half-sizes) that seats a flat cutout on the ground; `pool`: the deep, ragged
 * one a cut-off figure rises out of. */
function groundShadow(rx, rz, pool = false) {
  shadowTexture ??= Object.assign(canvasTexture(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(0,0,0,.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  }), { userData: { shared: true } });
  poolTexture ??= pool ? Object.assign(canvasTexture(128, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(6,4,8,.92)'); g.addColorStop(.5, 'rgba(6,4,8,.78)'); g.addColorStop(1, 'rgba(6,4,8,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    const rnd = mulberry32(5);
    for (let i = 0; i < 26; i++) { // smoky lobes break the rim (and stay inside the square: no edge on the floor)
      const a = rnd() * Math.PI * 2, d = s * (.24 + rnd() * .1), r = s * (.05 + rnd() * .07);
      const lobe = ctx.createRadialGradient(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, 0, s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, r);
      lobe.addColorStop(0, 'rgba(6,4,8,.55)'); lobe.addColorStop(1, 'rgba(6,4,8,0)');
      ctx.fillStyle = lobe; ctx.fillRect(0, 0, s, s);
    }
  }), { userData: { shared: true } }) : null;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(rx * 2, rz * 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: pool ? poolTexture : shadowTexture, transparent: true, depthWrite: false }));
  shadow.position.y = .03;
  return shadow;
}

/** How far a biome wall's tint fades to white (its real surface shows through): a grey or brown stays the photo's own
 * stone (0.9), a painted colour (a teal or magenta container) keeps its paint (0.2). */
export function paint(tint) {
  const hsl = tint.getHSL({ h: 0, s: 0, l: 0 });
  return hsl.s > .4 && hsl.l > .12 && hsl.l < .85 ? .2 : .9;
}

function gem(hex) {
  const group = new THREE.Group();
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(.3), GLOW(hex, 1.5));
  crystal.position.y = .35; group.add(crystal); return group;
}
function guide(accent) {
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(.45, .7, .2, 20), new THREE.MeshStandardMaterial({ color: '#27303d', metalness: .5, roughness: .4 }));
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(.42, 1), GLOW(accent, .8));
  core.position.y = 1; group.add(base, core); return group;
}
function drone(hex) {
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: '#283245', metalness: .7, roughness: .32 });
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(.6, 1), shell);
  body.scale.set(1.2, .6, 1); body.position.y = .9;
  const eye = new THREE.Mesh(new THREE.BoxGeometry(.7, .1, .08), GLOW(hex, 2));
  eye.position.set(0, .92, .52);
  group.add(body, eye);
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new RoundedBoxGeometry(.65, .12, .45, 2, .04), shell);
    wing.position.set(side * .8, .9, 0); group.add(wing);
  }
  return group;
}
