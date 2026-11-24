# IPverse Studio

A studio that takes one idea typed into a chat and makes IP images, 3D models, video, a game that plays in the browser, and a live broadcast with per-viewer ads. The left pane is the IP (characters, props, 3D, video), the right pane is the game, and both use the same IP records. A game is data written by the model (GameSpec); the server validates it and a fixed runtime runs it. Code written by the model is never run.

## What you can do

- Make a concept, character and prop images, and variants of the same character through the chat.
- Turn an image into a 3D mesh (GLB), rig it and render a turntable.
- Make and edit video shots, and cut them into a trailer and shorts.
- Pick the cast IPs and their roles, then make and edit a game (3D world with staged missions, open-world city, racing and more).
- Publish a game at a public URL and attach a trailer as an ad before the start and every N rounds.
- Broadcast game play live. You can send trailer ads that differ per viewer, playable ads that viewers play during the broadcast, and highlight clips.
- Run agents defined in natural language on a schedule, and connect external MCP servers as chat tools.

## Architecture

| Service | What it does here |
| --- | --- |
| CloudFront | Serves the web app (`/`), session assets (`/sessions/*`), games (`/games/*`) and runtimes (`/runtime/*`) from S3, and `/api/*` from a Lambda Function URL (AWS_IAM + OAC) |
| Lambda `ipverse-api` | The whole API (Python 3.12). Chat turns, ffmpeg jobs and highlights run by invoking itself asynchronously |
| DynamoDB `ipverse-main` | Single table: sessions, IPs, assets, jobs, games, agents, viewers |
| S3 `ipverse-assets-…` | Web app, session assets, game folders, game runtimes, IVS recordings |
| Cognito `ipverse-users` | Login (`USER_PASSWORD_AUTH`). The API checks the access token in `X-Auth-Token` |
| Bedrock | Chat agent (Converse tool loop), background removal, Stable Image Ultra (optional), highlight analysis (TwelveLabs Pegasus) |
| GPU boxes (mediagen MCP) | Image (Krea 2 Turbo, FLUX.2 klein 9B) and video (LTX-2.5, MiniMax H3, Kandinsky, Wan) generation. Two MCP proxies called over JSON-RPC |
| SQS + EC2 (`IpverseImg3d`) | Image → 3D mesh with Hunyuan3D-2.1. The box is on only while there are jobs |
| Deadline Cloud | Blender turntable render, character rigging |
| ffmpeg Lambda layer | Trailer, shorts and highlight editing, Korean subtitle font |
| Amazon IVS | Sends the play window's game screen to a low-latency channel; viewing, recording, timed metadata, server-side ad insertion |
| MediaTailor | Reads the per-viewer VAST (`/vast/ivs/p-<persona>.xml`) at each IVS ad break and inserts the trailer |
| GameLift Streams (us-west-2) | Playable ads and cloud play: a web player stream group and a UE5 stream group |
| EventBridge | Scheduler advances jobs every minute, checks agents every 5 minutes, and runs each agent's schedule. One rule cleans up live resources every 5 minutes |
| Secrets Manager · SSM | Demo account, IVS playback key, MCP proxy keys |

CDK stacks: `IpverseCore`, `IpverseLive`, `IpverseImg3d` (us-east-1), `IpverseVideo` (us-west-2). `IpverseStreams` and `IpverseUe5Build` are synthesized only with `-c ue5=1`.

## Repository layout

| Path | Contents |
| --- | --- |
| `web/` | React + Vite SPA (studio, play window, watch window, ad page) |
| `server/` | Lambda code: router, agent tools, job engine, live and ads, providers |
| `game/` | Phaser 2D game runtime |
| `game3d/` | three.js 3D game runtime (authored worlds, city, racing) and the CC0 environment asset catalog |
| `workers/` | Blender relief and rigging jobs, Hunyuan3D worker, Electron shell for streams |
| `infra/` | CDK (Python) stacks, ffmpeg layer build |
| `scripts/` | Deploy, one-time setup, smoke and E2E check scripts |
| `plugins/` | Node library for Griptape Nodes (`griptape-ipverse`) |
| `ue5/` | UE5 template game for GameLift Streams |
| `docs/` | Contracts and design documents |
| `evidence/` | Folder where the verification scripts write results and screenshots (not in this copy; running the scripts creates it) |
| `build/` | Build output (git-ignored) and helper scripts |

