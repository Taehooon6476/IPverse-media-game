# IPverse 게임 설계 UI 변경 · 2026-11-01

기존 스튜디오, 분할 화면, 게임 탭, 색상과 drawer 디자인을 유지했다. 변경 범위는 `web/`이다. backend, game3d runtime, AWS 리소스와 배포는 수정하지 않았다.

## 확인한 원인

기존 게임 설계는 게임 유형과 용광로 테마를 기본 선택했다. 선택 IP는 채팅 본문의 `cast_ip_ids` 태그로만 전달했으며, 실제 API body는 `{text}`였다. 주인공·무기·소품·적·NPC 역할을 명시하지 않았다. 생성 결과는 미리보기와 GameSpec JSON만 제공해 사용자가 요청과 실제 저장된 게임 설정을 비교하기 어려웠다.

## 요청 계약

기존 `POST /api/sessions/{id}/chat`에 `gameDesign`을 함께 보낸다.

```json
{
  "text": "[게임 설계] ...",
  "gameDesign": {
    "prompt": "[게임 설계] ... 프롬프트와 상세 설계 전체 ...",
    "castIpIds": ["ip_player", "ip_core"],
    "playerIpId": "ip_player",
    "weaponIpId": null,
    "propIpIds": ["ip_core"],
    "enemyIpIds": [],
    "npcIpIds": []
  }
}
```

`prompt`에는 자유 프롬프트, 지정한 유형·환경, 미션·클리어·실패 조건, 적 구성, 난이도, 추가 규칙과 선택 IP가 모두 포함된다. IP 선택이 없으면 빈 목록과 `playerIpId:null`을 전달해 모델이 세션 IP를 고를 수 있다. 수동 선택 시 주인공 캐릭터는 정확히 1명, 주인공 무기와 NPC는 각각 최대 1개/1명이다. 선택하지 않은 IP가 역할 목록에 추가되지 않는다.

자유 프롬프트와 출연 IP를 먼저 배치했다. 기존 프리셋은 선택할 수 있으며, 기본 유형·테마·난이도는 ‘요청에 맞게’이다. 요청이 실패하면 프롬프트와 선택이 유지된다.

backend 계약을 재확인해 프롬프트 전체의 Unicode code point 4,000자 제한을 추가했다. 상세 조건과 IP 태그까지 포함해 계산하며, 초과하면 입력을 잘라내지 않고 안내와 함께 전송을 막는다.

## 생성 결과 확인

`GameDesignSummary`는 **저장된 spec**에서 미션 순서, 목표, 월드 크기와 배치 수, 규칙·조작 기능, 각 IP 역할을 읽는다. v2 NPC는 `world.npc.propIndex`를 통해 실제 `props` 슬롯에 연결한다. 3D·이미지 표기는 spec의 `modelUrl`·`spriteUrl`에 근거하며, IP 라이브러리에 새 3D가 있다는 이유로 해당 게임에 적용됐다고 표시하지 않는다.

선택 IP의 누락, 선택 밖 IP, 역할 불일치, v2 월드 배치가 없는 선택 IP를 표시한다. GameSpec 탭에서는 `spec.design.sourcePrompt` 또는 게임 metadata에 저장된 원본 요청을 별도로 비교할 수 있다. 이전 v1 게임도 기존 미션·환경 요약을 지원한다.

이 요약은 설정·연결 확인이다. 실제 로딩, 플레이 완료, 요구사항의 의미적 충족 또는 그래픽 품질을 증명하지 않는다.

## 검증

1. `npm run build`: typecheck와 production build 통과.
2. `npm test -- --reporter=dot`: 5개 파일, 28개 테스트 통과. API body와 정확한 UTF-8 SHA-256, 실제 React 입력·역할 변경·요청 실패 보존, 전체 Unicode 프롬프트 길이 경계, v2 미션·IP 배치, v1 호환과 생성 텍스트 escaping을 검증했다.
3. `agent-browser`의 독립 세션 `ipverse-design-ui-qa`: 실제 컴포넌트를 로컬 mock 및 명시적 v2 fixture로 확인했다. 1440×1000 desktop과 390×844 mobile 화면을 캡처했으며 가로 넘침이 없었다. 사용한 browser 세션은 종료했다.

검증 JSON은 `game-design-verification-20261101.json`이며 source SHA와 screenshot SHA를 포함한다. 모든 화면은 **로컬 fixture UI 증거**이고, 배포된 d12 화면이나 실제 모델 생성 결과의 증거가 아니다.

추가 실제 배포 화면 검증은 별도 `game-design-live-ui-20261101.md`와 `game-design-live-verification-20261101.json`에 저장했다.

스크린샷:

1. `game-design-desktop-20261101.png`
2. `game-design-prompt-mobile-20261101.png`
3. `game-summary-v2-desktop-20261101.png`
4. `game-summary-v2-mobile-20261101.png`
