# IPverse authored game contract

## 문제와 변경

기존 GameSpec v1은 테마·고정 레이아웃·단일 목표를 선택하는 계약이었다. 요청한 방, 동선, 소품 위치, 여러 단계의 미션을 표현할 필드가 없어 프롬프트가 달라도 고정 게임 구조가 반복됐다.

새 three.js 게임은 `version: 2`, `engine: "three"`를 사용한다. 모델은 실행 코드 대신 검증 가능한 세계 배치와 행동 목표를 생성한다. 기존 v1과 Phaser 계약은 유지한다. v2 데이터가 누락되거나 잘못되면 v1 게임으로 대체하지 않고 생성 오류를 반환한다.

## 실제 게임에 전달하는 데이터

| 필드 | 역할과 범위 |
| --- | --- |
| `world.width/depth` | 중심 좌표 기준 36–100m 세계. IP와 시작점은 경계에서 1m 이상 떨어진다. |
| `world.spawn` | 주인공의 실제 시작 좌표 `{x,z}`. |
| `world.entities` | 최대 48개 구조물. box/cylinder/spire/arch/tree/crystal/building/platform/beacon/hazard와 좌표·크기·회전·색·발광·충돌 여부. |
| `world.propPlacements` | 최대 24개 `{id,propIndex,x,z,stageId?}`. 실제 선택 소품 배열의 순번을 참조한다. |
| `world.enemySpawns` | 최대 16개 `{id,enemyIndex,x,z,stageId?}`. 실제 선택 적 배열의 순번을 참조한다. 평화로운 SF에서도 적 배열은 비워 둘 수 있다. |
| `world.npc` | 단일 `{id,x,z,name?,propIndex?}`. NPC의 실제 IP는 `props[propIndex]`다. |
| `mission.stages` | 순서가 있는 1–8개 행동 목표. collect/kills/reach/interact/survive/boss/talk. 실제 월드 ID와 IP 배열 순번을 참조한다. |
| `mechanics` | dash/jump/sprint/autoFire, 회복량·무기 피해·발사 간격·상호작용 거리. autoFire 기본값은 false다. |
| `artDirection` | 실제 하늘색·안개색/밀도·노출·블룸 값. |

구조물 크기는 폭/깊이 0.3–20m, 높이 0.1–18m, 바닥 높이 0–8m, 회전 ±π다. 기본 폭/깊이/높이는 2m이며 beacon/hazard는 기본 비충돌이다. 모든 월드 ID는 최대 48자의 제한된 식별자이고 세계 안에서 고유하다.

목표는 실제 배치된 대상을 참조해야 한다. 수집·처치·도달·상호작용 목표 수는 1–24이고 보스는 적 1명이다. survive만 1–200초이며 사용하지 않는 대상 필드를 넣을 수 없다. 이후 단계의 수집품·적은 해당 단계에 활성화하며, 이미 소비한 대상을 다음 단계에서 다시 요구할 수 없다.

## IP와 사용자 요구의 경계

`gameDesign.prompt`는 자유형 요구를 포함한 원문이다. 출연 선택과 역할은 `castIpIds`, `playerIpId`, `weaponIpId`, `propIpIds`, `enemyIpIds`, `npcIpIds`로 전달한다. 서버의 `game_design.py`는 출연과 역할을 검사하고 `spec.design`에 요구와 선택을 기록한다. NPC는 현재 한 명만 지원한다.

v2의 player/props/enemies는 실제 IP ID가 필요하다. 소품과 적은 JSON의 이름만 존재해서는 안 되며 실제 배치 또는 NPC 연결이 있어야 한다. 에셋 경로는 서버가 소유한 IP에서 해결한다. 모델이 보낸 sprite/model/weapon/animation URL을 사용하지 않는다. v2 적도 실제 선택 IP의 컷아웃 또는 모델을 사용한다.

공간과 목표의 구조적 유효성을 검사하지만, 자유형 요구의 모든 의미를 자동으로 입증하지는 않는다. 같은 출연 IP로 서로 다른 요구를 생성하고 저장된 월드·목표와 실제 조작 결과를 비교하는 검증이 필요하다.

## 검증과 제한

`server/tests`의 계약 테스트가 확인하는 것: 기존 v1 정규화, v2의 좌표·역할·목표 순서 보존, 적 없는 SF, 잘못된 엔진·인덱스·ID·목표 수·단계 재사용·충돌·유한값·외부 URL/실행 필드 거부.

필수 목표의 기본 지상 경로는 최대 10,000개 격자에서 검사한다. 회전 구조물의 경계와 충돌은 보수적인 AABB 검사다. 이는 실제 캐릭터 물리, 경사, 모든 점프 경로의 시뮬레이션을 대체하지 않는다.

지원 범위는 유한한 선언형 세계·단계별 목표·기존 IP 에셋·정해진 조작이다. 임의 JavaScript, 새 셰이더, 외부 에셋 URL, 멀티플레이 서버나 자동 AAA 게임 제작을 제공하지 않는다. 새 authored 세계는 three.js 전용이며 Phaser/Unreal 실행을 주장하지 않는다.

관련 구현: `server/authored_contract.py`, `server/gamespec.py`, `server/prompts.py`.

## 별도 배경·환경 슬롯

`gameDesign.backgroundIpId`는 선택 항목이다. 생략하면 기존 요청 형태를 유지한다. 지정할 때는 `castIpIds` 안의 소품(kind prop) 하나여야 하며 다른 역할과 중복할 수 없다.

모델이 작성하는 선택은 `world.background: {ipId, mode: "image"|"model", rotation?: number}`다. image의 회전은 0이고 model은 ±π 범위다. 서버는 image를 원본 `imageAssetId`, model을 raw `glbAssetId`에서 해결한다. 컷아웃·다른 IP·리깅 모델을 배경 원본으로 대체하지 않는다. 현재 소유 세션·에셋 종류·IP 일치·안전한 세션 경로·실제 이미지/GLB 헤더를 검사하고 게임 폴더의 `assets/{ipId}.background.png|glb`로 복사한다. 에이전트가 보낸 URL은 제거하며 그 밖의 실행·환경 필드를 허용하지 않는다.

image는 비율을 유지해 크롭하는 정적 화면 배경이고, model은 전체 raw GLB의 비율을 유지해 배치하는 정적 장면이다. 둘 다 0.85m 아이템 정규화·회전·수집 처리를 사용하지 않는다. 자동 3D 지형·시차·navmesh·모델 충돌 생성은 포함하지 않으며 기존 `world.entities` 또는 도시 배치가 이동과 충돌을 담당한다.

새 배경용 소품은 `create_ip_asset`의 `usage: "background"`로 생성하고 배경 제거 없이 전체 장면을 보존한다. 원본과 동일한 preview는 기존 자산 UI를 위한 호환 데이터이며 누끼 처리 증거가 아니다. 스튜디오의 배경 카드는 누끼 토글 대신 ‘배경 · 전체 장면’ 배지와 원본 이미지를 보여 준다. 일반 object 소품은 기존 동작을 유지한다.
