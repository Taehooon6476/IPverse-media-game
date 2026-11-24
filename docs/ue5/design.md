# UE5 + Amazon GameLift Streams design

Status (2026-10-30): the code and infrastructure are ready, and the first build is waiting for the token for the Epic container image (`ipverse/ghcr-token`). Prices were checked with the AWS Price List API on 2026-10-30.

| Component | Location | Status |
|---|---|---|
| Build box `IpverseUe5Build` | us-east-1, c6i.8xlarge, stops itself after 30 minutes idle | Deployed |
| Stream `IpverseStreams` | us-west-2, group `sg-awoQFa2Sf`, gen6n_high, capacity 0 | Deployed (no application) |
| Server `/api/sessions/{id}/stream` | `server/streams.py` | Code and tests done, IpverseCore deployment needed |
| Web Unreal panel | `web/src/components/UnrealStream.tsx` | Code and tests done |
| UE5 game | `ue5/` | Not yet compiled in the container |

The three.js runtime (`game3d/`) is the engine in use right now. The UE5 track is a second runtime for the "photorealistic game" requirement, and it reads the same GameSpec.

## 1. Decision summary

| Item | Decision | Rationale |
|---|---|---|
| Engine | UE 5.6 | The GameLift Streams documentation states UE5 support up to 5.6 [1] |
| Build approach | Package **one** template game once. Per-game differences come from a manifest received at launch | Cooking and packaging per game takes tens of minutes and keeps needing a UE-licensed machine |
| Platform/runtime | **Native Linux package + Ubuntu 22.04 LTS runtime** | No Windows license cost, and it can use a class where 2 sessions share 1 GPU. No Proton compatibility risk either [1][2] |
| Stream class | **gen6n_high** (L4, 4 vCPU, 16GB and 12GB VRAM per session, 2 sessions per GPU) | The cheapest L4 class that can aim for UE5 at 1080p60. gen4n_high is cheaper but is T4 with 8GB VRAM, so decide after a benchmark |
| Region | Primary location us-west-2, optional location ap-northeast-2 (Seoul) | The API endpoint is in us-west-2, and Seoul is a remote location without an endpoint. Turn Seoul on for a Korean audience |
| Capacity | Normally 0. Always-on 1 only during demo hours | Capacity is billed per second while allocated, even when idle [3] |
| Rigging | v1 procedural motion (static mesh), v2 offline auto-rigging | Section 6 below |
| GLB loading | glTFRuntime plugin (open source) | The de facto standard for importing GLB at runtime in a packaged game |
| World authoring | One empty map; C++ generates the sky, terrain and props at runtime | Cut the headless editor work to 5 materials and removed the failure points. The terrain seed also comes from the GameSpec |
| Build | Epic's official container `dev-slim-5.6.x`, run remotely over SSM | Repeatable with no manual steps. Needs only a GitHub token linked to an Epic account |

## 2. Architecture

```
IPverse web (game pane / public page)
  │ 1. Start the pre-roll ad + Web SDK generateSignalRequest()
  │ 2. POST /api/sessions/{id}/stream  {signalRequest}
  ▼
API Lambda (us-east-1)
  │ 3. Build the manifest: GameSpec + GLB presigned URL (15 min) → S3 → manifest presigned URL (15 min)
  │ 4. gameliftstreams:StartStreamSession (us-west-2)
  │      AdditionalEnvironmentVariables = {IPVERSE_SPEC_URL: <manifest url>}
  ▼
GameLift Streams stream group (gen6n_high, Ubuntu 22.04)
  │ 5. Run IpverseGame.sh → UIpverseSpecSubsystem downloads the manifest and GLBs
  │ 6. Build StaticMesh with glTFRuntime → BootGameMode opens the template map for the genre
  ▼
Web: poll GET .../stream/{streamId} → when ACTIVE, signalResponse → processSignalResponse() → attachInput()
```

### Data-driven "game making"

Making a new game involves no recompile and no recook. It uses GameSpec v1 (`server/gamespec.py`), which the agent already produces, as is.

| GameSpec | Meaning in the UE5 template |
|---|---|
| `genre` `sf-shooter`, `sf-survival` | Arena map: a shooter arena based on the Third Person template. kills/survive objectives |
| `genre` `rpg-explore`, `rpg-quest` | OpenWorld map: Landscape field + NPC dialogue + quest tracker. collect/talk objectives |
| `player.ipId`, `props[].ipId` | The GLB mesh of that IP. The template's default mesh when there is none |
| `enemies[]` speed, hp, color | Enemy AI parameters and material tint |
| `props[].effect` | heal, score, shield and key pickup Blueprints |
| `dialogue[]`, `quest`, `objective` | Dialogue widget, quest text, win condition |
| `palette.accent`, `difficulty` | UI accent color and light tint; enemy count and damage multiplier |

