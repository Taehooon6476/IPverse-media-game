# workers/rig: auto-rigging onto the UAL skeleton

A Hunyuan3D GLB goes in. `rigged.glb` comes out: one skinned mesh on the 65-bone Quaternius Universal Animation
Library (UAL) skeleton, at most 4 influences, PBR material kept. The job also writes a run-cycle preview. It runs as a
Deadline Cloud job on the existing CPU farm. `server/providers/rig.py` (`provider="rig"`) submits it after the
`mesh3d` job of a humanoid IP. That is a `character`, or an `enemy` with `humanoid: true`.

| File | Role |
|---|---|
| `blender_rig.py` | Blender 5.x script: normalise, views, joints, skeleton, weights, export, validation frames |
| `pose2d.py` | RTMPose-m (COCO-17) on CPU with onnxruntime; called by `blender_rig.py --pose-cmd` |
| `run_rig.py` | Deadline task script: download inputs, run Blender, ffmpeg the preview, upload |
| `sheet.py` | 6 run + 6 attack frames into `rig_sheet.png` |
| `deadline_rig_template.json` | OpenJD template; `workers/template_loader.load_rig_template()` embeds the files above and `../img3d/meshclean.py` |
| `export_ual.py`, `glbtools.py` | build `ual.glb` from the UAL downloads; GLB info/trim (stdlib) |
| `ual.glb`, `ual_bones.json`, `ual_clips.json` | the shared clip file, bone list and role-to-clip map (`docs/rig-contract.md`) |

## Pipeline

1. **Normalise.** Join meshes, scale to 1.8 m, put the feet on z = 0, centre on x/y. The mesh faces -Y in Blender, which is glTF +Z.
   - Before scaling, `workers/img3d/meshclean.py` (embedded as the `Clean` file) removes Hunyuan's floor slab and stray flat cards. The GPU worker already runs it on new meshes; the rig runs it again for older GLBs. Fused to the soles, a slab rode a foot bone as a flapping plate (the survival mutant's plate was 4 m wide).
   - The open loops the slab leaves at the soles are then capped. The voxel proxy needs a closed body: with open soles it failed at every voxel size.
2. **Joints.** Render orthographic front and side views. RTMPose reads keypoints from each, with the alpha box as the person box. Front gives (x, z).
   Each joint is ray-cast along the depth axis. Its depth is the midpoint of the entry/exit segment nearest the
   side view's depth. Elbows, wrists, knees and ankles are also centred across the limb.
   - If the shoulder/hip line is turned more than 4 degrees, the mesh is squared up and detected again. Kai was turned 14.8 degrees.
   - A wrist read more than 10 cm above its elbow is placed by continuing the upper arm. The A-pose input hangs its arms, and RTMPose put the survival boss's wrists on its shoulder pads.
   - Missing or implausible keypoints fall back to proportions plus cross-section slicing. The crotch is the first solid ray between the legs, the neck is the narrowest slice, and the limb ends are the farthest vertices.
   - The job refuses meshes whose hips sit in the bottom 30 % of the height. Those are busts or cut-off legs. The job exits 3 and `meta.json.fallbackReason` explains why.
   - A keypoint read below 0.3 takes its partner's position mirrored across the hips' and shoulders' midline (at most 3, never both of a pair). gm_1e7d17bbb0's fox had every joint sound but wrist_l (0.299, behind her bag); before, that one point threw the whole detection away.
   - Chibi and stylised bodies pass: shoulders anywhere in 50-92 % of the height and hips in 30-65 %, at least 15 % apart (the fox: 60 % and 33 %; a human is about 82 % and 52 %).
   - A leg chain must stay in the leg volume below its hip. Seen from the front, the knee within 25 % of the leg length of the hip-ankle line, knee and ankle within the hips' half width + 12 cm, knee between hip and ankle; and the left and right knees (or ankles) within 30 cm in depth (58 sound rigs: at most 15 cm). When one leg breaks a rule and the other does not, the good leg is mirrored, depth kept: a knee in a tail, or the cloaked skeleton king's ankle on the back of his cloak (job_5f0d98e7e4, 32 %), now rigs with even legs. The proportional fallback also keeps its leg samples beside the hip and at its depth, and places the knee at 53 % of the hip-ankle drop instead of a fixed 29 % of the height.
   - Legs whose hip-knee-ankle lengths still differ by more than 12 % were misread (sound rigs: under 5 %). From RTMPose they fall back to proportions; from proportions the job refuses with the same exit 3. gm_1e7d17bbb0's chibi fox had a knee in her tail (28 %), and baking the UAL rest drove that leg through the floor.
