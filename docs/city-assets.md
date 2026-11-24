# Real city asset kit

46 real GLBs were selected from the official Kenney distribution ZIPs to replace the old primitive buildings and single-color arena. The `License.txt` included in each original ZIP states Creative Commons Zero (CC0) and allows personal, educational and commercial use. Attribution is not required, but the source and the original license are kept together. No Epic City Sample assets were converted or imported.

This kit is **stylized low-poly** mesh. It provides real window frames, entrances and roofs for buildings, bodies and wheels for vehicles, and geometry for roads and street furniture, but it does not mean photorealistic PBR, GTA-level quality or a finished game. It is a redistributable base for building a real city layout and vehicle features.

## Files obtained

| Role | Count | Official pack |
|---|---:|---|
| Commercial, high-rise and industrial buildings | 16 | City Kit Commercial 2.1 / Industrial 2.0 |
| SUV, taxi, sedan, police car, delivery truck, van | 7 | Car Kit 3.1 |
| Straight, intersection, crosswalk, curve and sidewalk road pieces | 9 | City Kit Roads 2.2 |
| Street lights | 3 | City Kit Roads 2.2 |
| Awnings, parasols, chimneys, containers, solar panels, signs and other fixtures | 11 | The city packs above |

The original meshes, texture dependencies and licenses total 3,853,718 bytes, within the 30 MiB limit. The whole original ZIPs and the duplicate OBJ/FBX files are not stored in the kit. The size of the whole directory, including the reference browser PNGs, is recorded separately in the evidence.

## Sources and reproduction

1. https://kenney.nl/assets/city-kit-commercial
2. https://kenney.nl/assets/city-kit-industrial
3. https://kenney.nl/assets/city-kit-roads
4. https://kenney.nl/assets/car-kit
5. Official catalog search: https://kenney.nl/assets?search=city

```sh
python3 scripts/acquire_city_assets.py
```

The script downloads the real ZIPs using the public download IDs on the official pages. It uses only the Referer and the public cookie jar that a normal same-origin request needs. The temporary signed download URLs and cookies exist only in memory and are not left in files or output. It extracts only the allowlisted packs and GLBs and fails when the included CC0 license is missing. It runs no downloaded code or Python. It performs no AWS upload, model call or game generation.

The original licenses are copied as they are into `game3d/city-assets/licenses/`. `commonassetcatalog.json` and `evidence/city-assets.json` record the source page, the ZIP SHA, the original archive member, and the SHA of each real GLB, texture and license.

## Renderer contract

Each entry of the catalog's `assets` provides the following fields.

1. `id`, `path`, `category`: the path is `city-assets/models/...glb`, relative to game3d.
2. `boundingBox`: the Y-up `min`, `max` and `size` with the original GLB scene transform applied.
3. `metersPerUnit`, `sizeMeters`, `height`: the **recommended authored scale** for city layout. It is not claimed to be a real-world measurement or a unit declared by the original. The defaults chosen are a road tile width of 12 m, a vehicle length of 4.6 m and a street light height of 5 m.
4. `nativeForwardYaw`: 0 for the seven vehicles, whose +Z forward was confirmed from the root-node positions of `wheel-front-*` and `wheel-back-*` in the official GLBs. The forward direction of other assets is not guessed and is null.
5. `license`, `licensePath`, `source`, `sourceArchiveMember`, `sha256`, `bytes`, `meshCounts`, `dependencies`: provenance for redistribution and verification.

Load the original with GLTFLoader, align a wrapper on the X/Z center and the lowest Y of the native bounding box, then apply `metersPerUnit`. Colliders and placement spacing use the real scaled bounds. The wheel nodes of the vehicles exist as separate meshes in the original, but that does not include automatic driving, physics or steering, which the runtime must implement.

## Verification and limits

Six real assets (commercial skyscraper, industrial building, SUV, taxi, intersection, street light) were loaded in a loopback browser with the existing workspace Three.js + GLTFLoader, and the original meshes were rendered. No arbitrarily downloaded external script was run. The browser's `THREE.Box3` is compared with the catalog's native bounds, and the real PNGs and source SHAs are recorded in `evidence/city-assets.json`. The PNGs are asset review screens and are not presented as screens of a finished game.

Representative images are in `game3d/city-assets/previews/`. `review.html` is a review screen for a private loopback review server that serves the existing workspace's Three.js at the `/three/` path. The main app, the existing game manifests and the gallery were not changed.

Source metadata verification and loading real meshes in a browser are kept apart from verification of city gameplay, large-scale streaming, LOD, physics, NPCs and vehicle features. After the assets are combined into a real game, that runtime and its provenance must be verified again.
