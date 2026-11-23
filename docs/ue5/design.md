# UE5 + Amazon GameLift Streams 설계

상태(2026-10-30): 코드와 인프라는 준비됐고, 첫 빌드는 Epic 컨테이너 이미지용 토큰(`ipverse/ghcr-token`)을 기다린다. 가격은 2026-10-30에 AWS Price List API로 확인했다.

| 구성 | 위치 | 상태 |
|---|---|---|
| 빌드 박스 `IpverseUe5Build` | us-east-1, c6i.8xlarge, 유휴 30분 뒤 자동 정지 | 배포됨 |
| 스트림 `IpverseStreams` | us-west-2, 그룹 `sg-awoQFa2Sf`, gen6n_high, 용량 0 | 배포됨(애플리케이션 없음) |
| 서버 `/api/sessions/{id}/stream` | `server/streams.py` | 코드·테스트 완료, IpverseCore 배포 필요 |
| 웹 Unreal 패널 | `web/src/components/UnrealStream.tsx` | 코드·테스트 완료 |
| UE5 게임 | `ue5/` | 컨테이너에서 첫 컴파일 전 |

three.js 런타임(`game3d/`)이 당장 쓰는 엔진이다. UE5 트랙은 "실사급 게임" 요구를 위한 두 번째 런타임이고, 같은 GameSpec을 읽는다.

## 1. 결정 요약

| 항목 | 결정 | 근거 |
|---|---|---|
| 엔진 | UE 5.6 | GameLift Streams 문서가 UE5 지원을 5.6까지로 명시 [1] |
| 빌드 방식 | 템플릿 게임 **하나**를 한 번 패키징. 게임별 차이는 실행 시 받는 매니페스트 | 게임마다 쿡·패키징하면 수십 분 걸리고 UE 라이선스 머신이 계속 필요하다 |
| 플랫폼/런타임 | **Linux 네이티브 패키지 + Ubuntu 22.04 LTS 런타임** | Windows 라이선스 비용이 없고 GPU 1장을 2세션이 나눠 쓰는 클래스를 쓸 수 있다. Proton 호환성 위험도 없다 [1][2] |
| 스트림 클래스 | **gen6n_high** (L4, 세션당 4 vCPU·16GB·VRAM 12GB, GPU당 2세션) | UE5 1080p60을 노릴 수 있는 가장 싼 L4 클래스. gen4n_high가 더 싸지만 T4·VRAM 8GB라 벤치마크 후 결정 |
| 리전 | 기본 위치 us-west-2, 선택 위치 ap-northeast-2(서울) | API 엔드포인트는 us-west-2에 있고 서울은 엔드포인트가 없는 원격 위치다. 한국 관객이면 서울을 켠다 |
| 용량 | 평소 0. 데모 시간에만 always-on 1 | 용량은 할당된 동안 유휴여도 초 단위 과금 [3] |
| 리깅 | v1 절차적 모션(정적 메시), v2 오프라인 자동 리깅 | 아래 6절 |
| GLB 로딩 | glTFRuntime 플러그인(오픈소스) | 패키징된 게임에서 GLB를 런타임 임포트하는 사실상 표준 |
| 월드 제작 | 맵은 빈 맵 하나, 하늘·지형·소품은 C++가 런타임에 생성 | 헤드리스 에디터 작업을 머티리얼 5개로 줄여 실패 지점을 없앴다. 지형 시드도 GameSpec에서 온다 |
| 빌드 | Epic 공식 컨테이너 `dev-slim-5.6.x`, SSM으로 원격 실행 | 사람 손 없이 반복 가능. Epic 계정 연결 GitHub 토큰만 필요 |

## 2. 아키텍처

```
IPverse 웹 (게임 패널 / 공개 페이지)
  │ 1. 프리롤 광고 재생 시작 + Web SDK generateSignalRequest()
  │ 2. POST /api/sessions/{id}/stream  {signalRequest}
  ▼
API Lambda (us-east-1)
  │ 3. 매니페스트 생성: GameSpec + GLB presigned URL(15분) → S3 → manifest presigned URL(15분)
  │ 4. gameliftstreams:StartStreamSession (us-west-2)
  │      AdditionalEnvironmentVariables = {IPVERSE_SPEC_URL: <manifest url>}
  ▼
GameLift Streams 스트림 그룹 (gen6n_high, Ubuntu 22.04)
  │ 5. IpverseGame.sh 실행 → UIpverseSpecSubsystem이 매니페스트·GLB 다운로드
  │ 6. glTFRuntime으로 StaticMesh 생성 → BootGameMode가 장르로 템플릿 맵을 연다
  ▼
웹: GET .../stream/{streamId} 폴링 → ACTIVE이면 signalResponse → processSignalResponse() → attachInput()
```

