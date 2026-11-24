# IPverse authored game contract

## Problem and change

The old GameSpec v1 was a contract for picking a theme, a fixed layout and a single goal. It had no fields for the rooms, routes, prop positions and multi-stage missions a request asked for, so the same fixed game structure repeated however the prompt changed.

New three.js games use `version: 2`, `engine: "three"`. Instead of executable code, the model produces a verifiable world layout and action goals. The existing v1 and Phaser contracts stay. When the v2 data is missing or wrong, generation returns an error; it does not fall back to a v1 game.

## Data passed to the real game

| Field | Role and range |
|---|---|
| `world.width/depth` | A world of 36–100 m around the center coordinate. IPs and the start point stay at least 1 m from the border. |
| `world.spawn` | The hero's real start coordinate `{x,z}`. |
| `world.entities` | Up to 48 structures. box/cylinder/spire/arch/tree/crystal/building/platform/beacon/hazard with position, size, rotation, color, emission and whether it collides. |
| `world.propPlacements` | Up to 24 `{id,propIndex,x,z,stageId?}`. Refers to the index in the array of really selected props. |
| `world.enemySpawns` | Up to 16 `{id,enemyIndex,x,z,stageId?}`. Refers to the index in the array of really selected enemies. The enemy array may be empty, as in a peaceful SF game. |
| `world.npc` | A single `{id,x,z,name?,propIndex?}`. The NPC's real IP is `props[propIndex]`. |
| `mission.stages` | 1–8 ordered action goals. collect/kills/reach/interact/survive/boss/talk. Refers to real world IDs and IP array indexes. |
| `mechanics` | dash/jump/sprint/autoFire, heal amount, weapon damage, fire interval, interaction distance. autoFire defaults to false. |
| `artDirection` | The real sky color, fog color and density, exposure and bloom values. |

A structure is 0.3–20 m wide and deep, 0.1–18 m high, with a base height of 0–8 m and a rotation of ±π. The default width, depth and height are 2 m, and beacon/hazard do not collide by default. Every world ID is a restricted identifier of at most 48 characters and is unique within the world.

A goal must refer to targets that are really placed. The count for collect, kills, reach and interact goals is 1–24, and a boss is one enemy. Only survive takes 1–200 seconds, and unused target fields are not allowed. Collectibles and enemies of a later stage become active in that stage, and a target already consumed cannot be required again in a following stage.

## The boundary between IPs and the user's request

`gameDesign.prompt` is the original text, including the free-form request. The cast selection and roles are passed as `castIpIds`, `playerIpId`, `weaponIpId`, `propIpIds`, `enemyIpIds` and `npcIpIds`. The server's `game_design.py` checks the cast and roles and records the request and the selection in `spec.design`. Only one NPC is supported for now.

The v2 player/props/enemies need real IP IDs. Props and enemies must not exist only as names in the JSON; each needs a real placement or an NPC link. Asset paths are resolved from the IPs the server owns. Sprite/model/weapon/animation URLs sent by the model are not used. v2 enemies also use the cutout or the model of the really selected IP.

The structural validity of space and goals is checked, but not every meaning of a free-form request is proven automatically. Verification needs to generate different requests with the same cast IPs and compare the saved world and goals with the result of real play.

## Verification and limits

What the contract tests in `server/tests` check: v1 normalization as before; v2 keeping coordinates, roles and goal order; SF without enemies; rejection of a wrong engine, index, ID, goal count, stage reuse, collision, non-finite value, and external URL or executable field.

The basic ground route to the required goals is checked on a grid of at most 10,000 cells. Bounds and collision of rotated structures use a conservative AABB check. This does not replace a simulation of real character physics, slopes or every jump route.

The supported range is a finite declarative world, staged goals, existing IP assets and fixed controls. It does not provide arbitrary JavaScript, new shaders, external asset URLs, a multiplayer server or automatic AAA game production. A new authored world is three.js only and makes no claim of running on Phaser or Unreal.

Related implementation: `server/authored_contract.py`, `server/gamespec.py`, `server/prompts.py`.

## Separate background and environment slot

`gameDesign.backgroundIpId` is optional. Leaving it out keeps the existing request shape. When given, it must be one prop (kind prop) inside `castIpIds` and cannot overlap another role.

The choice the model writes is `world.background: {ipId, mode: "image"|"model", rotation?: number}`. The rotation of an image is 0, and a model takes ±π. The server resolves an image from the original `imageAssetId` and a model from the raw `glbAssetId`. A cutout, another IP or a rigged model never stands in for the background source. It checks the current owner's session, the asset kind, that the IP matches, a safe session path and the real image/GLB header, and copies the file to `assets/{ipId}.background.png|glb` in the game folder. URLs sent by the agent are removed, and no other executable or environment fields are allowed.

An image is a static screen background, cropped with its aspect ratio kept, and a model is a static scene, the whole raw GLB placed with its proportions kept. Neither goes through the 0.85 m item normalization, rotation or collection handling. Automatic 3D terrain, parallax, navmesh and model collision generation are not included; the existing `world.entities` or the city layout handle movement and collision.

A new background prop is created with `usage: "background"` of `create_ip_asset` and keeps the whole scene, with no background removal. The preview, identical to the original, is compatibility data for the existing asset UI and is no evidence of a cutout. The studio's background card shows a ‘배경 · 전체 장면’ ("Background · whole scene") badge and the original image instead of the cutout toggle. Ordinary object props keep their existing behavior.