The manifest v1 format is `ue5/manifest.example.json`. The launch contract is the `-IpverseSpecUrl=<https url>` launch argument or the `IPVERSE_SPEC_URL` environment variable, and the environment variable is recommended. The limit on an environment variable value is 4096 characters, so a presigned URL fits [4].

## 3. Stream classes and cost

us-west-2 on-demand rates, per 1 unit of stream capacity, checked with the AWS Price List API (`AmazonGameLiftStreams`) [3]:

| Stream class | GPU | Resources per session | USD/hour | Verdict |
|---|---|---|---|---|
| gen6n_medium | L4 1/4 | 2 vCPU, 8GB, 6GB VRAM | 0.3848 | Not enough for UE5 |
| gen4n_high | T4 1/2 | 4 vCPU, 16GB, 8GB VRAM | 0.4982 | Cheapest candidate. Needs a benchmark |
| **gen6n_high** | L4 1/2 | 4 vCPU, 16GB, 12GB VRAM | **0.7127** | **Default** |
| gen5n_high | A10G 1/2 | 4 vCPU, 16GB, 12GB VRAM | 0.7625 | More expensive than gen6n_high |
| gen6n_ultra | Full L4 | 8 vCPU, 32GB, 24GB VRAM | 1.3198 | For a quality upgrade |
| gen4n_win2022 | Full T4 | 8 vCPU, 32GB, 16GB VRAM | 1.5120 | Cheapest Windows alternative |
| gen6n_ultra_win2022 | Full L4 | 8 vCPU, 32GB, 24GB VRAM | 1.8166 | AWS-recommended Windows default [2] |

gen6n_high in Seoul (ap-northeast-2) is USD 0.7975 per hour. Build storage is USD 0.0296 per GB-month (us-west-2).

Cost examples (gen6n_high, us-west-2):

| Scenario | Calculation | Cost |
|---|---|---|
| Demo, 8 hours a day at always-on 1 | 8 × 0.7127 | About USD 5.70 |
| Always-on 1 for a whole month | 730 × 0.7127 | About USD 520 |
| On-demand play, 30 minutes × 100 times | 50 × 0.7127 | About USD 35.6 |

The CloudFormation documentation lists a reference resolution of 1080p and a reference frame rate of 60fps for both gen6n_high and gen4n_high [5]. Whether a real UE5 scene reaches 60fps has not been measured.

**Benchmark criterion.** Start with gen6n_high. Run the same build for 10 minutes on a gen4n_high stream group, and if the p95 frame time at 1080p is 16.7ms or less, move down to gen4n_high. The stream class cannot be changed after creation, so this needs a new stream group [5].

## 4. Capacity modes and cold start

| Mode | Placement timeout [4] | Billing | Use |
|---|---|---|---|
| always-on | 75 seconds | Continuous, even with no session | Scheduled demo hours |
| On-demand (Linux/Proton) | 90 seconds | While a session exists | Normal use |
| On-demand (Windows) | 10 minutes | While a session exists | With the Windows alternative the experience gets much worse |

The expected time to first frame is as follows. **This is an unmeasured estimate.**

- Placement: a few seconds with always-on, up to 90 seconds on demand. The AWS pricing page says scaling beyond the minimum capacity "typically" takes a few minutes [3].
- UE process start, manifest and GLB download, mesh creation: estimated 10–30 seconds.
- The web plays a pre-roll ad meanwhile. The example on the AWS pricing page also uses the pattern of covering the startup wait with a 30-second ad [3].

Decision: normally `MaxCapacity=1`, `AlwaysOnCapacity=0`. Raise `AlwaysOnCapacity` to 1 thirty minutes before a demo starts and lower it to 0 when it ends.

## 5. Backend contract (implemented by the agent that owns server/)

Every route uses the existing Cognito `X-Auth-Token` and checks ownership with `_own_session`. Because of the 29-second API Gateway limit, starting and fetching the connection info are split.

### `POST /api/sessions/{id}/stream`

Request: `{"signalRequest": "<result of Web SDK generateSignalRequest()>"}`

