// Exactly two native chat submissions in a fresh owned test session.
// Execution is opt-in. Credentials enter through stdin and never enter files,
// request logs, storageState exports, traces, screenshots or recordings.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';

const STUDIO = 'https://d12ka835iwfpnx.cloudfront.net';
const require = createRequire(import.meta.url);
const PLACEHOLDER = '{BACKGROUND_IP_ID}';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sorted = (items) => [...items].sort();
const sameIds = (a, b) => Array.isArray(a) && isDeepStrictEqual(sorted(a), sorted(b));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const pathOnly = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return '[INVALID_URL]'; } };

export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[JWT_REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]+/g, '$1?[QUERY_REDACTED]');
}

export function validatePrepared(p) {
  assert.equal(p?.status, 'PREPARED_NO_MODEL_CALLS', 'PREPARED_FRESH_TEST_REQUIRED');
  assert.match(p.sessionId ?? '', /^ses_[a-zA-Z0-9]+$/, 'TEST_SESSION_REQUIRED');
  assert.equal(p.sourceUnchanged, true, 'SOURCE_PRESERVATION_REQUIRED');
  const cast = p.commonCast;
  assert.match(cast?.playerIpId ?? '', /^ip_[a-zA-Z0-9_-]+$/, 'PLAYER_REQUIRED');
  assert.ok(Array.isArray(cast.propIpIds) && cast.propIpIds.length === 1, 'ONE_CORE_REQUIRED');
  assert.match(cast.propIpIds[0], /^ip_[a-zA-Z0-9_-]+$/, 'CORE_REQUIRED');
  assert.notEqual(cast.playerIpId, cast.propIpIds[0], 'DISTINCT_IP_ROLES_REQUIRED');
  assert.ok(!cast.weaponIpId && !(cast.enemyIpIds ?? []).length && !(cast.npcIpIds ?? []).length, 'TEST_CAST_SCOPE_CHANGED');
  assert.ok(Array.isArray(p.sourceAssetInventory) && p.sourceAssetInventory.length === 2, 'TWO_CLONED_IPS_REQUIRED');
  assert.ok(sameIds(p.sourceAssetInventory.map((ip) => ip.ipId), [cast.playerIpId, ...cast.propIpIds]), 'CLONED_CAST_MISMATCH');
  assert.ok(p.sourceAssetInventory.every((ip) => typeof ip.name === 'string' && ip.name.length), 'IP_NAMES_REQUIRED');
  assert.ok(p.background?.kind === 'prop' && p.background.usage === 'background'
    && p.background.mode === 'image' && p.background.ipId === null && p.background.name?.length, 'NEW_IMAGE_BACKGROUND_REQUIRED');
  assert.ok(typeof p.backgroundCreationPrompt === 'string' && p.backgroundCreationPrompt.trim()
    && p.backgroundCreationPrompt.length <= 4000, 'BACKGROUND_CREATION_PROMPT_REQUIRED');
  assert.ok(typeof p.gamePrompt === 'string' && p.gamePrompt.includes(PLACEHOLDER)
    && p.gamePrompt.length <= 3600, 'BOUNDED_GAME_PROMPT_WITH_PLACEHOLDER_REQUIRED');
  const template = p.gameDesignTemplate;
  assert.equal(template?.backgroundIpId, PLACEHOLDER, 'BACKGROUND_TEMPLATE_REQUIRED');
  assert.ok(sameIds(template.castIpIds, [cast.playerIpId, ...cast.propIpIds, PLACEHOLDER]), 'TEMPLATE_CAST_MISMATCH');
  return p;
}

