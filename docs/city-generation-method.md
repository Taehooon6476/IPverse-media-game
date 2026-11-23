# 기존 IPverse에서 도시 게임을 만드는 방식

인증된 채팅 경로에서 사용자가 고른 캐릭터·소품·NPC와 도시 요청을 GameSpec으로 저장하고 Three.js 게임으로 실행한다. **공통 도시 엔진이 모델이 작성한 선언형 데이터를 실행하는 방식**이며, 모델이 새 게임 엔진이나 임의의 실행 코드를 작성하지 않는다.

## UI 요청과 서버 입력

`web/src/components/DesignDrawer.tsx`의 ‘도시 오픈월드’ 유형과 ‘도시 코어 운송’ 프리셋은 기존 설계 drawer를 사용한다. 프리셋은 사용자가 선택한 IP나 역할을 바꾸지 않는다. 유형은 프롬프트를 구성하는 UI 값이며, 실제 도시 모드는 저장된 `version: 2`, `engine: "three"`, `world.city`로 결정된다.

`gameDesignRequest()`는 전체 설계와 선택 역할을 다음 형태로 직렬화한다. 원래 요청에 `[출연 IP cast_ip_ids=…]`와 선택한 IP 이름·종류도 포함한다.

```json
{
  "text": "전체 게임 요청과 공간·미션·조작 조건",
  "gameDesign": {
    "prompt": "text와 동일한 전체 원문",
    "castIpIds": ["선택한 주인공 ID", "선택한 소품 ID", "선택한 NPC ID"],
    "playerIpId": "선택한 주인공 ID",
    "weaponIpId": null,
    "propIpIds": ["선택한 소품 ID"],
    "enemyIpIds": [],
    "npcIpIds": ["선택한 NPC ID"]
  }
}
```

`App.tsx` → `api.sendChat()` → `POST /api/sessions/{sessionId}/chat`으로 보낸다. 서버는 세션 소유권, 원문 일치, 4,000자 제한, IP 존재 여부와 역할을 검사하고 사용자 메시지에 `gameDesign`을 저장한다. `npcIpIds`는 현재 한 종이며 도시 보행자는 그 NPC IP를 재사용한다.

## 실제 생성·패키징 경로

1. 채팅 API가 pending assistant 메시지를 만들고 기존 Lambda의 `agent_turn`을 비동기로 호출한다.
2. `server/agent.py`가 실제 세션 상태와 서버가 검증한 선택 역할을 Bedrock Converse에 제공한다. 모델 ID는 Lambda 환경 변수 `AGENT_MODEL_ID`다.
3. 에이전트가 `make_game`을 호출한다. 서버가 GameSpec, 도시 경계·도로·경로·대상 참조, 단계별 미션과 출연 역할을 검증한다. 도시 요청에 `world.city`가 없으면 작은 아레나로 저장하지 않고 오류를 반환한다. 실패한 도구 호출도 채팅 요약 기록에 남는다.
4. `make_game`이 모델이 작성한 `design`을 제거하고 원래 사용자 요청·역할을 서버 provenance로 저장한다. GLB·컷아웃 경로는 해당 세션의 준비된 IP 에셋에서 해결한다.
5. 신뢰된 공통 런타임과 실제 선택 IP 에셋을 S3의 `games/{gameId}/`로 복사하고 `spec.json`, `release.json`과 게임 레코드를 저장한다. 캐릭터·NPC의 준비된 리깅 GLB를 그대로 사용한다.
6. 기존 오른쪽 게임 패널은 게임 레코드의 `previewUrl`을 iframe으로 연다. 브라우저 런타임이 그 게임의 `spec.json`을 읽고 도시·차량·보행자·미션을 실행한다. GameSpec 요약은 저장된 도시 데이터와 주행 거리 목표를 읽으며 원래 요청과 구분해 표시한다.

공통 환경 키트는 `/games/city-kit/v1/city-assets/commonassetcatalog.json`과 그 아래 자산을 사용한다. 선택 IP는 게임별 폴더로 복사되고, 도시 건물·차량·가로시설은 출처와 라이선스가 보존된 공유 CC0 키트에서 로드된다. 도시 게임 생성은 새 이미지·3D·영상 작업을 시작하지 않는다.

## 예: 같은 IP로 만든 두 도시

