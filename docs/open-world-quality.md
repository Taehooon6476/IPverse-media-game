# Moving to a high-quality city game

## The goal and the limits of the mini-game contract

The goal is not a larger small map or another mini-game. It is an open-world game where a rich environment, movement, vehicles, NPCs and missions work together.

Sizes of the three mini-games before the city feature:

| Game | Actual size | Background structures |
|---|---:|---:|
| Forest core exploration (숲의 코어 탐험) | 56 × 48 m | 34 |
| Neon stronghold breakthrough (네온 거점 돌파) | 48 × 48 m | 7 |
| Power facility escape (전력시설 탈출) | 60 × 44 m | 24 |

`server/authored_contract.py` and `game3d/authored-contract.js` limit a world to 100 × 100 m, 48 structures and one NPC. `game3d/authored.js` builds the background from a shared flat floor and primitive shapes. The selected character and prop GLBs do appear and the mission does work, but that alone does not raise the quality of the environment or the game.

Before the change there were no vehicles, no road-based traffic, no paths for many pedestrians and no zone streaming. Each structure created its own window meshes and collision was a linear search, so raising the limits alone would not have solved the rendering, collision and memory problems of a large city.

The on-screen FPS from before the change is not used as performance evidence for a large city either. At that time the FPS display in `world.js` used the clamped simulation `dt`. The new city verification records the real render interval separately, based on `performance.now()`.

## City prototype measurements

These are the results measured after building two cities from the same three owned IPs through the production chat, Bedrock and the game generation tool. Zones, roads, vehicles, missions and color grading differ according to the saved request, and each game links the selected original character, prop and NPC GLBs.

| Generated result | Coastal city by day | Industrial city by night |
|---|---|---|
| Size and buildings | 600×600 m, 209 | 800×600 m, 323 |
| Zones | Downtown, residential, waterfront | Industrial, downtown, residential |
| Selected vehicle | Sedan | SUV |
| Generated mission | Talk to the NPC → drive 140 m → retrieve the core → deliver | Retrieve the core → drive 180 m → deliver |
| Result of real play | All 4 stages completed, 423.14 m driven | All 3 stages completed, 431.07 m driven |

Played with keyboard and mouse input only, the real render interval over the last 1,200 frames was 59.6 fps on average with a p95 of 21.5 ms by day, and 56 fps on average with a p95 of 23.2 ms by night. This is one observation on a single macOS Chromium machine and is no guarantee of performance on a target GPU or with many users.

This is a working Three.js city prototype. The model writes a bounded city data contract, and an engine implemented ahead of time runs it. The environment uses 46 official Kenney CC0 GLBs. It is limited to straight roads, one selected NPC reused, and simple background traffic. It does not provide interiors, large crowds, traffic lights at intersections, realistic vehicles or AAA content production. Nothing here proves an Unreal or MCP run, or automatic production at the level of GTA6.

Evidence files: `evidence/city-generation-live.json` (generation), `evidence/city-play.json` (play), `evidence/city-delivery-live.json` (delivery), `evidence/city-studio-live.json` (studio), `evidence/city-platform-verification.json` (summary). On mobile only display and start were checked. There is no touch driving, and the HUD overlaps in a small window.

## Readiness for a real Unreal run

Status as of 2026-11-01:

| Item | Current status |
|---|---|
| Local Unreal engine | Not found in the standard install paths |
| Epic container access secret `ipverse/ghcr-token` | `DescribeSecret`: `ResourceNotFoundException`; the value was not read |
| Existing `IpverseUe5Build` | `c6i.8xlarge`, stopped |
| Existing `IpverseStreams` | Group active, no default application, capacity 0 |
| GameLift Streams application | The us-west-2 list is empty |
| `ue5/` of the active IPverse | 5.6 source template; no real `.uasset` or `.umap` |

`unreal/OriginNeon` in the parent ORIGIN repository is a separate 5.8 source project. It is not presented as a game that runs in the active IPverse or as a verified Unreal build. The Unreal template of the active IPverse is also built around primitive-shape arenas and canyons, and adding engine access alone does not produce a GTA-style city.

According to the official AWS documentation, gen6n_high currently runs two sessions per GPU, and capacity is configured in units of two. The capacity 1 example in the existing `docs/ue5/design.md` is not used as-is in an execution plan. Real capacity and cost are calculated separately after package play and measurement on the target GPU.

## Production bar for the new deliverable

The first goal is not an automatic copy of the whole scale of GTA6 or of the same production quality. The proposed first deliverable is a city district where the behavior below can actually be verified. The items below are not a list of finished features.

