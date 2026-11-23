# workers: Blender relief turntable

`blender_relief.py` turns a cutout PNG (RGBA, transparent background) into a silhouette relief: the
alpha mask (alpha >= 0.5) is sampled on a grid of at most 96 cells along the longer side, one quad per
covered cell, merged, outline-smoothed, extruded (Solidify) and bevelled. Front and back show the image;
the sides use the accent color. It renders a Cycles (CPU) turntable and exports a GLB.

Outputs in `--out`: `frames/0001.png ...`, `poster.png` (copy of frame 1, front view), `model.glb`
(front faces glTF +Z, Y up, 2 units on the longer side), `meta.json` `{"frames", "width", "height", "verts", "faces"}`.
A fully transparent image exits with code 1 and `blender_relief: no pixels with alpha >= 0.5 ...`.

Runs on Blender 4.2 LTS and 5.x (checked on 4.2.23 and 5.1.2): bpy/bmesh/mathutils/numpy only, no add-ons, no compositor.

## Run locally

```sh
python3 workers/make_fixture.py /tmp/cutout.png 1024     # or use any real cutout PNG
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -noaudio --python-exit-code 1 \
  --python workers/blender_relief.py -- \
  --image /tmp/cutout.png --out /tmp/relief --frames 72 --width 1280 --height 720 --samples 24 --thickness 0.12 --accent "#5de6cf"
ffmpeg -y -framerate 24 -i /tmp/relief/frames/%04d.png -c:v libx264 -pix_fmt yuv420p -movflags +faststart /tmp/relief/turntable.mp4
```

Tests (from the repo root): `python3 -m pytest workers -v`. The Blender test uses `$BLENDER` if set, else
`/Applications/Blender.app/Contents/MacOS/Blender`, and is skipped when neither exists.

## Deadline Cloud job

`deadline_relief_template.json` is the OpenJD job template (`jobtemplate-2023-09`, submit with
`templateType="JSON"`). Its `Relief` embedded file holds the placeholder `@@RELIEF@@`;
`template_loader.load_template()` swaps in the current `blender_relief.py`, so edit only the `.py` file.
`server/providers/deadline.py` submits `json.dumps(load_template())` with `CreateJob`.

One step (`Render`), one task. The embedded `Run` script downloads the input, runs Blender on the
`Relief` file (with `PYTHONPATH`/`PYTHONHOME` removed from its environment), encodes the frames, and uploads
four files.

| Parameter | Type | Default | Used as |
|---|---|---|---|
| `InputUri` | STRING | - | `s3://bucket/key` of the cutout PNG, downloaded and passed as `--image` |
| `OutputPrefix` | STRING | - | `s3://bucket/prefix` (no trailing slash); receives `turntable.mp4` (`video/mp4`), `model.glb` (`model/gltf-binary`), `poster.png` (`image/png`), `meta.json` (`application/json`) |
| `Frames` | INT | 72 | `--frames`; the mp4 is 24 fps, so 72 frames = 3 s |
| `Width`, `Height` | INT | 1280, 720 | `--width`, `--height` (keep them even for yuv420p) |
| `Samples` | INT | 24 | `--samples` (Cycles, OpenImageDenoise on) |
| `Accent` | STRING | `#5de6cf` | `--accent`, the side color |
| `CondaPackages` | STRING | `blender python boto3 ffmpeg` | read by the queue's Conda environment |
| `CondaChannels` | STRING | `deadline-cloud conda-forge` | read by the queue's Conda environment |

`--thickness` is fixed at `0.12` in the `Run` script. The task times out after 3600 s.

Manual submit (same call the server makes):

