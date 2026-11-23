# IPverse Studio — design (demo)

> **As built (2026-10-30).** The shipped demo deviates from this design in these facts:
> - `/api/*` Lambda Function URL uses `AWS_IAM` auth behind CloudFront Origin Access Control (SigV4 signed at the edge); an account guardrail removes public (auth NONE) Lambda URL permissions. Clients send `x-amz-content-sha256` on requests with a body. The Lambda still validates the Cognito access token in `X-Auth-Token`.
> - The layer is the BtbN GPL ffmpeg build (UPX-compressed, has drawtext) plus `NotoSansKR-Bold.otf`. No ffprobe ships (`FFPROBE_BIN=""`); durations are parsed from `ffmpeg -i` stderr.
> - Deadline inputs are staged into `s3://griptapenode-queue-087967639890-us-east-1-an/DeadlineCloud/ipverse/{jobId}/inputs/`.
> - Render defaults are 48 frames / 16 samples.
> - `REMOVE_BG_MODEL_ID=us.stability.stable-image-remove-background-v1:0` (cross-region inference profile).
> - DynamoDB attributes added: Job `rev` (optimistic lock on every job write), `throttledAt`, `statusErrorSince`; Message `claimedAt`; Job input `extra_asset_ids`.
> - CloudFront serves the SPA via a CloudFront Function (viewer-request rewrite to `/index.html`) on the default behavior instead of 403/404 error responses.
> - Video shots run on the account's self-hosted GPU models instead of Luma Ray 2: provider `mediagen_video` calls the mediagen MCP proxy (`VIDEOGEN_MCP_URL`, key in SSM `/mediagen/mcp-api-key`). `make_video_shot` takes `model` (`ltx` default, `minimax-h3`, `kandinsky-6-0-video-pro`) and `duration` in seconds (2–8; 5 for H3/Kandinsky). New tool `animate_character` makes a Wan 2.2 Animate shot driven by an existing shot. Inputs go to the boxes as public CloudFront URLs. mediagen jobs are not serialized per session; `bedrock_video` stays in code for old jobs only.
> - IP images are selectable too: `create_ip_asset` takes `image_model` (`krea` = Krea 2 Turbo, the default for a new IP; `klein9` = FLUX.2 klein 9B, the default when `reference_ip_id` derives the IP from an existing one; `stability-ultra` = the original Bedrock path). Krea and klein run on the storyboard GPU box behind a second MCP proxy (`IMAGEGEN_MCP_URL`, key in SSM `/storyboard-mcp/api-key`). Their 1216×688 PNG is awaited inside the tool call, at most 150 s and never past the agent turn budget. New tool `make_ip_variant` redraws an IP with klein9 from its own image as the next `version`. Image assets record `meta.model`, and the UI shows it.

Date: 2026-10-29. Author: Claude (defaults chosen after the user skipped the clarifying questions; every "default" below is Claude's call, not the user's).

## Intent

One AWS-hosted web demo: the user opens a session, chats one concept, and the result appears in two panes.
The left pane turns the concept into IP (characters and props as images, a 3D asset rendered with Blender,
video shots, a graded trailer and a 9:16 short). The right pane turns the same IP into a playable browser
game in a chosen genre. Publishing the game can attach one of the left pane's videos as a pre-roll ad.
Everything the left and right panes produce refers to the same IP record (id, version, reference image,
cutout, palette, GLB), so the game visibly uses the character the trailer sells.

Reference demo (Media Agent Harness, stack `mediaworks-harness-infra`) is a source of patterns, not a copy
target. Reused from the account: Bedrock models, the Deadline Cloud farm the user already runs Griptape Nodes
jobs on, and the Blender-on-Deadline OpenJD pattern. New: the IP record, the game pipeline, the ad-attached
release, the Griptape plugin boundary.

## Goals / non-goals / anti-goals

Goals
- Real generation on AWS end to end: Stable Image Ultra → background removal → Blender relief turntable + GLB on
  Deadline Cloud → Luma Ray 2 image-to-video → ffmpeg grade + trailer + short → GameSpec → Phaser game → publish
  with ad.
- Chat-driven: a Bedrock Converse tool-using agent (Claude Sonnet 5.5) decides which tools to call.
- Long work is asynchronous: every generation longer than a few seconds is a job with status the UI polls.
- The Griptape Nodes plugin boundary is real code: a provider interface on the platform side and an installable
  custom node library on the Griptape side.

Non-goals (this demo)
- Multiplayer, GameLift, Unity/Unreal, user sign-up, billing, moderation UI.
- A true image-to-mesh model. 3D is a silhouette relief mesh built in Blender from the character cutout
  (upgrade path: Hunyuan3D-2 or TRELLIS on a GPU box behind the same job provider interface).
- Running the Griptape engine server-side. The engine stays on the user's Mac (Desktop app); the plugin library
  calls the platform API.