### 데이터 기반 "게임 만들기"

새 게임을 만들 때 재컴파일·재쿡은 없다. 에이전트가 이미 만드는 GameSpec v1(`server/gamespec.py`)을 그대로 쓴다.

| GameSpec | UE5 템플릿에서의 의미 |
|---|---|
| `genre` `sf-shooter`, `sf-survival` | Arena 맵: Third Person 템플릿 기반 슈터 아레나. kills/survive 목표 |
| `genre` `rpg-explore`, `rpg-quest` | OpenWorld 맵: Landscape 필드 + NPC 대화 + 퀘스트 트래커. collect/talk 목표 |
| `player.ipId`, `props[].ipId` | 해당 IP의 GLB 메시. 없으면 템플릿 기본 메시 |
| `enemies[]` speed·hp·color | 적 AI 파라미터와 머티리얼 틴트 |
| `props[].effect` | heal·score·shield·key 픽업 Blueprint |
| `dialogue[]`, `quest`, `objective` | 대화 위젯, 퀘스트 텍스트, 승리 조건 |
| `palette.accent`, `difficulty` | UI 강조색·라이트 틴트, 적 수·데미지 배율 |

매니페스트 v1 형식은 `ue5/manifest.example.json`이다. 실행 계약은 `-IpverseSpecUrl=<https url>` 실행 인자 또는 `IPVERSE_SPEC_URL` 환경 변수이고, 환경 변수를 권장한다. 환경 변수 값 한도는 4096자라 presigned URL이 들어간다 [4].

## 3. 스트림 클래스와 비용

us-west-2 온디맨드 단가, 스트림 용량 1개 기준, AWS Price List API(`AmazonGameLiftStreams`)로 확인 [3]:

| 스트림 클래스 | GPU | 세션당 자원 | USD/시간 | 판단 |
|---|---|---|---|---|
| gen6n_medium | L4 1/4 | 2 vCPU, 8GB, VRAM 6GB | 0.3848 | UE5에는 부족 |
| gen4n_high | T4 1/2 | 4 vCPU, 16GB, VRAM 8GB | 0.4982 | 최저가 후보. 벤치마크 필요 |
| **gen6n_high** | L4 1/2 | 4 vCPU, 16GB, VRAM 12GB | **0.7127** | **기본값** |
| gen5n_high | A10G 1/2 | 4 vCPU, 16GB, VRAM 12GB | 0.7625 | gen6n_high보다 비싸다 |
| gen6n_ultra | L4 전체 | 8 vCPU, 32GB, VRAM 24GB | 1.3198 | 품질 상향 시 |
| gen4n_win2022 | T4 전체 | 8 vCPU, 32GB, VRAM 16GB | 1.5120 | Windows 대안 최저가 |
| gen6n_ultra_win2022 | L4 전체 | 8 vCPU, 32GB, VRAM 24GB | 1.8166 | AWS 권장 Windows 기본 [2] |

서울(ap-northeast-2) gen6n_high는 시간당 0.7975달러다. 빌드 저장은 GB-월 0.0296달러다(us-west-2).

비용 예시 (gen6n_high, us-west-2):

| 시나리오 | 계산 | 비용 |
|---|---|---|
| 데모 하루 8시간 always-on 1 | 8 × 0.7127 | 약 5.70달러 |
| always-on 1을 한 달 내내 | 730 × 0.7127 | 약 520달러 |
| 온디맨드 플레이 30분 × 100회 | 50 × 0.7127 | 약 35.6달러 |

CloudFormation 문서는 gen6n_high와 gen4n_high 모두 기준 해상도 1080p, 기준 프레임 60fps로 적는다 [5]. 실제 UE5 장면에서 60fps가 나오는지는 측정하지 않았다.

