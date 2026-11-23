# ue5/ — IPverse UE5 템플릿 게임

패키징한 빌드 하나가 모든 IPverse 게임을 돌린다. 게임마다 바뀌는 것은 실행 시 받는 매니페스트(GameSpec + IP GLB 서명 URL)뿐이다. 설계와 비용은 [`docs/ue5/design.md`](../docs/ue5/design.md)에 있다.

## 무엇이 어디서 만들어지나

| 단계 | 어디서 | 내용 |
|---|---|---|
| 에디터 콘텐츠 | `Scripts/build_levels.py` (헤드리스 에디터) | 머티리얼 5개(M_NeonGrid, M_Glow, M_Surface, M_Terrain, M_Water)와 빈 맵 `/Game/Ipverse/Maps/Main` |
| 월드 | `AIpverseLevel` (런타임) | `sf-*` 네온 아레나: 발광 그리드 바닥, 엄폐물, 빛기둥, 스카이라인. `rpg-*` 계곡: 시드 기반 지형 메시, 호수, 나무·바위·풀 인스턴스 |
| 하늘·빛 | `AIpverseEnvironment` (런타임) | 대기 산란 태양, 실시간 스카이라이트, 볼류메트릭 구름·안개, Lumen GI·반사, 블룸 |
| 캐릭터 | `AIpverseCharacter` | IP GLB를 glTFRuntime으로 불러 발바닥 기준 1.8 m로 맞춤. 리그 없이 절차적 모션 |
| 게임 규칙 | `AIpverseGameMode` | 적·소품·NPC 스폰, 목표(kills·survive·collect·talk), 승패, R 재시작 |
| HUD | `AIpverseHud` | Slate, 나눔고딕 Bold(OFL)로 한국어 표시 |

맵을 에디터에서 손으로 만들지 않는다. 그래서 새 게임은 재쿡 없이 데이터만으로 만들어진다.

## 실행 계약

```
IPVERSE_SPEC_URL=<https url>       # StartStreamSession AdditionalEnvironmentVariables (서버가 사용)
-IpverseSpecUrl=<https url>        # 실행 인자, 있으면 우선
```

- 매니페스트 v1 예시는 `manifest.example.json`이다. 서버(`server/streams.py`)가 스트림마다 `streams/` 비공개 경로에 쓰고 15분 presigned URL을 넘긴다.
- URL이 없으면 데모 아레나를 띄운다. GameLift Streams 콘솔의 Test stream으로 빌드만 확인할 때 쓴다.
- GLB 하나가 실패하면 그 엔티티만 절차적 대체 모델로 나온다.

## 빌드 (Epic 컨테이너 이미지, 사람 손 없음)

준비물은 Secrets Manager `ipverse/ghcr-token`(us-east-1)이다. 값은 Epic 계정과 연결된 GitHub 계정의 PAT(`read:packages`)이고 형식은 `{"username","token"}`이다.

```bash
bash scripts/ue5_build.sh                    # 소스 업로드, 빌드 박스 기동, SSM으로 빌드 시작 → 명령 ID 출력
bash scripts/ue5_build.sh --wait <command-id> # 끝날 때까지 기다린 뒤 로그 끝부분 출력
```

빌드 박스(`IpverseUe5Build`, c6i.8xlarge)에서 `Scripts/build.sh`가 순서대로 한다.

1. `ghcr.io/epicgames/unreal-engine`에서 가장 높은 `dev-slim-5.6.x` 태그를 받는다.
2. glTFRuntime(MIT)을 커밋 `cef7be2`(태그 20260826)로 고정해 `Plugins/`에 넣고, 나눔고딕 Bold를 `Content/Fonts/`에 넣는다.
3. `IpverseGameEditor`를 빌드하고 `build_levels.py`를 실행한 뒤 `IPVERSE_LEVELS_OK`를 확인한다.
4. `RunUAT BuildCookRun -platform=Linux -clientconfig=Shipping -cook -stage -pak -iostore -archive`를 실행한다.
5. `s3://ipverse-ue5-builds-087967639890-us-west-2/ipverse-ue5/<version>/`에 `app/`(GameLift 애플리케이션 루트), `IpverseGame-Linux.tar.gz`, `build.log`를 올린다.

박스는 빌드 락과 실행 중인 컨테이너가 없으면 30분 뒤 스스로 꺼진다.

## 스트림 등록

```bash
cd infra && npx aws-cdk@latest deploy IpverseStreams -c ue5=1 --exclusively \
  --parameters BuildVersion=<version> --parameters MaxCapacity=1
```

데모가 끝나면 `MaxCapacity=0`으로 되돌린다.
