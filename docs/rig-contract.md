# Rigged character contract (2026-10-30)

Shared by the rigging pipeline (workers/, server/providers) and the game runtimes (game3d/, ue5/).

## Skeleton
- Every humanoid IP (player, NPC, humanoid enemy) gets a rigged GLB whose skeleton is the **Quaternius Universal Animation Library (UAL) humanoid rig** — same bone names, hierarchy and rest orientation as the UAL mannequin (CC0, https://quaternius.com/packs/universalanimationlibrary.html). The exact bone-name list is recorded in `workers/rig/ual_bones.json` by the rigging task.
- Units metres, Y-up (glTF), character faces +Z, feet on y = 0, height normalised to 1.8 m. Rest pose = the UAL rest (T-pose) with identical bone rotations; the source image is A-pose so the mesh separates cleanly.
- One skinned mesh, ≤ 4 influences per vertex, PBR material kept from Hunyuan3D.
- Asset kind `rigged_glb`; IP field `riggedGlbAssetId`. The unrigged `glb` stays as fallback.

## Animations
- Clips come from UAL 1 + UAL 2 (CC0), exported once to `runtime3d/v1/anims/ual.glb` (and the UE5 equivalent) — not per character. Runtimes bind clips to any rigged GLB by bone name.
- Required clip roles (the rigging task writes the real clip names into `workers/rig/ual_clips.json` as `{role: clipName}`): `idle`, `walk`, `run`, `sprint`, `jump`, `fall`, `land`, `attack_melee`, `attack_gun`, `hit`, `death`, `interact`, `zombie_walk`, `zombie_attack`.
- As built (`workers/rig/README.md`): every bone's rest rotation equals the UAL rest rotation; only bone lengths differ. The skinned mesh is baked into that pose. So `ual.glb` clips play 1:1 by bone name in any runtime with no retarget: 30 fps, in place, a rotation channel on all 65 joints, translation on `pelvis` only. Clip names have no prefix (`Idle_Loop`). The right-hand bone is `hand_r`.
- **Runtimes should scale the pelvis position track** by the rigged GLB's armature-node extra `ualHipsScale` (rig pelvis height ÷ UAL's 0.917 m, about 0.9–1.05). Without it, characters with shorter legs float, and the death and crouch heights come out wrong. In three.js, clone the clip per model and multiply the `pelvis.position` track values.
- Not every humanoid gets a rig. The rig job refuses meshes without full legs, such as busts or figures cropped at the thighs, and meshes whose legs it reads at uneven lengths (a knee in a tail or a coat), and fails with "리깅 불가: …". Such IPs keep only `glbAssetId`. A published rig with uneven legs (over 12 %) is dropped by the runtime for the raw mesh, which make_game copies next to it as `assets/{ipId}.glb`.

## Weapons and items
- Asset kind `weapon` (IP kind `weapon`): a GLB with its grip at the origin, blade/barrel along +Z. Attached at runtime to the right-hand bone (`hand_r` equivalent in UAL — name in `ual_bones.json`).
- Items/props stay kind `prop` with an unrigged GLB.

## Game spec additions (v1 + optional fields)
- `player.modelUrl` → rigged GLB when available; `player.weaponUrl` optional.
- `enemies[]` may carry `ipId`, `modelUrl` (rigged → animated; unrigged → procedural motion), `weaponUrl`.
- `animUrl`: `assets/ual.glb` copied into the game folder.
