# ue5/ — IPverse UE5 template game

One packaged build runs every IPverse game. The only thing that changes per game is the manifest received at launch (GameSpec + signed URLs of the IP GLBs). The design and costs are in [`docs/ue5/design.md`](../docs/ue5/design.md).

## What is made where

| Stage | Where | Details |
|---|---|---|
| Editor content | `Scripts/build_levels.py` (headless editor) | 5 materials (M_NeonGrid, M_Glow, M_Surface, M_Terrain, M_Water) and the empty map `/Game/Ipverse/Maps/Main` |
| World | `AIpverseLevel` (runtime) | `sf-*` neon arena: glowing grid floor, cover, light pillars, skyline. `rpg-*` valley: seeded terrain mesh, lake, tree, rock and grass instances |
| Sky and light | `AIpverseEnvironment` (runtime) | Sun with atmospheric scattering, real-time skylight, volumetric clouds and fog, Lumen GI and reflections, bloom |
| Character | `AIpverseCharacter` | Loads the IP GLB with glTFRuntime and scales it to 1.8 m from the soles. Procedural motion without a rig |
| Game rules | `AIpverseGameMode` | Spawns enemies, props and NPCs; objectives (kills, survive, collect, talk); win and loss; R to restart |
| HUD | `AIpverseHud` | Slate, shows Korean in NanumGothic Bold (OFL) |

The maps are not made by hand in the editor. That is why a new game is made from data alone, without a recook.

## Launch contract

```
IPVERSE_SPEC_URL=<https url>       # StartStreamSession AdditionalEnvironmentVariables (used by the server)
-IpverseSpecUrl=<https url>        # launch argument, takes precedence when present
```

- The manifest v1 example is `manifest.example.json`. The server (`server/streams.py`) writes one per stream to the private `streams/` path and passes a 15-minute presigned URL.
- Without a URL it brings up a demo arena. Use this to check just the build with Test stream in the GameLift Streams console.
- If one GLB fails, only that entity appears as a procedural stand-in model.

## Build (Epic container image, no manual steps)

The prerequisite is the Secrets Manager secret `ipverse/ghcr-token` (us-east-1). Its value is a PAT (`read:packages`) of the GitHub account linked to the Epic account, in the format `{"username","token"}`.

```bash
bash scripts/ue5_build.sh                    # upload the source, start the build box, start the build over SSM → prints the command ID
bash scripts/ue5_build.sh --wait <command-id> # wait until it finishes, then print the tail of the log
```

On the build box (`IpverseUe5Build`, c6i.8xlarge), `Scripts/build.sh` does the following in order.

1. Pulls the highest `dev-slim-5.6.x` tag from `ghcr.io/epicgames/unreal-engine`.
2. Pins glTFRuntime (MIT) to commit `cef7be2` (tag 20260826) and puts it in `Plugins/`, and puts NanumGothic Bold in `Content/Fonts/`.
3. Builds `IpverseGameEditor`, runs `build_levels.py`, then checks for `IPVERSE_LEVELS_OK`.
4. Runs `RunUAT BuildCookRun -platform=Linux -clientconfig=Shipping -cook -stage -pak -iostore -archive`.
5. Uploads `app/` (the GameLift application root), `IpverseGame-Linux.tar.gz` and `build.log` to `s3://ipverse-ue5-builds-087967639890-us-west-2/ipverse-ue5/<version>/`.

The box shuts itself down after 30 minutes when there is no build lock and no running container.

## Registering the stream

```bash
cd infra && npx aws-cdk@latest deploy IpverseStreams -c ue5=1 --exclusively \
  --parameters BuildVersion=<version> --parameters MaxCapacity=1
```

Set `MaxCapacity=0` again when the demo is over.