Server behavior:
1. Validate the session's GameSpec again with `validate_spec`. Return 409 on failure.
2. Limit of 1 active stream per user. If one already exists, end that session with `TerminateStreamSession`.
3. Build the manifest. `ips[ipId].glbUrl` is a presigned GET (15 minutes) of the IP's `glbAssetId` object. Store it at `s3://<assets>/ue5/{sessionId}/{uuid}.json` and create a presigned GET (15 minutes).
4. Call `StartStreamSession` (us-west-2):
   ```python
   gls.start_stream_session(
       Identifier=STREAM_GROUP_ID, ApplicationIdentifier=APPLICATION_ID,
       Protocol="WebRTC", SignalRequest=body["signalRequest"],
       UserId=user["sub"],
       AdditionalEnvironmentVariables={"IPVERSE_SPEC_URL": manifest_url},
       Locations=["ap-northeast-2", "us-west-2"],  # put Seoul first only when it is turned on
       SessionLengthSeconds=1800, ConnectionTimeoutSeconds=120,
       DisplayConfiguration={"Resolution": {"Width": 1920, "Height": 1080}},
   )
   ```
5. Store `streamSessionArn` in the session record.

Response 202: `{"streamId": "<last segment of the arn>", "status": "ACTIVATING"}`

### `GET /api/sessions/{id}/stream/{streamId}`

Calls `GetStreamSession`. Response 200: `{"status": "ACTIVATING|ACTIVE|CONNECTED|PENDING_CLIENT_RECONNECTION|ERROR|TERMINATED", "signalResponse": "<only when ACTIVE>", "statusReason": "<when ERROR, e.g. placementTimeout>"}`. The web polls every 2 seconds. On ERROR it falls back to the three.js runtime.

### `POST /api/sessions/{id}/stream/{streamId}/reconnect`

Request: `{"signalRequest": "..."}`. Calls `CreateStreamSessionConnection`. Response 200: `{"signalResponse": "..."}`. Used within `ConnectionTimeoutSeconds` after a tab refresh or a network drop.

### `DELETE /api/sessions/{id}/stream/{streamId}`

Calls `TerminateStreamSession`. Response 204. The web calls it with `fetch(..., {keepalive: true})` when the game pane closes or on `pagehide`. `sendBeacon` is not used because it cannot carry the auth header.

### Server settings and permissions

- Environment variables: `STREAMS_REGION=us-west-2`, `STREAM_GROUP_ID`, `STREAM_APPLICATION_ID`, `STREAM_LOCATIONS`.
- IAM: attach the stream stack output `ApiStreamPolicyArn` (a managed policy) to the API Lambda role. The actions are `StartStreamSession`, `GetStreamSession`, `TerminateStreamSession` and `CreateStreamSessionConnection`, and the resource is limited to that stream group. IAM is global, so it attaches to the us-east-1 Lambda as is.

### Web client

The Web SDK is not an npm package but a bundle downloaded from Resources on the GameLift Streams getting-started page [6]. Check the function names again against the API Reference included in the SDK.

1. `new GameLiftStreams({videoElement, audioElement, clientConnection: {connectionState, channelError, serverDisconnect}})`
2. `generateSignalRequest()` at the same time as the pre-roll ad starts → POST
3. Once polling returns `signalResponse`, `processSignalResponse(signalResponse)` after the ad ends
4. `attachInput()` on the first click. Mouse, keyboard and gamepad attach.

On the public page only logged-in users get the UE5 stream. Visitors who are not logged in see the three.js runtime. A stream is billed per user, so anonymous exposure has no cost ceiling.

## 6. Asset requirements and rigging

The GLB that the current 3D pipeline (a Blender job on Deadline Cloud, `render_3d`) produces is a static mesh without a rig.

**Decision: v1 is procedural motion, v2 is offline auto-rigging.**

- **v1 procedural motion.** Load the IP mesh as a StaticMesh, attach it to the Third Person character capsule and hide the Manny mesh. `UIpverseProceduralMotionComponent` adds a bounce that follows speed, a lean in the direction of travel, a squash on landing and breathing. There are three reasons. Many IPs are props, creatures or non-humanoid, so a humanoid rig does not fit. It works for every IP right now. It has no failure point. The cost is the feel of "a figurine that moves".
- **v2 auto-rigging.** Humanoid IPs only. Add an auto-rigging step after the existing Deadline Blender job to produce a skinned GLB with Mixamo-compatible bone names. On the UE side, reuse the template animations with glTFRuntime skeletal mesh loading and a prebuilt IK Retargeter (Mixamo → UE5 Manny). **Auto-rigging quality and the choice of tool have not been verified.**
- **Why not Mixamo.** It has no public API and needs a manual upload with an Adobe account, so it cannot go into an automated pipeline.