**벤치마크 기준.** gen6n_high로 시작한다. 같은 빌드를 gen4n_high 스트림 그룹에서 10분 돌려 1080p에서 프레임 타임 p95가 16.7ms 이하이면 gen4n_high로 내린다. 스트림 클래스는 생성 후 바꿀 수 없어서 새 스트림 그룹이 필요하다 [5].

## 4. 용량 모드와 콜드 스타트

| 모드 | 배치 제한 시간 [4] | 과금 | 용도 |
|---|---|---|---|
| always-on | 75초 | 세션이 없어도 계속 | 예정된 데모 시간 |
| 온디맨드 (Linux/Proton) | 90초 | 세션이 있는 동안 | 평소 |
| 온디맨드 (Windows) | 10분 | 세션이 있는 동안 | Windows 대안을 쓰면 체감이 크게 나빠진다 |

예상 첫 화면까지 시간은 다음과 같다. **측정하지 않은 추정이다.**

- 배치: always-on이면 수 초, 온디맨드면 최대 90초. AWS 가격 페이지는 최소 용량을 넘는 확장에 "보통 몇 분"이 걸린다고 적고 있다 [3].
- UE 프로세스 기동, 매니페스트·GLB 다운로드, 메시 생성: 10–30초로 추정.
- 웹은 그동안 프리롤 광고를 튼다. AWS 가격 페이지 예시도 30초 광고로 시작 대기를 가리는 패턴을 쓴다 [3].

결정: 평소 `MaxCapacity=1`, `AlwaysOnCapacity=0`. 데모 시작 30분 전에 `AlwaysOnCapacity=1`로 올리고 끝나면 0으로 내린다.

## 5. 백엔드 계약 (server/ 담당 에이전트가 구현)

모든 경로는 기존 Cognito `X-Auth-Token`을 쓰고 `_own_session`으로 소유권을 확인한다. API Gateway 29초 제한 때문에 시작과 연결 정보 받기를 나눈다.

### `POST /api/sessions/{id}/stream`

요청: `{"signalRequest": "<Web SDK generateSignalRequest() 결과>"}`

서버 동작:
1. 세션의 GameSpec을 `validate_spec`으로 다시 검증한다. 실패하면 409를 준다.
2. 사용자당 활성 스트림 1개 제한. 이미 있으면 그 세션을 `TerminateStreamSession`으로 끝낸다.
3. 매니페스트를 만든다. `ips[ipId].glbUrl`은 IP의 `glbAssetId` 객체 presigned GET(15분)이다. `s3://<assets>/ue5/{sessionId}/{uuid}.json`에 저장하고 presigned GET(15분)을 만든다.
4. `StartStreamSession` 호출 (us-west-2):
   ```python
   gls.start_stream_session(
       Identifier=STREAM_GROUP_ID, ApplicationIdentifier=APPLICATION_ID,
       Protocol="WebRTC", SignalRequest=body["signalRequest"],
       UserId=user["sub"],
       AdditionalEnvironmentVariables={"IPVERSE_SPEC_URL": manifest_url},
       Locations=["ap-northeast-2", "us-west-2"],  # 서울을 켰을 때만 앞에 둔다
       SessionLengthSeconds=1800, ConnectionTimeoutSeconds=120,
       DisplayConfiguration={"Resolution": {"Width": 1920, "Height": 1080}},
   )
   ```
5. 세션 레코드에 `streamSessionArn`을 저장한다.

응답 202: `{"streamId": "<arn 마지막 구간>", "status": "ACTIVATING"}`

### `GET /api/sessions/{id}/stream/{streamId}`

`GetStreamSession`을 호출한다. 응답 200: `{"status": "ACTIVATING|ACTIVE|CONNECTED|PENDING_CLIENT_RECONNECTION|ERROR|TERMINATED", "signalResponse": "<ACTIVE일 때만>", "statusReason": "<ERROR일 때, 예: placementTimeout>"}`. 웹은 2초마다 폴링한다. ERROR이면 three.js 런타임으로 대체한다.

### `POST /api/sessions/{id}/stream/{streamId}/reconnect`

요청: `{"signalRequest": "..."}`. `CreateStreamSessionConnection`을 호출한다. 응답 200: `{"signalResponse": "..."}`. 탭 새로고침이나 네트워크 끊김 뒤 `ConnectionTimeoutSeconds` 안에 쓴다.

