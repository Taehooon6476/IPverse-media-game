// UAL clip roles and bone names, without three.js so Node tests can import it (test/anim.test.mjs).

// role -> UAL clip name. Mirrors workers/rig/ual_clips.json (the rigging task owns it); test/anim.test.mjs checks
// that the two agree once the rig file exists. Roles missing from a library fall back through FALLBACK.
export const UAL_CLIPS = {
  idle: 'Idle_Loop',
  walk: 'Walk_Loop',
  run: 'Jog_Fwd_Loop',
  sprint: 'Sprint_Loop',
  jump: 'Jump_Start',
  fall: 'Jump_Loop',
  land: 'Jump_Land',
  attack_melee: 'Sword_Attack',
  attack_gun: 'Pistol_Shoot',
  hit: 'Hit_Chest',
  death: 'Death01',
  interact: 'Interact',
  zombie_walk: 'Zombie_Walk_Fwd_Loop',
  zombie_attack: 'Zombie_Scratch',
};
// Optional extras, as in ual_clips.json. aim_gun falls back to idle_gun for libraries without Pistol_Aim_Neutral.
export const EXTRA_CLIPS = {
  idle_gun: 'Pistol_Idle_Loop', idle_melee: 'Sword_Idle', punch: 'Punch_Cross', zombie_idle: 'Zombie_Idle_Loop',
  aim_gun: 'Pistol_Aim_Neutral',
};
export const FALLBACK = {
  run: ['walk'], sprint: ['run', 'walk'], fall: ['jump'], zombie_walk: ['walk'], zombie_attack: ['attack_melee'],
  attack_gun: ['attack_melee'], attack_melee: ['attack_gun'], aim_gun: ['idle_gun'], zombie_idle: ['idle'],
};
// UAL bone names used here (workers/rig/ual_bones.json lists all of them).
export const BONES = {
  pelvis: 'pelvis', upperRoot: 'spine_01', handR: 'hand_r', footL: 'foot_l', footR: 'foot_r',
  middleR: 'middle_01_r', indexR: 'index_01_r', pinkyR: 'pinky_01_r', thumbR: 'thumb_01_r',
};

// Clip lookup by exact name, then case-insensitively, then ignoring an exporter prefix ("Armature|Idle_Loop").
export function findClip(clips, name) {
  if (!name) return null;
  const low = name.toLowerCase();
  const bare = (n) => n.split('|').pop().toLowerCase();
  return clips.find((c) => c.name === name) ?? clips.find((c) => c.name.toLowerCase() === low)
    ?? clips.find((c) => bare(c.name) === low) ?? null;
}

// role -> clip for this library, following FALLBACK when a role is missing.
export function resolveRoles(clips, map = UAL_CLIPS) {
  const out = {};
  const direct = (role) => findClip(clips, map[role] ?? EXTRA_CLIPS[role]);
  for (const role of [...Object.keys(map), ...Object.keys(EXTRA_CLIPS)]) {
    out[role] = direct(role);
    for (const alt of FALLBACK[role] ?? []) out[role] ??= direct(alt) ?? direct(FALLBACK[alt]?.[0]);
  }
  return out;
}

// A broken auto-rig (docs/rig-contract.md): a misread knee makes one leg far longer than the other; baking the UAL
// rest then straightens that leg through the floor, and every clip bends the body at the wrong places. Sound rigs
// differ by under 5 % between the legs; the broken ones by 18-46 %.
export const LEG_IMBALANCE_MAX = 0.12;
const LEG = ['thigh', 'calf', 'foot'];
/** |left - right| / longer, from bone head positions {name: [x, y, z]} (any one space); 0 without both leg chains. */
export function legImbalance(points) {
  const chain = (s) => {
    const p = LEG.map((b) => points[`${b}_${s}`]);
    return p.every(Boolean) ? Math.hypot(...p[0].map((v, i) => v - p[1][i])) + Math.hypot(...p[1].map((v, i) => v - p[2][i])) : null;
  };
  const l = chain('l'), r = chain('r');
  return l && r ? Math.abs(l - r) / Math.max(l, r) : 0;
}
/** The raw (unrigged) mesh make_game copies next to a rig: assets/{ipId}.rig.glb -> assets/{ipId}.glb, else null. */
export const rawModelUrl = (url) => (typeof url === 'string' && url.endsWith('.rig.glb') ? url.replace(/\.rig\.glb$/, '.glb') : null);