| Area | What to produce | Done when |
|---|---|---|
| City environment | Detailed buildings, roads, sidewalks, street furniture and environment materials with checked licenses. Distinct zones such as residential, commercial and port | Checked with the real play camera; a background made only of an empty floor and shapes is not marked complete |
| World scale | A continuous city district of 0.5–1 km² first, with zone streaming and LOD | Real loads, frame time and collision verified while moving between zones on foot and by car |
| Character IP | The selected character's real skeleton, animation, materials and collision, and the prop attachment | The lineage of the selected IP is kept; an unsupported asset is not silently replaced by a default character |
| Vehicles | Getting in and out, acceleration, braking and steering, vehicle collision and camera | Board → drive → get out confirmed with real keyboard and mouse input |
| City life | Pedestrians on sidewalks and traffic on roads, handling intersections, crossings and obstacles | Paths and collisions of moving NPCs and vehicles observed for real |
| Missions | NPC request → drive between zones → do the objective on site → reward, with failure and restart | Completed from start to finish with real input; the checker does not change the timer, position or objective counters |
| Quality | Lighting, color grading and materials per zone, camera collision and animation transitions | A recording of real play and a visual review; not replaced by concept images or source code |

Epic City Sample is the reference and reuse candidate for a detailed city and its vehicle, pedestrian and traffic systems. Only real content whose download and usage rights, engine version and platform compatibility have been checked is used. Generating every building and vehicle with AI from scratch is not the default path.

The official City Sample requirements call for a Windows/DX12 environment for high-quality rendering. The current Fab distribution also includes 5.8-related features, so no promise is made that the existing IPverse Linux/5.6 build and stream configuration is compatible as it is or gives the same quality. The compatible version and platform of the project actually obtained are checked first, and the build and streaming path is decided after that.

In Unreal, zones are managed with World Partition/HLOD, and Nanite plus the material and lighting setup are evaluated for the detailed environment. Chaos Vehicles is evaluated for vehicles, and the related City Sample systems for city population and traffic. A setting that says a feature is enabled does not prove behavior or performance.

## Connection to the IP platform

The existing IPverse chat, media generation, selected IPs and video ad UI can stay. The game production contract needs an environment kit, zones, roads and their connections, vehicles, NPC roles and paths, and mission stages. Passing a mini-game's v2 world data to Unreal as-is is not presented as finished city production.

The production agent connects to a really installed Unreal Editor, performs the supported operations and saves them. An MCP connection is a connection to an editing tool; it does not stand in for a finished game, vehicle physics, content licenses or a packaged run. Play behavior is saved and built with Blueprint/C++ and real content.

The AWS path can be: the existing build instance → a versioned package in private S3 → GameLift Streams registration → a streaming API that checks the existing authentication and session ownership. The existing build instance is for CPU builds and does not prove game performance on a GPU. Until a real game executable and content exist, the existence of a stream group is not used as evidence that a high-quality game runs.

This is a path available to the current 5.6/Linux project. If City Sample is chosen, the support conditions of the engine and content obtained and of the target Windows/Linux runtime must be checked, and a separate matching streaming configuration used where needed. No decision is made to use the existing group as it is.

## Completion checks and current blockers

1. Confirm an installed engine or an accessible Epic container, and the content rights.
2. Import real content, then save and compile the play logic.
3. Confirm city travel, getting in and out, driving, NPCs, missions, failure and restart in editor play and in a standalone package.
4. Measure the real wall-clock frame time at 1080p on the target GPU. The first goal is a p95 of 33.3 ms or less over 10 minutes of driving. This is a goal, not an achieved result.
5. Register the package on AWS and verify authenticated browser input, video, sound and shutdown.
6. Report the game as complete only after providing a video of real play and a link to run it.

The external input needed now is the path or instance of a usable Unreal work environment, or container access credentials for a GitHub account linked to Epic. The existing build tool uses the `{"username","token"}` contract of AWS Secrets Manager `ipverse/ghcr-token`. The token is never written into chat or documents. Without this access the engine cannot be downloaded or compiled, so the current status is `ENGINE_ACCESS_REQUIRED`.

## Official references

1. Epic City Sample: https://dev.epicgames.com/documentation/en-us/unreal-engine/city-sample-project-unreal-engine-demonstration
2. Epic World Partition: https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine
3. Epic Nanite: https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine
4. Epic Lumen: https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine
5. Epic Chaos Vehicles: https://dev.epicgames.com/documentation/en-us/unreal-engine/vehicles-in-unreal-engine
6. AWS GameLift Streams requirements: https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/applications.html
7. AWS GameLift Streams capacity: https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/stream-groups.html
