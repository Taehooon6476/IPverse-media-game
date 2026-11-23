# 고품질 도시 게임 전환

## 목표와 미니게임 계약의 한계

목표는 작은 맵의 확대나 새 미니게임이 아니라, 풍부한 환경과 이동·차량·NPC·임무가 함께 동작하는 오픈월드 게임이다.

도시 기능 이전의 세 미니게임 크기:

| 게임 | 실제 크기 | 배경 구조물 |
| --- | --- | --- |
| 숲의 코어 탐험 | 56 × 48m | 34개 |
| 네온 거점 돌파 | 48 × 48m | 7개 |
| 전력시설 탈출 | 60 × 44m | 24개 |

`server/authored_contract.py`와 `game3d/authored-contract.js`는 세계를 최대 100 × 100m, 구조물 48개, NPC 한 명으로 제한한다. `game3d/authored.js`는 공통 평면 바닥과 기본 도형으로 배경을 만든다. 선택한 캐릭터·소품 GLB가 실제로 나타나고 미션이 작동해도, 그것만으로 환경이나 게임 품질이 높아지지 않는다.

변경 전에는 차량, 도로 기반 교통, 다수 보행자 경로, 구역 스트리밍이 없었다. 구조물마다 창문 메시를 개별 생성하고 충돌을 선형 검색하므로 상한만 늘리는 방식은 대형 도시의 렌더·충돌·메모리 문제도 해결하지 못했다.

변경 전 화면의 FPS도 큰 도시의 성능 증거로 사용하지 않는다. 당시 `world.js`의 FPS 표시는 제한된 시뮬레이션 `dt`를 사용했다. 새 도시 검증에서는 `performance.now()` 기준의 실제 렌더 간격을 따로 기록했다.

## 도시 prototype 측정 예

같은 소유 IP 세 종으로 두 도시를 운영 채팅·Bedrock·게임 생성 도구로 만들어 측정한 결과다. 저장된 요청에 따라 구역·도로·차량·임무·색감이 달라지고, 각 게임은 선택한 원본 캐릭터·소품·NPC GLB를 연결한다.

| 실제 생성 결과 | 낮의 해안 도시 | 밤의 산업 도시 |
| --- | --- | --- |
| 크기·건물 | 600×600m·209개 | 800×600m·323개 |
| 구역 | 도심·주거·수변 | 산업·도심·주거 |
| 선택한 차량 | 세단 | SUV |
| 생성된 임무 | NPC 대화 → 140m 운전 → 코어 회수 → 배송 | 코어 회수 → 180m 운전 → 배송 |
| 실제 조작 결과 | 전체 4단계 완료·423.14m 주행 | 전체 3단계 완료·431.07m 주행 |

키보드·마우스 입력만으로 플레이했을 때 마지막 1200프레임의 실제 렌더 간격은 낮 평균 59.6fps/p95 21.5ms, 밤 평균 56fps/p95 23.2ms였다. macOS Chromium 한 대의 관측치이며 대상 GPU나 다수 사용자 성능 보장은 아니다.

이는 기능이 있는 Three.js 도시 prototype이다. 모델은 제한된 도시 데이터 계약을 작성하고, 미리 구현한 엔진이 이를 실행한다. 환경에는 공식 Kenney CC0 GLB 46개를 사용한다. 직선 도로, 한 종류의 선택 NPC 재사용, 단순한 배경 교통으로 제한되며 실내·대규모 군중·교차로 신호·사실적인 차량·AAA 콘텐츠 제작을 제공하지 않는다. Unreal·MCP 실행이나 GTA6 수준의 자동 제작이 입증된 것은 아니다.

증거 파일: `evidence/city-generation-live.json`(생성), `evidence/city-play.json`(조작), `evidence/city-delivery-live.json`(배포), `evidence/city-studio-live.json`(스튜디오), `evidence/city-platform-verification.json`(집계). 모바일은 표시와 시작만 확인했다. 터치 운전이 없고 작은 창에서는 HUD가 겹친다.

## 실제 Unreal 실행 준비 상태

2026-11-01 기준 상태:

