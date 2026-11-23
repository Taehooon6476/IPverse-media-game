# server

Lambda backend for IPverse Studio (Python 3.12, boto3 only). One function, handler `server.app.handler`
(the bundle keeps the `server` package, see `scripts/package_server.py`):

- Function URL HTTP API (`/api/*` behind CloudFront), routed in `app.py`.
- `{"action": "agent_turn", "sessionId", "messageId"}` events: the async chat turn that `POST /chat` self-invokes.
- `{"action": "run_job", "sessionId", "jobId"}` events: an ffmpeg trailer render claimed by a poll, run outside
  the request (`local_dev.py` runs both kinds on a thread in the same process).

| module | job |
|---|---|
| `app.py` | routing, request/response shapes, session ownership check |
| `auth.py` | `X-Auth-Token` → `cognito-idp:GetUser` → `{sub, username}` (cached 5 min per token) |
| `store.py` | DynamoDB single table `ipverse-main` (pk/sk), session snapshot |
| `jobs.py` | job engine: `create_job`, `advance_jobs` (every `GET /sessions/{id}`, optimistic `rev` locking), `run_job` |
| `gamespec.py` | GameSpec v1 validation (same rules and messages as `game/gamespec.js`), sprite URLs |
| `tools.py` | the 9 agent tools + their Converse `toolSpec`s |
| `agent.py`, `prompts.py` | Converse tool-use loop (max 8 rounds) and the Korean system prompt |
| `providers/` | `mcp_client` (JSON-RPC client for both MCP proxies), GPU images (`mediagen_image`: Krea 2 Turbo, FLUX.2 klein 9B), Bedrock image (Stable Image Ultra, background removal), GPU video (`mediagen_video`), legacy Bedrock video, Deadline Cloud, ffmpeg (`JobProvider`: submit/status/collect) |

## Tests

```sh
python3 -m pytest server -v            # from the repo root; fakes only, no network
LIVE=1 python3 -m pytest server/tests/test_live_bedrock.py -v   # one real Bedrock image call
LIVE=1 python3 -m pytest server/tests/test_mediagen_video.py -k live -v   # one real list_video_models call
LIVE=1 python3 -m pytest server/tests/test_mediagen_image.py -k live -v   # one real image list_models call
```

## Local dev server

`server/local_dev.py` serves the same handler on `http://127.0.0.1:8787` (the Vite dev server proxies `/api`
there). It uses real AWS clients from your default profile, skips Cognito (every request is user `local`),
and runs agent turns on a background thread instead of a Lambda self-invoke.

```sh
export TABLE_NAME=ipverse-main
export ASSETS_BUCKET=ipverse-assets-087967639890-us-east-1
export CDN_DOMAIN=<CloudFront domain from build/outputs.json>   # needed locally, see below
export VIDEO_BUCKET=ipverse-video-087967639890-us-west-2
export DEADLINE_FARM_ID=farm-7e90f6ad8b8d4a99a614f5e0db148f36
export DEADLINE_QUEUE_ID=queue-3a8f02c1a75d4bef86411923256597ac
export FFMPEG_BIN=ffmpeg FFPROBE_BIN=ffprobe   # local binaries; an empty FFPROBE_BIN (as on Lambda) reads durations from ffmpeg
LOCAL_DEV=1 python3 server/local_dev.py
```

Asset and game URLs are `https://{CDN_DOMAIN}/{key}`, or root-relative `/{key}` when `CDN_DOMAIN` is empty
(the deployed Lambda may run without it; the SPA and games share the CloudFront origin). Locally the SPA is
served by Vite, so set `CDN_DOMAIN` or root-relative URLs will miss.

Other env vars (model ids, queue bucket/prefix) default to the shared-contract values in
`providers/base.py`. Set `LOCAL_DEV_PORT` if 8787 is taken (then point `web/vite.config.ts` at it).
The stack must be deployed first: the table, bucket and runtime files (`runtime/v1/`) are real.
