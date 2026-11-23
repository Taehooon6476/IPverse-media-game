// GameSpec v1 validation. Pure ES module (no Phaser, no DOM): runs in the browser and in Node.
// The rules must stay identical to server/gamespec.py (see "GameSpec v1" in the shared contracts).

export const GENRES = ['sf-shooter', 'sf-survival', 'rpg-explore', 'rpg-quest'];
const OBJECTIVES = { sf: ['kills', 'survive'], rpg: ['collect', 'talk'] };
const SHAPES = ['triangle', 'circle', 'square'];
const EFFECTS = ['heal', 'score', 'shield', 'key'];
const DIFFICULTIES = ['easy', 'normal', 'hard'];
const DEFAULT_MAP = { width: 20, height: 15, seed: 1234 };

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

// Returns {ok: true, spec} with optional fields filled in, or {ok: false, errors}. Never mutates the input.
export function validateSpec(input) {
  if (!isObject(input)) return { ok: false, errors: ['spec must be a JSON object'] };
  const spec = structuredClone(input);
  const errors = [];
  const need = (ok, message) => { if (!ok) errors.push(message); };
  const family = GENRES.includes(spec.genre) ? spec.genre.split('-')[0] : null;

  need(spec.version === 1, 'version must be 1');
  need(family, `genre must be one of ${GENRES.join('|')}`);

  if (!isObject(spec.palette)) errors.push('palette must be an object with bg, accent, text');
  else for (const key of ['bg', 'accent', 'text']) need(isHex(spec.palette[key]), `palette.${key} must be a #rrggbb hex color`);

  if (!isObject(spec.player)) errors.push('player must be an object');
  else need(isInt(spec.player.speed, 1, 3), 'player.speed must be an integer 1-3');

  if (!isObject(spec.objective)) errors.push('objective must be an object');
  else {
    if (family) need(OBJECTIVES[family].includes(spec.objective.type), `objective.type must be ${OBJECTIVES[family].join('|')} for ${spec.genre}`);
    need(isInt(spec.objective.target, 1, 200), 'objective.target must be an integer 1-200');
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
    });
  }

  if (spec.props == null) spec.props = [];
  if (!Array.isArray(spec.props)) errors.push('props must be an array');
  else {
    spec.props.forEach((prop, i) => {
      if (!isObject(prop)) return errors.push(`props[${i}] must be an object`);
      need(EFFECTS.includes(prop.effect), `props[${i}].effect must be ${EFFECTS.join('|')}`);
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

// A playable spec without IP sprites (the runtime draws placeholder shapes).
export function defaultSpec(genre = 'sf-shooter') {
  const sf = genre.startsWith('sf-');
  return {
    version: 1,
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