Anti-goals
- Executing model-written code in the browser. Games are data (GameSpec JSON) run by a fixed runtime.
- Touching or redeploying the existing harness, mediagen GPU boxes or Codex's files in the main checkout.
- Secrets in the repo or in the frontend bundle.

## Constraints

- AWS account 087967639890. Control plane in us-east-1. Bedrock image/video models exist only in us-west-2 for
  this account: `stability.stable-image-ultra-v1:1`, `luma.ray-v2:0`. Background removal
  `stability.stable-image-remove-background-v1:0` exists in us-east-1. Agent model inference profile
  `global.anthropic.claude-sonnet-5-5`.
- Deadline Cloud: farm `farm-7e90f6ad8b8d4a99a614f5e0db148f36`, queue `queue-3a8f02c1a75d4bef86411923256597ac`,
  CPU-only service-managed fleet (16 vCPU, 0–2 workers, Conda queue environment). The queue role can read any
  bucket and write only `s3://griptapenode-queue-087967639890-us-east-1-an/DeadlineCloud/*`.
- Resource names use the prefix `ipverse-` so they cannot collide with Codex's `origin-ip-platform-*` resources.
- Lambda-only backend (Python 3.12, boto3, no third-party packages); ffmpeg (BtbN GPL, UPX, no ffprobe) and a Korean font ship in a layer.
- Frontend: React 19 + Vite + TypeScript, no component library; CSS only. Korean UI copy.
- Local verification tools: Blender 5.1.2 (`/Applications/Blender.app/Contents/MacOS/Blender`), ffmpeg, Python 3.10
  with boto3/pytest/pyyaml, Node 25, CDK CLI via `npx cdk`.

## How it is made (Claude's calls)

- Infra as CDK Python, two stacks: `IpverseCore` (us-east-1) and `IpverseVideo` (us-west-2 bucket for Bedrock
  async output).
- One CloudFront distribution: `/` → S3 `web/` (SPA), `/sessions/*` and `/games/*` and `/runtime/*` → same S3
  bucket, `/api/*` → Lambda Function URL (auth `AWS_IAM` via CloudFront OAC; the Lambda checks the Cognito access
  token sent in the `X-Auth-Token` header via `cognito-idp:GetUser`).
- Chat turns are asynchronous: `POST /chat` stores the user message and self-invokes the Lambda (async) to run
  the agent turn; the UI polls `GET /sessions/{id}` which also advances jobs. No CloudFront timeout exposure.
- One DynamoDB table `ipverse-main` (pk/sk). One S3 bucket `ipverse-assets-{account}-us-east-1`.
- Cognito user pool with one demo user created by the deploy script; password stored in Secrets Manager
  `ipverse/demo-user`.
- Game runtime: Phaser 3 from CDN, two scenes (SF shooter, RPG exploration) driven by `spec.json`; pre-roll ad
  from `release.json`.

## UI (ui-picker build message, final)

- 세션 목록 (새 세션 버튼): Sidebar Layout — 260px, icon rail at ≤1024px, drawer under 768px.
- 상단 바 (세션 제목·컨셉·배포 버튼): Sticky Header — ≤64px, shadow once scrolled, skip link first in DOM.
- 좌/우 결과 화면 2개: Split Layout — 50/50, 48px gap, one column under 768px (IP pane first). Panes stretch to
  full height (the card's vertical centering applies to text-beside-media, not to app panes).
- 좌측 IP 결과물: Tabs — 캐릭터 | 소품 | 3D | 영상, underline indicator, URL hash, arrow keys.
- 우측 게임 장르 선택: Dropdown — SF 슈터 / SF 서바이벌 / RPG 탐험 / RPG 퀘스트.
- 우측 게임 파이프라인·미리보기: Tabs — 미리보기 | 파이프라인 | GameSpec.
- 생성 대기 중 표시: Skeleton — only for loads under 5s; longer jobs show progress text in job rows.
- 광고 영상 붙여서 게임 올리기: Drawer — right, 400px, dialog semantics, focus trap, full width on mobile.
- 생성·배포 완료 알림: Toast — top-right, 4s, max 3, `role="status"` (`alert` for failures).
- Chat: a bottom dock spanning both panes (transcript + composer). Claude's call; not a vocab term.

## Griptape Nodes verdict (delivered to the user in chat)

Plugin-style attachment is feasible in both directions. Platform-side: every long job goes through one
`JobProvider` interface (`submit`, `status`, `collect`), so a Griptape workflow published to a folder and run as
a Deadline Cloud job is just another provider. Griptape-side: a custom node library that calls the platform API
lets a Griptape graph trigger platform jobs and read IP assets. The engine is not made a server dependency.

## Left to the builder

File-level structure, exact CSS, prompt wording, LUT filter values, GameSpec defaults — all in the plan.
