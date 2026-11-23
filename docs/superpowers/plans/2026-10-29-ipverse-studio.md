# IPverse Studio Implementation Plan

> **As built (2026-10-30).** The shipped demo deviates from this plan in these facts:
> - `/api/*` Lambda Function URL uses `AWS_IAM` auth behind CloudFront Origin Access Control (SigV4 signed at the edge); an account guardrail removes public (auth NONE) Lambda URL permissions. Clients send `x-amz-content-sha256` on requests with a body. The Lambda still validates the Cognito access token in `X-Auth-Token`.
> - The layer is the BtbN GPL ffmpeg build (UPX-compressed, has drawtext) plus `NotoSansKR-Bold.otf`. No ffprobe ships (`FFPROBE_BIN=""`); durations are parsed from `ffmpeg -i` stderr.
> - Deadline inputs are staged into `s3://griptapenode-queue-087967639890-us-east-1-an/DeadlineCloud/ipverse/{jobId}/inputs/`.
> - Render defaults are 48 frames / 16 samples.
> - `REMOVE_BG_MODEL_ID=us.stability.stable-image-remove-background-v1:0` (cross-region inference profile).
> - DynamoDB attributes added: Job `rev` (optimistic lock on every job write), `throttledAt`, `statusErrorSince`; Message `claimedAt`; Job input `extra_asset_ids`.
> - CloudFront serves the SPA via a CloudFront Function (viewer-request rewrite to `/index.html`) on the default behavior instead of 403/404 error responses.
> - Video shots: provider `mediagen_video` (`server/providers/mediagen_video.py`) replaces `bedrock_video` for new jobs. It sends JSON-RPC `tools/call` to the mediagen MCP proxy (`VIDEOGEN_MCP_URL`, `x-api-key: Key <SSM /mediagen/mcp-api-key>`): `ltx_start_video` / `minimax_h3_start_video` / `video_start(model="kandinsky-6-0-video-pro")` / `wan_animate_start`, then the matching `*_get_status`; `collect` downloads the result mp4 into `sessions/{sessionId}/{assetId}.mp4` with `meta {model, prompt, aspect_ratio}`. Tool contract changes: `make_video_shot {ipId, prompt, aspect_ratio, duration?: int 2–8, model?: ltx|minimax-h3|kandinsky-6-0-video-pro}` → job input `{ipId, imageKey, prompt, aspect_ratio, seconds, model}`; new `animate_character {ipId, driving_shot_job_id, prompt?}` → kind `shot`, model `wan-animate`, deps `[driving_shot_job_id]`. Only `bedrock_video` is serialized. IAM adds `ssm:GetParameter` on the key and `kms:Decrypt` via `ssm.us-east-1.amazonaws.com`.
> - Image models: `server/providers/mcp_client.py` is the one JSON-RPC client for both proxies (`VIDEO`, `IMAGE` endpoints, keys cached per process). `server/providers/mediagen_image.generate` calls `start_image {prompt, model: krea|klein9, style: "real", reference_image_urls?}` and polls `get_image_status` every 5 s until done or out of time. The status `model` is a display label, so the id from the start call is kept. Tool contract: `create_ip_asset {kind, name, description, role?, image_model?: krea|klein9|stability-ultra, reference_ip_id?}` returns `{ipId, imageUrl, cutoutUrl, imageModel}`. The GPU models store a `.png` image asset with `meta {prompt, model, references?}`. Errors are `image_timeout` (retry) and `turn_budget` (stop the turn). `run_tool(..., deadline)` gets `started + TURN_BUDGET_SEC` from the agent, and the wait is `min(150, deadline − now − 25 s)`, refusing to start under 30 s. New `make_ip_variant {ipId, prompt}` → klein9 with the IP image as reference, then `update_ip(version+1, imageAssetId, cutoutAssetId)`. Old 3D outputs stay linked. Env adds `IMAGEGEN_MCP_URL`/`IMAGEGEN_KEY_PARAM`, and `ssm:GetParameter` covers `/storyboard-mcp/api-key`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed AWS demo where one chat concept becomes IP assets (images, Blender 3D turntable + GLB, video shots, graded trailer and short) in the left pane and a playable, publishable Phaser game that reuses that IP (with an optional pre-roll ad) in the right pane.

**Architecture:** React/Vite SPA + Lambda (Python, Function URL) behind one CloudFront distribution; DynamoDB single table; S3 assets; Cognito demo user. A Bedrock Converse tool-using agent drives tools; long work becomes jobs run by providers (Deadline Cloud Blender job, Bedrock Luma Ray 2 async, in-Lambda ffmpeg). Chat turns run asynchronously via Lambda self-invoke; the UI polls session state.

**Tech Stack:** Python 3.12 Lambda (boto3 only), CDK Python, React 19 + Vite + TypeScript (no UI libs), Phaser 3 (CDN), Blender 5.x bpy, ffmpeg layer (BtbN GPL, UPX, no ffprobe), Deadline Cloud OpenJD (JSON template), Bedrock (`global.anthropic.claude-sonnet-5-5`, `stability.stable-image-ultra-v1:1` @ us-west-2, `us.stability.stable-image-remove-background-v1:0` @ us-east-1, `luma.ray-v2:0` @ us-west-2).

**Spec:** `docs/superpowers/specs/2026-10-29-ipverse-studio-design.md`

## Global Constraints

- Work only inside this worktree (`.claude/worktrees/claude-ip-platform`). Never write into the main checkout (Codex is building there). Use plain `git add`/`git commit` commands from the worktree root.
- Every AWS resource name starts with `ipverse-`. Account `087967639890`. Core region `us-east-1`; image and video models `us-west-2`.
- Backend: Python 3.12 syntax that also runs on local Python 3.10 (no `match`, no PEP 695). Only stdlib + boto3. Tests: `pytest` under `server/tests`, no network unless `LIVE=1` is set.
- Frontend: TypeScript strict, no component library, Korean UI copy, CSS variables for the session palette.
- Commit message footer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- No secrets in the repo. Demo credentials go to Secrets Manager `ipverse/demo-user`.
- Model-written text is data, never code: GameSpec is validated; the browser runs only the fixed runtime.

## Shared contracts (every task reads this section)

### Environment variables (Lambda)

`TABLE_NAME`, `ASSETS_BUCKET`, `CDN_DOMAIN`, `VIDEO_BUCKET`, `VIDEO_REGION=us-west-2`, `IMAGE_REGION=us-west-2`, `QUEUE_BUCKET=griptapenode-queue-087967639890-us-east-1-an`, `QUEUE_PREFIX=DeadlineCloud/ipverse`, `DEADLINE_FARM_ID`, `DEADLINE_QUEUE_ID`, `USER_POOL_ID`, `CLIENT_ID`, `AGENT_MODEL_ID=global.anthropic.claude-sonnet-5-5`, `IMAGE_MODEL_ID=stability.stable-image-ultra-v1:1`, `REMOVE_BG_MODEL_ID=us.stability.stable-image-remove-background-v1:0` (cross-region inference profile; the bare model id fails in us-east-1), `VIDEO_MODEL_ID=luma.ray-v2:0`, `RUNTIME_PREFIX=runtime/v1/`, `FFMPEG_BIN=/opt/bin/ffmpeg`, `FFPROBE_BIN=""` (no ffprobe in the layer; durations parsed from `ffmpeg -i`), `FONT_PATH=/opt/fonts/NotoSansKR-Bold.otf`, `SELF_FUNCTION_NAME`.

