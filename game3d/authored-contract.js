// Explicit v2 authored-world contract. Invalid instructions cannot fall back to a fixed v1 game.
import { validateCity } from './city-contract.js';
import { validateBackground } from './background-data.js';
export const ENTITY_KINDS = ['box', 'cylinder', 'spire', 'arch', 'tree', 'crystal', 'building', 'platform', 'beacon', 'hazard', 'model'];
export const BIOMES = ['forest', 'desert', 'snow', 'ruins', 'industrial', 'volcanic', 'night-city', 'crypt', 'temple'];
export const SETTINGS = ['harbor', 'sky']; // server/authored_contract.py SETTINGS
export const STAGE_TYPES = ['collect', 'kills', 'reach', 'interact', 'survive', 'boss', 'talk', 'drive', 'race'];
const MOVING_KINDS = ['platform', 'hazard', 'box', 'model'];
const PICKUP_KINDS = ['model', 'crystal'];
const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const number = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const integer = (v, lo, hi) => Number.isInteger(v) && number(v, lo, hi);
const hex = (v) => typeof v === 'string' && /^#[a-f\d]{6}$/i.test(v);
const id = (v) => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(v);

export function validateAuthoredSpec(input) {
  const errors = [];
  const need = (ok, text) => { if (!ok) errors.push(text); };
  if (!object(input)) return { ok: false, errors: ['spec must be an object'] };
  const spec = structuredClone(input);
  need(spec.version === 2, 'authored version must be 2');
  need(spec.engine === 'three', 'version 2 engine must be three');
  const world = spec.world;
  if (!object(world)) return { ok: false, errors: [...errors, 'version 2 world is required'] };
  const city = world.city != null, track = world.track != null;
  const [lo, hi] = city ? [300, 1200] : track ? [200, 800] : spec.mechanics?.style === 'arpg' ? [36, 160] : [36, 100];
  need(!(city && track), 'world.track and world.city cannot be combined');
  need(!track || (object(world.track) && (world.track.roadWidth == null || number(world.track.roadWidth, 8, 24))), 'world.track.roadWidth must be 8-24');
  need(number(world.width, lo, hi), `world.width must be ${lo}-${hi} meters`);
  need(number(world.depth, lo, hi), `world.depth must be ${lo}-${hi} meters`);
  need(hex(world.groundColor), 'world.groundColor must be #rrggbb');
  validateBackground(world.background, need);
  const point = (p, prefix) => {
    need(object(p) && number(p.x, -world.width / 2 + 1, world.width / 2 - 1)
      && number(p.z, -world.depth / 2 + 1, world.depth / 2 - 1), `${prefix} must be inside world bounds`);
  };
  point(world.spawn, 'world.spawn');
  const ids = new Set();
  const unique = (v, field) => {
    need(id(v) && !ids.has(v), `${field}.id must be a unique identifier`);
    ids.add(v);
  };
  for (const [key, maximum] of [['entities', 72], ['propPlacements', 24], ['enemySpawns', 16]]) {
    need(Array.isArray(world[key]) && world[key].length <= maximum, `world.${key} must be an array of at most ${maximum}`);
    if (!Array.isArray(world[key])) world[key] = [];
  }
  world.entities.forEach((e, i) => {
    const field = `world.entities[${i}]`;
    if (!object(e)) return need(false, `${field} must be an object`);
    unique(e.id, field); point(e, field);
    need(ENTITY_KINDS.includes(e.kind), `${field}.kind is unsupported`);
    for (const [key, lo, hi] of [['width', .3, 20], ['depth', .3, 20], ['height', .1, 18], ['y', 0, 8], ['rotation', -Math.PI, Math.PI]]) {
      need(e[key] == null || number(e[key], lo, hi), `${field}.${key} is outside its supported range`);
    }
    for (const key of ['color', 'emissive']) need(e[key] == null || hex(e[key]), `${field}.${key} must be #rrggbb`);
    need(e.solid == null || typeof e.solid === 'boolean', `${field}.solid must be boolean`);
    need(e.label == null || (typeof e.label === 'string' && [...e.label].length <= 100), `${field}.label must be at most 100 characters`);
    if (e.kind === 'model') {
      need(typeof e.ipId === 'string' && /^ip_[A-Za-z0-9_-]{1,64}$/.test(e.ipId), `${field}.ipId must name a prop IP`);
      // its 3D model, or without one its cutout standing as a panel (authored.js); a race car body needs the model
      const glb = typeof e.modelUrl === 'string' && /^assets\/ip_[A-Za-z0-9_-]{1,64}\.set\.glb$/.test(e.modelUrl);
      const cutout = e.modelUrl == null && e.car == null && e.spriteUrl === `assets/${e.ipId}.png`;
      need(glb || cutout, `${field}.modelUrl must be the server-resolved set-piece GLB (or spriteUrl its cutout)`);
    }
    if (e.motion != null) {
      need(MOVING_KINDS.includes(e.kind) && object(e.motion) && ['x', 'y', 'z'].includes(e.motion.axis)
        && number(e.motion.distance, .5, 12) && (e.motion.periodSec == null || number(e.motion.periodSec, 1, 12)),
      `${field}.motion must be {axis x|y|z, distance 0.5-12, periodSec 1-12} on a platform, hazard, box or model`);
    }
    need(e.pickup == null || (e.pickup === true && PICKUP_KINDS.includes(e.kind)), `${field}.pickup is only for model or crystal`);
    need(e.car == null || (e.kind === 'model' && ['player', 'rival'].includes(e.car)), `${field}.car is player|rival on a model`);
  });
  for (const [key, assetKey, indexKey] of [['propPlacements', 'props', 'propIndex'], ['enemySpawns', 'enemies', 'enemyIndex']]) {
    world[key].forEach((p, i) => {
      const field = `world.${key}[${i}]`;
      if (!object(p)) return need(false, `${field} must be an object`);
      unique(p.id, field); point(p, field);
      need(integer(p[indexKey], 0, (spec[assetKey]?.length ?? 0) - 1), `${field}.${indexKey} must reference a selected ${assetKey} entry`);
      need(p.stageId == null || id(p.stageId), `${field}.stageId must be an identifier`);
    });
  }
  if (world.npc != null) {
    if (!object(world.npc)) need(false, 'world.npc must be an object');
    else {
      unique(world.npc.id, 'world.npc'); point(world.npc, 'world.npc');
      need(world.npc.propIndex == null || integer(world.npc.propIndex, 0, (spec.props?.length ?? 0) - 1), 'world.npc.propIndex must reference selected props');
      need(world.npc.name == null || (typeof world.npc.name === 'string' && [...world.npc.name].length <= 100), 'world.npc.name must be at most 100 characters');
    }
  }
  if (city) validateCity(spec, { need, point, unique });
  const mission = spec.mission;
  if (!object(mission) || !Array.isArray(mission.stages) || !integer(mission.stages.length, 1, 8)) {
    need(false, 'mission.stages must have 1-8 stages');
  } else {
    const stages = new Set();
    mission.stages.forEach((s, i) => {
      const field = `mission.stages[${i}]`;
      if (!object(s)) return need(false, `${field} must be an object`);
      need(id(s.id) && !stages.has(s.id), `${field}.id must be unique`); stages.add(s.id);
      need(STAGE_TYPES.includes(s.type), `${field}.type is unsupported`);
      if (s.type === 'drive') {
        need(city && s.target === 1 && number(s.distanceMeters, 20, 1500), `${field} drive requires a city and distanceMeters 20-1500`);
        need(s.holdSec == null && s.propIndex == null && s.enemyIndex == null, `${field} drive cannot include holdSec or role indices`);
        need(Array.isArray(s.entityIds) && s.entityIds.length === 1
          && world.city?.vehicles?.some((v) => v.id === s.entityIds[0]), `${field} drive must reference one vehicle`);
      } else need(s.distanceMeters == null, `${field}.distanceMeters is only for drive`);
      if (s.type === 'race') {
        need((city || track) && integer(s.target, 1, 5), `${field} race requires a city or a track and a lap count 1-5`);
        need(Array.isArray(s.entityIds) && s.entityIds.length >= 3 && s.entityIds.length <= 16
          && s.entityIds.every((ref) => world.entities.some((e) => e.id === ref && e.kind === 'beacon')), `${field} race needs 3-16 ordered checkpoint beacons`);
        need(s.rivals == null || integer(s.rivals, 0, 5), `${field}.rivals must be 0-5`);
        need(s.vehicleId == null || world.city?.vehicles?.some((v) => v.id === s.vehicleId), `${field}.vehicleId must name a city vehicle`);
        need(s.finishRank == null || integer(s.finishRank, 1, 6), `${field}.finishRank must be 1-6`);
      } else need(s.rivals == null && s.vehicleId == null && s.finishRank == null, `${field}.rivals/vehicleId/finishRank are only for race`);
      need(s.vehicle == null || (s.vehicle === true && city && ['reach', 'interact'].includes(s.type)), `${field}.vehicle is only for city reach/interact`);
      need(typeof s.label === 'string' && [...s.label].length > 0 && [...s.label].length <= 100, `${field}.label must be text`);
      need(integer(s.target, 1, s.type === 'survive' ? 200 : 24), `${field}.target is outside its supported range`);
      need(s.holdSec == null || number(s.holdSec, 0, 15), `${field}.holdSec must be 0-15`);
      need(s.story == null || (object(s.story) && typeof s.story.speaker === 'string' && typeof s.story.text === 'string'
        && [...s.story.speaker].length <= 40 && [...s.story.text].length <= 200), `${field}.story must be {speaker ≤40, text ≤200}`);
      if (s.entityIds != null) {
        need(Array.isArray(s.entityIds) && s.entityIds.length > 0 && new Set(s.entityIds).size === s.entityIds.length
          && s.entityIds.every((ref) => ids.has(ref)), `${field}.entityIds must reference unique world targets`);
      }
      need(s.propIndex == null || integer(s.propIndex, 0, (spec.props?.length ?? 0) - 1), `${field}.propIndex must reference selected props`);
      need(s.enemyIndex == null || integer(s.enemyIndex, 0, (spec.enemies?.length ?? 0) - 1), `${field}.enemyIndex must reference selected enemies`);
    });
    for (const p of [...world.propPlacements, ...world.enemySpawns]) need(p.stageId == null || stages.has(p.stageId), 'world target stageId must reference a mission stage');
    mission.stages.forEach((s, i) => {
      if (!object(s)) return;
      const matching = (p) => (!s.entityIds?.length || s.entityIds.includes(p.id))
        && (!p.stageId || p.stageId === s.id);
      if (s.type === 'collect') {
        const count = world.propPlacements.filter((p) => matching(p) && (s.propIndex == null || p.propIndex === s.propIndex)).length;
        need(count >= s.target, `mission.stages[${i}] collect target exceeds matching prop placements`);
      }
      if (['kills', 'boss'].includes(s.type)) {
        const count = world.enemySpawns.filter((p) => matching(p) && (s.enemyIndex == null || p.enemyIndex === s.enemyIndex)).length;
        need(count >= s.target, `mission.stages[${i}] combat target exceeds matching enemy spawns`);
      }
      if (['reach', 'interact', 'talk'].includes(s.type)) {
        const targets = [...world.entities.filter((e) => e.kind === 'beacon' || e.pickup === true), ...(world.npc ? [world.npc] : []),
          ...(world.city?.pedestrians ?? [])].filter(matching);
        need(targets.length >= s.target, `mission.stages[${i}] has too few beacon/NPC targets`);
      }
    });
  }
  if (object(mission)) {
    need(mission.title == null || (typeof mission.title === 'string' && [...mission.title].length <= 100), 'mission.title must be at most 100 characters');
    need(mission.successText == null || (typeof mission.successText === 'string' && [...mission.successText].length <= 200), 'mission.successText must be at most 200 characters');
  }
  if (spec.mechanics != null) {
    const m = spec.mechanics;
    if (!object(m)) need(false, 'mechanics must be an object');
    else {
      for (const key of ['dash', 'jump', 'sprint', 'autoFire', 'fallRespawn']) need(m[key] == null || typeof m[key] === 'boolean', `mechanics.${key} must be boolean`);
      need(m.style == null || ['action', 'arpg'].includes(m.style), 'mechanics.style must be action|arpg');
      for (const [key, lo, hi] of [['regenPerSec', 0, 15], ['weaponDamage', 1, 5], ['fireIntervalSec', .08, 2], ['interactRadius', 1, 4]]) {
        need(m[key] == null || number(m[key], lo, hi), `mechanics.${key} is outside its supported range`);
      }
    }
  }
  if (spec.artDirection != null) {
    if (!object(spec.artDirection)) need(false, 'artDirection must be an object');
    else {
      for (const key of ['skyColor', 'fogColor']) need(spec.artDirection[key] == null || hex(spec.artDirection[key]), `artDirection.${key} must be #rrggbb`);
      need(spec.artDirection.biome == null || BIOMES.includes(spec.artDirection.biome), 'artDirection.biome is unsupported');
      need(spec.artDirection.timeOfDay == null || ['day', 'dusk', 'night'].includes(spec.artDirection.timeOfDay), 'artDirection.timeOfDay is unsupported');
      need(spec.artDirection.weather == null || ['clear', 'rain', 'snow'].includes(spec.artDirection.weather), 'artDirection.weather is unsupported');
      // server/gamespec.py apply_setting: a harbor's water, quay, cranes and container stacks past one edge (biome.js
      // harborPlan); sky islands over a cloud sea, no floor (sky.js)
      need(spec.artDirection.setting == null || SETTINGS.includes(spec.artDirection.setting), 'artDirection.setting is unsupported');
      for (const [key, lo, hi] of [['fogDensity', 0, .06], ['exposure', .5, 2], ['bloomStrength', 0, 1.5]]) {
        need(spec.artDirection[key] == null || number(spec.artDirection[key], lo, hi), `artDirection.${key} is outside its supported range`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, spec };
}
