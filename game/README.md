# game/ — GameSpec v1 runtime (Phaser 3)

A fixed runtime that plays a GameSpec (`spec.json`). It never runs model-written code. The page loads Phaser 3.87.0 from jsDelivr, pinned with an SRI hash; there is no build step and nothing to install.

| file | role |
|---|---|
| `index.html` | 960×540 stage (`Phaser.Scale.FIT`), HUD, dialogue box, win/lose overlay, ad overlay |
| `runtime.js` | boot: `./spec.json` → validate → `./release.json` (404 or non-JSON → `null`) → pre-roll ad → scene by genre prefix (`sf-*` → `ShooterScene`, `rpg-*` → `RpgScene`) |
| `gamespec.js` | `validateSpec(spec)` and `defaultSpec(genre)`. Pure ES module, used by both the browser and Node |
| `shooter.js` | `ShooterScene` |
| `rpg.js` | `RpgScene` |

## Deployment shape

The deploy script uploads `game/*.{html,js}` to `runtime/v1/`. `make_game` copies those five files unchanged into `games/{gameId}/`, next to `spec.json`, `assets/{ipId}.png` and `release.json`. The server writes `"ad": null` for a preview and the chosen ad on publish; a missing or non-JSON `release.json` also means no ad. Every fetch is relative. Link to `games/{gameId}/index.html`: with a URL like `games/{gameId}` (no trailing slash), `./spec.json` resolves one level too high.

`release.json` = `{"publishedAt": iso, "ad": {"videoUrl": url, "skipAfterSec": 5} | null}`. With an ad, the video plays muted. The skip button counts down (`광고 건너뛰기 (5)`) and then enables. The game starts on skip, on `ended`, or when the video fails to load.

## Gameplay

- **Shooter**: WASD or the arrow keys move. Firing is automatic; holding space fires faster. You have 3 lives. Enemies are generated textures (`shape`, `color`) with `hp` and `speed`. Spawn interval: easy 1400 ms, normal 1000 ms, hard 700 ms. Killed enemies sometimes drop a prop sprite. Drop effects: `score` +100, `heal` +1 life, `shield` 5 s, `key` +250. The objective is `kills` (a count) or `survive` (seconds).
- **RPG**: The map is seeded from `map.seed` (mulberry32): border walls, about 12% random walls, and an open 3×3 around the start. You move one 32 px tile per keypress. The NPC stands at least 6 steps away. Items and monsters are placed only on tiles you can reach. E or space next to the NPC plays the `dialogue` lines, then `quest.completeText`, and you win. `objective.target` is unused for `talk`. `collect` wins after `objective.target` pickups, capped by the free tiles. `rpg-quest` with `talk` requires the `quest.itemPropIndex` prop first. If that prop is missing, a stand-in item is placed. The NPC sprite and the monsters follow rules 2 and 3 below.
- End overlay: `클리어!` or `게임 오버`. Click `다시 시작` or press Enter, Space or R to restart the scene.
- Sprites must be same-origin, because cross-origin images break WebGL textures. A sprite that is missing or fails to load is replaced by a drawn shape.

## Validation and runtime rules

These rules were agreed with the plan owner. `server/gamespec.py` mirrors rule 1. Rules 2 to 4 are runtime-only and listed here for reference.

1. **`validateSpec(spec)`** implements the shared-contract rules. It returns a normalized copy and never mutates its input.
   - Required: `version` (1), `genre`, `palette.{bg,accent,text}`, `player.speed`, `objective.{type,target}`, `difficulty`, and `enemies` for `sf-*` (1–5 items).
   - Filled when missing: `props=[]`, `dialogue=[]`, `quest=null`. For `rpg-*` also `enemies=[]` (0–5 allowed) and `map={width:20,height:15,seed:1234}`. `map` is range-checked whenever it is present, for any genre.
   - Not checked; the runtime falls back: `title`, every name, `spriteUrl`, `map.seed`, every `quest` field.
   - Types:
     - Integers must be JSON integers: `2.0` is accepted; `"2"` and `true` are rejected.
     - Hex values must be strings that fully match `^#[0-9a-fA-F]{6}$`. In Python use `re.fullmatch`, because `$` also accepts a trailing `\n`.
     - Dialogue length counts code points (`[...text].length`), the same as Python `len()`.
2. **NPC sprite (RPG)**: the NPC uses the first prop whose sprite loaded and which is neither the quest item (`quest.itemPropIndex`, rpg-quest + talk) nor drawn with the player's `spriteUrl`. That prop is then not placed on the map. Under `collect` every prop is needed as an item, so the NPC is an accent circle; the same applies when no prop qualifies.
3. **RPG monsters and the lose state**: each `spec.enemies` entry becomes one roaming monster, placed at least 5 steps from the start while free tiles last. It is drawn as its `shape` and `color` and steps one tile every `900 / speed` ms × {easy 1.4, normal 1, hard 0.7}. Monsters stand still for the first 3 s of every run, including after a restart; the status line shows `몬스터가 곧 움직입니다` meanwhile. A monster chases within {easy 2, normal 3, hard 4} tiles (Manhattan), wanders otherwise, and waits while dialogue is open. Touching it costs 1 of 3 lives and gives 2 s of invulnerability, so at most one life is lost per 2 s; 0 lives is `게임 오버`. The monster that hit is knocked back to its spawn tile and rests 2 s. If the player is within 4 tiles of that spawn, it goes instead to the floor tile the player can reach that is the most steps away from them, never the NPC tile (`knockbackTile`, tested in `test/rpg.test.mjs`). With `enemies` empty, an RPG has no lose state.
4. **Shooter start grace**: no enemies spawn in the first 2 s of every run, including after a restart; spawning then runs every {easy 1400, normal 1000, hard 700} ms.

## Dev

```bash
python3 -m http.server 8099 --directory game
open "http://localhost:8099/index.html?spec=dev/spec-sf.json"
open "http://localhost:8099/index.html?spec=dev/spec-rpg.json"
node --test game/test/*.test.mjs
```

Node 25 treats a directory argument to `--test` as a file to run, so `node --test game/test` fails. Name the test files instead. `?spec=` and `?release=` override `./spec.json` and `./release.json` on `localhost`/`127.0.0.1` only. They accept any URL, including `data:` (for example `?release=data:application/json,{"ad":{"videoUrl":"...","skipAfterSec":3}}`, URL-encoded). `dev/smoke-*.png` are the browser smoke screenshots. The deploy upload skips `dev/`.