같은 주인공·소품·NPC IP로 서로 다른 두 요청을 보낸 결과다. `scripts/create_city_games.py`가 새 세션에 소유 IP·에셋 레코드를 복제하고 인증된 채팅 API로 요청을 제출한다. 원본 세션과 원본 파일은 바뀌지 않는다.

| 실제 저장된 게임 | 낮의 해안 도시 | 밤의 산업 도시 |
| --- | --- | --- |
| 도시 크기 | 600 × 600m | 800 × 600m |
| 3개 구역 | 도심·주거·수변 | 산업·도심·주거 |
| 도로 6개 | x축의 z와 z축의 x 모두 −180 / 0 / 180m | x축 z는 −180 / 0 / 180m, z축 x는 −240 / 0 / 240m |
| 운전 차량 / 주행 목표 | 세단 1대 / 140m | SUV 1대 / 180m |
| 보행자 / 교통 차량 | 카이 IP 4명 / 6대 | 카이 IP 4명 / 4대 |
| 임무 순서 | 대화 → 주행 → 코어 회수 → 수변 배송 지점 | 코어 회수 → 주행 → 산업 배송 지점 |
| 하늘·안개·노출·블룸 | 낮의 청색, 안개 0.002, 노출 1.1, 블룸 0.2 | 밤의 남색, 안개 0.003, 노출 1.25, 블룸 0.75 |

프롬프트는 출발·NPC·차량·코어·배송 지점 좌표, 도로 폭, 보행자 순환 경로, 단계 ID와 주행 거리를 구체적으로 요청한다. `scripts/create_city_games.py`는 저장된 값과 요청을 비교한다. 도로 비교에서는 UUID 차이를 제거하고 축·좌표·폭을 비교하므로, 이름만 바뀐 동일 도로를 다른 구조로 판정하지 않는다.

## 검증 도구

- `scripts/create_city_games.py`: 생성 요청과 저장된 GameSpec·선택 자산 바이트·런타임 복사·원본 불변을 비교한다. raw Bedrock Converse 응답과 전체 tool payload는 보관하지 않는다.
- `scripts/verify_city_games.mjs`: 공개 게임 URL에서 native 키보드·포인터 입력으로 플레이한다(주행 거리, E 승하차, 보행자·교통 이동, 건물 충돌, 렌더 chunk 로드·해제, 재시작). 읽기 전용 `__ipverseGameState`만 관찰하고 위치·거리·미션 진행을 바꾸지 않는다.
- `scripts/verify_city_studio.mjs --input evidence/city-generation-live.json --output evidence/city-studio-live.json --screenshots evidence/city-studio` (`--self-test`는 로컬 자체 검사): 스튜디오의 원래 로그인 폼, 설계 요약·원본 요청·선택 역할, 오른쪽 iframe 로드와 시작을 확인한다. 자격 증명은 stdin의 `{"username","password"}` JSON으로만 받고, 로그인 외의 변경 요청은 브라우저 네트워크 단계에서 차단한다.
- `scripts/verify_city_delivery.py`: 배포된 코드·S3 객체·공개 런타임 바이트·인증 거부를 읽기 전용으로 확인한다.

390px 화면은 표시와 시작만 지원한다. 작은 16:9 창에서는 데스크톱 HUD·미니맵·미션 안내가 겹치고, 터치 운전은 없다.

## 엔진과 품질 제한

모델은 지원하는 도시 데이터와 미션을 작성하고, 제공한 Three.js 엔진이 차량 제어·충돌·NPC 경로·구역 배치·렌더 chunk를 실행한다. 구역 건물은 결정적 배치 로직과 공식 Kenney의 stylized low-poly CC0 자산 키트로 조립된다. 모델이 새로운 건물 메쉬·차량 물리·군중 AI 코드를 생성했다고 주장하지 않는다.

지원 범위는 300–1200m 월드, 3–6구역, 4–14개 축 평행 도로, 운전 차량 1–8대, NPC IP 한 종을 재사용한 보행자 1–8명, 교통 차량 최대 16대다. 보행자 경로도 수평·수직 도로/인도 구간으로 제한된다. 임의 곡선 도로, 복잡한 군중 행동, 실내·파괴·다중 사용자, 실사 도시 또는 GTA6/AAA 제작 품질은 지원 범위가 아니다. Unreal로 실행하지 않는다.

구체 계약은 `docs/city-contract.md`, 자산 출처는 `docs/city-assets.md`, 고품질 제작과의 구분은 `docs/open-world-quality.md`에 있다.
