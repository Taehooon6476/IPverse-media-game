# Google Ad Manager(GAM) 연결 준비

2026-11-10. 개인화 광고 2단계 문서입니다. 코드는 들어가 있지만 **기본값은 꺼짐**이고, 아직 GAM에 연결하지 않았습니다. 지금 광고 결정은 우리 ADS(`server/adserver.py`)가 합니다. 이 문서는 GAM을 켤 때 사용자가 GAM에서 만들 것과 AWS에서 바꿀 것을 정리합니다.

## 1. 구조

```
시청 창(시청자 v-junho) ─ POST /api/live/token ─▶ ads.playback
   ├ 우리 ADS(기본): 토큰 {aws:ads-player-params: {persona: v-junho}}
   │    → MediaTailor "ipverse-ivs" → https://<live CDN>/vast/ivs/p-v-junho.xml (서버가 브레이크마다 씀)
   └ GAM: 토큰 {aws:ads-playback-config-name: "ipverse-ivs-gam",
               aws:ads-player-params: {persona, ppid, g1, g2, skill, dev, age}}
        → MediaTailor "ipverse-ivs-gam" → GAM VAST 태그(키-값 타게팅) → GAM이 고른 크리에이티브
```

- 전환 단위는 **시청자**입니다. IVS 광고 설정 하나에 MediaTailor 설정을 3개까지 묶을 수 있고, 첫 번째가 기본값입니다. 토큰의 `aws:ads-playback-config-name`이 시청자별로 다른 설정을 고릅니다([IVS SSAI 문서](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/server-side-ad-insertion.html) Step 3).
- 그래서 같은 방송에서 일부 시청자만 GAM으로 보내 "우리 ADS 대 GAM"을 나란히 보여 줄 수 있습니다(`GAM_VIEWERS`).
- 키-값(`server/gam.py`, `adserver.features`):

| 키 | 값 | 계산 |
| --- | --- | --- |
| `g1`, `g2` | `arpg` `racing` `explore` `shooter` `survival` `platformer` `none` | 활동 기록의 장르 관심도(7일 반감기) 상위 2개 |
| `skill` | `lo` `mid` `hi` | 플레이 승률 0.45 / 0.6 기준 |
| `dev` | `pc` `console` `mobile` | 프로필 기기 |
| `age` | `18-24` `25-34` `35-44` | 프로필 연령대 |
| `ppid` | 시청자 id(`v-junho`) | 가명 id입니다. 개인정보가 아닙니다. |

값은 모두 `[a-z0-9-]`입니다. 그래서 MediaTailor가 값을 한 번 디코드해도 바뀌지 않고, 따로 인코딩할 필요도 없습니다.

## 2. GAM에서 만들 것 (사용자 작업)

1. **네트워크 코드**: 관리 → 전역 설정에 있는 숫자(예: `21700000`)입니다.
2. **광고 단위**: 인벤토리 → 광고 단위에서 동영상 광고 단위를 만듭니다(예: `ipverse/live_midroll`). 크기는 `1280x720v`, `640x360v`입니다.
3. **키-값**: 인벤토리 → 키-값에서 **사전 정의(predefined)** 키 4개를 만들고, 위 표의 값을 등록합니다.
   - `g1` "선호 장르 1위"(값 6개 + `none`)
   - `g2` "선호 장르 2위"(같은 값)
   - `skill`(`lo`, `mid`, `hi`)
   - `dev`(`pc`, `console`, `mobile`)
   - `age`는 쓸 때만 만듭니다.
   - 보고서에 쓰려면 "보고에 포함"을 켭니다.
4. **주문과 라인 아이템**: 캠페인(트레일러) 하나에 라인 아이템 하나를 만듭니다.
   - 유형은 스폰서십이나 표준(데모는 하우스 광고 우선순위)으로 합니다.
   - 인벤토리는 2번의 광고 단위입니다.
   - **키-값 타게팅**을 겁니다. 예: 레이싱 트레일러 "네온 드리프트"는 `g1 = racing` OR `g2 = racing`, 보스 트레일러는 `g1 = arpg`.
   - 빈도 제한은 GAM의 라인 아이템 빈도 제한을 씁니다(예: 시청자당 1시간 2회). GAM은 `ppid`로 시청자를 셉니다.
   - 우리 ADS의 규칙(2브레이크 안에 같은 크리에이티브 금지)과 비슷하게 맞추면 비교하기 쉽습니다.