### S3 keys (bucket `ASSETS_BUCKET`, public URL `https://{CDN_DOMAIN}/{key}`)

- `web/**` SPA build; `web/config.json` = `{"region","userPoolId","clientId"}`.
- `runtime/v1/{index.html,runtime.js,shooter.js,rpg.js,gamespec.js}` game runtime (uploaded by deploy script).
- `sessions/{sessionId}/{assetId}.{jpg|png|mp4|glb|json}` generated assets.
- `games/{gameId}/` = runtime files copied from `runtime/v1/` + `spec.json` + `release.json` (only after publish) + `assets/{ipId}.png` sprites.
- Deadline exchange: inputs read straight from `ASSETS_BUCKET`; outputs written by the worker to `s3://{QUEUE_BUCKET}/{QUEUE_PREFIX}/{jobId}/` then copied by the Lambda into `sessions/{sessionId}/`.
- Bedrock video output: `s3://{VIDEO_BUCKET}/{sessionId}/{jobId}/` (Bedrock appends `{invocationId}/output.mp4`).

### DynamoDB table `ipverse-main` (`pk` S, `sk` S), items

| item | pk | sk | attributes |
|---|---|---|---|
| Session | `SESSION#{sessionId}` | `META` | sessionId, userSub, title, genre, concept `{title, logline, style, palette:[hex,hex,hex]}`, createdAt, updatedAt |
| UserIndex | `USER#{sub}` | `SESSION#{createdAt}#{sessionId}` | sessionId, title, genre, createdAt |
| Message | `SESSION#{sessionId}` | `MSG#{ts}#{messageId}` | messageId, role `user|assistant`, text, status `pending|done|failed`, toolEvents `[{tool, summary, ts}]`, ts, claimedAt? |
| IP | `SESSION#{sessionId}` | `IP#{ipId}` | ipId, kind `character|prop`, name, description, role, imageAssetId, cutoutAssetId, glbAssetId?, turntableAssetId?, posterAssetId?, version (int), createdAt |
| Asset | `SESSION#{sessionId}` | `ASSET#{assetId}` | assetId, kind `image|cutout|glb|turntable|poster|shot|trailer|shorts`, key, url, contentType, ipId?, jobId?, meta `{}`, createdAt |
| Job | `SESSION#{sessionId}` | `JOB#{jobId}` | jobId, kind `render3d|shot|trailer`, provider `deadline|bedrock_video|ffmpeg`, status `queued|running|done|failed`, externalId?, input `{}` (trailer: `extra_asset_ids?`), outputs `[assetId]`, deps `[jobId]`, progress (str), error?, rev (int, optimistic lock), throttledAt?, statusErrorSince?, createdAt, updatedAt |
| Game | `SESSION#{sessionId}` | `GAME#{gameId}` | gameId, title, genre, specKey, previewUrl, publishedUrl?, adAssetId?, createdAt, publishedAt? |

Genre values everywhere: `sf-shooter | sf-survival | rpg-explore | rpg-quest`.

### HTTP API (Lambda Function URL behind CloudFront `/api/*`; JSON; header `X-Auth-Token: <Cognito AccessToken>`)

| method path | body | response |
|---|---|---|
| `GET /api/health` | – | `{"ok":true}` (no auth) |
| `POST /api/sessions` | `{title?, genre?}` | `201 {session}` |
| `GET /api/sessions` | – | `{sessions:[{sessionId,title,genre,createdAt}]}` newest first |
| `GET /api/sessions/{id}` | – | snapshot (below); advances jobs first |
| `POST /api/sessions/{id}/chat` | `{text}` | `202 {messageId}`; agent turn runs async |
| `PATCH /api/sessions/{id}` | `{genre?, title?}` | snapshot |
| `POST /api/sessions/{id}/tools/{tool}` | tool args JSON | `{result}`; runs one tool directly (plugin path) |
| `POST /api/sessions/{id}/publish` | `{gameId, adAssetId?, skipAfterSec?}` | `{publishedUrl}` |

Snapshot = `{"session":{...},"messages":[...],"ips":[...],"assets":[...],"jobs":[...],"games":[...]}` sorted by createdAt ascending. Errors: `{"error": "<code>", "message": "<text>"}` with 400/401/404/500. Unauthorized → 401 `{"error":"unauthorized"}`.

### Agent tools (Converse `toolSpec` names and input schemas)

| tool | input | effect / return |
|---|---|---|
| `set_concept` | `{title, logline, style, palette:[hex x3], genre}` | updates Session.concept and genre; returns concept |
| `create_ip_asset` | `{kind: character\|prop, name, description, role?, image_model?, reference_ip_id?}` | sync: Krea 2 Turbo / FLUX.2 klein 9B (MCP, png) or Stable Image Ultra (1:1, jpeg) → remove background (png) → IP + 2 Assets; returns `{ipId, imageUrl, cutoutUrl, imageModel}` (see As built) |
| `render_3d` | `{ipId}` | Job kind `render3d` provider `deadline`; returns `{jobId}` |
| `make_video_shot` | `{ipId, prompt, aspect_ratio: "16:9"\|"9:16", duration: "5s"\|"9s"}` | Job kind `shot` provider `bedrock_video` (frame0 = IP image); returns `{jobId}` |
| `cut_trailer` | `{shot_job_ids:[...], title, subtitle, lut: "teal-orange"\|"warm"\|"noir"\|"none", include_turntable_ip_id?, make_shorts: bool}` | Job kind `trailer` provider `ffmpeg` with deps; runs when deps done; returns `{jobId}` |
| `make_game` | `{spec: GameSpecInput}` | validates, resolves sprite URLs from ipIds, writes `games/{gameId}/`; returns `{gameId, previewUrl}` |
| `publish_game` | `{gameId, ad_asset_id?, skip_after_sec?: int}` | writes `release.json`; returns `{publishedUrl}` |

The agent system prompt carries a compact state summary (ips with ids, assets with ids/kinds, jobs with status, games) so tools receive real ids. Max 8 tool rounds per turn.

### GameSpec v1 (`spec.json`)

```json
{
  "version": 1,
  "title": "루나의 궤도 탈출",
  "genre": "sf-shooter",
  "palette": {"bg": "#0b0d12", "accent": "#5de6cf", "text": "#f5f7fa"},
  "player": {"ipId": "ip_123", "name": "루나", "spriteUrl": "assets/ip_123.png", "speed": 2},
  "props": [{"ipId": "ip_456", "name": "플라즈마 코어", "spriteUrl": "assets/ip_456.png", "effect": "score"}],
  "enemies": [{"name": "드론", "color": "#ff5a5a", "shape": "triangle", "speed": 2, "hp": 1}],
  "objective": {"type": "kills", "target": 15},
  "difficulty": "normal",
  "dialogue": [{"speaker": "루나", "text": "..."}],
  "quest": {"giverName": "...", "itemName": "...", "itemPropIndex": 0, "completeText": "..."},
  "map": {"width": 20, "height": 15, "seed": 1234}
}
```