3. **Skeleton.** Copy the UAL armature from `ual.glb` and move bones onto the joints. Torso, head, hand/fingers and feet follow per-segment similarity transforms. Rolls are kept by rotating each UAL bone's z axis with its segment. Names and hierarchy are unchanged. Fingers, `root` and `*_leaf` bones do not deform.
4. **Weights.** Blender heat weighting runs first. When more than 2 % of vertices stay unweighted, the job builds a voxel remesh proxy (12 mm), weights it, and copies the weights by inverse-distance blend of the 4 nearest proxy vertices, matched by group name.
   Every Hunyuan mesh tried so far took the proxy path, because they are not manifold. The Data Transfer modifier was tried and dropped: it mixed up groups between left and right and between hand and forearm.
   Weights are then cleaned, limited to 4 and normalised.
5. **Rest = UAL rest.** Every bone is posed to its UAL rest world rotation. The skinned mesh is baked in that pose and the pose is applied as the new rest, with the same weights. Rest rotations now match `ual.glb` exactly (`meta.restDeviationDeg` is 0), so clips play 1:1 by bone name: glTF runtimes, Blender actions, UE5 with a shared skeleton.
   An arms-down mesh with hands fused to the thighs is stretched into the T-pose: the fused faces become webs in the rest mesh too. A-pose source images avoid it.
6. **Export.** `rigged.glb` holds the mesh and armature, with no animations. The armature node `Rig` has the extra `ualHipsScale`: rig pelvis height ÷ UAL pelvis height (0.917 m). The mesh keeps Hunyuan's triangles (minus a removed slab or cards), with no decimation.
7. **Validation, runtime-like.** The working scene is dropped and the exported `rigged.glb` re-imported. The `ual.glb` actions are assigned to it by name, with no constraints or retargeting. Output is one run cycle, 6 attack frames and `weights.png` (dominant bone per vertex in the rest pose).
   Blender plays the pelvis translation relative to rest instead of scaled-absolute; the difference is (1 − ualHipsScale) × the clip's pelvis offset, a few cm.

## Clips (`ual.glb`)

UAL 1 + 2 "[Standard]" Unreal-Godot GLBs, the variant without root motion. Clips are resampled to 30 fps and the mannequin mesh is stripped. Every clip keeps a rotation channel on all 65 joints, because glTF rotations are absolute and a missing channel would leave the rig's own rest pose in place.
Translation is kept on `pelvis` only, so characters keep their bone lengths. Runtimes scale that pelvis translation by the rig's `ualHipsScale`. The file is 1.1 MB with 19 clips; `ual_clips.json` maps 20 roles, since `idle_melee` and `hold_melee` share `Sword_Idle`.

Rebuild after changing `ual_clips.json`:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -noaudio --python-exit-code 1 \
  --python workers/rig/export_ual.py -- --ual1 ".../UAL1_Standard.glb" --ual2 ".../UAL2_Standard.glb" \
  --clips workers/rig/ual_clips.json --out workers/rig/ual.glb
python3 scripts/upload_web.py   # also uploads runtime3d/v1/anims/ual.glb
```

## Inputs in S3 (one-time)

- `s3://ipverse-assets-087967639890-us-east-1/runtime3d/v1/anims/ual.glb` is uploaded by `scripts/upload_web.py`.
- `s3://ipverse-assets-087967639890-us-east-1/rig/models/rtmpose-m_body7_256x192.onnx` is the `end2end.onnx` from
  `https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip`.
  It was uploaded with `aws s3 cp`.

The provider copies both files, plus the mesh, to `DeadlineCloud/ipverse/{jobId}/inputs/`. The queue role reads only there.
The queue's Conda environment installs `blender python boto3 ffmpeg onnxruntime pillow numpy`.

## Run locally

```sh
python3 -m venv /tmp/rigvenv && /tmp/rigvenv/bin/pip install onnxruntime pillow numpy
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -noaudio --python-exit-code 1 \
  --python workers/rig/blender_rig.py -- --glb IN.glb --ual workers/rig/ual.glb --bones workers/rig/ual_bones.json \
  --clips workers/rig/ual_clips.json --out /tmp/rig --pose-cmd "/tmp/rigvenv/bin/python workers/rig/pose2d.py rtmpose.onnx"
```

Without `--pose-cmd` the job uses the proportional fallback. Without `--meshclean` it loads `workers/img3d/meshclean.py`; the farm passes the template's embedded copy. On the farm, a whole job runs about 30 s on a warm 16 vCPU worker.

## Licenses

- Universal Animation Library 1 and 2 by Quaternius: CC0 1.0 (https://quaternius.com/packs/universalanimationlibrary.html).
- RTMPose (OpenMMLab mmpose): Apache-2.0.