export function validateGameChat(body, prepared, backgroundId) {
  const design = body?.gameDesign;
  const prompt = prepared.gamePrompt.split(PLACEHOLDER).join(backgroundId);
  assert.ok(typeof body?.text === 'string' && body.text.includes(prompt), 'COMPLETE_NATIVE_GAME_PROMPT_REQUIRED');
  assert.equal(design?.prompt, body.text, 'NATIVE_PROMPT_PAYLOAD_MISMATCH');
  assert.equal(design.backgroundIpId, backgroundId, 'NATIVE_BACKGROUND_ROLE_MISMATCH');
  assert.equal(design.playerIpId, prepared.commonCast.playerIpId, 'NATIVE_PLAYER_ROLE_MISMATCH');
  assert.ok(sameIds(design.propIpIds, prepared.commonCast.propIpIds), 'NATIVE_PROP_ROLE_MISMATCH');
  assert.ok(sameIds(design.castIpIds, [prepared.commonCast.playerIpId, ...prepared.commonCast.propIpIds, backgroundId]), 'NATIVE_CAST_MISMATCH');
  assert.ok(!design.weaponIpId && !(design.enemyIpIds ?? []).length && !(design.npcIpIds ?? []).length, 'UNREQUESTED_NATIVE_ROLE');
  assert.ok(!design.propIpIds.includes(backgroundId), 'BACKGROUND_CANNOT_BE_COLLECTIBLE');
  return true;
}

function options(argv) {
  const out = { input: 'evidence/background-game-test.json', output: 'evidence/background-studio-live.json',
    screenshots: 'evidence/background-studio', media: 'evidence/background-studio' };
  for (let i = 0; i < argv.length; i++) {
    if (['--execute', '--inspect', '--self-test'].includes(argv[i])) out[argv[i].slice(2)] = true;
    else if (['--input', '--output', '--screenshots', '--media'].includes(argv[i]) && argv[i + 1])
      out[argv[i].slice(2)] = argv[++i];
    else throw new Error('UNKNOWN_OR_INCOMPLETE_ARGUMENT');
  }
  assert.ok(!(out.execute && (out.inspect || out['self-test'])), 'CHOOSE_ONE_MODE');
  return out;
}

async function credentialsFromStdin() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; assert.ok(input.length <= 16384, 'STDIN_TOO_LARGE'); }
  let value;
  try { value = JSON.parse(input); } catch { throw new Error('CREDENTIAL_JSON_REQUIRED_ON_STDIN'); }
  input = '';
  assert.ok(value.username?.length && value.password?.length, 'NATIVE_CREDENTIALS_REQUIRED');
  assert.ok(value.expectedConfig?.clientId && value.expectedConfig.userPoolId
    && value.expectedConfig.region === 'us-east-1', 'ACTUAL_PUBLIC_COGNITO_CONFIG_REQUIRED');
  return value;
}

