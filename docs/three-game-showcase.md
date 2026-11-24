# Showcase of three real games

> The files under `evidence/` that this document points to are not included in this copy. Running the scripts below creates them again.

The existing IPverse studio UI and game runtime are kept. A separate static gallery shows play captures, mission order, controls and IP roles of the exploration RPG, sci-fi combat and facility escape games that were actually generated, and links to the real play URLs and studio sessions.

## Input and build

The `cases` in `evidence/three-game-showcase-generation.json` contain `type`, `sessionId`, `gameId`, `previewUrl` and the `spec` as actually saved. The type is `exploration`, `combat` or `escape`, and each v2 spec must have exactly three mission stages. IP names are read from the verified `sourceAssetInventory` of the same report, and roles are linked to the player, props, enemies and weapon slots of the real spec. The real play PNG of each game uses these paths.

1. `evidence/three-game-showcase/exploration-playing.png`
2. `evidence/three-game-showcase/combat-playing.png`
3. `evidence/three-game-showcase/escape-playing.png`

Optionally, `{type}-short.mp4` in the same folder can be attached as real gameplay video. External images or mock screens are not used in their place.

For the combat poster, `combat-combat-kill-1.png`, which shows the real first kill, is chosen if it exists. The existing `combat-playing.png` is not overwritten and no image is retouched. The manifest's `sourceScreenshot` and SHA record the original that was actually used.

```sh
python3 scripts/build_three_game_showcase.py
```

The output is in `artifacts/three-game-showcase/site/`. The builder reads local evidence only and performs no authentication, model call, game change or AWS upload. The original PNG/MP4 files are copied under file names that include the SHA. Missions use the real saved spec, and generated text is HTML-escaped. Links are allowed only to the path of that gameId on the existing IPverse CloudFront. Dash is Q, attack is click / F, and the jump, sprint and interact labels follow each spec's mechanics and missions.

If there are no real play captures yet, the default build fails. During local work, `--allow-pending` can produce clearly marked placeholders, but the build manifest status is `DRAFT_SCREENSHOTS_PENDING` and it does not claim that real capture is complete.

## Public upload contract

`artifacts/three-game-showcase/build-manifest.json` gives the `s3Key`, `contentType`, `cacheControl`, bytes and SHA of each file. After the operator confirms `READY`, only the files declared in the manifest are uploaded to this prefix of the existing bucket.

```text
web/showcases/three-game-types-20261101/
```

The existing CloudFront default origin is `/web`, so the real entry URL must include `index.html`.

```text
https://d12ka835iwfpnx.cloudfront.net/showcases/three-game-types-20261101/index.html
```

The public gallery contains no demo login details, auth tokens or internal backend settings. `바로 플레이` ("Play now") opens the preview of each real game in a new window, and `스튜디오 세션` ("Studio session") goes to that session in the existing studio.

Only the real PNG/MP4 files use content-hash names and a long immutable cache. `index.html` and `styles.css` use a short cache so that a rebuilt gallery does not reuse an old style. The gallery has no JavaScript, and its CSP allows only same-origin stylesheets, images and video.

## Verification scope

The gallery builder does not verify real gameplay success or the effect of the 3D models. The per-game runtime QA (`scripts/verify_three_game_showcase.mjs`) does that verification.

`evidence/three-game-showcase-builder-verification.json` is the record of checking, with local fixture input, that the builder rejects missing captures, failed generation, wrong game URLs, HTML injection, media symlinks and output path escapes.

## Published gallery

The gallery is at the CloudFront `index.html` URL above. It is 8 files in total: HTML, CSS, 3 PNGs and 3 MP4s.

| Game | Real gameId | Real mission order | Time |
| --- | --- | --- | --- |
| 숲의 코어 탐험 (Forest core exploration) | `gm_79d1aae71c` | Talk to Kai → collect 3 cores → reach the temple beacon | No limit |
| 네온 거점 돌파 (Neon stronghold breakthrough) | `gm_6d9f10c2f0` | Defeat 2 zombies → retrieve the core → reach the escape gate | No limit |
| 전력시설 탈출 (Power facility escape) | `gm_126ec27234` | Retrieve 2 cores → interact with 2 terminals with E → reach the gate | 120 s |

The three games use the prepared IPs 제나 (Zena), 에너지 코어 (Energy core) and 카이 (Kai). Combat additionally includes the 플라즈마 라이플 (Plasma rifle) and 사이버 좀비 병사 (Cyber zombie soldier) that were actually selected. The missions, timer, mechanics and IP roles on the cards were read from the saved spec and the verified source inventory. The actual implementation is a Three.js browser game and must not be read as a result of running Unreal.

1. [Final summary](../evidence/three-game-showcase-verification.json)
2. [Public gallery browser QA](../evidence/three-game-showcase-gallery-public.json)
3. [Real generation and IP bindings](../evidence/three-game-showcase-generation.json)
4. [Game input and win QA](../evidence/three-game-showcase-play.json)
5. [Real clip decode](../evidence/three-game-showcase-media.json)
6. [Public desktop](../evidence/three-game-showcase/gallery-live-desktop.png) / [Public mobile](../evidence/three-game-showcase/gallery-live-mobile.png)