```sh
python3 -c "import json; from workers.template_loader import load_template; print(json.dumps(load_template()))" > /tmp/relief-template.json
aws deadline create-job --farm-id "$DEADLINE_FARM_ID" --queue-id "$DEADLINE_QUEUE_ID" --priority 50 \
  --template file:///tmp/relief-template.json --template-type JSON \
  --parameters '{"InputUri": {"string": "s3://BUCKET/sessions/S/IP.png"}, "OutputPrefix": {"string": "s3://griptapenode-queue-087967639890-us-east-1-an/DeadlineCloud/ipverse/test-1"}}'
```

## GLB mode (Hunyuan3D turntable)

`--glb MODEL.glb` replaces `--image`: the mesh is imported, scaled to 2 units on its longest side, framed at
eye level (12 deg), and turned like the relief. No `model.glb` is written. The Deadline `Run` script picks the
mode from the `InputUri` extension (`.glb` or `.png`); `server/providers/deadline.py` stages `input.glbKey`.

# workers/img3d: image-to-3D GPU worker (Hunyuan3D-2.1)

`worker.py` runs as the `ipverse-img3d` systemd service on the `IpverseImg3d` box (L40S, tag `ipverse=img3d`,
no inbound rules). It long-polls SQS `ipverse-img3d-jobs` for `{jobId, input_key, output_prefix, params}`,
runs Hunyuan3D-2.1 shape + PBR paint on the cutout, and writes `model.glb` and `status.json`
(`{status, phase, error, seconds, updatedAt, stats}`) under `output_prefix` in the assets bucket.
Between shape and paint, `meshclean.py` removes the flat sheets Hunyuan sometimes makes: a floor slab under the
feet (thin, horizontal, at the bottom, wider than the body above it) and stray flat cards that faint cutout alpha
turns into geometry, with any card stuck to the body in the same plane. `stats.cleanup` reports
`{removedFaces, slabs, cards}`. Capes, blades, shields and flat bottoms stay; `workers/tests/test_meshclean.py`
has the cases. The rig job runs the same module again (`workers/rig/README.md`). While a job
runs it rewrites `status.json` and extends the message visibility every 60 s. After 20 idle minutes it stops
the instance. `server/providers/img3d.py` reads `status.json` and starts the box when a job is queued.

- Deploy: `bash scripts/deploy_img3d.sh` uploads `worker.py`, `meshclean.py`, `setup.sh`, and the unit to
  `s3://ipverse-assets-087967639890-us-east-1/img3d/worker/`, then deploys the stack. The unit fetches `worker.py`
  on every start, and `worker.py` fetches `meshclean.py` next to itself, so boxes from the baked AMI need nothing else.
- First boot: user data downloads `setup.sh`, which installs Python 3.10 + torch 2.5.1 (cu124), the repo,
  both CUDA extensions, and all weights (~18 GB on the root volume). It took about 35 minutes. The log is
  `/var/log/img3d-setup.log`.
- Re-run setup after a failure: `bash scripts/deploy_img3d.sh --setup`. Pick up a new `worker.py`:
  `bash scripts/deploy_img3d.sh --restart`. Look inside: `aws ssm start-session --target <instance-id>`.
- Timing on the L40S: the first job after boot loads models for about 2 minutes. A warm job takes about 100 s
  (shape ~40 s, texture ~60 s). Output is about 30k vertices, 40k faces, and a 9-10 MB GLB with base color and
  metallic-roughness textures.

## Relocation (no g6e capacity)

The stack owns no instance. `server/providers/img3d.py` starts the stopped box tagged `ipverse=img3d`. If
its AZ has no capacity (or no box exists), the provider launches one from the `ipverse-img3d` launch
template. It tries g6e.xlarge, then 2xlarge, then 4xlarge, in subnets b, d, c, a, without SDK retries and
within 40 s per poll. Once the replacement runs, it terminates the stranded box. The template boots the
baked AMI `ipverse-img3d-20261030` (venv, weights, worker) and initializes the root volume at 300 MiB/s.
Without that rate, the first model load read lazily from the snapshot for more than 20 minutes. The worker is
polling about 1.5 minutes after launch, and a cold job takes about 290 s.
