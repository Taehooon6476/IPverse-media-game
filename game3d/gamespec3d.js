// GameSpec v1 validation for the three.js runtime. Pure ES module (no three, no DOM): runs in the browser and Node.
// Self-contained copy of game/gamespec.js (a published game folder holds only its own runtime files) plus the
// optional 3D fields: `engine`, `animUrl`, `modelUrl` on player/props/enemies, `weaponUrl` on player/enemies,
// `player.weaponType` and `enemies[].humanoid` (docs/rig-contract.md). test/gamespec3d.test.mjs checks that the 2D
// rules did not drift.
// server/gamespec.py mirrors these rules.
import { validateAuthoredSpec } from './authored-contract.js';

export const GENRES = ['sf-shooter', 'sf-survival', 'rpg-explore', 'rpg-quest'];
const OBJECTIVES = { sf: ['kills', 'survive'], rpg: ['collect', 'talk'] };
const SHAPES = ['triangle', 'circle', 'square'];
const EFFECTS = ['heal', 'score', 'shield', 'key'];
const DIFFICULTIES = ['easy', 'normal', 'hard'];
export const ENGINES = ['phaser', 'three'];
const WEAPON_TYPES = ['melee', 'gun'];
const DEFAULT_MAP = { width: 20, height: 15, seed: 1234 };
// three.js only (the Phaser runtime keeps the 2D contract): more SF objectives, a custom mission line, the arena's
// environment and the round's rules.
const OBJECTIVES_3D = { sf: ['boss', 'collect', 'reach'], rpg: [] };
export const THEMES = ['neon-arena', 'ruined-city', 'desert-outpost', 'ice-station', 'lava-forge', 'jungle-ruins'];
export const SKIES = ['space', 'day', 'dusk', 'storm', 'night'];
export const LAYOUTS = ['pillars', 'open', 'maze', 'ring'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const isUrl = (v) => v == null || (typeof v === 'string' && v !== '');

// Returns {ok: true, spec} with optional fields filled in, or {ok: false, errors}. Never mutates the input.
export function validateSpec(input) {
  if (!isObject(input)) return { ok: false, errors: ['spec must be a JSON object'] };
  if (input.version === 2) {
    // Keep the shared asset/palette rules, while v2's mission replaces the legacy objective.
    const base = structuredClone(input);
    base.version = 1;
    base.objective = { type: input.genre?.startsWith('sf-') ? 'kills' : 'collect', target: 1 };
    const peacefulSf = input.genre?.startsWith('sf-')
      && (input.enemies == null || (Array.isArray(input.enemies) && input.enemies.length === 0));
    // V1 SF requires an enemy; v2 may author a peaceful retrieval/extraction world.
    // Validate the shared fields with a temporary entry, then restore the exact original cast.
    if (peacefulSf) base.enemies = [{ color: '#000000', shape: 'circle', speed: 1, hp: 1 }];
    const inherited = validateSpec(base);
    if (!inherited.ok) return inherited;
    return validateAuthoredSpec({ ...inherited.spec, version: 2,
      ...(peacefulSf ? { enemies: [] } : {}), objective: input.objective ?? base.objective });
  }
  const spec = structuredClone(input);
  const errors = [];
  const need = (ok, message) => { if (!ok) errors.push(message); };
  const family = GENRES.includes(spec.genre) ? spec.genre.split('-')[0] : null;

  need(spec.version === 1, 'version must be 1');
  need(family, `genre must be one of ${GENRES.join('|')}`);
  need(spec.engine == null || ENGINES.includes(spec.engine), `engine must be ${ENGINES.join('|')}`);
  need(isUrl(spec.animUrl), 'animUrl must be a non-empty string');

  if (!isObject(spec.palette)) errors.push('palette must be an object with bg, accent, text');
  else for (const key of ['bg', 'accent', 'text']) need(isHex(spec.palette[key]), `palette.${key} must be a #rrggbb hex color`);

  if (!isObject(spec.player)) errors.push('player must be an object');
  else {
    need(isInt(spec.player.speed, 1, 3), 'player.speed must be an integer 1-3');
    need(isUrl(spec.player.modelUrl), 'player.modelUrl must be a non-empty string');
    need(isUrl(spec.player.weaponUrl), 'player.weaponUrl must be a non-empty string');
    need(spec.player.weaponType == null || WEAPON_TYPES.includes(spec.player.weaponType), `player.weaponType must be ${WEAPON_TYPES.join('|')}`);
  }

  if (!isObject(spec.objective)) errors.push('objective must be an object');
  else {
    const types = family ? [...OBJECTIVES[family], ...(spec.engine === 'phaser' ? [] : OBJECTIVES_3D[family])] : [];
    if (family) need(types.includes(spec.objective.type), `objective.type must be ${types.join('|')} for ${spec.genre}`);
    need(isInt(spec.objective.target, 1, 200), 'objective.target must be an integer 1-200');
    need(spec.objective.label == null || (typeof spec.objective.label === 'string' && [...spec.objective.label].length <= 60),
      'objective.label must be a string of at most 60 characters');
  }

  if (spec.environment != null) {
    const env = spec.environment;
    if (!isObject(env)) errors.push('environment must be an object');
    else {
      need(env.theme == null || THEMES.includes(env.theme), `environment.theme must be ${THEMES.join('|')}`);
      need(env.sky == null || SKIES.includes(env.sky), `environment.sky must be ${SKIES.join('|')}`);
      need(env.layout == null || LAYOUTS.includes(env.layout), `environment.layout must be ${LAYOUTS.join('|')}`);
      need(env.size == null || isInt(env.size, 18, 45), 'environment.size must be an integer 18-45');
      need(env.obstacles == null || isInt(env.obstacles, 0, 30), 'environment.obstacles must be an integer 0-30');
    }
  }
  if (spec.rules != null) {
    const r = spec.rules;
    if (!isObject(r)) errors.push('rules must be an object');
    else {
      need(r.timeLimitSec == null || isInt(r.timeLimitSec, 0, 900), 'rules.timeLimitSec must be an integer 0-900');
      need(r.enemyRate == null || (typeof r.enemyRate === 'number' && r.enemyRate >= 0.25 && r.enemyRate <= 3), 'rules.enemyRate must be a number 0.25-3');
      need(r.playerHp == null || isInt(r.playerHp, 50, 500), 'rules.playerHp must be an integer 50-500');
    }
  }

  need(DIFFICULTIES.includes(spec.difficulty), `difficulty must be ${DIFFICULTIES.join('|')}`);

  if (spec.enemies == null && family === 'rpg') spec.enemies = [];
  const minEnemies = family === 'rpg' ? 0 : 1;
  if (!Array.isArray(spec.enemies) || spec.enemies.length < minEnemies || spec.enemies.length > 5) {
    errors.push(`enemies must be an array of ${minEnemies}-5 items`);
  } else {
    spec.enemies.forEach((enemy, i) => {
      if (!isObject(enemy)) return errors.push(`enemies[${i}] must be an object`);
      need(isHex(enemy.color), `enemies[${i}].color must be a #rrggbb hex color`);
      need(SHAPES.includes(enemy.shape), `enemies[${i}].shape must be ${SHAPES.join('|')}`);
      need(isInt(enemy.speed, 1, 3), `enemies[${i}].speed must be an integer 1-3`);
      need(isInt(enemy.hp, 1, 3), `enemies[${i}].hp must be an integer 1-3`);
      need(isUrl(enemy.modelUrl), `enemies[${i}].modelUrl must be a non-empty string`);
      need(isUrl(enemy.weaponUrl), `enemies[${i}].weaponUrl must be a non-empty string`);
      need(enemy.humanoid == null || typeof enemy.humanoid === 'boolean', `enemies[${i}].humanoid must be a boolean`);
    });
  }

  if (spec.props == null) spec.props = [];
  if (!Array.isArray(spec.props)) errors.push('props must be an array');
  else {
    spec.props.forEach((prop, i) => {
      if (!isObject(prop)) return errors.push(`props[${i}] must be an object`);
      need(EFFECTS.includes(prop.effect), `props[${i}].effect must be ${EFFECTS.join('|')}`);
      need(isUrl(prop.modelUrl), `props[${i}].modelUrl must be a non-empty string`);
    });
  }

  if (spec.dialogue == null) spec.dialogue = [];
  if (!Array.isArray(spec.dialogue) || spec.dialogue.length > 12) errors.push('dialogue must be an array of 0-12 lines');
  else {
    // Length in code points, like Python len(), so emoji count once on both sides.
    spec.dialogue.forEach((line, i) => need(
      isObject(line) && typeof line.text === 'string' && [...line.text].length <= 140,
      `dialogue[${i}].text must be a string of at most 140 characters`,
    ));
  }

  if (spec.quest === undefined) spec.quest = null;
  need(spec.quest === null || isObject(spec.quest), 'quest must be an object or null');

  if (spec.map == null && family === 'rpg') spec.map = { ...DEFAULT_MAP };
  if (spec.map != null) {
    if (!isObject(spec.map)) errors.push('map must be an object');
    else {
      need(isInt(spec.map.width, 12, 30), 'map.width must be an integer 12-30');
      need(isInt(spec.map.height, 9, 20), 'map.height must be an integer 9-20');
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, spec };
}

const DEFAULT_OBJECTIVE = {
  'sf-shooter': { type: 'kills', target: 15 },
  'sf-survival': { type: 'survive', target: 60 },
  'rpg-explore': { type: 'collect', target: 3 },
  'rpg-quest': { type: 'talk', target: 1 },
};

// A playable spec without IP sprites or models (the runtime falls back to procedural stand-ins).
export function defaultSpec(genre = 'sf-shooter') {
  const sf = genre.startsWith('sf-');
  return {
    version: 1,
    engine: 'three',
    title: sf ? '궤도 탈출' : '잃어버린 코어',
    genre,
    palette: { bg: '#0b0d12', accent: '#5de6cf', text: '#f5f7fa' },
    player: { name: '주인공', speed: 2 },
    props: [{ name: '에너지 코어', effect: sf ? 'score' : 'key' }],
    enemies: sf ? [{ name: '드론', color: '#ff5a5a', shape: 'triangle', speed: 2, hp: 1 }] : [],
    objective: { ...DEFAULT_OBJECTIVE[genre] },
    difficulty: 'normal',
    dialogue: sf ? [] : [{ speaker: '촌장', text: '마을을 밝히던 에너지 코어를 찾아 주게.' }],
    quest: genre === 'rpg-quest'
      ? { giverName: '촌장', itemName: '에너지 코어', itemPropIndex: 0, completeText: '고맙네! 마을에 다시 불이 켜졌어.' }
      : null,
    map: { ...DEFAULT_MAP },
  };
}