5. **동영상 크리에이티브**(라인 아이템마다 1개). 둘 중 하나를 고릅니다.
   - (a) **동영상 크리에이티브**: 우리 트레일러 MP4 URL을 넣습니다. `GET /api/live/viewers`의 캠페인이나 `broadcaster/inventory.json`의 `url`이고, `https://<main CDN>/sessions/<sid>/....mp4` 형태입니다. GAM이 자체 VAST를 만듭니다.
   - (b) **VAST 리디렉션**: 크리에이티브 하나만 두고 VAST URL로 우리 정적 파일 `https://<live CDN>/vast/ivs/p-<viewerId>.xml`을 넣습니다. 이 경우 GAM은 타게팅·리포트만 하고, 고르는 일은 여전히 우리가 합니다.
   - 데모 메시지가 "GAM이 고른다"라면 (a)를 씁니다.
   - 길이는 브레이크보다 짧아야 합니다. 길면 MediaTailor가 `DurationExceeded`로 건너뜁니다. 우리 브레이크는 가장 긴 픽에 맞춥니다.
6. 테스트할 때는 라인 아이템을 "준비됨"으로 두고 GAM의 **광고 태그 테스트**(Delivery tools)로 아래 4번 URL을 확인합니다.

## 3. AWS에서 바꿀 것 (채널이 오프라인일 때)

