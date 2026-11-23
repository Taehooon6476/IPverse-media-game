# IPverse 실제 배포 UI 확인 · 2026-11-01

실제 `d12ka835iwfpnx.cloudfront.net`에 배포된 `assets/index-B4unEG6G.js`를 HTTP로 읽어 local dist와 전체 bytes/SHA-256이 같은지 확인했다. SHA-256은 `bc7fcd0064ade3316bfb1e94501882b501b802fae2f5f38a5b64e4d270486087`이다.

독립 browser `ipverse-authored-live-ui-qa`에서 데모 계정의 실제 Cognito 인증을 사용했다. SecretsManager에서 읽은 로그인 정보와 토큰은 process/stdin/browser 메모리에서만 사용했고, credential·token·browser state 파일을 저장하지 않았다. 이 감사에서 생성 요청, 게임 시작, 추가 모델 작업이나 원래 세션 변경은 하지 않았다. 브라우저는 종료했다.

확인 결과:

1. 실제 drawer의 프롬프트, 제나(player), 에너지 코어(prop), 노인 정비사 카이(NPC) 선택과 역할을 확인했다. 기본 게임 유형은 ‘요청에 맞게’이며, desktop 및 390×844 mobile에서 가로 넘침이 없었다.
2. 4,000자를 입력하면 IP 태그를 포함한 전체 설계가 4,177자가 되어 안내가 표시되고 전송이 차단됐다. 입력은 보존됐다. 생성 버튼은 누르지 않았다.
3. 숲 게임 `ses_de73dbabc0` / `gm_6487d05bd1`: NPC 대화 → 코어 3개 수집 → 신전 입구 도착. 저장된 world는 80×80, 구조물 34개, 소품 3곳, 시간 제한 없음, 점프·달리기 설정이다. 주인공·소품·NPC의 3D 연결과 실제 배치 수, 저장된 원본 요청을 확인했다.
4. 네온 게임 `ses_9ad48c6559` / `gm_46b7b7b66b`: 코어 2개 수집 → 단말 2곳 상호작용 → 탈출 게이트 도착. 저장된 world는 80×60, 구조물 21개, 소품 2곳, 제한 90초, 체력 200, 대시·달리기 설정이다. 같은 선택 IP의 3D 연결과 원본 요청을 확인했다.
5. 두 게임의 IP 경고와 page error는 없었다. 기존 앱의 hash만 바꾸는 외부 navigation은 현재 mounted session을 유지했으므로, 최종 case별 검증은 전체 document navigation 후 제목과 원본 요청을 확인했다. 이 기존 navigation 동작은 수정하지 않았다.

증거는 `game-design-live-verification-20261101.json`에 저장했다. 실제 배포 UI의 desktop/mobile 스크린샷 7개와 SHA를 포함한다. 로컬 fixture 증거와 분리했다.

이 검증은 실제 인증·배포·저장된 설정의 UI 표시까지이다. 이 감사에서는 게임을 실행하지 않았으므로 3D 자산 로딩, 게임플레이 승리와 그래픽 품질은 별도 runtime/gameplay 검증이 필요하다.
