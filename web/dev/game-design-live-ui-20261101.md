# IPverse deployed UI check · 2026-11-01

The `assets/index-B4unEG6G.js` deployed at the real `d12ka835iwfpnx.cloudfront.net` was read over HTTP and checked to have the same full bytes and SHA-256 as the local dist. The SHA-256 is `bc7fcd0064ade3316bfb1e94501882b501b802fae2f5f38a5b64e4d270486087`.

The independent browser `ipverse-authored-live-ui-qa` used the demo account's real Cognito authentication. The login details and tokens read from SecretsManager were used only in process/stdin/browser memory, and no credential, token or browser state file was saved. This audit made no generation request, started no game, ran no further model work and did not change the original sessions. The browser was closed.

Results:

1. In the real drawer, the prompt and the selection and roles of 제나 (Jena, player), 에너지 코어 (Energy Core, prop) and 노인 정비사 카이 (Old Mechanic Kai, NPC) were checked. The default game type is ‘Match the request’, and there was no horizontal overflow on desktop or on 390×844 mobile.
2. Entering 4,000 characters made the whole design, IP tags included, 4,177 characters, so the notice was shown and sending was blocked. The input was preserved. The generate button was not pressed.
3. Forest game `ses_de73dbabc0` / `gm_6487d05bd1`: talk to the NPC → collect 3 cores → reach the temple entrance. The saved world is 80×80, 34 structures, 3 prop spots, no time limit, with jump and sprint set. The 3D links of the hero, prop and NPC, the actual placement counts and the saved original request were checked.
4. Neon game `ses_9ad48c6559` / `gm_46b7b7b66b`: collect 2 cores → interact with 2 terminals → reach the escape gate. The saved world is 80×60, 21 structures, 2 prop spots, a 90-second limit, 200 health, with dash and sprint set. The 3D links of the same selected IPs and the original request were checked.
5. Neither game had an IP warning or a page error. An external navigation that only changes the existing app's hash kept the currently mounted session, so the final per-case verification checked the title and the original request after a full document navigation. This existing navigation behavior was not modified.

The evidence is saved in `game-design-live-verification-20261101.json`. It includes 7 desktop/mobile screenshots of the actual deployed UI and their SHAs. It is kept separate from the local fixture evidence.

This verification covers real authentication, the deployment and the UI display of the saved settings. The games were not run in this audit, so 3D asset loading, winning the gameplay and graphics quality need a separate runtime/gameplay verification.