| 항목 | 현재 상태 |
| --- | --- |
| 로컬 Unreal 엔진 | 표준 설치 경로에서 발견되지 않음 |
| Epic 컨테이너 접근 Secret `ipverse/ghcr-token` | `DescribeSecret`: `ResourceNotFoundException`; 값은 읽지 않음 |
| 기존 `IpverseUe5Build` | `c6i.8xlarge`, stopped |
| 기존 `IpverseStreams` | 그룹 active, default application 없음, 용량 0 |
| GameLift Streams application | us-west-2 목록 비어 있음 |
| 활성 IPverse의 `ue5/` | 5.6 소스 템플릿; 실제 `.uasset`·`.umap` 없음 |

상위 ORIGIN 저장소의 `unreal/OriginNeon`은 별도 5.8 소스 프로젝트다. 이를 활성 IPverse에서 실행되는 게임이나 검증된 Unreal 빌드로 표시하지 않는다. 활성 IPverse의 Unreal 템플릿 역시 기본 도형 아레나·계곡 중심이고, 엔진 접근만 추가한다고 GTA 스타일 도시가 완성되지는 않는다.

공식 AWS 문서의 현재 gen6n_high는 GPU당 세션 두 개이며 용량은 두 개 단위로 구성한다. 기존 `docs/ue5/design.md`의 용량 1 예시를 그대로 실행 계획에 사용하지 않는다. 실제 용량과 비용은 패키지 플레이 및 대상 GPU 측정 이후 별도로 계산한다.

## 새 결과물의 제작 기준

첫 목표는 GTA6 전체 규모나 동일한 제작 품질의 자동 복제가 아니다. 제안하는 첫 결과물은 아래 동작을 실제로 검증할 수 있는 도시 구역이다. 아래 항목은 완료된 기능 목록이 아니다.

| 영역 | 제작할 결과 | 완료 판정 |
| --- | --- | --- |
| 도시 환경 | 라이선스를 확인한 상세 건물·도로·보도·가로시설·환경 재질. 주거·상업·항만 등 구분되는 구역 | 실제 플레이 카메라로 확인; 빈 바닥과 도형만으로 구성된 배경을 완성으로 표시하지 않음 |
| 월드 규모 | 우선 0.5–1km²의 연속 도시 구역을 목표로 구역 스트리밍·LOD 구성 | 도보와 차량으로 구역을 이동하며 실제 로드·프레임 시간·충돌 검증 |
| 캐릭터 IP | 선택한 캐릭터의 실제 골격·애니메이션·재질·충돌 및 소품 연결 | 선택 IP 계보 유지; 미지원 자산을 기본 캐릭터로 조용히 대체하지 않음 |
| 차량 | 승하차, 가속·제동·조향, 차량 충돌과 카메라 | 실제 키보드·마우스 입력으로 탑승 → 주행 → 하차 확인 |
| 도시 생활 | 보도 보행자와 도로 교통, 교차로·횡단·장애물 대응 | 움직이는 NPC·차량의 경로와 충돌을 실제 관찰 |
| 임무 | NPC 의뢰 → 구역 사이 차량 이동 → 현장 목표 수행 → 보상, 실패·재시작 | 처음부터 끝까지 실제 입력으로 완료; 타이머·위치·목표 카운터를 검사기가 변경하지 않음 |
| 품질 | 구역별 조명·색감·재질, 카메라 충돌과 애니메이션 전환 | 실제 플레이 녹화와 시각 검토; 컨셉 이미지나 소스 코드로 대체하지 않음 |

Epic City Sample은 상세 도시와 차량·보행자·교통 시스템의 기준 및 재사용 후보이다. 다운로드·사용 권한과 엔진 버전·플랫폼 호환성을 확인한 실제 콘텐츠만 사용한다. 처음부터 모든 건물과 차량을 AI로 생성하는 경로를 기본으로 삼지 않는다.

City Sample 공식 요구사항은 고품질 렌더를 위한 Windows/DX12 환경을 제시한다. 현재 Fab 배포본에는 5.8 관련 기능도 있으므로 기존 IPverse의 Linux/5.6 빌드·스트림 구성이 그대로 호환되거나 같은 품질을 낸다고 약속하지 않는다. 실제 확보한 프로젝트의 호환 버전과 플랫폼을 먼저 확인한 뒤 빌드와 스트리밍 경로를 정한다.

