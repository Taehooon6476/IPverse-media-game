# IPverse city extension

This is an additive contract for the existing `d12` IPverse chat → `make_game` → right-hand game pane. It retains `version: 2`, `engine: "three"` and activates city mode only when `world.city` exists. Older non-city v2 and v1 games keep their contracts.

This source change enables a bounded browser city slice. It does not establish Unreal execution, GTA6 visual quality, production open-world streaming, multiplayer, or automatic AAA game creation. Local contract tests do not prove a Bedrock call, AWS deployment, model effect, or browser gameplay; those require separate evidence from the parent integration/QA work.

## World and spatial contract

| Field | Limits and behavior |
| --- | --- |
| City world `width`, `depth` | 300–1200 meters; origin centered, actors at least 1m inside the actual bounds. |
| Non-city world | Existing 36–100m limit remains. |
| `city.districts` | 3–6 `{id,name,style,x,z,width,depth}`; styles `downtown`, `residential`, `industrial`, `waterfront`; dimensions 80–600m. Entire footprint fits the world. |
| `city.streets` | 4–14 `{id,axis,coordinate,width}`; each axis has at least two roads; width 8–24m. |
| `city.vehicles` | 1–8 `{id,kind,x,z,yaw,color?}`; `sedan`, `suv`, `taxi`; yaw ±π. Starts on a road within width/2 +2m. |
| `city.pedestrians` | 1–8 `{id,propIndex,x,z,route}`; 2–8 route points, at least two distinct; all use the actual `world.npc.propIndex`. |
| `trafficCount`, `seed` | Integers 0–16 and 0–2147483647; normalized defaults 0 and 1234. |

An x-axis road runs across the whole world at constant z; a z-axis road runs at constant x. Parallel roads must leave more than 8m between their edges and must leave 16m outside their road edge before the world boundary. The intersecting full-length grid is connected by construction.

Pedestrian routes follow horizontal or vertical road/sidewalk segments within width/2 +8m of the matching road axis. Start → route points → first point forms a closed cycle; a repeated initial point is allowed, but a route with only one distinct point is rejected. The guide and pedestrians reuse a prepared character/enemy NPC IP. They do not replace a selected NPC with an unrelated prop or a procedural actor.

City IDs reserve one namespace with existing world entities, props, enemies, and the guide. District and street IDs cannot be gameplay target IDs. Vehicle and pedestrian IDs join the mission index. World entities remain at most 48 explicitly authored landmarks, mission markers, or feature structures. The runtime's trusted district asset kit supplies the urban building scenery.

Spawn, actual IP placements, NPCs, cars, pedestrians and mission markers must be on connected roads or sidewalks. Authored ground solids may not intersect roads or their 2m clearance, and pedestrian route segments cannot cross them. Mission beacons and actors cannot overlap solid geometry. Flat-ground reachability uses a coarse grid of at most 100×100 cells for large worlds, preserving the existing 1m grid for small worlds. This check is a basic structural gate, not a physics simulation or proof of the renderer's building collision behavior.

## Ordered gameplay

Existing `collect`, `kills`, `reach`, `interact`, `survive`, `boss`, and `talk` stages retain their meaning. City mode adds:

```json
{
  "id": "transport",
  "type": "drive",
  "label": "지정 차량을 140m 운전",
  "target": 1,
  "entityIds": ["quest_car"],
  "distanceMeters": 140
}
```

`drive` requires exactly one actual city vehicle ID and a distance of 20–1500m. It is illegal outside city mode, cannot target a beacon/NPC, and cannot carry ignored `propIndex`, `enemyIndex`, or `holdSec` fields. `distanceMeters` is illegal on other actions. A city summary `objective.type: "drive"` also has target 1. Runtime completion must use successful movement while driving the selected vehicle; a renamed `reach` objective is insufficient.

`talk` and `interact` may reference the guide or an actual pedestrian ID. Their `propIndex` still checks the same selected NPC IP. Ordered talk → drive → collect → reach flows use existing source-owned props and mission state. Later collection/enemy instances retain their stage activation constraints.

## Model and packaging boundaries

`city_contract.CITY_SCHEMA` is merged into the existing Converse `make_game` JSON schema through `AUTHORED_PROPERTIES`; Python validation remains authoritative for city-only bounds, references, role consistency, and geometry. Closed city objects reject unsupported fields, URLs, asset paths, and code. Authored `environment` also rejects unknown fields.

The system prompt instructs explicit city/open-world/GTA-style requests to produce `world.city`, preserving actual user roles and topology instead of reducing them to a small arena. `make_game` additionally checks the server-injected design/source prompt and rejects a non-city replacement with `city_world_required` before storing a game. Only server-owned design metadata records the source prompt; the model cannot supply that provenance.

Every new three runtime includes `city-contract.js` because the shared authored validator imports it. Only city games additionally copy `city.js`, `city-controller.js`, and `city-layout.js` from the trusted `runtime3d/v1/` prefix. IP cutouts/models still resolve from the current session's prepared assets, ignoring model-authored replacement URLs.

The renderer fetches the trusted shared catalog at `/runtime3d/v1/city-assets/commonassetcatalog.json` and mesh/texture dependencies under that prefix. The backend does not accept model-provided kit URLs, copy kit meshes into the Lambda package, or initiate new media jobs. Kit publication and runtime integration are deploy steps, not backend work.

## Verification

`server/tests/test_city_contract.py` uses labeled local fixtures and in-memory S3/DynamoDB clients. It checks a 600m transport plan, a 1200m distant target, immutable source inputs, exact NPC/IP binding, role-safe talk targets, vehicle references and distance limits, roads/routes/bounds, unknown-field rejection, blocked/off-road targets, source-prompt anti-shrink enforcement, and trusted runtime/owned-asset packing. Fixture model bytes are not presented as real generated meshes.
