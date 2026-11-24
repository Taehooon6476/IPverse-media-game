# Preparing the Google Ad Manager (GAM) connection

2026-11-10. This is the phase 2 document for personalized ads. The code is in, but it is **off by default**, and GAM is not connected yet. Today our own ADS (`server/adserver.py`) makes the ad decision. This document lists what the user creates in GAM and what changes in AWS when GAM is turned on.

## 1. Structure

```
Watch window (viewer v-junho) ─ POST /api/live/token ─▶ ads.playback
   ├ Our ADS (default): token {aws:ads-player-params: {persona: v-junho}}
   │    → MediaTailor "ipverse-ivs" → https://<live CDN>/vast/ivs/p-v-junho.xml (the server writes it at each break)
   └ GAM: token {aws:ads-playback-config-name: "ipverse-ivs-gam",
               aws:ads-player-params: {persona, ppid, g1, g2, skill, dev, age}}
        → MediaTailor "ipverse-ivs-gam" → GAM VAST tag (key-value targeting) → the creative GAM picks
```

- The unit of switching is the **viewer**. One IVS ad configuration can bind up to 3 MediaTailor configurations, and the first is the default. The token's `aws:ads-playback-config-name` picks a different configuration per viewer ([IVS SSAI documentation](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/server-side-ad-insertion.html), Step 3).
- So in the same broadcast, only some viewers can be sent to GAM to show "our ADS versus GAM" side by side (`GAM_VIEWERS`).
- Key-values (`server/gam.py`, `adserver.features`):

| Key | Values | How it is computed |
| --- | --- | --- |
| `g1`, `g2` | `arpg` `racing` `explore` `shooter` `survival` `platformer` `none` | Top 2 genre interests from the activity history (7-day half-life) |
| `skill` | `lo` `mid` `hi` | Play win rate, thresholds 0.45 / 0.6 |
| `dev` | `pc` `console` `mobile` | Profile device |
| `age` | `18-24` `25-34` `35-44` | Profile age band |
| `ppid` | Viewer id (`v-junho`) | A pseudonymous id. Not personal information. |

All values are `[a-z0-9-]`. So a value does not change when MediaTailor decodes it once, and no separate encoding is needed.

## 2. What to create in GAM (user task)

1. **Network code**: the number under Admin → Global settings (e.g. `21700000`).
2. **Ad unit**: create a video ad unit under Inventory → Ad units (e.g. `ipverse/live_midroll`). Sizes are `1280x720v` and `640x360v`.
3. **Key-values**: under Inventory → Key-values, create 4 **predefined** keys and register the values from the table above.
   - `g1` "top preferred genre" (6 values + `none`)
   - `g2` "second preferred genre" (same values)
   - `skill` (`lo`, `mid`, `hi`)
   - `dev` (`pc`, `console`, `mobile`)
   - Create `age` only if you use it.
   - To use them in reports, turn on "Include in reporting".
4. **Order and line items**: create one line item per campaign (trailer).
   - The type is Sponsorship or Standard (House priority for the demo).
   - The inventory is the ad unit from item 2.
   - Set **key-value targeting**. Example: the racing trailer "네온 드리프트" (Neon Drift) gets `g1 = racing` OR `g2 = racing`; the boss trailer gets `g1 = arpg`.
   - For frequency capping, use GAM's line item frequency cap (e.g. 2 per hour per viewer). GAM counts viewers by `ppid`.
   - Keeping it close to our ADS rule (the same creative is not allowed within 2 breaks) makes the comparison easier.
5. **Video creative** (1 per line item). Pick one of the two.
   - (a) **Video creative**: enter the MP4 URL of our trailer. It is the campaign in `GET /api/live/viewers` or the `url` in `broadcaster/inventory.json`, in the form `https://<main CDN>/sessions/<sid>/....mp4`. GAM builds its own VAST.
   - (b) **VAST redirect**: keep a single creative and enter our static file `https://<live CDN>/vast/ivs/p-<viewerId>.xml` as the VAST URL. In this case GAM only does targeting and reporting, and we still do the picking.
   - If the demo message is "GAM picks", use (a).
   - The length must be shorter than the break. If it is longer, MediaTailor skips it with `DurationExceeded`. Our break is sized to the longest pick.
