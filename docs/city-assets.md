# 실제 도시 자산 kit

기존 primitive 건물과 단색 arena를 교체하는 데 사용할 수 있는 실제 GLB 46개를 공식 Kenney 배포 ZIP에서 선별했다. 원본 ZIP에 포함된 `License.txt`가 모두 Creative Commons Zero, CC0를 명시하며 개인·교육·상업용 사용을 허용한다. 저작자 표기는 요구사항이 아니지만 출처와 원본 license를 함께 보존한다. Epic City Sample 자산을 변환하거나 가져오지 않았다.

이 kit는 **stylized low-poly** 메쉬다. 건물의 실제 창틀·입구·지붕, 차량의 차체·바퀴, 도로·가로시설 geometry를 제공하지만 사진 실사 PBR·GTA 수준 품질이나 완성 게임을 의미하지 않는다. 실제 도시 구성과 차량 기능을 구현하기 위한 재배포 가능한 기반이다.

## 확보한 실제 파일

| 역할 | 수량 | 공식 pack |
| --- | ---: | --- |
| 상업·고층·산업 건물 | 16 | City Kit Commercial 2.1 / Industrial 2.0 |
| SUV·택시·승용차·경찰차·배송차·밴 | 7 | Car Kit 3.1 |
| 직선·교차로·횡단보도·곡선·보도 도로 | 9 | City Kit Roads 2.2 |
| 가로등 | 3 | City Kit Roads 2.2 |
| 차양·파라솔·굴뚝·컨테이너·태양광·표지판·기타 시설 | 11 | 상기 city packs |

원본 mesh·texture dependency·license 합계는 3,853,718 bytes이며 30MiB 제한 이내다. 원본 ZIP 전체나 OBJ/FBX 중복 파일을 kit에 저장하지 않는다. 참고용 browser PNG를 포함한 디렉터리 전체 크기도 evidence에 별도로 기록한다.

## 출처와 재현

1. https://kenney.nl/assets/city-kit-commercial
2. https://kenney.nl/assets/city-kit-industrial
3. https://kenney.nl/assets/city-kit-roads
4. https://kenney.nl/assets/car-kit
5. 실제 공식 catalog 검색: https://kenney.nl/assets?search=city

```sh
python3 scripts/acquire_city_assets.py
```

script는 공식 페이지의 public download ID로 실제 ZIP을 받는다. 정상 same-origin 요청에 필요한 Referer와 public cookie jar만 사용한다. 임시 signed download URL과 cookie는 메모리에만 존재하며 파일·출력에 남기지 않는다. allowlist pack과 GLB만 추출하고 포함된 CC0 license가 없으면 실패한다. 다운로드한 코드나 Python을 실행하지 않는다. AWS 업로드·모델 호출·게임 생성은 수행하지 않는다.

`game3d/city-assets/licenses/`에 원본 license를 그대로 복사한다. `commonassetcatalog.json`과 `evidence/city-assets.json`에 source page, ZIP SHA, 원본 archive member, 각 실제 GLB/texture/license SHA를 기록한다.

## Renderer 계약

catalog의 `assets` 각 항목은 다음 필드를 제공한다.

1. `id`, `path`, `category`: path는 game3d 기준 `city-assets/models/...glb`이다.
2. `boundingBox`: 원본 GLB scene transform을 적용한 Y-up `min`, `max`, `size`다.
3. `metersPerUnit`, `sizeMeters`, `height`: 도시 배치를 위한 **권장 authored scale**이다. 실물 측량이나 원본에서 선언한 단위라고 주장하지 않는다. 도로 tile 폭 12m, 차량 길이 4.6m, 가로등 높이 5m를 기본으로 선택했다.
4. `nativeForwardYaw`: 차량 7종은 공식 GLB의 `wheel-front-*`와 `wheel-back-*` root-node 위치로 +Z 전방을 확인해 0이다. 다른 자산의 전방은 임의 추정하지 않고 null이다.
5. `license`, `licensePath`, `source`, `sourceArchiveMember`, `sha256`, `bytes`, `meshCounts`, `dependencies`: 재배포와 검증 provenance다.

GLTFLoader로 원본을 로드하고 native bounding box의 X/Z 중심과 Y 최저점을 기준으로 wrapper를 정렬한 뒤 `metersPerUnit`을 적용한다. collider와 배치 간격은 실제 scaled bounds를 사용한다. 차량의 wheel nodes는 원본에 별도 메쉬로 존재하지만 자동 주행·물리·조향 기능까지 포함한 것이 아니므로 runtime이 구현해야 한다.

## 실제 검증과 한계

실제 commercial skyscraper·industrial building·SUV·택시·교차로·가로등 6개를 기존 workspace Three.js + GLTFLoader로 loopback browser에서 로드해 원본 mesh를 렌더했다. 임의로 다운로드한 external script를 실행하지 않았다. browser `THREE.Box3`와 catalog native bounds를 비교하고 실제 PNG와 source SHA를 `evidence/city-assets.json`에 기록한다. PNG는 자산 검토용 화면이며 완성 게임 화면으로 표시하지 않는다.

대표 이미지가 `game3d/city-assets/previews/`에 있다. `review.html`은 기존 workspace의 Three.js를 `/three/` 경로로 제공하는 개인 loopback review server를 위한 검토 화면이다. main app, 기존 게임 manifest와 gallery는 변경하지 않았다.

source metadata 검증과 실제 mesh browser 로드는 도시 gameplay·대규모 streaming·LOD·물리·NPC·차량 기능 검증과 구분한다. 실제 게임에 결합한 뒤 해당 runtime과 provenance를 다시 검증해야 한다.