Rules (identical in `server/gamespec.py` and `game/gamespec.js`): `version==1`; `genre` in the 4 values; `objective.type` ∈ `kills|survive` for `sf-*`, `collect|talk` for `rpg-*`; `objective.target` int 1–200; `player.speed`, enemy `speed` int 1–3; enemy `hp` int 1–3; `shape` ∈ `triangle|circle|square`; `props[].effect` ∈ `heal|score|shield|key`; `difficulty` ∈ `easy|normal|hard`; `enemies` 1–5 items (sf only, optional for rpg); `dialogue` 0–12 lines, each text ≤ 140 chars; `map.width` 12–30, `map.height` 9–20; hex colors `^#[0-9a-fA-F]{6}$`. `GameSpecInput` (what the agent sends) is the same shape minus `spriteUrl` fields; the server fills them. `release.json` = `{"publishedAt": iso, "ad": {"videoUrl": url, "skipAfterSec": 5} | null}`.

### Blender relief worker CLI (fixed)

```
blender -b --factory-startup -noaudio --python-exit-code 1 --python workers/blender_relief.py -- \
  --image IN.png --out OUTDIR --frames 48 --width 1280 --height 720 --samples 16 --thickness 0.12 --accent "#5de6cf"
```

Writes `OUTDIR/frames/0001.png … {frames:04d}.png`, `OUTDIR/model.glb`, `OUTDIR/poster.png` (copy of frame 1), `OUTDIR/meta.json` `{"frames", "width", "height", "verts", "faces"}`.

### Deadline job (JSON OpenJD template, `templateType="JSON"`)