## Run the web client locally

```bash
npm --prefix web install
npm --prefix web run dev:mock    # VITE_MOCK=1: in-memory fake backend, log in with any id/password
```

To run against the real API, set the environment variables in `server/README.md`, run `LOCAL_DEV=1 python3 server/local_dev.py` (port 8787), then run `npm --prefix web run dev`.

## Tests

```bash
python3 -m pytest server -q                         # fake clients only, no network
python3 -m pytest workers -q
python3 -m pytest plugins -q
node --test game/test/*.test.mjs game3d/test/*.test.mjs
npm --prefix web test                               # vitest
npm --prefix web run typecheck
infra/.venv/bin/python -m pytest infra/tests -q     # venv setup: infra/README.md
```

## Deploy

```bash
bash scripts/deploy.sh
```

What `scripts/deploy.sh` does:

1. `infra/build_layer.py`: assembles the ffmpeg layer.
2. `scripts/package_server.py`: copies `server/` and the worker files to `build/server/` and checks the imports.
3. If the `IpverseCore` stack already exists, uploads the game runtimes (`runtime/v1/`, `runtime3d/v1/`) first.
4. `npx aws-cdk@latest deploy --all` in `infra/`; outputs go to `build/outputs.json`.
5. Sets the `CDN_DOMAIN` environment variable of Lambda `ipverse-api` to the CloudFront domain.
6. `VITE_API_BASE=/api npm --prefix web run build`.
7. `scripts/upload_web.py`: `web/dist` → S3 `web/`, writes `web/config.json`, uploads the game runtimes and the shared animations (`ual.glb`), invalidates CloudFront.
8. `scripts/create_demo_user.py`: creates the Cognito user `demo` and stores the password in Secrets Manager `ipverse/demo-user`.

Things to know:

- The account and regions are fixed in `infra/app.py`. Change them first to deploy to another account.
- Required tools: Python 3, Node, the AWS CLI with a default profile. The CDK CLI is `npx aws-cdk@latest`.
- For live broadcast, run `python3 scripts/setup_ivs_playback_key.py` and `python3 scripts/setup_ivs_ads.py` once, the first time, while the channel is off.
- These are uploaded separately: the 3D worker with `bash scripts/deploy_img3d.sh`, the UE5 build with `bash scripts/ue5_build.sh`, and the web player for streams with `python3 scripts/build_stream_shell.py`.
- There are two helper scripts under `build/`. `build/hl/fix_cdn_env.py` puts `CDN_DOMAIN` back after a `cdk deploy` run outside `deploy.sh` and prints the stream group environment variables. `build/hotpatch_game.py gm_…` copies the current game runtime into a game folder that was already made (a game keeps a copy of the runtime from when it was made).
- Check after deploy: `python3 scripts/smoke.py` (login → session → one chat turn).

## Language toggle

The toggle at the top right of the studio and the login screen switches between 한국어 (Korean) and English. The choice is saved in the browser, and the default is Korean. Server responses and the agent's answers follow the same language (`X-Lang` header).

## Known limits

- There is one IVS channel, shared by all accounts. Only one broadcast runs at a time, and one broadcast lasts at most 45 minutes.
- There is one GPU box per model.
- In-game text and the public ad page are Korean only.

## Documents

- Game contracts: `docs/game-authored-contract.md`, `docs/city-contract.md`, `docs/rig-contract.md`
- City games: `docs/city-generation-method.md`, `docs/city-assets.md`, `docs/open-world-quality.md`
- Ads and streams: `docs/gam-setup.md`, `docs/ue5/design.md`
- Other: `docs/demo-script.md`, `docs/griptape-plugin.md`, `docs/three-game-showcase.md`, `docs/superpowers/`
