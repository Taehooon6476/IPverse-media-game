# IPverse Studio demo script

App: `https://d12ka835iwfpnx.cloudfront.net/` · login `demo` (password: Secrets Manager `ipverse/demo-user`)

## Preparation (20 minutes before the demo)

1. After logging in, run "Make one hero" → "Make it in 3D" in a throwaway session to wake the Deadline worker and the Conda environment (Blender). The first job takes 10–20 minutes; later jobs take about 2 minutes.
2. Check that the API is alive with `python3 scripts/smoke.py` (one chat turn, about 1 minute).

## Main demo (about 12 minutes + waiting)

| Step | Action | Expected result | Wait |
| --- | --- | --- | --- |
| 1 | Sidebar **New session** → title "Luna the space cat explorer", genre **Sci-fi shooter** | Two empty panes + the chat dock | Immediate |
| 2 | Chat: `Set the concept and make the hero character and one key prop` (to show the model, `With Krea, …`) | Concept chip in the top bar, images with a cutout toggle in the Characters/Props tabs on the left, `v1 · Krea 2 Turbo` on the card | 1–2 min (tool progress shows in the chat dock) |
| 2b | (Optional) Chat: `Make a version of Luna wearing a winter coat` | The same card changes to `v2 · FLUX.2 klein 9B` and keeps the same face and build | 30 s–3 min (+2 min when the model swaps Krea→klein) |
| 2c | (Optional) Character card **Edit** → in the drawer `Push the goggles up onto the head` → Request edit | The same card changes to v2 and only the requested part differs (klein image-to-image) | 30 s–3 min |
| 3 | The **Make 3D** quick button on the character card → send | A `render3d` job (Deadline) in the Pipeline tab on the right. When done, a turntable video + a rotating GLB in the 3D tab on the left | 2 min (worker warm) / 10–20 min (cold) |
| 4 | Chat: `Make 2 video shots of Luna with LTX and cut them into a teal-orange trailer and shorts` (to show high-quality sound, `With MiniMax H3, …`) | `mediagen GPU · LTX-2.5` on the pipeline row, 2 shots in the Video tab → trailer (16:9) + shorts (9:16) | LTX shots 3–6 min (warm); H3 and Kandinsky add ~10 min of boot if stopped; trailer tens of seconds |
| 4b | (Optional) Chat: `Make one rival character and make it move like the first shot with Wan` | The `Wan 2.2 Animate` shot starts after the first shot finishes | 3–8 min |
| 4c | (Optional) Video tab **Direct a trailer** → the scene flow in sentences, length 20 s → Make with this direction | One LTX 20 s shot (not stitched) → color-graded trailer + shorts + title card | 6–8 min |
| 5 | Check the genre tab on the right, then chat: `Make a game` | A playable sci-fi shooter in the Preview tab (hero = Luna's cutout, prop = item), JSON in the GameSpec tab | 10–20 s |
| 6 | Play in the preview with the arrow keys and space, reach the goal → `클리어!` ("Clear!") | Shows that the game really runs | — |
| 7 | **Publish** at the top → pick the trailer in the modal, skip after 5 s → **Upload** | Published URL + open/copy | 2–3 s |
| 8 | Published URL in a new window → the pre-roll trailer plays → `광고 건너뛰기 (5)` ("Skip ad (5)") countdown → the game starts | Shows that the ad and the game share the same IP | — |

## Talking points

- Left and right refer to the **same IP records**: the character in the trailer is the same cutout file as the player sprite in the game.
- What the model wrote is **data** (GameSpec JSON), and what runs is a validated runtime (the Agentic Arcade pattern).
- All long work is **asynchronous jobs**: Deadline Cloud (Blender), the account's own GPU video models (mediagen MCP proxy: LTX-2.5 · MiniMax H3 · Kandinsky 6.0 Pro · Wan 2.2 Animate), Lambda self-invoke (ffmpeg).
- The user picks the image and video models: name a model in the chat and that model is used. The defaults are Krea 2 Turbo for images (FLUX.2 klein 9B when deriving from an existing IP) and LTX-2.5 for video. Stable Image Ultra (Bedrock) can also be picked.
- Griptape Nodes is a **plugin**: the `plugins/griptape-ipverse` nodes call the same tool API, and the Deadline provider can also run Griptape workflows as jobs.

## If something fails

- If the 3D job is `FAILED`, read the error text in the Pipeline tab and show the turntable from a session run in advance.
- If image generation fails with "끝나지 않았습니다" ("did not finish"), the GPU is swapping models. Send the same request again, or ask `With Stable Image`.
- If the video shot's progress text is `starting_instance` or `model_loading`, the GPU box is booting (~10 min). Wait, or ask again with LTX.
- If a video shot fails, read the error text on the pipeline row (the GPU server's message) and ask again with LTX.
- If a chat turn fails, the message shows the cause in the page's language. Send it again.