6. When testing, leave the line item at "Ready" and check the URL from section 4 below with GAM's **ad tag test** (Delivery tools).

## 3. What to change in AWS (while the channel is offline)

1. Create the **second MediaTailor configuration**, `ipverse-ivs-gam`. The content source and insertion mode are the same as `ipverse-ivs` (IVS playback URL prefix, `PLAYER_SELECT`). `gam.ads_url_template(cfg)` builds the ADS URL.

   ```
   https://pubads.g.doubleclick.net/gampad/ads?iu=/<network>/<ad-unit>&sz=1280x720%7C640x360&gdfp_req=1&output=vast&env=vp
     &unviewed_position_start=1&vpos=midroll&pmad=-1&pmxd=[session.avail_duration_ms]&correlator=[avail.random]
     &ppid=[player_params.ppid]
     &cust_params=g1%3D[player_params.g1]%26g2%3D[player_params.g2]%26skill%3D[player_params.skill]%26dev%3D[player_params.dev]%26age%3D[player_params.age]
   ```

   Print the URL with this command.

   ```
   python3 -c "import os;os.environ.update(GAM_NETWORK_CODE='<network>',GAM_AD_UNIT='<ad-unit>');from server import gam;print(gam.ads_url_template(gam.config()))"
   ```

   - `correlator=[avail.random]`: each break is handled as a new request. Without it, the next break of the same session may get an empty response.
   - `pmxd=[session.avail_duration_ms]`: fills to the break length. Do not fix it to a number.
   - Use `pmad=-1` and `vpos=midroll`. `[avail.type]` is not supported. Source: [MediaTailor GAM fill-rate](https://docs.aws.amazon.com/mediatailor/latest/ug/gam-integration-fill-rate.html).
   - Without `ppid`, GAM may stop returning ads after the first break (same document).
   - MediaTailor authenticates server-to-server to GAM automatically with a Google-issued certificate and appends `ssss=mediatailor` ([gam-integration-ssl](https://docs.aws.amazon.com/mediatailor/latest/ug/gam-integration-ssl.html)).

   ```
   aws mediatailor put-playback-configuration --region us-east-1 --name ipverse-ivs-gam \
     --video-content-source-url https://569427d99bba.us-east-1.playback.live-video.net/ \
     --insertion-mode PLAYER_SELECT --avail-suppression Mode=OFF \
     --ad-decision-server-url '<template above>'
   aws mediatailor configure-logs-for-playback-configuration --playback-configuration-name ipverse-ivs-gam --percent-enabled 100
   ```

2. Add the second configuration to the **IVS ad configuration** `ipverse-ads`. Keep `ipverse-ivs` **first (the default)**.
   - `aws ivs update-ad-configuration --arn <ipverse-ads ARN> --media-tailor-playback-configurations playbackConfigurationArn=<ipverse-ivs ARN> playbackConfigurationArn=<ipverse-ivs-gam ARN>`
   - If UpdateAdConfiguration does not accept a change to the list, create a new ad configuration with both configurations while the channel is offline and attach it to the channel (add the second ARN to the `create_ad_configuration` call in `scripts/setup_ivs_ads.py`). **Needs checking**: this was not verified against the real API this time.
3. **Lambda environment variables** (`ipverse-api`). Alternatively, use `GAM_SSM_PARAM=/ipverse/gam` and its SSM parameter `{"networkCode","adUnit","playbackConfig"}`. With SSM, the Lambda role needs `ssm:GetParameter`. The current infrastructure does not have it.

   | Variable | Example | Meaning |
   | --- | --- | --- |
   | `GAM_NETWORK_CODE` | `21700000` | If empty, GAM is off. |
   | `GAM_AD_UNIT` | `ipverse/live_midroll` | |
   | `GAM_PLAYBACK_CONFIG` | `ipverse-ivs-gam` | The token's `aws:ads-playback-config-name` |
   | `GAM_VIEWERS` | `v-junho,v-hyunwoo` | Only these viewers are sent to GAM. |
   | `AD_DECISION_PROVIDER` | `gam` | Sends all viewers to GAM (default `ipverse`). |
   | `GAM_SIZES` | `1280x720\|640x360` | |

   A token is reused for 10 minutes. After switching, refresh the watch window to get a token for the new configuration.

## 4. Notes on cust_params encoding

- MediaTailor **URL-decodes player parameter values once** and then puts them into the ADS URL. The documentation says that if the ADS must receive encoded values, the player side should encode them **twice** ([variables-player](https://docs.aws.amazon.com/mediatailor/latest/ug/variables-player.html)).
- Our template keeps a separate parameter per key and already writes the separators `=` and `&` in the template as `%3D` and `%26`. The values are `[a-z0-9-]`, so no encoding problem arises. The value GAM receives (`gam.tag_url`) is:
  `cust_params=g1%3Dracing%26g2%3Dexplore%26skill%3Dhi%26dev%3Dconsole%26age%3D35-44`
- To pass the whole `cust_params` as a single parameter (`&cust_params=[player_params.cust]`), use `gam.cust_param_value(..., encode=2)` as the token value (`g1%253Dracing%2526…`).
  - The documentation does not say whether MediaTailor decodes exactly once on the IVS token claim path too.
  - Before turning it on, check the actual request URL in the ADS log (`MAKING_ADS_REQUEST` in `MediaTailor/AdDecisionServerInteractions`).
  - The per-key template (the default) does not have this uncertainty.

## 5. Privacy

- The only values that go to GAM are the pseudonymous `ppid` and the key-values above. Name, region and email are not sent.
- MediaTailor passes the viewer's user-agent and IP (x-forwarded-for) to the ADS. So with GAM on, viewer IPs go to Google. This must be stated in the privacy policy (`build/personalized-ads/research.md` 4.3).

## 6. Checks after turning it on

1. Update the Lambda with `GAM_VIEWERS=v-junho`. In the watch window's "4 simulated viewers", the Junho Park tile must show a `GAM` chip.
2. After a break, check in the ADS log of `ipverse-ivs-gam`:
   - that the `MAKING_ADS_REQUEST` URL has `cust_params=g1%3Dracing…` and `ppid=v-junho`
   - that the VAST response has a GAM creative
3. Check that in the same break the other three viewers received `p-<viewerId>.xml` from `ipverse-ivs` (`picks` in the break record).
4. Check in a GAM report (key-values × line items) that impressions are recorded per key-value.

## 7. Corner trailer = VAST NonLinear (works without GAM; connection prepared only)

The Corner trailer (a small muted PiP in a corner of the broadcast) does not go through MediaTailor. The server picks one per viewer (`adserver` kind `corner`), IVS timed metadata `{"type":"corner","e":<eventId>}` rides on the frame where the round ends, and the player draws it. Impressions and clicks are recorded in the viewer's activity history by the IPverse beacon (`POST /live/ad-event`).

In GAM, this ad corresponds to a **VAST NonLinear** (overlay) creative. To attach it:

1. GAM: create an **overlay (Non-linear)** creative on the video ad unit.
   - Media: the trailer MP4 (16:9). `minSuggestedDuration` 10–15 s.
   - Click-through: the published game URL (`games/<gameId>/index.html`).
   - Line items and key-values (`g1`, `g2`, `skill`, `dev`, `age`) are the ones from section 2, unchanged.
2. Request: the player (watch window) calls the GAM tag directly. The request is made from the client, not through the server.
   - In the `gam.tag_url` from section 2, keep `vpos=midroll` and add `vad_type=nonlinear` and an overlay size such as `sz=480x70|300x250`.
   - MediaTailor (SSAI) does not stitch NonLinear. So client-side VAST is the right place for the overlay.
3. Read `<NonLinearAds><NonLinear>` in the VAST response.
   - Placement: `StaticResource`/`IFrameResource`, or pass the media URL to the current `CornerAd` as it is.
   - `NonLinearClickThrough` → the "View game" link.
   - `<Impression>`, `<TrackingEvents>` (`creativeView`, `expand`, `unmute`, `close`) → call them alongside at the points where the beacon is sent today (`impression`, `expand`, `unmute`, `click`).
4. To produce the same shape with our own VAST: write a separate file (`vast/corner/p-<viewerId>.xml`) that has `NonLinearAds` in place of the Linear in today's `vast/ivs/p-<viewerId>.xml`. The picks of the corner break are its contents.
   - Not built yet. Today's approach, where the player reads the break record directly, is enough.

Turning GAM on does not change the MediaTailor configuration (section 3). For the corner ad, only the watch window code changes. No actual GAM connection has been made.
