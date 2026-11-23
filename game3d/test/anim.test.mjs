import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { UAL_CLIPS, EXTRA_CLIPS, BONES, findClip, resolveRoles } from '../ualclips.js';

const ROLES = ['idle', 'walk', 'run', 'sprint', 'jump', 'fall', 'land', 'attack_melee', 'attack_gun', 'hit', 'death',
  'interact', 'zombie_walk', 'zombie_attack']; // docs/rig-contract.md
// The clip names of Quaternius UAL 1 (UAL1_Standard.glb), the pack without the zombie set.
const UAL1 = ['A_TPose', 'Crouch_Fwd_Loop', 'Crouch_Idle_Loop', 'Dance_Loop', 'Death01', 'Driving_Loop', 'Fixing_Kneeling',
  'Hit_Chest', 'Hit_Head', 'Idle_Loop', 'Idle_Talking_Loop', 'Idle_Torch_Loop', 'Interact', 'Jog_Fwd_Loop', 'Jump_Land',
  'Jump_Loop', 'Jump_Start', 'PickUp_Table', 'Pistol_Aim_Down', 'Pistol_Aim_Neutral', 'Pistol_Aim_Up', 'Pistol_Idle_Loop',
  'Pistol_Reload', 'Pistol_Shoot', 'Punch_Cross', 'Punch_Jab', 'Push_Loop', 'Roll', 'Sitting_Enter', 'Sitting_Exit',
  'Sitting_Idle_Loop', 'Sitting_Talking_Loop', 'Spell_Simple_Enter', 'Spell_Simple_Exit', 'Spell_Simple_Idle_Loop',
  'Spell_Simple_Shoot', 'Sprint_Loop', 'Swim_Fwd_Loop', 'Swim_Idle_Loop', 'Sword_Attack', 'Sword_Idle',
  'Walk_Formal_Loop', 'Walk_Loop'].map((name) => ({ name }));

test('every contract role has a clip name', () => {
  assert.deepEqual(Object.keys(UAL_CLIPS).sort(), [...ROLES].sort());
});

test('UAL 1 alone resolves every role, zombies through their fallbacks', () => {
  const roles = resolveRoles(UAL1);
  for (const role of ROLES) assert.ok(roles[role], `no clip for ${role}`);
  assert.equal(roles.zombie_walk.name, 'Walk_Loop');
  assert.equal(roles.zombie_attack.name, 'Sword_Attack');
  assert.equal(roles.aim_gun.name, EXTRA_CLIPS.aim_gun);
  assert.equal(resolveRoles([{ name: 'Pistol_Idle_Loop' }]).aim_gun.name, 'Pistol_Idle_Loop'); // ual.glb without the aim clip
});

test('clip lookup ignores case and exporter prefixes', () => {
  const clips = [{ name: 'Armature|idle_loop' }, { name: 'WALK_LOOP' }];
  assert.equal(findClip(clips, 'Idle_Loop'), clips[0]);
  assert.equal(findClip(clips, 'Walk_Loop'), clips[1]);
  assert.equal(findClip(clips, 'Run'), null);
});

test('a library with only idle and walk still drives locomotion', () => {
  const roles = resolveRoles([{ name: 'Idle_Loop' }, { name: 'Walk_Loop' }]);
  assert.equal(roles.run.name, 'Walk_Loop');
  assert.equal(roles.sprint.name, 'Walk_Loop');
  assert.equal(roles.death, null);
});

// The rigging task owns workers/rig/ual_clips.json and ual_bones.json; the runtime copies must agree with them.
const rigFile = (name) => new URL(`../../workers/rig/${name}`, import.meta.url);

test('UAL_CLIPS mirrors workers/rig/ual_clips.json', { skip: !existsSync(rigFile('ual_clips.json')) && 'rig file not there yet' }, () => {
  const rig = JSON.parse(readFileSync(rigFile('ual_clips.json'), 'utf8'));
  for (const role of ROLES) assert.equal(UAL_CLIPS[role], rig[role], role);
  for (const [role, name] of Object.entries(EXTRA_CLIPS)) if (rig[role]) assert.equal(name, rig[role], role);
});

test('BONES are UAL bone names', { skip: !existsSync(rigFile('ual_bones.json')) && 'rig file not there yet' }, () => {
  const raw = JSON.parse(readFileSync(rigFile('ual_bones.json'), 'utf8'));
  const names = new Set(raw.bones.map((b) => b.name));
  assert.equal(raw.roles.weaponSocket, BONES.handR);
  assert.equal(raw.roles.hips, BONES.pelvis);
  for (const bone of Object.values(BONES)) assert.ok(names.has(bone), bone);
});
