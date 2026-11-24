# IPverse game design UI change · 2026-11-01

The existing studio, split screen, game tabs, colors and drawer design were kept. The scope of the change is `web/`. The backend, the game3d runtime, AWS resources and deployment were not modified.

## Cause found

The existing game design selected a game type and the Lava forge theme by default. The selected IPs were passed only as a `cast_ip_ids` tag in the chat text, and the actual API body was `{text}`. The hero, weapon, prop, enemy and NPC roles were not stated. The result offered only a preview and the GameSpec JSON, so it was hard for the user to compare the request with the game settings actually saved.

## Request contract

`gameDesign` is sent along with the existing `POST /api/sessions/{id}/chat`. `[게임 설계]` ("[Game design]") is the literal tag the page puts before the message.

```json
{
  "text": "[게임 설계] ...",
  "gameDesign": {
    "prompt": "[게임 설계] ... the whole prompt and detailed design ...",
    "castIpIds": ["ip_player", "ip_core"],
    "playerIpId": "ip_player",
    "weaponIpId": null,
    "propIpIds": ["ip_core"],
    "enemyIpIds": [],
    "npcIpIds": []
  }
}
```

`prompt` contains all of the free prompt, the chosen type and environment, the mission, clear and fail conditions, the enemies, the difficulty, the extra rules and the selected IPs. With no IP selected, an empty list and `playerIpId:null` are passed so the model can pick from the session's IPs. With a manual selection, there is exactly 1 hero character, and at most 1 hero's weapon and 1 NPC. An IP that was not selected is not added to the role lists.

The free prompt and the cast IPs are placed first. The existing presets can still be chosen, and the default type, theme and difficulty are ‘Match the request’. If the request fails, the prompt and the selection are kept.

After rechecking the backend contract, a limit of 4,000 Unicode code points on the whole prompt was added. The count includes the detailed conditions and the IP tags, and when it is exceeded the input is not cut off; sending is blocked with a notice.

## Checking the generated result

`GameDesignSummary` reads the mission order, the objectives, the world size and placement counts, the rules and control features, and each IP's role from the **saved spec**. A v2 NPC is linked to its actual `props` slot through `world.npc.propIndex`. The 3D and image marks are based on the spec's `modelUrl` and `spriteUrl`, and a new 3D in the IP library is not a reason to show it as applied to that game.

It shows a selected IP that is missing, an IP outside the selection, a role mismatch, and a selected IP with no v2 world placement. In the GameSpec tab, the original request saved in `spec.design.sourcePrompt` or in the game metadata can be compared separately. Older v1 games still get the existing mission and environment summary.

This summary is a check of settings and links. It does not prove actual loading, completion of play, that the requirements are met in meaning, or graphics quality.

## Verification

1. `npm run build`: typecheck and production build pass.
2. `npm test -- --reporter=dot`: 5 files, 28 tests pass. They verify the API body and the exact UTF-8 SHA-256, real React input, role changes and preservation on a failed request, the length boundary of the whole Unicode prompt, v2 mission and IP placement, v1 compatibility and escaping of generated text.
3. Independent `agent-browser` session `ipverse-design-ui-qa`: the real components were checked with the local mock and an explicit v2 fixture. The 1440×1000 desktop and 390×844 mobile screens were captured and had no horizontal overflow. The browser session used was closed.

The verification JSON is `game-design-verification-20261101.json` and includes the source SHA and the screenshot SHAs. Every screen is **local fixture UI evidence**, not evidence of the deployed d12 screen or of real model generation results.

The additional verification of the actual deployed screen is saved separately in `game-design-live-ui-20261101.md` and `game-design-live-verification-20261101.json`.

Screenshots:

1. `game-design-desktop-20261101.png`
2. `game-design-prompt-mobile-20261101.png`
3. `game-summary-v2-desktop-20261101.png`
4. `game-summary-v2-mobile-20261101.png`