async function run(args, prepared) {
  const credentials = await credentialsFromStdin();
  const secrets = [credentials.username, credentials.password], config = credentials.expectedConfig;
  const output = resolve(args.output), screenshots = resolve(args.screenshots), media = resolve(args.media);
  for (const directory of [dirname(output), screenshots, media]) await mkdir(directory, { recursive: true });
  const report = {
    status: 'RUNNING', startedAt: new Date().toISOString(), sessionId: prepared.sessionId,
    studioUrl: `${STUDIO}/#s=${prepared.sessionId}&game=preview`, source: args.input,
    toolSha256: sha(await readFile(new URL(import.meta.url))),
    scope: 'Two original UI submissions: one image background and one game. Native embedded start; no movement or completion claim.',
    authentication: { method: 'Native Cognito login form', flows: [], statuses: [], tokensSavedToFiles: false },
    requests: [], turns: [], checks: [], screenshots: [], errors: [], mutationsBlocked: [],
    browserClosed: false, serverStarted: false,
  };
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const check = (name, passed, detail) => {
    report.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
    assert.ok(passed, name);
  };
  let browser, snapshot, phase = null, backgroundId = null;
  const chatPath = `/api/sessions/${prepared.sessionId}/chat`;
  const sessionPath = `/api/sessions/${prepared.sessionId}`;
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE ||
    '/opt/homebrew/Cellar/agent-browser/0.16.3/libexec/lib/node_modules/agent-browser/node_modules/playwright-core');
  const snapshotWait = async (label, predicate, seconds = 300) => {
    const start = Date.now(); let lastProgress = 0;
    while (Date.now() - start < seconds * 1000) {
      const replyId = report.requests.at(-1)?.response?.messageId;
      const reply = snapshot?.messages?.find((message) => message.messageId === replyId);
      if (reply?.status === 'failed') {
        report.turns.push({ intent: report.requests.at(-1).intent, messageId: replyId, status: reply.status,
          text: redact(reply.text ?? '', secrets), tools: (reply.toolEvents ?? []).map((event) => ({ tool: event.tool, summary: redact(event.summary, secrets) })) });
        throw new Error(`${label.toUpperCase()}_AGENT_FAILED`);
      }
      if (snapshot && predicate(snapshot)) return snapshot;
      if (label === 'game_generation' && reply?.status === 'done' && !snapshot.games.length)
        throw new Error('AGENT_FINISHED_WITHOUT_GAME');
      if (Date.now() - lastProgress > 30000) {
        console.log(JSON.stringify({ status: 'PROGRESS', stage: label, elapsedSeconds: Math.round((Date.now() - start) / 1000),
          pendingMessages: snapshot?.messages?.filter((m) => m.status === 'pending').length ?? 0,
          newIPs: snapshot?.ips?.length === undefined ? 0 : snapshot.ips.length - 2 }));
        lastProgress = Date.now();
        await save();
      }
      await wait(1000);
    }
    throw new Error(`${label.toUpperCase()}_TIMEOUT_${seconds}S`);
  };
  const screenshot = async (page, name, selector) => {
    if (selector) await page.locator(selector).scrollIntoViewIfNeeded();
    const file = resolve(screenshots, name);
    await page.screenshot({ path: file, animations: 'disabled' });
    report.screenshots.push({ path: file, sha256: sha(await readFile(file)) });
  };
  const download = async (url, file) => {
    const address = new URL(url, STUDIO);
    assert.ok(address.origin === STUDIO && !address.search && !address.hash, 'OWNED_PUBLIC_ASSET_URL_REQUIRED');
    const response = await fetch(address);
    assert.equal(response.status, 200, 'ACTUAL_ASSET_NOT_AVAILABLE');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 100, 'ACTUAL_ASSET_EMPTY');
    if (file) await writeFile(resolve(media, file), bytes);
    return { bytes: bytes.length, sha256: sha(bytes), contentType: response.headers.get('content-type'),
      url: address.href, ...(file ? { path: resolve(media, file) } : {}) };
  };
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    await context.route('**/*', async (route) => {
      const request = route.request(), method = request.method(), url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
      let body;
      try { body = request.postDataJSON(); } catch { body = null; }
      if (method === 'POST' && url.protocol === 'https:' && url.hostname === `cognito-idp.${config.region}.amazonaws.com`
        && request.headers()['x-amz-target'] === 'AWSCognitoIdentityProviderService.InitiateAuth'
        && ['USER_PASSWORD_AUTH', 'REFRESH_TOKEN_AUTH'].includes(body?.AuthFlow)
        && body.ClientId === config.clientId) {
        if (body.AuthFlow === 'USER_PASSWORD_AUTH'
          && (body.AuthParameters?.USERNAME !== secrets[0] || body.AuthParameters?.PASSWORD !== secrets[1])) {
          report.errors.push({ kind: 'auth-protocol', message: 'NATIVE_CREDENTIALS_DID_NOT_MATCH_STDIN' });
          return route.abort('blockedbyclient');
        }
        report.authentication.flows.push(body.AuthFlow);
        return route.continue();
      }
      if (method === 'POST' && url.origin === STUDIO && url.pathname === chatPath && !url.search && phase
        && report.requests.length < 2) {
        try {
          if (phase === 'background') {
            assert.equal(report.requests.length, 0, 'BACKGROUND_CHAT_ALREADY_SUBMITTED');
            assert.equal(body?.text, prepared.backgroundCreationPrompt.trim(), 'CREATION_PROMPT_MISMATCH');
            assert.ok(!body.gameDesign, 'CREATION_MUST_NOT_BE_GAME_SUBMISSION');
          } else {
            assert.equal(report.requests.length, 1, 'GAME_CHAT_ORDER_MISMATCH');
            validateGameChat(body, prepared, backgroundId);
          }
          report.requests.push({ intent: phase, method, path: url.pathname,
            nativeUi: true, submittedAt: new Date().toISOString(), body });
          phase = null; // Every native submit gets a single request; duplicate clicks cannot pass.
          await save();
          return route.continue();
        } catch (error) { report.errors.push({ kind: 'chat-contract', message: redact(error.message, secrets) }); }
      }
      report.mutationsBlocked.push({ method, path: pathOnly(request.url()) });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push({ kind: 'pageerror', message: redact(error.message, secrets) }));
    page.on('console', (message) => {
      if (message.type() === 'error') report.errors.push({ kind: 'console', message: redact(message.text(), secrets) });
    });
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (url.hostname === `cognito-idp.${config.region}.amazonaws.com`) {
        report.authentication.statuses.push(response.status());
        if (response.status() >= 400) {
          const body = await response.json().catch(() => ({}));
          report.errors.push({ kind: 'authentication', status: response.status(), type: redact(body.__type ?? 'UNKNOWN', secrets) });
        }
      }
      if (url.origin === STUDIO && url.pathname === sessionPath && response.request().method() === 'GET' && response.status() === 200) {
        const data = await response.json().catch(() => null);
        if (data?.session?.sessionId === prepared.sessionId) snapshot = data; // Memory only, never a session dump.
      }
      if (url.origin === STUDIO && url.pathname === chatPath && response.request().method() === 'POST') {
        const entry = report.requests.find((item) => !item.response);
        const data = await response.json().catch(() => ({}));
        if (entry) entry.response = { status: response.status(), messageId: data.messageId ?? null };
      }
    });
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' });
    report.frontendModule = await page.locator('script[type="module"][src*="/assets/index-"]').first().getAttribute('src');
    const observed = await page.evaluate(async () => (await fetch('/config.json')).json());
    check('native config matches actual current Cognito', observed.clientId === config.clientId
      && observed.userPoolId === config.userPoolId && observed.region === config.region);
    await page.locator('input[name="username"]').fill(credentials.username);
    await page.locator('input[name="password"]').fill(credentials.password);
    await page.locator('.login-card button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#game-pane-title')
      || document.querySelector('.login-card .form-error'), null, { timeout: 60000 });
    if (await page.locator('.login-card .form-error').count()) throw new Error('NATIVE_LOGIN_FAILED');
    check('native Cognito login succeeded', report.authentication.flows.includes('USER_PASSWORD_AUTH')
      && report.authentication.statuses.includes(200));
    credentials.username = ''; credentials.password = '';
    await page.goto(report.studioUrl, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#game-pane-title').waitFor({ timeout: 60000 });
    await snapshotWait('initial_owned_session', () => true, 60);
    const initialIds = snapshot.ips.map((ip) => ip.ipId);
    check('fresh owned session contains only two prepared IPs', sameIds(initialIds,
      [prepared.commonCast.playerIpId, ...prepared.commonCast.propIpIds]));
    check('no prior test turns, jobs or games', snapshot.messages.length === 0 && snapshot.jobs.length === 0 && snapshot.games.length === 0);

    await page.locator('#composer').fill(prepared.backgroundCreationPrompt);
    phase = 'background';
    await page.locator('.composer button[type="submit"]').click();
    await snapshotWait('background_image_creation', (s) => s.messages.some((m) => m.role === 'assistant' && m.status !== 'pending')
      && !s.messages.some((m) => m.status === 'pending'));
    check('one native background request accepted', report.requests.length === 1 && report.requests[0].response?.status === 202);
    const backgroundTurn = snapshot.messages.find((message) => message.messageId === report.requests[0].response.messageId);
    check('background model turn completed', backgroundTurn?.status === 'done');
    report.turns.push({ intent: 'background', messageId: backgroundTurn.messageId, status: backgroundTurn.status,
      text: redact(backgroundTurn.text, secrets), tools: (backgroundTurn.toolEvents ?? []).map((event) => ({ tool: event.tool, summary: redact(event.summary, secrets) })) });
    const newIPs = snapshot.ips.filter((ip) => !initialIds.includes(ip.ipId));
    check('exactly one real background prop created', newIPs.length === 1 && newIPs[0].kind === 'prop'
      && newIPs[0].usage === 'background' && newIPs[0].name === prepared.background.name);
    const background = newIPs[0]; backgroundId = background.ipId;
    check('image-only test created no GPU mesh/video/rig jobs', snapshot.jobs.length === 0);
    const image = snapshot.assets.find((asset) => asset.assetId === background.imageAssetId);
    const cutout = snapshot.assets.find((asset) => asset.assetId === background.cutoutAssetId);
    check('background owns its full original image asset', image?.kind === 'image' && image.ipId === backgroundId
      && image.key.startsWith(`sessions/${prepared.sessionId}/`));
    check('paired preview explicitly preserves full scene', cutout?.kind === 'cutout' && cutout.ipId === backgroundId
      && cutout.assetId !== image.assetId && cutout.meta?.forAssetId === image.assetId && cutout.meta?.backgroundPreserved === true);
    const original = await download(image.url, 'original-background.png');
    const preview = await download(cutout.url);
    check('paired preview preserves identical original bytes', original.sha256 === preview.sha256);
    report.background = { ipId: backgroundId, name: background.name, kind: background.kind, usage: background.usage,
      imageAssetId: image.assetId, imageKey: image.key, imageModel: image.meta?.model,
      cutoutAssetId: cutout.assetId, cutoutKey: cutout.key, original, preview,
      previewMeaning: 'Separate cutout-kind compatibility preview retains identical whole-scene bytes; no background removal.' };
    await page.locator('#ip-tab-props').click();
    await screenshot(page, '01-background-generated.png', '.pane[aria-labelledby="ip-pane-title"]');
    await save();

    await page.getByRole('button', { name: '✎ 게임 설계', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '게임 설계', exact: true });
    await drawer.waitFor();
    const gamePrompt = prepared.gamePrompt.split(PLACEHOLDER).join(backgroundId);
    await drawer.locator('#game-design-prompt').fill(gamePrompt);
    const roleList = [{ id: prepared.commonCast.playerIpId, role: 'player' },
      ...prepared.commonCast.propIpIds.map((id) => ({ id, role: 'prop' })), { id: backgroundId, role: 'background' }];
    for (const role of roleList) {
      const name = snapshot.ips.find((ip) => ip.ipId === role.id).name;
      await drawer.getByRole('checkbox', { name: `${name} 출연 IP 선택`, exact: true }).check();
      const choice = drawer.getByRole('combobox', { name: `${name} 게임 역할`, exact: true });
      await choice.selectOption(role.role);
      check(`native drawer role ${role.role}`, await choice.inputValue() === role.role);
    }
    check('complete original game request remains in drawer', await drawer.locator('#game-design-prompt').inputValue() === gamePrompt);
    check('image background limitations are visible', (await drawer.innerText()).includes('자동으로 3D 지형이 되지는 않습니다'));
    await screenshot(page, '02-design-selected.png', '.design-drawer');
    phase = 'game';
    await drawer.getByRole('button', { name: '이 설계로 게임 만들기', exact: true }).click();
    await snapshotWait('game_generation', (s) => s.games.length > 0 && !s.messages.some((m) => m.status === 'pending'));
    check('exactly two native chat requests accepted', report.requests.length === 2 && report.requests.every((r) => r.response?.status === 202));
    const gameTurn = snapshot.messages.find((message) => message.messageId === report.requests[1].response.messageId);
    check('game model turn completed', gameTurn?.status === 'done');
    report.turns.push({ intent: 'game', messageId: gameTurn.messageId, status: gameTurn.status,
      text: redact(gameTurn.text, secrets), tools: (gameTurn.toolEvents ?? []).map((event) => ({ tool: event.tool, summary: redact(event.summary, secrets) })) });
    check('one game and no unrequested extra IP or GPU job', snapshot.games.length === 1 && snapshot.ips.length === 3 && snapshot.jobs.length === 0);
    const game = snapshot.games[0];
    assert.match(game.gameId, /^gm_[a-zA-Z0-9]+$/, 'ACTUAL_GAME_ID_REQUIRED');
    const specResponse = await fetch(`${STUDIO}/${game.specKey}`);
    assert.equal(specResponse.status, 200, 'SAVED_GAME_SPEC_UNAVAILABLE');
    const spec = await specResponse.json();
    const submittedDesign = report.requests[1].body.gameDesign;
    check('saved complete source prompt matches native request', spec.design?.sourcePrompt === report.requests[1].body.text);
    check('saved roles match native user selection', Object.entries(submittedDesign)
      .filter(([key]) => key !== 'prompt').every(([key, value]) => isDeepStrictEqual(spec.design?.[key], value)));
    check('saved image background is the selected IP', spec.world?.background?.ipId === backgroundId
      && spec.world.background.mode === 'image' && spec.world.background.imageUrl === `assets/${backgroundId}.background.png`
      && !spec.world.background.modelUrl);
    check('background is not player, enemy or collectible prop', spec.player.ipId !== backgroundId
      && ![...spec.props, ...spec.enemies].some((item) => item.ipId === backgroundId));
    check('saved playable world and two stages meet original request', spec.world.width === 60 && spec.world.depth === 48
      && spec.mission.stages.length === 2 && spec.mission.stages[0].type === 'collect' && spec.mission.stages[1].type === 'reach');
    const copy = await download(new URL(spec.world.background.imageUrl, game.previewUrl).href, 'game-background.png');
    check('game background bytes exactly equal selected full original image', copy.sha256 === original.sha256 && copy.bytes === original.bytes);
    report.game = { gameId: game.gameId, previewUrl: game.previewUrl, spec, copiedBackground: copy,
      fullImageLineage: { ipId: backgroundId, sourceAssetId: image.assetId, sourceKind: image.kind, sourceKey: image.key,
        resolver: 'Server selects IP.imageAssetId; game snapshot bytes match. Preserved preview bytes are separately recorded.' } };
    report.case = { sessionId: prepared.sessionId, gameId: game.gameId, previewUrl: game.previewUrl, spec, backgroundIpId: backgroundId,
      originalImage: { assetId: image.assetId, key: image.key, sha256: original.sha256, bytes: original.bytes } };
    const summary = page.locator('#game-panel-preview .game-design-summary');
    await summary.waitFor({ timeout: 60000 });
    const summaryText = await summary.innerText();
    check('native generated summary names original image background', summaryText.includes(background.name)
      && summaryText.includes('배경·환경') && summaryText.includes('원본 이미지 연결') && summaryText.includes('화면 배경'));
    check('native summary reports no selected-IP warnings', await summary.locator('.game-design-warnings').count() === 0);
    report.summary = summaryText;
    await screenshot(page, '03-saved-summary.png', '#game-panel-preview .game-design-summary');
    await page.locator('#game-tab-spec').click();
    await page.locator('.game-source-prompt summary').click();
    check('full saved request is visible in native studio', await page.locator('.game-source-prompt p').innerText() === spec.design.sourcePrompt);
    await screenshot(page, '04-saved-request.png', '.game-source-prompt');
    await page.locator('#game-tab-preview').click();
    await page.locator('#game-panel-preview .game-start-btn').click();
    const iframe = page.locator('#game-panel-preview iframe');
    await iframe.waitFor({ timeout: 30000 });
    check('main right pane embeds this actual generated game', await iframe.getAttribute('src') === game.previewUrl);
    const frame = await (await iframe.elementHandle()).contentFrame();
    assert.ok(frame, 'ACTUAL_GAME_FRAME_REQUIRED');
    await frame.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready', null, { timeout: 180000 });
    const state = await frame.evaluate(() => window.__ipverseGameState());
    check('actual image background loaded as static non-collectible environment', state.background?.ipId === backgroundId
      && state.background.mode === 'image' && state.background.loaded === true && state.background.static === true
      && state.background.collectible === false && state.background.render === 'original-image-backdrop'
      && state.background.automatic3DTerrain === false);
    check('selected character and core retain actual runtime roles', state.playerIpId === prepared.commonCast.playerIpId
      && sameIds(state.propIpIds, prepared.commonCast.propIpIds) && ['model', 'rigged'].includes(state.actorKind));
    check('actual loaded original image has valid dimensions', state.background.width > 0 && state.background.height > 0);
    Object.assign(report.case.originalImage, { width: state.background.width, height: state.background.height });
    report.initialState = state;
    await frame.locator('.briefing-start').click();
    await frame.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing', null, { timeout: 30000 });
    report.playingState = await frame.evaluate(() => window.__ipverseGameState());
    check('native embedded start reaches playing', report.playingState.phase === 'playing');
    await screenshot(page, '05-desktop-playing.png', '#game-panel-preview .preview');
    const captured = await frame.evaluate(async () => {
      const canvas = document.querySelector('#game canvas');
      if (!canvas || !canvas.captureStream || typeof MediaRecorder === 'undefined') throw new Error('CANVAS_RECORDING_UNAVAILABLE');
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      if (!mimeType) throw new Error('WEBM_RECORDING_UNAVAILABLE');
      const stream = canvas.captureStream(20), recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2500000 });
      const chunks = [], start = performance.now();
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise((done, reject) => { recorder.onstop = done; recorder.onerror = () => reject(new Error('CANVAS_RECORDING_FAILED')); });
      recorder.start(500); await new Promise((done) => setTimeout(done, 6000)); recorder.stop(); await stopped;
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: mimeType });
      const base64 = await new Promise((done, reject) => {
        const reader = new FileReader(); reader.onload = () => done(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      return { base64, mimeType, elapsedSeconds: (performance.now() - start) / 1000, width: canvas.width, height: canvas.height };
    });
    const video = Buffer.from(captured.base64, 'base64'); delete captured.base64;
    const videoPath = resolve(media, 'background-native-canvas.webm');
    await writeFile(videoPath, video);
    const decoded = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', videoPath, '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000 });
    report.media = { ...captured, path: videoPath, bytes: video.length, sha256: sha(video), fullDecode: decoded.status === 0,
      scope: 'Six real seconds of the playing WebGL canvas only; no login UI, fabricated frame or gameplay completion.' };
    check('real local recording fully decodes', report.media.fullDecode && video.length > 1000);
    await page.setViewportSize({ width: 390, height: 844 });
    await iframe.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    check('390px studio has no horizontal overflow', dimensions.width <= dimensions.viewport + 1);
    await screenshot(page, '06-mobile-playing.png', '#game-panel-preview .preview');
    await screenshot(page, '07-mobile-summary.png', '#game-panel-preview .game-design-summary');
    report.mobileScope = 'Responsive display only; no touch controls or mobile gameplay quality claim.';
    check('no unexpected browser or mutation errors', report.errors.length === 0 && report.mutationsBlocked.length === 0);
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAILED'; report.failure = redact(error.message, secrets);
  } finally {
    phase = null;
    if (browser) await browser.close();
    report.browserClosed = true; report.finishedAt = new Date().toISOString();
    secrets.fill(''); credentials.username = ''; credentials.password = '';
    await save();
  }
  console.log(JSON.stringify({ status: report.status, sessionId: report.sessionId, requests: report.requests.length,
    checks: report.checks.length, errors: report.errors.length, browserClosed: report.browserClosed, report: args.output }));
  if (report.status !== 'PASS') process.exitCode = 1;
}