1. **두 번째 MediaTailor 설정** `ipverse-ivs-gam`을 만듭니다. 콘텐츠 소스와 삽입 모드는 `ipverse-ivs`와 같습니다(IVS 재생 URL 접두사, `PLAYER_SELECT`). ADS URL은 `gam.ads_url_template(cfg)`가 만듭니다.

   ```
   https://pubads.g.doubleclick.net/gampad/ads?iu=/<네트워크>/<광고단위>&sz=1280x720%7C640x360&gdfp_req=1&output=vast&env=vp
     &unviewed_position_start=1&vpos=midroll&pmad=-1&pmxd=[session.avail_duration_ms]&correlator=[avail.random]
     &ppid=[player_params.ppid]
     &cust_params=g1%3D[player_params.g1]%26g2%3D[player_params.g2]%26skill%3D[player_params.skill]%26dev%3D[player_params.dev]%26age%3D[player_params.age]
   ```

   URL은 아래 명령으로 출력합니다.

   ```
   python3 -c "import os;os.environ.update(GAM_NETWORK_CODE='<네트워크>',GAM_AD_UNIT='<광고단위>');from server import gam;print(gam.ads_url_template(gam.config()))"
   ```

   - `correlator=[avail.random]`: 브레이크마다 새 요청으로 처리됩니다. 빠지면 같은 세션의 다음 브레이크가 빈 응답일 수 있습니다.
   - `pmxd=[session.avail_duration_ms]`: 브레이크 길이에 맞춰 채웁니다. 숫자로 고정하지 않습니다.
   - `pmad=-1`과 `vpos=midroll`을 씁니다. `[avail.type]`은 지원하지 않습니다. 근거: [MediaTailor GAM fill-rate](https://docs.aws.amazon.com/mediatailor/latest/ug/gam-integration-fill-rate.html).
   - `ppid`가 빠지면 첫 브레이크 뒤로 GAM이 광고를 안 줄 수 있습니다(같은 문서).
   - MediaTailor는 GAM에 Google 발급 인증서로 서버 간 인증을 자동으로 하고 `ssss=mediatailor`를 붙입니다([gam-integration-ssl](https://docs.aws.amazon.com/mediatailor/latest/ug/gam-integration-ssl.html)).

   ```
   aws mediatailor put-playback-configuration --region us-east-1 --name ipverse-ivs-gam \
     --video-content-source-url https://569427d99bba.us-east-1.playback.live-video.net/ \
     --insertion-mode PLAYER_SELECT --avail-suppression Mode=OFF \
     --ad-decision-server-url '<위 템플릿>'
   aws mediatailor configure-logs-for-playback-configuration --playback-configuration-name ipverse-ivs-gam --percent-enabled 100
   ```

2. **IVS 광고 설정** `ipverse-ads`에 두 번째 설정을 추가합니다. `ipverse-ivs`를 **첫 번째(기본)**로 둡니다.
   - `aws ivs update-ad-configuration --arn <ipverse-ads ARN> --media-tailor-playback-configurations playbackConfigurationArn=<ipverse-ivs ARN> playbackConfigurationArn=<ipverse-ivs-gam ARN>`
   - UpdateAdConfiguration이 목록 변경을 받지 않으면, 채널이 오프라인일 때 광고 설정을 두 설정으로 새로 만들어 채널에 붙입니다(`scripts/setup_ivs_ads.py`의 `create_ad_configuration` 호출에 두 번째 ARN을 추가). **확인 필요**: 이번에는 실제 API로 확인하지 않았습니다.
3. **Lambda 환경 변수**(`ipverse-api`). 아니면 `GAM_SSM_PARAM=/ipverse/gam`과 그 SSM 파라미터 `{"networkCode","adUnit","playbackConfig"}`를 씁니다. SSM을 쓰면 Lambda 역할에 `ssm:GetParameter`가 필요합니다. 지금 인프라에는 없습니다.

   | 변수 | 예 | 뜻 |
   | --- | --- | --- |
   | `GAM_NETWORK_CODE` | `21700000` | 비어 있으면 GAM은 꺼집니다. |
   | `GAM_AD_UNIT` | `ipverse/live_midroll` | |
   | `GAM_PLAYBACK_CONFIG` | `ipverse-ivs-gam` | 토큰의 `aws:ads-playback-config-name` |
   | `GAM_VIEWERS` | `v-junho,v-hyunwoo` | 이 시청자만 GAM으로 보냅니다. |
   | `AD_DECISION_PROVIDER` | `gam` | 모든 시청자를 GAM으로 보냅니다(기본 `ipverse`). |
   | `GAM_SIZES` | `1280x720\|640x360` | |

   토큰은 10분 동안 재사용됩니다. 전환한 뒤에는 시청 창을 새로 고쳐야 새 설정의 토큰을 받습니다.

## 4. cust_params 인코딩 메모

- MediaTailor는 플레이어 파라미터 값을 **한 번 URL 디코드**한 다음 ADS URL에 넣습니다. ADS가 인코딩된 값을 받아야 하면 플레이어 쪽에서 **두 번** 인코딩하라고 되어 있습니다([variables-player](https://docs.aws.amazon.com/mediatailor/latest/ug/variables-player.html)).
- 우리 템플릿은 키마다 파라미터를 따로 두고, 구분자 `=`와 `&`를 템플릿에 이미 `%3D`, `%26`으로 적어 둡니다. 값은 `[a-z0-9-]`라서 인코딩 문제가 생기지 않습니다. GAM이 받는 값(`gam.tag_url`)은 다음과 같습니다.
  `cust_params=g1%3Dracing%26g2%3Dexplore%26skill%3Dhi%26dev%3Dconsole%26age%3D35-44`
- `cust_params` 전체를 파라미터 하나(`&cust_params=[player_params.cust]`)로 넘기려면 토큰 값으로 `gam.cust_param_value(..., encode=2)`를 씁니다(`g1%253Dracing%2526…`).
  - IVS 토큰 클레임 경로에서도 MediaTailor가 정확히 한 번 디코드하는지는 문서에 없습니다.
  - 켜기 전에 ADS 로그(`MediaTailor/AdDecisionServerInteractions`의 `MAKING_ADS_REQUEST`)에서 실제 요청 URL을 보고 확인합니다.
  - 키별 템플릿(기본)은 이 불확실성이 없습니다.

## 5. 개인정보

- GAM으로 가는 값은 가명 `ppid`와 위 키-값뿐입니다. 이름, 지역, 이메일은 보내지 않습니다.
- MediaTailor는 시청자의 user-agent와 IP(x-forwarded-for)를 ADS에 넘깁니다. 그래서 GAM을 켜면 시청자 IP가 Google로 갑니다. 처리방침에 적어야 합니다(`build/personalized-ads/research.md` 4.3).

## 6. 켠 뒤 확인

1. `GAM_VIEWERS=v-junho`로 Lambda를 갱신합니다. 시청 창 "시청자 4명"에서 박준호 타일에 `GAM` 칩이 보여야 합니다.
2. 브레이크 뒤 `ipverse-ivs-gam`의 ADS 로그에서 확인할 것:
   - `MAKING_ADS_REQUEST` URL에 `cust_params=g1%3Dracing…`과 `ppid=v-junho`가 있는지
   - VAST 응답에 GAM 크리에이티브가 있는지
3. 같은 브레이크에서 다른 세 시청자는 `ipverse-ivs`의 `p-<viewerId>.xml`을 받았는지 확인합니다(break 기록 `picks`).
4. GAM 보고서(키-값 × 라인 아이템)에서 노출이 키-값별로 잡히는지 확인합니다.

## 7. 코너 트레일러 = VAST NonLinear (GAM 없이 동작, 연결 준비만)

코너 트레일러(방송 구석의 작은 음소거 PiP)는 MediaTailor를 거치지 않습니다. 서버가 시청자마다 고르고(`adserver` kind `corner`), IVS 타임드 메타데이터 `{"type":"corner","e":<eventId>}`가 판이 끝난 프레임에 실려 가며, 플레이어가 그립니다. 노출과 클릭은 IPverse 비컨(`POST /live/ad-event`)이 시청자 활동 기록에 남깁니다.

GAM에서는 이 광고가 **VAST NonLinear**(오버레이) 크리에이티브에 해당합니다. 붙일 때는 이렇게 합니다.

1. GAM: 동영상 광고 단위에 **오버레이(Non-linear)** 크리에이티브를 만듭니다.
   - 미디어: 트레일러 MP4(16:9). `minSuggestedDuration` 10–15초.
   - 클릭 연결: 게시된 게임 URL(`games/<gameId>/index.html`).
   - 라인 아이템과 키-값(`g1`, `g2`, `skill`, `dev`, `age`)은 2장의 것을 그대로 씁니다.
2. 요청: 플레이어(시청 창)가 GAM 태그를 직접 부릅니다. 서버를 통하지 않고 클라이언트에서 요청합니다.
   - 2장의 `gam.tag_url`에서 `vpos=midroll`을 그대로 두고, `vad_type=nonlinear`, `sz=480x70|300x250` 같은 오버레이 크기를 더합니다.
   - MediaTailor(SSAI)는 NonLinear를 이어 붙이지 않습니다. 그래서 오버레이는 클라이언트 쪽 VAST가 맞는 자리입니다.
3. 응답 VAST의 `<NonLinearAds><NonLinear>`를 읽습니다.
   - 위치: `StaticResource`/`IFrameResource`, 또는 미디어 URL을 지금의 `CornerAd`에 그대로 넘깁니다.
   - `NonLinearClickThrough` → "게임 보기" 링크.
   - `<Impression>`, `<TrackingEvents>`(`creativeView`, `expand`, `unmute`, `close`) → 지금 비컨을 보내는 자리(`impression`, `expand`, `unmute`, `click`)에서 같이 부릅니다.
4. 우리 VAST로 같은 모양을 내려면: 지금 `vast/ivs/p-<viewerId>.xml`의 Linear 자리에 `NonLinearAds`를 둔 파일(`vast/corner/p-<viewerId>.xml`)을 따로 쓰면 됩니다. 코너 브레이크의 picks가 그 내용입니다.
   - 아직 만들지 않았습니다. 플레이어가 break 기록을 직접 읽는 지금 방식으로 충분합니다.

GAM을 켜도 MediaTailor 쪽 설정(3장)은 바뀌지 않습니다. 코너 광고는 시청 창 코드만 바뀝니다. 실제 GAM 연결은 하지 않았습니다.
