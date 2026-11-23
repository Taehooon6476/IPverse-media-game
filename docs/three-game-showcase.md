# 세 가지 실제 게임 쇼케이스

> 이 문서가 가리키는 `evidence/` 아래 파일은 이 사본에 포함되어 있지 않습니다. 아래 스크립트를 실행하면 다시 만들어집니다.

기존 IPverse 스튜디오 UI와 게임 runtime을 유지한다. 별도 static gallery가 실제 생성된 탐험 RPG·SF 전투·시설 탈출 게임의 플레이 캡처, 미션 순서, 조작법과 IP 역할을 보여주고 실제 플레이 URL 및 스튜디오 세션으로 연결한다.

## 입력과 빌드

`evidence/three-game-showcase-generation.json`의 `cases`에 `type`, `sessionId`, `gameId`, `previewUrl`, 실제 저장된 `spec`을 포함한다. type은 `exploration`, `combat`, `escape`이며 각 v2 spec에 정확히 세 단계 미션이 있어야 한다. IP 이름은 같은 report의 검증된 `sourceAssetInventory`에서 읽고 실제 spec의 player·props·enemies·weapon 슬롯에 역할을 연결한다. 각 게임의 실제 플레이 PNG는 다음 경로를 사용한다.

1. `evidence/three-game-showcase/exploration-playing.png`
2. `evidence/three-game-showcase/combat-playing.png`
3. `evidence/three-game-showcase/escape-playing.png`

선택적으로 같은 폴더의 `{type}-short.mp4`를 실제 gameplay 영상으로 붙일 수 있다. 외부 이미지나 mock 화면을 대신 쓰지 않는다.

전투 대표 poster는 실제 첫 처치가 보이는 `combat-combat-kill-1.png`가 있으면 이를 선택한다. 기존 `combat-playing.png`를 덮어쓰거나 이미지를 보정하지 않는다. manifest의 `sourceScreenshot`과 SHA가 실제 사용한 원본을 기록한다.

```sh
python3 scripts/build_three_game_showcase.py
```

생성 결과는 `artifacts/three-game-showcase/site/`에 있다. builder는 local evidence만 읽고 인증, 모델 호출, 게임 변경 또는 AWS 업로드를 수행하지 않는다. 원본 PNG/MP4는 SHA를 포함한 파일명으로 복사한다. 미션은 실제 saved spec을 사용하며 생성 텍스트를 HTML-escape한다. 링크는 기존 IPverse CloudFront의 해당 gameId 경로만 허용한다. 대시는 Q, 공격은 클릭 / F이고 점프·달리기·상호작용 표시는 각 spec의 mechanics와 미션에 맞춘다.

실제 플레이 캡처가 아직 없으면 기본 빌드는 실패한다. 로컬 작업 중 `--allow-pending`을 사용하면 명확히 표시된 placeholder를 만들 수 있지만 build manifest 상태가 `DRAFT_SCREENSHOTS_PENDING`이고 실제 캡처 완료를 주장하지 않는다.

## 공개 업로드 계약

`artifacts/three-game-showcase/build-manifest.json`은 파일별 `s3Key`, `contentType`, `cacheControl`, bytes, SHA를 제공한다. operator가 `READY`를 확인한 뒤 manifest에 선언된 파일만 기존 bucket의 다음 prefix로 올린다.

```text
web/showcases/three-game-types-20261101/
```

기존 CloudFront default origin은 `/web`이므로 실제 진입 URL에 `index.html`을 포함해야 한다.

```text
https://d12ka835iwfpnx.cloudfront.net/showcases/three-game-types-20261101/index.html
```

공개 gallery에는 데모 로그인 정보, 인증 토큰, backend 내부 설정을 넣지 않는다. `바로 플레이`는 각 실제 게임 미리보기를 새 창에서 열고, `스튜디오 세션`은 기존 studio의 해당 세션으로 이동한다.

실제 PNG/MP4만 content hash 이름과 긴 immutable 캐시를 사용한다. `index.html`과 `styles.css`는 짧은 캐시로 재빌드한 갤러리가 이전 스타일을 재사용하지 않도록 한다. gallery에는 JavaScript가 없으며 CSP가 같은 origin의 stylesheet·image·video만 허용한다.

## 검증 범위

갤러리 builder는 실제 gameplay 성공이나 3D 모델 효과를 검증하지 않는다. 그 검증은 게임별 runtime QA(`scripts/verify_three_game_showcase.mjs`)가 한다.

`evidence/three-game-showcase-builder-verification.json`은 로컬 fixture 입력으로 누락된 캡처, 실패한 생성, 잘못된 game URL, HTML 삽입, media symlink와 output 경로 이탈을 거부하는지 검사한 기록이다.

## 공개된 갤러리

갤러리는 위 CloudFront `index.html` URL에 있다. HTML·CSS·PNG 3개·MP4 3개, 총 8개 파일이다.

| 게임 | 실제 gameId | 실제 미션 순서 | 시간 |
| --- | --- | --- | --- |
| 숲의 코어 탐험 | `gm_79d1aae71c` | 카이 대화 → 코어 3개 수집 → 신전 비콘 도착 | 제한 없음 |
| 네온 거점 돌파 | `gm_6d9f10c2f0` | 좀비 2명 처치 → 코어 회수 → 탈출 게이트 도착 | 제한 없음 |
| 전력시설 탈출 | `gm_126ec27234` | 코어 2개 회수 → 단말 2개 E 상호작용 → 게이트 도착 | 120초 |

세 게임은 준비된 제나·에너지 코어·카이를 활용한다. 전투에는 추가로 실제 선택된 플라즈마 라이플과 사이버 좀비 병사가 들어간다. 카드의 미션·timer·mechanics·IP 역할은 saved spec과 검증된 source inventory에서 읽었다. 실제 구현은 Three.js browser game이며 Unreal 실행 결과로 해석하지 않는다.

1. [최종 집계](../evidence/three-game-showcase-verification.json)
2. [공개 갤러리 browser QA](../evidence/three-game-showcase-gallery-public.json)
3. [실제 생성 및 IP bindings](../evidence/three-game-showcase-generation.json)
4. [게임 입력 및 승리 QA](../evidence/three-game-showcase-play.json)
5. [실제 clip decode](../evidence/three-game-showcase-media.json)
6. [공개 desktop](../evidence/three-game-showcase/gallery-live-desktop.png) / [공개 mobile](../evidence/three-game-showcase/gallery-live-mobile.png)
