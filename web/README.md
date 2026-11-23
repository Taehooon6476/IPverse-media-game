# IPverse Studio web (React + Vite)

SPA for the IPverse demo: a session sidebar, a sticky header, the IP pane (characters, props, 3D, video) and the
game pane (preview, pipeline, GameSpec) side by side, a chat dock at the bottom, a "게임 올리기" drawer and toasts.

## Commands (run inside `web/`)

```bash
npm install
npm run dev:mock     # VITE_MOCK=1: in-memory fake backend, any id/password logs in
npm run dev          # real API: proxies /api to http://localhost:8787 (server/local_dev.py)
npm test             # vitest (api.ts / auth.ts)
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + vite build → web/dist (deploy.sh sets VITE_API_BASE=/api)
```

From the repo root the same works with `npm exec --prefix web --no -- <bin> ...`, for example
`VITE_MOCK=1 npm exec --prefix web --no -- vite --config web/vite.config.ts` or
`npm exec --prefix web --no -- tsc --noEmit -p web`. Plain `npx tsc` from the root resolves the unrelated
`tsc` package from npm, because TypeScript is only installed under `web/`.

## Runtime config

`/config.json` → `{"region","userPoolId","clientId"}`, fetched at login. `public/config.json` holds placeholders for
dev; the deploy script writes the real one to `s3://…/web/config.json` after uploading `dist/`.

## Auth

`src/auth.ts` calls Cognito `InitiateAuth` with plain `fetch` (`USER_PASSWORD_AUTH`, then `REFRESH_TOKEN_AUTH` when
the access token is within a minute of expiry). Tokens live in `sessionStorage`. Every API call sends
`X-Auth-Token: <AccessToken>`. A 401 clears the tokens and shows the login screen with
"세션이 만료되었습니다. 다시 로그인해 주세요.".

## Mock mode

`src/mock/mockApi.ts` replaces the network layer when `VITE_MOCK=1` (it is not bundled otherwise). After the first chat
message in a session, each `GET /sessions/{id}` runs one scripted step: concept → character → prop → jobs queued →
running → shots done and one 3D render deliberately failed (to show the error badge and alert toast) → turntable/GLB →
trailer + shorts → game. Media are public placeholders (picsum images, an MDN sample mp4, the model-viewer Astronaut
GLB); the game preview is a blob page. Later messages get a short canned reply.

## Layout of `src/`

- `App.tsx`: composition, session selection, polling (3 s while a turn is pending or a job is queued/running, else
  10 s), snapshot → `diffJobs` → toasts.
- `api.ts`: typed API client, `AuthError`, `diffJobs`, `pollInterval`, `getGameSpec` (`/{specKey}` next to the game).
- `components/`: one component per file. Tab state is in the URL hash: `#s=<sessionId>&ip=<tab>&game=<tab>`.
- `env.d.ts`: Vite env typing and the `<model-viewer>` JSX element (script loaded from the Google CDN in `index.html`).