### `DELETE /api/sessions/{id}/stream/{streamId}`

`TerminateStreamSession`을 호출한다. 응답 204. 웹은 게임 패널을 닫거나 `pagehide` 때 `fetch(..., {keepalive: true})`로 부른다. `sendBeacon`은 인증 헤더를 못 실어서 쓰지 않는다.

### 서버 설정과 권한

- 환경 변수: `STREAMS_REGION=us-west-2`, `STREAM_GROUP_ID`, `STREAM_APPLICATION_ID`, `STREAM_LOCATIONS`.
- IAM: 스트림 스택 출력 `ApiStreamPolicyArn`(관리형 정책)을 API Lambda 역할에 붙인다. 액션은 `StartStreamSession`, `GetStreamSession`, `TerminateStreamSession`, `CreateStreamSessionConnection`이고 리소스는 해당 스트림 그룹으로 한정된다. IAM은 글로벌이라 us-east-1 Lambda에 그대로 붙는다.

### 웹 클라이언트

Web SDK는 npm 패키지가 아니라 GameLift Streams 시작 페이지의 Resources에서 받는 번들이다 [6]. 함수 이름은 SDK에 포함된 API Reference로 다시 확인한다.

1. `new GameLiftStreams({videoElement, audioElement, clientConnection: {connectionState, channelError, serverDisconnect}})`
2. 프리롤 광고 재생과 동시에 `generateSignalRequest()` → POST
3. 폴링으로 `signalResponse`를 받으면 광고가 끝난 뒤 `processSignalResponse(signalResponse)`
4. 첫 클릭에 `attachInput()`. 마우스·키보드·게임패드가 붙는다.

공개 페이지에서 UE5 스트림은 로그인 사용자만 쓴다. 비로그인 방문자는 three.js 런타임을 본다. 스트림은 사용자당 과금되므로 익명 노출은 비용 상한이 없다.

## 6. 에셋 요구사항과 리깅

현재 3D 파이프라인(Deadline Cloud의 Blender 작업, `render_3d`)이 만드는 GLB는 리그가 없는 정적 메시다.

**결정: v1은 절차적 모션, v2는 오프라인 자동 리깅.**

- **v1 절차적 모션.** IP 메시를 StaticMesh로 불러 Third Person 캐릭터 캡슐에 붙이고 Manny 메시는 숨긴다. `UIpverseProceduralMotionComponent`가 속도에 맞춰 통통 튀기, 진행 방향 기울기, 착지 찌그러짐, 숨쉬기를 준다. 이유는 세 가지다. IP 중 소품·생물·비인간형이 많아 휴머노이드 리그가 맞지 않는다. 지금 바로 모든 IP에 동작한다. 실패 지점이 없다. 대가는 "피규어가 움직이는" 느낌이다.
- **v2 자동 리깅.** 휴머노이드 IP만 대상이다. 기존 Deadline Blender 작업 뒤에 자동 리깅 단계를 붙여 Mixamo 호환 본 이름의 스킨드 GLB를 만든다. UE 쪽은 glTFRuntime 스켈레탈 메시 로딩과 미리 만든 IK Retargeter(Mixamo → UE5 Manny)로 템플릿 애니메이션을 재사용한다. **자동 리깅 품질과 도구 선택은 검증하지 않았다.**
- **Mixamo를 쓰지 않는 이유.** 공개 API가 없고 Adobe 계정으로 수동 업로드해야 해서 자동 파이프라인에 넣을 수 없다.

GLB 요구사항:

- glTF 2.0 바이너리, Y-up, 미터 단위. glTFRuntime 기본 설정이 UE의 Z-up 센티미터로 바꾼다.
- PBR metallic-roughness 머티리얼, 텍스처 2048px 이하, GLB 하나 20MB 이하, 삼각형 10만 개 이하(권장, 미측정).
- 원점은 발바닥 중앙, 정면은 +Z(glTF 기준). 크기는 템플릿이 바운드 기준으로 맞춘다.

## 7. 보안

