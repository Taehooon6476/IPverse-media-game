# IPverse Studio

아이디어 하나를 채팅으로 입력하면 IP 이미지, 3D 모델, 영상, 브라우저에서 바로 플레이하는 게임, 시청자별 광고가 들어가는 라이브 방송까지 만드는 스튜디오입니다. 왼쪽 패널은 IP(캐릭터·소품·3D·영상), 오른쪽 패널은 게임이며 둘은 같은 IP 레코드를 씁니다. 게임은 모델이 작성한 데이터(GameSpec)를 서버가 검증한 뒤 고정된 런타임이 실행합니다. 모델이 만든 코드는 실행하지 않습니다.

## 할 수 있는 일

- 채팅으로 컨셉, 캐릭터·소품 이미지, 같은 캐릭터의 변형을 만듭니다.
- 이미지를 3D 메시(GLB)로 만들고 리깅·턴테이블 렌더를 합니다.
- 영상 샷을 만들고 편집하며, 트레일러와 숏츠로 자릅니다.
- 출연 IP와 역할을 골라 게임을 만들고 수정합니다(3D 월드·단계별 미션, 도시 오픈월드, 레이싱 등).
- 게임을 공개 URL로 게시하고 트레일러를 시작 전·N판마다 광고로 붙입니다.
- 게임 플레이를 라이브로 방송합니다. 시청자마다 다른 트레일러 광고, 방송 중 바로 플레이하는 플레이어블 광고, 하이라이트 클립을 보낼 수 있습니다.
- 자연어로 정의한 에이전트를 일정에 따라 실행하고, 외부 MCP 서버를 연결해 채팅 도구로 씁니다.

## 아키텍처

| 서비스 | 여기서 하는 일 |
| --- | --- |
| CloudFront | 웹 앱(`/`), 세션 에셋(`/sessions/*`), 게임(`/games/*`), 런타임(`/runtime/*`)을 S3에서, `/api/*`를 Lambda Function URL(AWS_IAM + OAC)에서 제공 |
| Lambda `ipverse-api` | API 전체(Python 3.12). 채팅 턴·ffmpeg 작업·하이라이트는 자기 자신을 비동기로 호출해 실행 |
| DynamoDB `ipverse-main` | 단일 테이블: 세션, IP, 에셋, 작업, 게임, 에이전트, 시청자 |
| S3 `ipverse-assets-…` | 웹 앱, 세션 에셋, 게임 폴더, 게임 런타임, IVS 녹화 |
| Cognito `ipverse-users` | 로그인(`USER_PASSWORD_AUTH`). API는 `X-Auth-Token`의 액세스 토큰을 검사 |
| Bedrock | 채팅 에이전트(Converse 도구 루프), 배경 제거, Stable Image Ultra(선택), 하이라이트 분석(TwelveLabs Pegasus) |
| GPU 박스(mediagen MCP) | 이미지(Krea 2 Turbo, FLUX.2 klein 9B)와 영상(LTX-2.5, MiniMax H3, Kandinsky, Wan) 생성. MCP 프록시 2개를 JSON-RPC로 호출 |
| SQS + EC2 (`IpverseImg3d`) | Hunyuan3D-2.1로 이미지 → 3D 메시. 박스는 작업이 있을 때만 켜짐 |
| Deadline Cloud | Blender 턴테이블 렌더, 캐릭터 리깅 |
| ffmpeg Lambda 레이어 | 트레일러·숏츠·하이라이트 편집, 한글 자막 폰트 |
| Amazon IVS | 플레이 창의 게임 화면을 저지연 채널로 송출, 시청, 녹화, 타임드 메타데이터, 서버 측 광고 삽입 |
| MediaTailor | IVS 광고 구간마다 시청자별 VAST(`/vast/ivs/p-<persona>.xml`)를 읽어 트레일러를 삽입 |
| GameLift Streams (us-west-2) | 플레이어블 광고와 클라우드 플레이: 웹 플레이어 스트림 그룹, UE5 스트림 그룹 |
| EventBridge | Scheduler가 1분마다 작업 진행, 5분마다 에이전트 점검, 에이전트별 일정을 실행. 규칙 하나가 5분마다 라이브 자원을 정리 |
| Secrets Manager · SSM | 데모 계정, IVS 재생 키, MCP 프록시 키 |

CDK 스택: `IpverseCore`, `IpverseLive`, `IpverseImg3d`(us-east-1), `IpverseVideo`(us-west-2). `IpverseStreams`와 `IpverseUe5Build`는 `-c ue5=1`을 줄 때만 합성됩니다.

## 저장소 구조