GLB requirements:

- glTF 2.0 binary, Y-up, in meters. The glTFRuntime defaults convert to UE's Z-up centimeters.
- PBR metallic-roughness materials, textures up to 2048px, up to 20MB per GLB, up to 100,000 triangles (recommended, not measured).
- The origin is the center of the soles and the front is +Z (in glTF terms). The template fits the size by the bounds.

## 7. Security

- **Session authentication.** Every stream API checks the Cognito token and session ownership. The Cognito `sub` goes into `UserId` to leave an audit trail.
- **Signed URLs.** The manifest and GLBs are 15-minute presigned GETs. The asset bucket stays private. The game does not log the URLs.
- **Private S3.** The build bucket blocks all public access and allows TLS only. Only `gameliftstreams.amazonaws.com`, under an `aws:SourceAccount` condition, reads `builds/*` and writes `logs/*`.
- **No AWS credentials in the game.** No `RoleArn` is given. The game does not reach AWS other than through presigned URLs.
- **Cost guards.** 1 active stream per user, `SessionLengthSeconds=1800`, the stack's `MaxCapacity` ceiling.
- **IAM least privilege.** The API policy is limited to one stream group and its sessions.

## 8. Infrastructure (`infra/stacks/streams_stack.py`)

It is not in the deploy script or `app.py` and has not been deployed. The synthesis test is `infra/tests/test_streams_stack.py`.

| Resource | Details |
|---|---|
| S3 `ipverse-ue5-builds-<account>-us-west-2` | Packaged builds (`builds/<version>/`) and session logs (`logs/`) |
| `AWS::GameLiftStreams::Application` | Created only when the `BuildVersion` parameter is not empty. UBUNTU 22_04_LTS, `IpverseGame.sh` |
| `AWS::GameLiftStreams::StreamGroup` | `StreamClass` defaults to gen6n_high; `MaxCapacity`, `AlwaysOnCapacity` and `SeoulMaxCapacity` default to 0 |
| `AWS::IAM::ManagedPolicy` | Stream session permissions for the API Lambda |

An update that fills in `DefaultApplication` later applies without interruption. Changing `StreamClass` replaces the stream group and changes its ID, so the server environment variables must change too [5].

## 9. What the user has to do (blockers)

1. **An Epic Games account and acceptance of the Unreal Engine EULA.** Needed to install UE and access the source. An agent cannot do this on the user's behalf.
2. **A UE build machine.** Windows + Visual Studio 2022 + UE 5.6 (with the Linux cross-compile toolchain), or an Ubuntu 22.04 GPU machine with UE built from source.
3. **Template content authoring.** The Arena and OpenWorld maps, the character, enemy and pickup Blueprints, the UI widgets. This is editor work, so a person has to do it, or it has to be done on a machine with UE installed.
4. **Approval of the stream capacity budget.** The default is USD 0. About USD 6 for a demo day, about USD 520 a month for 1 unit always on (gen6n_high, us-west-2).
5. **Region decision.** If the audience is in Korea, turn on the Seoul location (`SeoulMaxCapacity`).
6. **Check the GameLift Streams service quotas.** Not checked in this account.

## Sources

1. Configuration options (runtimes, stream classes): https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/configuration-options.html
2. Configuration selection guide: https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/choosing-configuration.html
3. Pricing (billing model, examples): https://aws.amazon.com/gamelift/streams/pricing/ — the per-class rates come from the AWS Price List API `aws pricing get-products --service-code AmazonGameLiftStreams --region us-east-1`
4. StartStreamSession API: https://docs.aws.amazon.com/gameliftstreams/latest/apireference/API_StartStreamSession.html
5. CloudFormation StreamGroup: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-gameliftstreams-streamgroup.html
6. Web SDK setup: https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/setting-up-web-sdk.html
7. AWS blog on running UE 5.6 with Proton on the Linux runtime (Linux launch conditions: X11, no root): https://aws.amazon.com/blogs/gametech/run-unreal-engine-5-6-with-proton-on-amazon-gamelift-streams-linux-runtime
8. glTFRuntime: https://github.com/rdeioris/glTFRuntime