Parameters: `InputUri` (s3 uri of the cutout PNG, staged by the provider to `s3://{QUEUE_BUCKET}/{QUEUE_PREFIX}/{jobId}/inputs/cutout.png` because the queue role's S3 scope is limited), `OutputPrefix` (s3 uri, no trailing slash), `Frames` INT, `Width` INT, `Height` INT, `Samples` INT, `Accent` STRING, `CondaPackages` default `"blender python boto3 ffmpeg"`, `CondaChannels` default `"deadline-cloud conda-forge"`. One step `Render`, one task: embedded `Run` script downloads the input, runs blender with embedded `Relief` script (the exact content of `workers/blender_relief.py`), encodes `turntable.mp4` (24 fps, libx264, yuv420p, `-movflags +faststart`), uploads `turntable.mp4`, `model.glb`, `poster.png`, `meta.json` to `OutputPrefix/`.

### JobProvider interface (`server/providers/base.py`)

```python
class JobProvider(Protocol):
    name: str
    def submit(self, job: dict, ctx: "Ctx") -> str: ...          # returns externalId
    def status(self, job: dict, ctx: "Ctx") -> tuple[str, str]: ...  # ("running"|"done"|"failed", progress_text)
    def collect(self, job: dict, ctx: "Ctx") -> list[dict]: ...  # asset dicts to store (kind, key, contentType, meta)
```

`Ctx` is a dataclass holding env config and boto3 clients (`s3`, `ddb` table, `bedrock_rt_east`, `bedrock_rt_west`, `deadline`, `lambda_`) so tests can inject fakes.

### Frontend API client (`web/src/api.ts`)

`login(username, password): Promise<void>`, `listSessions()`, `createSession(title?, genre?)`, `getSession(id)`, `sendChat(id, text)`, `patchSession(id, {genre})`, `publishGame(id, {gameId, adAssetId?, skipAfterSec})`. `diffJobs(prev: Job[], next: Job[]): ToastEvent[]` is a pure function (`{level: 'ok'|'error', text}`), one event per job whose status became `done` or `failed`.

## Review Focus

1. Agent turn fails mid-way (model error, tool exception): the assistant Message must end `failed` with a Korean error text, never stay `pending` → Task 4 test `test_run_turn_marks_failed_on_tool_error`.
2. Deadline job cold start > 10 min or `FAILED`: job rows must show elapsed time and the failure reason, trailer job must not run with a missing turntable → Task 4 tests `test_trailer_waits_for_deps`, `test_advance_marks_failed_dependency`.
3. GameSpec from the model with wrong genre/objective combination or bad hex: server rejects with a clear message and the agent retries; the runtime never crashes on a hand-edited spec → Task 2 test `rejects wrong objective for genre`, Task 4 test `test_make_game_rejects_invalid_spec`.
4. Expired Cognito token during a long demo: every API call maps 401 → re-login prompt, not a blank screen → Task 5 test `api 401 clears token and surfaces relogin`.
5. ffmpeg on a 9:16 shot mixed with 16:9 shots: trailer scales/crops every input to 1280×720 so concat never fails → Task 3 test `test_trailer_pipeline_mixed_aspect_inputs` (real ffmpeg on synthetic clips).

---

### Task 1: Blender relief worker + Deadline template

**Files:**
- Create: `workers/blender_relief.py`, `workers/deadline_relief_template.json`, `workers/make_fixture.py`, `workers/tests/test_relief_local.py`, `workers/tests/test_template.py`, `workers/README.md`

**Interfaces:**
- Produces: the CLI in Shared contracts; `workers/deadline_relief_template.json` whose embedded `Relief` file data must be kept identical to `workers/blender_relief.py` (test enforces it); function `load_template() -> dict` in `workers/template_loader.py` used by Task 3 (`server/providers/deadline.py` imports it by path copy: the deploy packaging copies `workers/*.py` and the JSON into the Lambda bundle as `server/workers/`).

- [ ] **Step 1: Write `workers/make_fixture.py`** — stdlib-only PNG writer: `write_cutout_png(path: str, size: int = 96) -> None` writes an RGBA PNG with a filled circle-plus-rectangle "character" (opaque, colored) on transparent background (zlib + struct, no Pillow).
- [ ] **Step 2: Write the failing local test `workers/tests/test_relief_local.py`** (skipped unless Blender exists at `/Applications/Blender.app/Contents/MacOS/Blender` or `$BLENDER`):

```python
def test_relief_produces_frames_glb_poster(tmp_path):
    png = tmp_path / "cutout.png"; write_cutout_png(str(png))
    out = tmp_path / "out"
    run_blender(["--image", str(png), "--out", str(out), "--frames", "3", "--width", "320", "--height", "180", "--samples", "4", "--thickness", "0.12", "--accent", "#5de6cf"])
    assert sorted(p.name for p in (out / "frames").iterdir()) == ["0001.png", "0002.png", "0003.png"]
    assert (out / "model.glb").stat().st_size > 1000
    assert (out / "poster.png").exists()
    meta = json.loads((out / "meta.json").read_text())
    assert meta["frames"] == 3 and meta["faces"] > 50
```

- [ ] **Step 3: Run it to see it fail** — `python3 -m pytest workers/tests/test_relief_local.py -v` → FAIL (script missing).
- [ ] **Step 4: Implement `workers/blender_relief.py`** (argparse after `--`). Algorithm: load image → `pixels.foreach_get` → alpha mask (≥0.5), downsample to ≤96 cells wide; build one quad per covered cell with `bmesh` (vertices on a grid, remove doubles), `dissolve_limit`, Smooth modifier (2 iterations), Solidify (thickness × object height), Bevel (small), shade smooth; UV = cell position / grid size; material A (front/back faces): Principled with the image as Base Color; material B (side faces created by Solidify, via `material_offset=1`): flat `--accent`; scene: camera looking at origin from +Y-ish at 35°, 3 area lights, dark ground plane, world color `#0b0d12`; turntable: object Z rotation `frame/frames*360`; Cycles CPU, `samples`, OpenImageDenoise; render frames; copy frame 1 → `poster.png`; export GLB with `bpy.ops.export_scene.gltf(export_format="GLB")`; write `meta.json`. Must run on Blender 4.2+ and 5.x (no compositor, no add-ons).
- [ ] **Step 5: Run the test to pass** — `python3 -m pytest workers/tests/test_relief_local.py -v` → PASS (takes < 2 min).
- [ ] **Step 6: Write the failing template test `workers/tests/test_template.py`**:

```python
def test_template_embeds_current_relief_script():
    t = load_template()
    relief = next(f for f in t["steps"][0]["script"]["embeddedFiles"] if f["name"] == "Relief")
    assert relief["data"] == Path("workers/blender_relief.py").read_text()
    names = {p["name"] for p in t["parameterDefinitions"]}
    assert names >= {"InputUri", "OutputPrefix", "Frames", "Width", "Height", "Samples", "Accent", "CondaPackages", "CondaChannels"}
    assert t["specificationVersion"] == "jobtemplate-2023-09"
```

- [ ] **Step 7: Write `workers/deadline_relief_template.json` and `workers/template_loader.py`** — `load_template() -> dict` reads the JSON and replaces the `Relief` embedded file data with the current `blender_relief.py` text (so the JSON holds a placeholder `"@@RELIEF@@"`). `Run` script (embedded, Python, boto3): parse argv `(input_uri, output_prefix, frames, width, height, samples, accent, relief_path)`, download input, `blender -b --factory-startup -noaudio --python-exit-code 1 --python {relief} -- ...` with `PYTHONPATH`/`PYTHONHOME` stripped from env, `ffmpeg -y -framerate 24 -i frames/%04d.png -c:v libx264 -pix_fmt yuv420p -movflags +faststart turntable.mp4`, upload 4 files with content types (`video/mp4`, `model/gltf-binary`, `image/png`, `application/json`). Step actions: `onRun: command: python, args: ["{{Task.File.Run}}", "{{Param.InputUri}}", "{{Param.OutputPrefix}}", "{{Param.Frames}}", "{{Param.Width}}", "{{Param.Height}}", "{{Param.Samples}}", "{{Param.Accent}}", "{{Task.File.Relief}}"]`. Conda packages/channels parameters exactly as in Shared contracts (the queue's Conda environment reads `CondaPackages`/`CondaChannels`).
- [ ] **Step 8: Run both tests** — `python3 -m pytest workers -v` → PASS.
- [ ] **Step 9: Write `workers/README.md`** (how to run locally, how the Deadline job maps params) and commit: `git add workers && git commit -m "feat(workers): Blender relief turntable worker and Deadline template"`.

### Task 2: Phaser game runtime (static)

**Files:**
- Create: `game/index.html`, `game/runtime.js`, `game/gamespec.js`, `game/shooter.js`, `game/rpg.js`, `game/test/gamespec.test.mjs`, `game/README.md`, `game/dev/spec-sf.json`, `game/dev/spec-rpg.json`, `game/dev/assets/*.png` (two tiny placeholder sprites made with a stdlib PNG writer or copied from Task 1 fixture)

**Interfaces:**
- Consumes: GameSpec v1 and `release.json` (Shared contracts). Relative fetches: `./spec.json`, `./release.json`, sprite `spriteUrl` relative to the game folder.
- Produces: `gamespec.js` exporting `validateSpec(spec) -> {ok: true, spec} | {ok: false, errors: string[]}` and `defaultSpec(genre)`; usable from browser (`<script type="module">`) and Node (`import`). `runtime.js` boots: load spec + release → ad gate → `new Phaser.Game` with scene by genre prefix.

- [ ] **Step 1: Write failing `game/test/gamespec.test.mjs`** (`node --test game/test`): cases `accepts the dev sf spec`, `accepts the dev rpg spec`, `rejects wrong objective for genre` (`sf-shooter` + `collect` → error mentions `objective.type`), `rejects bad hex`, `rejects enemy speed 4`, `defaultSpec("rpg-quest") validates`.
- [ ] **Step 2: Run → FAIL** (`gamespec.js` missing).
- [ ] **Step 3: Implement `game/gamespec.js`** per the rules table (pure functions, no Phaser import).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Implement `game/index.html` + `game/runtime.js`**: Phaser 3 from `https://cdn.jsdelivr.net/npm/phaser@3.87.0/dist/phaser.min.js`; `index.html` has a 960×540 canvas container scaled to fit (`Phaser.Scale.FIT`), a HUD div, an ad overlay `<div id="ad" hidden><video playsinline autoplay muted></video><button id="skip"></button></div>`. `runtime.js`: fetch `./spec.json` (validate; on failure render the errors in the page and stop), fetch `./release.json` (404 → `null`), if `release.ad` show the overlay, enable the skip button after `skipAfterSec` ("광고 건너뛰기"), start the game on skip or `ended`; genre `sf-*` → `ShooterScene`, `rpg-*` → `RpgScene`; common HUD text (objective progress), win/lose overlay with "다시 시작" (restarts the scene), palette applied via CSS vars and Phaser background color.
- [ ] **Step 6: Implement `game/shooter.js`**: player sprite from `player.spriteUrl` (scaled to 72px height), WASD/arrows move, space/auto-fire bullets, enemies spawn from top as generated-texture shapes (`shape`, `color`) with `hp` and `speed`, props drop occasionally (`effect`: score +100, heal +1 life, shield 5s, key = score +250), 3 lives, objective `kills` (count) or `survive` (seconds). Difficulty scales spawn interval (easy 1400ms, normal 1000ms, hard 700ms).
- [ ] **Step 7: Implement `game/rpg.js`**: procedural tile map from `map.seed` (mulberry32 PRNG; walls on the border plus ~12% random walls, guaranteed open 3×3 at start), grid movement (one tile per keypress, 32px tiles), NPC (second IP sprite if present else accent circle) placed ≥6 tiles away, props placed on floor tiles; objective `talk`: press E/space next to NPC → dialogue lines from `dialogue` then `quest.completeText` → win; `collect`: pick up `objective.target` props → win; `rpg-quest` additionally requires the `quest.itemPropIndex` prop before talking completes.
- [ ] **Step 8: Browser smoke** — `python3 -m http.server 8099 --directory game` then open `http://localhost:8099/index.html?spec=dev/spec-sf.json` (runtime honors `?spec=` and `?release=` query params for dev only) with the `agent-browser` skill or Playwright: assert the canvas exists and the HUD shows the objective text, for both dev specs. Record the two screenshots in `game/dev/`.
- [ ] **Step 9: Commit** — `git add game && git commit -m "feat(game): spec-driven Phaser runtime with SF shooter, RPG scenes and ad gate"`.

### Task 3: Server providers (Bedrock image/video, Deadline, ffmpeg)

**Files:**
- Create: `server/providers/__init__.py`, `server/providers/base.py` (Ctx, JobProvider Protocol, `s3_key_for(session_id, asset_id, ext)`), `server/providers/bedrock_image.py`, `server/providers/bedrock_video.py`, `server/providers/deadline.py`, `server/providers/ffmpeg.py`, `server/providers/griptape.py` (see Task 7), `server/tests/conftest.py` (fake clients), `server/tests/test_bedrock_image.py`, `server/tests/test_bedrock_video.py`, `server/tests/test_deadline.py`, `server/tests/test_ffmpeg.py`

**Interfaces:**
- Consumes: Task 1 `load_template()` (import from `server.workers.template_loader`; Task 6 packaging copies `workers/` into `server/workers/`; for local tests add `server/workers` as a symlink to `../workers`).
- Produces:
  - `bedrock_image.generate_image(ctx, prompt: str, negative: str, seed: int, aspect_ratio: str = "1:1", output_format: str = "jpeg") -> bytes`
  - `bedrock_image.remove_background(ctx, image_bytes: bytes) -> bytes` (PNG with alpha)
  - `bedrock_video.BedrockVideoProvider` (`name="bedrock_video"`): `submit` → `start_async_invoke` with `keyframes.frame0` base64 of `job["input"]["imageKey"]` object, `outputDataConfig.s3OutputDataConfig.s3Uri = s3://{VIDEO_BUCKET}/{sessionId}/{jobId}/`; `status` → `get_async_invoke` (`Completed→done`, `Failed→failed` with `failureMessage`); `collect` → find `*.mp4` under the prefix, `copy_object` into `sessions/{sessionId}/{assetId}.mp4`, return `[{"kind":"shot", ...}]`.
  - `deadline.DeadlineProvider` (`name="deadline"`): `submit` → `create_job(farmId, queueId, template=json.dumps(load_template()), templateType="JSON", parameters={...}, priority=50, maxRetriesPerTask=1)` returns `jobId`; `status` → `get_job` (`taskRunStatus SUCCEEDED→done`, `FAILED|CANCELED→failed`, `lifecycleStatus *_FAILED→failed`, else running with progress `"{taskRunStatus} · {elapsed}"`); `collect` → copy `turntable.mp4`, `model.glb`, `poster.png` from `{QUEUE_BUCKET}/{QUEUE_PREFIX}/{jobId}/` into `sessions/{sessionId}/` and return 3 asset dicts (`turntable`, `glb`, `poster`).
  - `ffmpeg.grade_filter(lut: str) -> str`; `ffmpeg.build_shot_cmd(ffmpeg_bin, src, dst, lut) -> list[str]`; `ffmpeg.build_card_cmd(ffmpeg_bin, dst, title, subtitle, seconds, font_path, bg_hex) -> list[str]`; `ffmpeg.build_concat_cmd(ffmpeg_bin, list_path, dst) -> list[str]`; `ffmpeg.build_shorts_cmd(ffmpeg_bin, src, dst) -> list[str]`; `ffmpeg.render_trailer(ffmpeg_bin, ffprobe_bin, font_path, workdir, shots: list[str], title, subtitle, lut, make_shorts) -> dict(trailer=path, shorts=path|None, seconds=float)`; `ffmpeg.FfmpegProvider` (`name="ffmpeg"`): `submit` downloads dep outputs to `/tmp`, runs `render_trailer`, uploads `trailer.mp4` (+ `shorts.mp4`), returns `"local"`; `status` → `("done", "")`; `collect` returns the asset dicts recorded on `job["result"]`.

- [ ] **Step 1: Write `server/tests/conftest.py`** — `FakeS3` (dict store: `put_object`, `get_object`, `copy_object`, `list_objects_v2`, `download_file`, `upload_file`), `FakeBedrockRT` (scripted responses), `FakeDeadline` (`create_job`→`{"jobId":"job-1"}`, `get_job` scripted), `make_ctx(**fakes)`.
- [ ] **Step 2: Write failing tests** — `test_generate_image_builds_request_and_decodes` (asserts modelId, body fields `prompt`, `aspect_ratio`, `seed`, `output_format`, decodes `images[0]`), `test_remove_background_accepts_image_or_images_key`, `test_video_submit_uses_frame0_and_output_uri`, `test_video_collect_copies_mp4`, `test_deadline_submit_parameters_types` (INT params as `{"int": "48"}`, strings as `{"string": ...}`), `test_deadline_status_mapping` (parametrized), `test_deadline_collect_copies_three_assets`, `test_grade_filter_names` (4 LUTs, `none` → `null`), `test_trailer_pipeline_mixed_aspect_inputs` (REAL ffmpeg: create two `testsrc2` clips 1280×720 and 720×1280, 1s each, run `render_trailer` with title "테스트", lut `teal-orange`, shorts True; assert both outputs exist and `ffprobe` duration ≈ 2 + 2.5 + 2 ± 0.3 s; skipped if no `ffmpeg` on PATH).
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement the five modules.** Stability request body: `{"prompt","negative_prompt","aspect_ratio","seed","output_format"}`; response `images[0]` base64. Remove-background body `{"image": b64, "output_format": "png"}`; accept response key `image` or `images[0]`. Grade filters: `teal-orange` → `colorbalance=rs=.08:bs=-.08:rm=.02:bm=-.02:rh=-.05:bh=.08,eq=contrast=1.08:saturation=1.15`; `warm` → `colorbalance=rs=.1:bs=-.1,eq=brightness=0.02:saturation=1.1`; `noir` → `hue=s=0,eq=contrast=1.25:brightness=-0.03`; `none` → `null`. Shot command: `-vf "{grade},scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=24" -an -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p`. Card: `-f lavfi -i color=c={bg}:s=1280x720:d={seconds}` + two `drawtext` (fontsize 72 / 36, white, centered, `fontfile`). Concat: concat demuxer `-f concat -safe 0 -i list.txt -c copy -movflags +faststart`. Shorts: `-vf "crop=ih*9/16:ih,scale=720:1280"`. Font fallback: if `font_path` missing, omit `fontfile` (ffmpeg default font) so local tests pass.
- [ ] **Step 5: Run → PASS** (`python3 -m pytest server/tests -v`).
- [ ] **Step 6: Live check (optional, `LIVE=1`)** — `server/tests/test_live_bedrock.py`: one real `generate_image` (seed 7, prompt "a small friendly robot mascot, white background") and `remove_background`; asserts PNG signature and alpha channel present (parse IHDR color type 6). Run once with `LIVE=1 python3 -m pytest server/tests/test_live_bedrock.py -v` using the default AWS profile and record the result in the commit message.
- [ ] **Step 7: Commit** — `git add server && git commit -m "feat(server): Bedrock image/video, Deadline and ffmpeg job providers"`.

### Task 4: Server core (store, jobs, GameSpec, agent, tools, router)

**Files:**
- Create: `server/app.py` (handler), `server/auth.py`, `server/store.py`, `server/jobs.py`, `server/gamespec.py`, `server/agent.py`, `server/tools.py`, `server/prompts.py`, `server/tests/test_store.py`, `server/tests/test_jobs.py`, `server/tests/test_gamespec.py`, `server/tests/test_tools.py`, `server/tests/test_agent.py`, `server/tests/test_app.py`, `server/local_dev.py` (runs the handler as a local HTTP server on 8787 with a fake auth user when `LOCAL_DEV=1`)

**Interfaces:**
- Consumes: Task 3 providers and `Ctx`; Shared contracts tables/API/tools/GameSpec.
- Produces:
  - `store.py`: `new_id(prefix) -> str` (`ses_`, `msg_`, `ip_`, `ast_`, `job_`, `gm_` + 10 hex), `put_session/get_session/list_sessions(sub)`, `put_message/update_message`, `put_ip/get_ip/update_ip`, `put_asset`, `put_job/update_job`, `put_game/update_game`, `snapshot(session_id) -> dict`.
  - `jobs.py`: `PROVIDERS: dict[str, JobProvider]`; `create_job(ctx, session_id, kind, provider, input, deps) -> dict`; `advance_jobs(ctx, session_id) -> None` (for each non-terminal job: if `queued` and all deps `done` → `submit` (ffmpeg provider submits = runs) → `running`; if any dep `failed` → `failed` with error "선행 작업 실패"; if `running` → `status`; on `done` → `collect` → `put_asset` each, link to IP fields by asset kind (`turntable→turntableAssetId`, `glb→glbAssetId`, `poster→posterAssetId`), set `outputs`).
  - `gamespec.py`: `validate_spec(spec: dict) -> tuple[dict | None, list[str]]` (normalizes ints, fills `dialogue=[]`, `quest=None`, `map` defaults for rpg), `resolve_sprites(spec, ips_by_id, game_prefix) -> dict` (sets `spriteUrl` to `assets/{ipId}.png`).
  - `tools.py`: `TOOL_SPECS: list[dict]` (Converse toolSpec with JSON schemas from Shared contracts) and `run_tool(ctx, session, name, args) -> dict` dispatching to the 7 tools; `create_ip_asset` prompt template: `"{style}. Full-body character sheet of {name}: {description}. Centered, single subject, neutral studio background, high detail, concept art"` (prop variant: `"... product render of {name}: {description} ..."`), negative `"text, watermark, blurry, multiple subjects, cropped"`; `make_game` copies `runtime/v1/*` and sprites (`cutout` assets) into `games/{gameId}/`, writes `spec.json`; `publish_game` writes `release.json`.
  - `agent.py`: `run_turn(ctx, session_id, message_id) -> None` — loads session snapshot, builds system prompt (`prompts.SYSTEM` Korean, with the state summary and the rule "ids come only from the state"), loops Converse with `toolConfig` up to 8 rounds, appends `toolEvents` to the pending assistant message after each tool, ends with `status=done` and the final text, or `status=failed` + Korean error on exception.
  - `auth.py`: `user_from_event(ctx, event) -> dict | None` (header `x-auth-token` → `cognito-idp.get_user` → `{"sub", "username"}`; cache by token in module dict).
  - `app.py`: `handler(event, context)`: if `event.get("action") == "agent_turn"` → `agent.run_turn`; else route Function URL event (`requestContext.http.method`, `rawPath`) per the API table; `POST /chat` stores user message + pending assistant message and `lambda_.invoke(FunctionName=SELF_FUNCTION_NAME, InvocationType="Event", Payload={"action":"agent_turn", ...})`; `GET /sessions/{id}` calls `advance_jobs` then `snapshot`.

- [ ] **Step 1: Write failing tests** (fake Ctx from Task 3 conftest, `FakeTable` with query/put/update):
  - `test_store_snapshot_sorts_and_groups`
  - `test_create_job_queued_then_submit_on_advance`, `test_trailer_waits_for_deps`, `test_advance_marks_failed_dependency`, `test_collect_links_ip_fields`
  - `test_validate_spec_accepts_minimal_sf`, `test_validate_spec_rejects_rpg_objective_for_sf`, `test_validate_spec_rejects_bad_hex`, `test_resolve_sprites_sets_relative_urls`
  - `test_make_game_rejects_invalid_spec` (returns `{"error": ...}` without writing), `test_make_game_writes_runtime_spec_and_sprites`, `test_publish_game_writes_release_with_ad`, `test_create_ip_asset_stores_two_assets_and_ip`
  - `test_run_turn_calls_tool_and_finishes` (FakeBedrockRT scripted: toolUse → text), `test_run_turn_marks_failed_on_tool_error`
  - `test_app_health_no_auth`, `test_app_rejects_missing_token`, `test_app_chat_returns_202_and_self_invokes`, `test_app_get_session_advances_jobs`
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement modules** in the order store → gamespec → jobs → tools → agent → auth → app.
- [ ] **Step 4: Run → PASS** (`python3 -m pytest server -v`).
- [ ] **Step 5: Local dev server** — `LOCAL_DEV=1 python3 server/local_dev.py` serves the handler on `http://127.0.0.1:8787` with real AWS clients (default profile) and a fixed fake user; document in `server/README.md`.
- [ ] **Step 6: Commit** — `git add server && git commit -m "feat(server): session store, job engine, GameSpec, agent loop and HTTP router"`.

### Task 5: Frontend (React + Vite)

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/public/config.json` (dev placeholder), `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/auth.ts`, `web/src/types.ts`, `web/src/styles.css`, `web/src/components/{Sidebar,TopBar,SplitPanes,IpPane,GamePane,ChatDock,Tabs,Dropdown,Drawer,Toasts,Skeleton,Login}.tsx`, `web/src/mock/mockApi.ts`, `web/src/api.test.ts` (vitest), `web/README.md`

**Interfaces:**
- Consumes: HTTP API and snapshot shape (Shared contracts); `web/config.json` at runtime; Cognito `InitiateAuth` (`USER_PASSWORD_AUTH`) and `REFRESH_TOKEN_AUTH` via `fetch` to `https://cognito-idp.{region}.amazonaws.com/` with header `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth` and `Content-Type: application/x-amz-json-1.1`.
- Produces: `api.ts` functions and `diffJobs` (Shared contracts); dev mode `VITE_MOCK=1` serves a scripted snapshot that progresses jobs on each poll.

UI rules (the ui-vocab build message is final; defaults are the checklist):
- Sidebar Layout: 260px `<nav aria-label="세션 목록">`, "새 세션" button first, sessions newest first with `aria-current="page"` on the open one; ≤1024px icon rail (64px, titles as `title=`), <768px a drawer toggled from the top bar.
- Sticky Header: `<header>` `position: sticky; top: 0`, 56px, shadow class after `scrollY > 0`; a skip link `<a href="#main">본문으로</a>` is the first element in the DOM; contents: session title, concept chip (title · style), genre label, buttons "게임 올리기" and "로그아웃"; mobile: logo + menu button only.
- Split Layout: `main#main` two 50/50 columns, `gap: 48px`, `align-items: stretch`; one column under 768px, IP pane first.
- Tabs (both panes): `role="tablist"`, buttons `role="tab"` with `aria-selected`, `aria-controls`, Left/Right arrow moves focus and selects, underline indicator, hash sync `#ip=<tab>&game=<tab>`; horizontal scroll under 768px.
- Dropdown (genre): custom button + `role="listbox"` list, opens below (flips above near viewport bottom), closes on select/Esc/outside, `aria-haspopup="listbox"`, `aria-expanded`, arrow keys + Enter, first-letter jump; under 640px render a native `<select>`. Options: `sf-shooter` "SF 슈터", `sf-survival` "SF 서바이벌", `rpg-explore` "RPG 탐험", `rpg-quest` "RPG 퀘스트"; change → `PATCH /sessions/{id}`.
- Skeleton: pane placeholders while the first snapshot loads (`aria-busy="true"`, visually hidden "불러오는 중"), 1.5s shimmer, none under `prefers-reduced-motion`; never used for jobs (they show progress text and elapsed time).
- Drawer: right, 400px, `role="dialog" aria-modal="true" aria-labelledby`, focus trapped, Esc and backdrop click close, focus returns to "게임 올리기"; content: game select (default newest), ad radio list (trailer/shorts assets + "광고 없음"), skip seconds (5), "올리기" → `publishGame` → shows URL + "열기" + "복사"; full width under 768px.
- Toast: top-right stack (max 3), 4s auto-dismiss paused on hover, dismiss button, `role="status"` / `role="alert"` for failures; fired from `diffJobs` and after publish.
- Chat dock: bottom, 220px, transcript (user/assistant bubbles, pending assistant shows its `toolEvents` as a progress list), composer (textarea, Enter sends, Shift+Enter newline), disabled while a turn is pending.
- Polling: every 3s while any message is `pending` or any job is `queued|running`, else 10s.
- IP pane tabs: 캐릭터/소품 = cards (image, cutout toggle, name, role, "v{version}") with quick-action buttons that prefill the composer ("{name} 3D로 만들어줘", "{name} 영상 샷 만들어줘"); 3D = `<model-viewer>` (CDN `https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js`, `camera-controls auto-rotate`) per GLB + turntable `<video>`; 영상 = shots, trailer (16:9), shorts (9:16) players with download links.
- Game pane tabs: 미리보기 = `<iframe>` of newest game `publishedUrl ?? previewUrl` + "새 창에서 열기"; 파이프라인 = job rows (kind label, provider, status badge, elapsed, progress text, error); GameSpec = `<pre>` of the newest spec fetched from `spec.json`.
- Theme: dark (`--bg #0e1116`, `--panel #151a22`, `--text #e8ecf2`), accent from `session.concept.palette[0]`.

- [ ] **Step 1: Scaffold** `web/` (`npm create vite` equivalent by hand: react-ts template files), add `vitest` devDependency, `npm install`.
- [ ] **Step 2: Write failing `web/src/api.test.ts`**: `diffJobs` emits one ok event for queued→done, one error event for running→failed, nothing for unchanged; `api 401 clears token and surfaces relogin` (mock `fetch` returning 401 → `getSession` rejects with `AuthError` and `auth.token()` is null).
- [ ] **Step 3: Run → FAIL** (`npx vitest run`).
- [ ] **Step 4: Implement `types.ts`, `auth.ts`, `api.ts`.**
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Implement components and `App.tsx`** per the UI rules; `mockApi.ts` when `import.meta.env.VITE_MOCK === "1"`.
- [ ] **Step 7: Verify** — `npx tsc --noEmit -p web` passes; `VITE_MOCK=1 npx vite --config web/vite.config.ts` and check with the browser: login screen → sessions → chat → both panes populate from the mock; keyboard: Tab reaches skip link first, arrows move tabs, Esc closes drawer. Save a screenshot to `web/dev/mock.png`.
- [ ] **Step 8: Commit** — `git add web && git commit -m "feat(web): IPverse Studio SPA (sidebar, sticky header, split panes, tabs, drawer, toasts, chat dock)"`.

### Task 6: Infra (CDK Python) + deploy script

**Files:**
- Create: `infra/app.py`, `infra/cdk.json`, `infra/requirements.txt`, `infra/stacks/__init__.py`, `infra/stacks/core_stack.py`, `infra/stacks/video_stack.py`, `infra/build_layer.py`, `infra/tests/test_synth.py`, `scripts/deploy.sh`, `scripts/package_server.py`, `scripts/create_demo_user.py`, `scripts/upload_web.py`, `.gitignore`

**Interfaces:**
- Consumes: Lambda env var names (Shared contracts), `server/` + `workers/` packaging, `web/dist`, `game/` runtime.
- Produces: stack outputs `CdnDomain`, `UserPoolId`, `ClientId`, `AssetsBucket`, `ApiFunctionName`; `scripts/deploy.sh` = one command deploy.

- [ ] **Step 1: Write `infra/build_layer.py`** — downloads the BtbN GPL ffmpeg build (has drawtext; skips if cached in `build/`), extracts only `ffmpeg` into `build/ffmpeg-layer/bin/` and UPX-compresses it to stay under the 250 MB layer limit, downloads `NotoSansKR-Bold.otf` from `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf` (fallback `https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf`) into `build/ffmpeg-layer/fonts/`; verifies `ffmpeg -version` runs under `docker run --rm -v ... public.ecr.aws/lambda/python:3.12 /opt/bin/ffmpeg -version` when docker is available.
- [ ] **Step 2: Write `scripts/package_server.py`** — copies `server/*.py`, `server/providers/`, and `workers/{blender_relief.py,template_loader.py,deadline_relief_template.json}` into `build/server/` (as `server/workers/`), excluding tests.
- [ ] **Step 3: Write failing `infra/tests/test_synth.py`** — `cdk synth` via `aws_cdk.App()` + `Template.from_stack`: Core stack has exactly one `AWS::DynamoDB::Table` with `pk`/`sk`, one `AWS::Lambda::Function` with `Runtime python3.12`, `Timeout 300`, `MemorySize 2048`, `EphemeralStorage.Size 2048`, env contains `AGENT_MODEL_ID`; one `AWS::CloudFront::Distribution` whose `CacheBehaviors` include `PathPattern` `/api/*`, `/sessions/*`, `/games/*`, `/runtime/*`; a `AWS::Cognito::UserPoolClient` with `ExplicitAuthFlows` containing `ALLOW_USER_PASSWORD_AUTH`; Video stack has one bucket named `ipverse-video-087967639890-us-west-2`.
- [ ] **Step 4: Run → FAIL.**
- [ ] **Step 5: Implement stacks.** Core (us-east-1): bucket `ipverse-assets-{account}-us-east-1` (block public, CORS GET/HEAD, versioning off, `RemovalPolicy.RETAIN`); table `ipverse-main` PAY_PER_REQUEST; user pool `ipverse-users` (self sign-up off, password policy 12+), client `ipverse-web` (no secret, `USER_PASSWORD_AUTH` + `REFRESH_TOKEN_AUTH`, token validity access 8h via refresh 30d); layer from `build/ffmpeg-layer`; function `ipverse-api` (`Code.from_asset("build/server")`, handler `app.handler`, python3.12, 2048MB, 300s, ephemeral 2048MB, env per Shared contracts, `SELF_FUNCTION_NAME` set via `CfnFunction` override to avoid the circular reference — use the fixed function name); Function URL `auth_type AWS_IAM`, reached only through CloudFront OAC (an account guardrail removes public Lambda URL permissions); IAM: `bedrock:InvokeModel`, `bedrock:Converse`, `bedrock:StartAsyncInvoke`, `bedrock:GetAsyncInvoke` on `*`; `deadline:CreateJob`, `deadline:GetJob`, `deadline:GetQueue` on `arn:aws:deadline:us-east-1:{account}:farm/{farm}/queue/{queue}` and `/job/*` (plus `deadline:ListJobs` on the queue); S3 read/write on the assets bucket, `s3:GetObject/PutObject/ListBucket` on `arn:aws:s3:::ipverse-video-{account}-us-west-2[/*]` and `arn:aws:s3:::griptapenode-queue-087967639890-us-east-1-an[/DeadlineCloud/ipverse/*]`; `cognito-idp:GetUser` on `*`; `lambda:InvokeFunction` on itself (by name ARN); DynamoDB rw on the table. CloudFront: S3 origin with OAC; default behavior origin path `/web`, `CACHING_OPTIMIZED`, SPA rewrite to `/index.html` via a viewer-request CloudFront Function (no 403/404 error responses); behaviors `/sessions/*`, `/games/*`, `/runtime/*` → S3 origin (no origin path), `/api/*` → `FunctionUrlOrigin`, `CACHING_DISABLED`, `ALL_VIEWER_EXCEPT_HOST_HEADER`, allow all methods. Video stack (us-west-2): bucket `ipverse-video-{account}-us-west-2` with a 7-day expiration lifecycle rule.
- [ ] **Step 6: Run → PASS** (`cd infra && python3 -m pytest tests -v`; `pip install -r infra/requirements.txt` first).
- [ ] **Step 7: Write `scripts/deploy.sh`** (set -euo pipefail; steps: build layer → package server → `npx cdk deploy --all --require-approval never --outputs-file build/outputs.json` → `npm --prefix web run build` with `VITE_API_BASE=/api` → `scripts/upload_web.py` (uploads `web/dist` to `web/`, writes `web/config.json` from outputs, uploads `game/*.{html,js}` to `runtime/v1/`, invalidates `/*`) → `scripts/create_demo_user.py` (idempotent: creates user `demo`, random 20-char password, `admin_set_user_password permanent`, stores JSON in Secrets Manager `ipverse/demo-user`, prints the CloudFront URL and the secret name). Also `scripts/smoke.py`: logs in with the secret, creates a session, posts one chat message, polls until the assistant message is `done` or 10 min, prints the snapshot summary.
- [ ] **Step 8: Commit** — `git add infra scripts .gitignore && git commit -m "feat(infra): CDK stacks, ffmpeg layer build and one-command deploy"`.

### Task 7: Griptape Nodes plugin library + platform adapter docs

**Files:**
- Create: `plugins/griptape-ipverse/griptape_nodes_library.json`, `plugins/griptape-ipverse/ipverse_nodes.py`, `plugins/griptape-ipverse/README.md`, `plugins/griptape-ipverse/tests/test_nodes_import.py`, `server/providers/griptape.py`, `server/tests/test_griptape_provider.py`, `docs/griptape-plugin.md`

**Interfaces:**
- Consumes: API `POST /api/sessions/{id}/tools/{tool}` and `GET /api/sessions/{id}` (Shared contracts); `JobProvider` Protocol.
- Produces: nodes `IPverseRunTool` (ControlNode; params `api_base`, `auth_token` (secret), `session_id`, `tool` (choices = the 7 tool names), `args_json`; outputs `result_json`) and `IPverseSessionAssets` (DataNode; params `api_base`, `auth_token`, `session_id`; outputs `assets_json`, `asset_urls` list). `server/providers/griptape.py`: `GriptapeDeadlineProvider` (`name="griptape_deadline"`) that submits a published Griptape workflow folder (`job["input"]["bundleUri"]` s3 prefix) as a Deadline job whose conda packages are `python=3.12 pip` and whose script runs `pip install griptape-nodes-engine` then `python workflow.py`; `status`/`collect` reuse the Deadline logic (import from `deadline.py`). Marked `# ponytail: unexercised live path; the Blender relief job is the live Deadline proof` in code.

- [ ] **Step 1: Write failing `plugins/griptape-ipverse/tests/test_nodes_import.py`** — with a minimal stub package `griptape_nodes` injected into `sys.modules` (classes `ControlNode`, `DataNode`, `Parameter`, `ParameterMode`), import `ipverse_nodes`, instantiate both nodes, assert parameter names; test `IPverseRunTool.process()` with a fake `urlopen` posts to `{api_base}/api/sessions/{sid}/tools/{tool}` with header `X-Auth-Token`.
- [ ] **Step 2: Write failing `server/tests/test_griptape_provider.py`** — `submit` builds a template whose `CondaPackages` default is `python=3.12 pip` and whose `Run` script contains `griptape-nodes-engine`; `status` delegates to Deadline mapping.
- [ ] **Step 3: Run → FAIL; implement; run → PASS.**
- [ ] **Step 4: Write `docs/griptape-plugin.md`**: the verdict, the two directions, install steps (Library Manager → add from path; set `IPVERSE_TOKEN` secret), the limitation list (engine runs on the Mac; Deadline cold start; hardcoded buckets in the user's sandbox nodes), and the upgrade path (publish a Griptape workflow to a folder in S3 → `griptape_deadline` provider).
- [ ] **Step 5: Commit** — `git add plugins server docs && git commit -m "feat(griptape): IPverse custom node library and Griptape-on-Deadline provider"`.

### Task 8: Integration, deploy, end-to-end smoke (lead agent)

**Files:**
- Modify: anything the smoke run breaks. Create: `README.md`, `docs/demo-script.md`, `evidence/` screenshots.

- [ ] **Step 1:** `python3 -m pytest server workers infra -q` and `node --test game/test` and `npx vitest run` all green on the integrated tree.
- [ ] **Step 2:** `scripts/deploy.sh` → record outputs; open the CloudFront URL; log in with the Secrets Manager credentials.
- [ ] **Step 3:** Smoke in the real UI: new session "우주 고양이 탐험가 루나" (genre SF 슈터) → chat "컨셉 잡고 주인공 캐릭터와 핵심 소품 하나 만들어줘" → images appear in 캐릭터/소품 tabs; "루나 3D로 만들어줘" → Deadline job visible in 파이프라인 (allow 10–20 min cold start); "루나 영상 샷 2개 만들고 teal-orange 트레일러랑 숏츠로 잘라줘" → shots then trailer; "게임 만들어줘" → preview iframe playable; Drawer → pick trailer → 올리기 → open published URL → pre-roll plays → skip → game runs. Save screenshots to `evidence/`.
- [ ] **Step 4:** Fix whatever failed; rerun the affected tests; commit each fix.
- [ ] **Step 5:** Write `README.md` (what it is, architecture diagram in text, deploy, demo script pointer, costs and warm-up advice: submit a Blender job 20 minutes before a live demo) and `docs/demo-script.md` (the exact chat lines above with expected waits).
- [ ] **Step 6:** Final commit; report to the user with URLs, what is real vs. mocked (nothing mocked), known limits (relief 3D, Deadline cold start, CPU-only fleet), and the Codex-collision note (this branch lives in the worktree).
