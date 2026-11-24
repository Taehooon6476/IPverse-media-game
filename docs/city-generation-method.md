# How the existing IPverse makes a city game

On the authenticated chat path, the characters, props and NPC the user picked and the city request are saved as a GameSpec and run as a Three.js game. **A shared city engine runs declarative data written by the model**; the model does not write a new game engine or arbitrary executable code.

## UI request and server input

The ‘Open-world city’ type and the ‘City core delivery’ preset in `web/src/components/DesignDrawer.tsx` use the existing design drawer. The preset does not change the IPs or roles the user selected. The type is a UI value that composes the prompt; the actual city mode is decided by the saved `version: 2`, `engine: "three"` and `world.city`.

`gameDesignRequest()` serializes the whole design and the selected roles in the following form. The original request also includes `[출연 IP cast_ip_ids=…]` ("cast IPs") and the names and kinds of the selected IPs.

```json
{
  "text": "the whole game request with the space, mission and control conditions",
  "gameDesign": {
    "prompt": "the same full original text as text",
    "castIpIds": ["selected hero ID", "selected prop ID", "selected NPC ID"],
    "playerIpId": "selected hero ID",
    "weaponIpId": null,
    "propIpIds": ["selected prop ID"],
    "enemyIpIds": [],
    "npcIpIds": ["selected NPC ID"]
  }
}
```

It is sent through `App.tsx` → `api.sendChat()` → `POST /api/sessions/{sessionId}/chat`. The server checks session ownership, that the original text matches, the 4,000-character limit, and that the IPs exist with those roles, and saves `gameDesign` on the user message. `npcIpIds` currently holds one kind, and the city pedestrians reuse that NPC IP.

## Actual generation and packaging path

1. The chat API creates a pending assistant message and invokes `agent_turn` of the existing Lambda asynchronously.
2. `server/agent.py` gives Bedrock Converse the real session state and the selected roles the server validated. The model ID is the Lambda environment variable `AGENT_MODEL_ID`.
3. The agent calls `make_game`. The server validates the GameSpec, the city bounds, roads, routes and target references, the staged missions and the cast roles. If a city request has no `world.city`, it is not saved as a small arena; an error is returned. Failed tool calls are also kept in the chat summary record.
4. `make_game` removes the `design` the model wrote and saves the original user request and roles as server provenance. GLB and cutout paths are resolved from the ready IP assets of that session.
5. The trusted shared runtime and the actual selected IP assets are copied to `games/{gameId}/` in S3, and `spec.json`, `release.json` and the game record are saved. The ready rigged GLBs of the character and NPC are used as they are.
6. The existing game pane on the right opens the game record's `previewUrl` in an iframe. The browser runtime reads that game's `spec.json` and runs the city, vehicles, pedestrians and missions. The GameSpec summary reads the saved city data and the driving distance goal and shows them separately from the original request.

The shared environment kit uses `/games/city-kit/v1/city-assets/commonassetcatalog.json` and the assets under it. Selected IPs are copied into the per-game folder, and city buildings, vehicles and street furniture are loaded from the shared CC0 kit, whose sources and licenses are preserved. Making a city game does not start new image, 3D or video jobs.

## Example: two cities made from the same IPs

This is the result of sending two different requests with the same hero, prop and NPC IPs. `scripts/create_city_games.py` clones the owned IP and asset records into a new session and submits the request through the authenticated chat API. The source session and source files are not changed.

| Game as actually saved | Daytime coastal city | Night industrial city |
| --- | --- | --- |
| City size | 600 × 600m | 800 × 600m |
| 3 districts | Downtown, residential, waterfront | Industrial, downtown, residential |
| 6 roads | Both z of the x-axis roads and x of the z-axis roads: −180 / 0 / 180m | z of the x-axis roads −180 / 0 / 180m, x of the z-axis roads −240 / 0 / 240m |
| Drivable vehicle / driving goal | 1 sedan / 140m | 1 SUV / 180m |
| Pedestrians / traffic vehicles | 4 of the Kai IP / 6 | 4 of the Kai IP / 4 |
| Mission order | Talk → drive → retrieve the core → waterfront delivery point | Retrieve the core → drive → industrial delivery point |
| Sky, fog, exposure, bloom | Daytime blue, fog 0.002, exposure 1.1, bloom 0.2 | Night navy, fog 0.003, exposure 1.25, bloom 0.75 |

The prompt asks specifically for the coordinates of the spawn, NPC, vehicle, core and delivery point, the road width, the pedestrian loop route, the stage IDs and the driving distance. `scripts/create_city_games.py` compares the saved values with the request. The road comparison removes UUID differences and compares axis, coordinate and width, so the same road under a different name is not judged a different structure.

## Verification tools

- `scripts/create_city_games.py`: compares the generation request with the saved GameSpec, the selected asset bytes, the runtime copy and the unchanged originals. Raw Bedrock Converse responses and full tool payloads are not kept.
- `scripts/verify_city_games.mjs`: plays at the public game URL with native keyboard and pointer input (driving distance, E to enter/exit, pedestrian and traffic movement, building collision, render chunk load/unload, restart). It only observes the read-only `__ipverseGameState` and does not change position, distance or mission progress.
- `scripts/verify_city_studio.mjs --input evidence/city-generation-live.json --output evidence/city-studio-live.json --screenshots evidence/city-studio` (`--self-test` is a local self-check): checks the studio's original login form, the design summary, original request and selected roles, and that the iframe on the right loads and starts. Credentials are accepted only as `{"username","password"}` JSON on stdin, and mutating requests other than login are blocked at the browser network layer.
- `scripts/verify_city_delivery.py`: read-only check of the deployed code, S3 objects, public runtime bytes and auth rejection.

A 390px screen supports display and start only. In a small 16:9 window the desktop HUD, minimap and mission guide overlap, and there is no touch driving.

## Engine and quality limits

The model writes the supported city data and missions, and the provided Three.js engine runs vehicle control, collision, NPC routes, district layout and render chunks. District buildings are assembled by deterministic placement logic from the official Kenney stylized low-poly CC0 asset kits. No claim is made that the model generated new building meshes, vehicle physics or crowd AI code.

The supported range is a 300–1200m world, 3–6 districts, 4–14 axis-aligned roads, 1–8 drivable vehicles, 1–8 pedestrians reusing one NPC IP, and at most 16 traffic vehicles. Pedestrian routes are also limited to horizontal and vertical road/sidewalk segments. Arbitrary curved roads, complex crowd behavior, interiors, destruction, multiple users, a photoreal city, or GTA6/AAA production quality are outside the supported range. It does not run on Unreal.

The detailed contract is in `docs/city-contract.md`, asset sources in `docs/city-assets.md`, and the distinction from high-quality production in `docs/open-world-quality.md`.