function selfTest() {
  const fixture = { status: 'PREPARED_NO_MODEL_CALLS', sessionId: 'ses_fixture', sourceUnchanged: true,
    commonCast: { playerIpId: 'ip_hero', propIpIds: ['ip_core'], weaponIpId: null, enemyIpIds: [], npcIpIds: [] },
    sourceAssetInventory: [{ ipId: 'ip_hero', name: '주인공' }, { ipId: 'ip_core', name: '코어' }],
    background: { name: '환경', kind: 'prop', usage: 'background', mode: 'image', ipId: null },
    backgroundCreationPrompt: 'Create one background', gamePrompt: `Use ${PLACEHOLDER} as background`,
    gameDesignTemplate: { backgroundIpId: PLACEHOLDER, castIpIds: ['ip_hero', 'ip_core', PLACEHOLDER] } };
  assert.equal(validatePrepared(fixture), fixture);
  assert.throws(() => validatePrepared({ ...fixture, status: 'FINISHED' }), /PREPARED_FRESH_TEST_REQUIRED/);
  assert.throws(() => validatePrepared({ ...fixture, sourceUnchanged: false }), /SOURCE_PRESERVATION_REQUIRED/);
  assert.throws(() => validatePrepared({ ...fixture, gamePrompt: 'missing placeholder' }), /PLACEHOLDER/);
  assert.throws(() => validatePrepared({ ...fixture, background: { ...fixture.background, mode: 'model' } }), /NEW_IMAGE_BACKGROUND_REQUIRED/);
  const body = { text: 'Use ip_background as background', gameDesign: {
    prompt: 'Use ip_background as background', backgroundIpId: 'ip_background',
    playerIpId: 'ip_hero', propIpIds: ['ip_core'], castIpIds: ['ip_hero', 'ip_core', 'ip_background'],
    enemyIpIds: [], npcIpIds: [], weaponIpId: null } };
  assert.ok(validateGameChat(body, fixture, 'ip_background'));
  assert.throws(() => validateGameChat({ ...body, gameDesign: { ...body.gameDesign, backgroundIpId: 'ip_other' } }, fixture, 'ip_background'), /BACKGROUND_ROLE/);
  assert.throws(() => validateGameChat({ ...body, text: 'truncated' }, fixture, 'ip_background'), /COMPLETE_NATIVE_GAME_PROMPT/);
  assert.throws(() => validateGameChat({ ...body, gameDesign: { ...body.gameDesign, propIpIds: ['ip_core', 'ip_background'] } }, fixture, 'ip_background'), /PROP_ROLE/);
  assert.equal(redact('password Bearer secret', ['password']), '[REDACTED] Bearer [REDACTED]');
  console.log(JSON.stringify({ status: 'SELF_TEST_PASS', checks: 10, browserLaunched: false, networkRequests: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = options(process.argv.slice(2));
    if (args['self-test']) selfTest();
    else {
      const prepared = validatePrepared(JSON.parse(await readFile(resolve(args.input), 'utf8')));
      if (args.execute) await run(args, prepared);
      else console.log(JSON.stringify({ status: 'READY_NO_BROWSER_OR_MODEL_CALLS', sessionId: prepared.sessionId,
        input: args.input, executeRequired: true }));
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'PREFLIGHT_FAILED', reason: redact(error.message) }));
    process.exitCode = 1;
  }
}