| 경로 | 내용 |
| --- | --- |
| `web/` | React + Vite SPA (스튜디오, 플레이 창, 시청 창, 광고 페이지) |
| `server/` | Lambda 코드: 라우터, 에이전트 도구, 작업 엔진, 라이브·광고, 프로바이더 |
| `game/` | Phaser 2D 게임 런타임 |
| `game3d/` | three.js 3D 게임 런타임(작성된 월드, 도시, 레이싱)과 CC0 환경 자산 카탈로그 |
| `workers/` | Blender 릴리프·리깅 작업, Hunyuan3D 워커, 스트림용 Electron 셸 |
| `infra/` | CDK(Python) 스택, ffmpeg 레이어 빌드 |
| `scripts/` | 배포, 일회성 설정, 스모크·E2E 점검 스크립트 |
| `plugins/` | Griptape Nodes용 노드 라이브러리(`griptape-ipverse`) |
| `ue5/` | GameLift Streams용 UE5 템플릿 게임 |
| `docs/` | 계약과 설계 문서 |
| `evidence/` | 검증 스크립트가 결과와 화면 캡처를 쓰는 폴더 (이 사본에는 없고, 스크립트를 실행하면 생깁니다) |
| `build/` | 빌드 산출물(git 제외)과 보조 스크립트 |

## 웹 클라이언트 로컬 실행

```bash
npm --prefix web install
npm --prefix web run dev:mock    # VITE_MOCK=1: 메모리 안의 가짜 백엔드, 아무 아이디/비밀번호로 로그인
```

실제 API로 띄우려면 `server/README.md`의 환경 변수를 설정하고 `LOCAL_DEV=1 python3 server/local_dev.py`(포트 8787)를 실행한 뒤 `npm --prefix web run dev`를 실행합니다.

## 테스트

```bash
python3 -m pytest server -q                         # 가짜 클라이언트만 사용, 네트워크 없음
python3 -m pytest workers -q
python3 -m pytest plugins -q
node --test game/test/*.test.mjs game3d/test/*.test.mjs
npm --prefix web test                               # vitest
npm --prefix web run typecheck
infra/.venv/bin/python -m pytest infra/tests -q     # venv 준비는 infra/README.md
```

## 배포

```bash
bash scripts/deploy.sh
```

`scripts/deploy.sh`가 하는 일:

1. `infra/build_layer.py`: ffmpeg 레이어 조립.
2. `scripts/package_server.py`: `server/`와 워커 파일을 `build/server/`로 복사하고 import를 확인.
3. `IpverseCore` 스택이 이미 있으면 게임 런타임(`runtime/v1/`, `runtime3d/v1/`)을 먼저 업로드.
4. `infra/`에서 `npx aws-cdk@latest deploy --all`, 출력은 `build/outputs.json`.
5. Lambda `ipverse-api`의 환경 변수 `CDN_DOMAIN`을 CloudFront 도메인으로 설정.
6. `VITE_API_BASE=/api npm --prefix web run build`.
7. `scripts/upload_web.py`: `web/dist` → S3 `web/`, `web/config.json` 작성, 게임 런타임과 공용 애니메이션(`ual.glb`) 업로드, CloudFront 무효화.
8. `scripts/create_demo_user.py`: Cognito 사용자 `demo`를 만들고 비밀번호를 Secrets Manager `ipverse/demo-user`에 저장.

알아 둘 점:

- 계정과 리전은 `infra/app.py`에 고정되어 있습니다. 다른 계정에 배포하려면 먼저 바꿉니다.
- 필요 도구: Python 3, Node, AWS CLI와 기본 프로파일. CDK CLI는 `npx aws-cdk@latest`를 씁니다.
- 라이브 방송은 처음 한 번, 채널이 꺼져 있을 때 `python3 scripts/setup_ivs_playback_key.py`와 `python3 scripts/setup_ivs_ads.py`를 실행합니다.
- 3D 워커는 `bash scripts/deploy_img3d.sh`, UE5 빌드는 `bash scripts/ue5_build.sh`, 스트림용 웹 플레이어는 `python3 scripts/build_stream_shell.py`로 따로 올립니다.
- `build/` 아래에 보조 스크립트가 두 개 있습니다. `build/hl/fix_cdn_env.py`는 `deploy.sh` 밖에서 `cdk deploy`를 한 뒤 `CDN_DOMAIN`을 다시 넣고 스트림 그룹 환경 변수를 출력합니다. `build/hotpatch_game.py gm_…`는 현재 게임 런타임을 이미 만들어진 게임 폴더에 복사합니다(게임은 만들 때의 런타임 사본을 갖고 있습니다).
- 배포 후 점검: `python3 scripts/smoke.py`(로그인 → 세션 → 채팅 1턴).

## 언어 전환

스튜디오와 로그인 화면 오른쪽 위의 토글로 한국어와 English를 바꿉니다. 선택은 브라우저에 저장되고, 기본은 한국어입니다. 서버의 응답과 에이전트의 답도 같은 언어를 따릅니다(`X-Lang` 헤더).

## 알려진 한계

- IVS 채널은 하나이며 모든 계정이 함께 씁니다. 한 번에 한 방송만 나가고, 방송 하나는 최대 45분입니다.
- GPU 박스는 모델마다 한 대입니다.
- 게임 안의 글자와 공개 광고 페이지는 한국어만 지원합니다.

## 문서

- 게임 계약: `docs/game-authored-contract.md`, `docs/city-contract.md`, `docs/rig-contract.md`
- 도시 게임: `docs/city-generation-method.md`, `docs/city-assets.md`, `docs/open-world-quality.md`
- 광고·스트림: `docs/gam-setup.md`, `docs/ue5/design.md`
- 그 밖: `docs/demo-script.md`, `docs/griptape-plugin.md`, `docs/three-game-showcase.md`, `docs/superpowers/`