Unreal에서는 World Partition/HLOD로 구역을 관리하고, 상세 환경은 Nanite와 재질·조명 구성을 검토한다. 차량은 Chaos Vehicles, 도시 인구·교통은 City Sample의 관련 시스템을 검토한다. 각 기능이 활성화됐다는 설정만으로 동작이나 성능이 입증되지는 않는다.

## IP 플랫폼과 연결

기존 IPverse의 채팅·미디어 생성·선택 IP·영상 광고 UI는 유지할 수 있다. 게임 제작 계약에는 환경 키트, 구역·도로와 이동 연결, 차량, NPC 역할·경로, 임무 단계가 필요하다. 미니게임의 v2 world 데이터를 Unreal에 그대로 전달해 도시 제작이 완료됐다고 표시하지 않는다.

제작 에이전트는 실제 설치된 Unreal Editor에 연결해 지원되는 작업을 수행하고 저장한다. MCP 연결은 편집 도구 연결이며 게임 완성, 차량 물리, 콘텐츠 라이선스, 패키지 실행을 대신하지 않는다. 플레이 동작은 Blueprint/C++ 및 실제 콘텐츠로 저장·빌드한다.

AWS 경로는 기존 빌드 인스턴스 → private S3의 버전별 패키지 → GameLift Streams 등록 → 기존 인증·세션 소유권을 검사하는 스트리밍 API로 연결할 수 있다. 기존 빌드 인스턴스는 CPU 빌드용이며 GPU에서의 게임 성능을 증명하지 않는다. 실제 게임 실행 파일과 콘텐츠를 만들기 전에는 스트림 그룹의 존재를 고품질 게임 실행 증거로 사용하지 않는다.

이는 현재 5.6/Linux 프로젝트에 사용할 수 있는 경로다. City Sample을 선택한다면 확보한 엔진·콘텐츠와 대상 Windows/Linux 런타임의 지원 조건을 확인하고, 필요한 경우 별도의 일치하는 스트리밍 구성을 사용해야 한다. 기존 그룹을 그대로 사용한다고 결정하지 않는다.

## 완료 검증과 현재 차단 요소

1. 설치된 엔진 또는 접근 가능한 Epic 컨테이너와 콘텐츠 권한을 확인한다.
2. 실제 콘텐츠를 임포트하고 플레이 로직을 저장·컴파일한다.
3. 에디터 플레이와 독립 패키지에서 도시 이동, 승하차, 주행, NPC, 임무, 실패·재시작을 확인한다.
4. 대상 GPU에서 1080p의 실제 wall-clock 프레임 시간을 측정한다. 첫 목표는 10분 주행 중 p95 33.3ms 이하다. 이는 목표이며 달성 결과가 아니다.
5. 패키지를 AWS에 등록하고 인증된 브라우저 입력·영상·사운드·종료를 검증한다.
6. 실제 플레이 영상과 실행 링크를 제공한 뒤에만 게임 완료로 보고한다.

현재 필요한 외부 입력은 사용할 수 있는 Unreal 작업환경의 경로/인스턴스 또는 Epic과 연결된 GitHub 계정의 컨테이너 접근정보이다. 기존 빌드 도구는 AWS Secrets Manager `ipverse/ghcr-token`의 `{"username","token"}` 계약을 사용한다. 토큰은 채팅이나 문서에 기록하지 않는다. 이 접근정보 없이 엔진을 다운로드·컴파일한 결과를 만들 수 없으므로 현재 상태는 `ENGINE_ACCESS_REQUIRED`다.

## 공식 참고 자료

1. Epic City Sample: https://dev.epicgames.com/documentation/en-us/unreal-engine/city-sample-project-unreal-engine-demonstration
2. Epic World Partition: https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition-in-unreal-engine
3. Epic Nanite: https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine
4. Epic Lumen: https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine
5. Epic Chaos Vehicles: https://dev.epicgames.com/documentation/en-us/unreal-engine/vehicles-in-unreal-engine
6. AWS GameLift Streams requirements: https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/applications.html
7. AWS GameLift Streams capacity: https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/stream-groups.html