- **세션 인증.** 스트림 API는 모두 Cognito 토큰과 세션 소유권을 확인한다. `UserId`에 Cognito `sub`를 넣어 감사 추적을 남긴다.
- **서명 URL.** 매니페스트와 GLB는 15분짜리 presigned GET이다. 자산 버킷은 계속 비공개다. 게임은 URL을 로그에 남기지 않는다.
- **비공개 S3.** 빌드 버킷은 퍼블릭 액세스를 모두 막고 TLS만 허용한다. `gameliftstreams.amazonaws.com`만 `aws:SourceAccount` 조건으로 `builds/*` 읽기와 `logs/*` 쓰기를 한다.
- **게임에 AWS 자격 증명 없음.** `RoleArn`을 주지 않는다. 게임은 presigned URL 말고 AWS에 접근하지 않는다.
- **비용 가드.** 사용자당 활성 스트림 1개, `SessionLengthSeconds=1800`, 스택 `MaxCapacity` 상한.
- **IAM 최소 권한.** API 정책은 스트림 그룹 하나와 그 세션으로 한정된다.

## 8. 인프라 (`infra/stacks/streams_stack.py`)

배포 스크립트와 `app.py`에 넣지 않았고 배포하지 않았다. 합성 테스트는 `infra/tests/test_streams_stack.py`다.

| 리소스 | 내용 |
|---|---|
| S3 `ipverse-ue5-builds-<account>-us-west-2` | 패키징 빌드(`builds/<version>/`)와 세션 로그(`logs/`) |
| `AWS::GameLiftStreams::Application` | `BuildVersion` 파라미터가 비어 있지 않을 때만 생성. UBUNTU 22_04_LTS, `IpverseGame.sh` |
| `AWS::GameLiftStreams::StreamGroup` | `StreamClass` 기본 gen6n_high, `MaxCapacity`·`AlwaysOnCapacity`·`SeoulMaxCapacity` 기본 0 |
| `AWS::IAM::ManagedPolicy` | API Lambda용 스트림 세션 권한 |

`DefaultApplication`을 나중에 채우는 업데이트는 중단 없이 적용된다. `StreamClass`를 바꾸면 스트림 그룹이 교체되어 ID가 바뀌므로 서버 환경 변수도 바꿔야 한다 [5].

## 9. 사용자가 해야 할 일 (차단 요소)

1. **Epic Games 계정과 Unreal Engine EULA 동의.** UE 설치·소스 접근에 필요하다. 에이전트가 대신할 수 없다.
2. **UE 빌드 머신.** Windows + Visual Studio 2022 + UE 5.6(Linux 크로스 컴파일 툴체인 포함) 또는 UE 소스를 빌드한 Ubuntu 22.04 GPU 머신.
3. **템플릿 콘텐츠 제작.** Arena·OpenWorld 맵, 캐릭터·적·픽업 Blueprint, UI 위젯. 에디터 작업이라 사람이 하거나 UE가 깔린 머신에서 해야 한다.
4. **스트림 용량 예산 승인.** 기본값은 0달러다. 데모 하루 약 6달러, 상시 1대 월 약 520달러(gen6n_high, us-west-2).
5. **리전 결정.** 관객이 한국이면 서울 위치를 켠다(`SeoulMaxCapacity`).
6. **GameLift Streams 서비스 할당량 확인.** 이 계정에서 확인하지 않았다.

## 출처

1. 구성 옵션(런타임, 스트림 클래스): https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/configuration-options.html
2. 구성 선택 가이드: https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/choosing-configuration.html
3. 가격(과금 방식, 예시): https://aws.amazon.com/gamelift/streams/pricing/ — 클래스별 단가는 AWS Price List API `aws pricing get-products --service-code AmazonGameLiftStreams --region us-east-1`
4. StartStreamSession API: https://docs.aws.amazon.com/gameliftstreams/latest/apireference/API_StartStreamSession.html
5. CloudFormation StreamGroup: https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-gameliftstreams-streamgroup.html
6. Web SDK 설정: https://docs.aws.amazon.com/gameliftstreams/latest/developerguide/setting-up-web-sdk.html
7. UE 5.6을 Proton으로 Linux 런타임에서 돌리는 AWS 블로그(Linux 실행 조건: X11, root 금지): https://aws.amazon.com/blogs/gametech/run-unreal-engine-5-6-with-proton-on-amazon-gamelift-streams-linux-runtime
8. glTFRuntime: https://github.com/rdeioris/glTFRuntime
