// Existing-game verification only. Credentials arrive on stdin and stay in RAM.
// Every API mutation is blocked; the sole permitted POST is native Cognito login.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { redact } from './verify_background_studio.mjs';

const STUDIO = 'https://d12ka835iwfpnx.cloudfront.net';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = new Set(process.argv.slice(2));
assert.ok([...args].every((argument) => ['--execute', '--inspect'].includes(argument)), 'UNKNOWN_ARGUMENT');
const input = resolve('evidence/background-studio-live.json');
const inputBytes = await readFile(input);
const source = JSON.parse(inputBytes);
assert.ok(source.status === 'PASS' && source.browserClosed === true && source.case?.backgroundIpId, 'SUCCESSFUL_EXISTING_GAME_REQUIRED');
assert.equal(sha(await readFile(new URL('./verify_background_studio.mjs', import.meta.url))), source.toolSha256, 'GENERATION_VERIFIER_CHANGED');
const localIndex = await readFile('web/dist/index.html', 'utf8');
const bundlePath = localIndex.match(/<script[^>]*src="(\/assets\/index-[^"]+\.js)"/)?.[1];
assert.ok(bundlePath?.startsWith('/assets/index-') && bundlePath.endsWith('.js'), 'BUILT_UI_REQUIRED');
const bundleSha = sha(await readFile(resolve('web/dist', bundlePath.slice(1))));
if (!args.has('--execute')) {
  console.log(JSON.stringify({ status: 'READY_READONLY_NO_BROWSER_OR_MODEL_CALLS', sessionId: source.case.sessionId, bundlePath, bundleSha }));
} else {
  await run();
}

async function run() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    assert.ok(raw.length <= 16384, 'CREDENTIAL_INPUT_TOO_LARGE');
  }
  const credentials = JSON.parse(raw);
  raw = '';
  assert.ok(credentials.username && credentials.password && credentials.expectedConfig?.clientId
    && credentials.expectedConfig?.userPoolId && credentials.expectedConfig.region === 'us-east-1', 'PRIVATE_NATIVE_CREDENTIALS_REQUIRED');
  const secrets = [credentials.username, credentials.password];
  const config = credentials.expectedConfig;
  const output = resolve('evidence/background-studio-readonly.json');
  const screenshots = resolve('evidence/background-studio-readonly-complete');
  await mkdir(screenshots, { recursive: true });
  const report = {
    status: 'RUNNING', startedAt: new Date().toISOString(),
    studioUrl: `${STUDIO}/#s=${source.case.sessionId}&ip=props&game=preview`,
    sessionId: source.case.sessionId, gameId: source.case.gameId, backgroundIpId: source.case.backgroundIpId,
    generationEvidence: { path: input, sha256: sha(inputBytes), originalVerifierSha256: source.toolSha256 },
    toolSha256: sha(await readFile(new URL(import.meta.url))),
    frontend: { path: bundlePath, sha256: bundleSha },
    scope: 'Native login and existing IP/game UI only. API mutations blocked; no regeneration or movement.',
    authentication: { method: 'Native Cognito login form', flows: [], statuses: [], tokensSavedToFiles: false },
    checks: [], screenshots: [], errors: [], blockedMutations: [], apiMutations: 0,
    browserClosed: false, serverStarted: false,
  };
  const check = (name, passed) => {
    report.checks.push({ name, passed: Boolean(passed) });
    assert.ok(passed, name);
  };
  const capture = async (page, name, selector) => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const path = resolve(screenshots, name);
    await page.screenshot({ path, animations: 'disabled' });
    report.screenshots.push({ path, sha256: sha(await readFile(path)) });
  };
  const decode = async (locator) => locator.evaluate(async (image) => {
    await image.decode();
    const bounds = image.getBoundingClientRect();
    const parent = image.parentElement.getBoundingClientRect();
    return { src: image.currentSrc, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      width: bounds.width, height: bounds.height, parentWidth: parent.width, parentHeight: parent.height,
      complete: image.complete, objectFit: getComputedStyle(image).objectFit };
  });
  let browser, snapshot;
  try {
    const require = createRequire(import.meta.url);
    const { chromium } = require('/opt/homebrew/Cellar/agent-browser/0.16.3/libexec/lib/node_modules/agent-browser/node_modules/playwright-core');
    browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      let body;
      try { body = request.postDataJSON(); } catch { body = null; }
      if (request.method() === 'POST' && url.origin === `https://cognito-idp.${config.region}.amazonaws.com`
        && request.headers()['x-amz-target'] === 'AWSCognitoIdentityProviderService.InitiateAuth'
        && body?.ClientId === config.clientId && ['USER_PASSWORD_AUTH', 'REFRESH_TOKEN_AUTH'].includes(body.AuthFlow)
        && (body.AuthFlow === 'REFRESH_TOKEN_AUTH'
          || body.AuthParameters?.USERNAME === secrets[0] && body.AuthParameters?.PASSWORD === secrets[1])) {
        report.authentication.flows.push(body.AuthFlow);
        return route.continue();
      }
      report.blockedMutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push({ kind: 'page', message: redact(error.message, secrets) }));
    page.on('console', (event) => {
      if (event.type() === 'error') report.errors.push({ kind: 'console', message: redact(event.text(), secrets) });
    });
    page.on('response', async (response) => {
      try {
        const url = new URL(response.url());
        if (url.hostname === `cognito-idp.${config.region}.amazonaws.com`)
          report.authentication.statuses.push(response.status());
        if (response.request().method() === 'GET' && url.origin === STUDIO
          && url.pathname === `/api/sessions/${source.case.sessionId}` && response.status() === 200)
          snapshot = await response.json();
      } catch { /* Optional response observation must not retain request bodies. */ }
    });
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' });
    const actualConfig = await page.evaluate(async () => (await fetch('/config.json')).json());
    check('public Cognito config matches current account', actualConfig.clientId === config.clientId
      && actualConfig.userPoolId === config.userPoolId && actualConfig.region === config.region);
    const actualBundle = await page.locator('script[type="module"][src*="/assets/index-"]').getAttribute('src');
    check('public page loads the fixed UI bundle', actualBundle === bundlePath);
    const bundleResponse = await fetch(new URL(bundlePath, STUDIO));
    check('delivered fixed bundle bytes match build', bundleResponse.status === 200
      && sha(Buffer.from(await bundleResponse.arrayBuffer())) === bundleSha);
    await page.locator('input[name="username"]').fill(credentials.username);
    await page.locator('input[name="password"]').fill(credentials.password);
    await page.locator('.login-card button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#game-pane-title')
      || document.querySelector('.login-card .form-error'), null, { timeout: 60000 });
    check('native Cognito login succeeded', await page.locator('.login-card .form-error').count() === 0
      && report.authentication.flows.includes('USER_PASSWORD_AUTH') && report.authentication.statuses.includes(200));
    credentials.username = ''; credentials.password = '';
    await page.goto(report.studioUrl, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#ip-tab-props[aria-selected="true"]').waitFor({ timeout: 60000 });
    const waitStarted = Date.now();
    while (!snapshot && Date.now() - waitStarted < 60000) await page.waitForTimeout(250);
    check('existing generated session loaded', snapshot?.session.sessionId === source.case.sessionId);
    check('no new IP, game or GPU job', snapshot.ips.length === 3 && snapshot.games.length === 1
      && snapshot.games[0].gameId === source.case.gameId && snapshot.jobs.length === 0);
    const background = snapshot.ips.find((ip) => ip.ipId === source.case.backgroundIpId);
    check('saved background usage remains explicit', background?.usage === 'background');
    const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: background.name, exact: true }) }).first();
    check('background card clearly labels the full scene', await card.getByText('배경 · 전체 장면', { exact: true }).isVisible());
    check('background card has no cutout toggle', await card.locator('.cutout-toggle').count() === 0);
    const original = await decode(card.locator('.card-media img'));
    report.originalCard = original;
    check('background card shows its original image', original.src === source.background.original.url
      && original.naturalWidth === source.case.originalImage.width && original.naturalHeight === source.case.originalImage.height
      && await card.locator('.card-media.is-cutout').count() === 0);
    check('original background alt does not claim a cutout', (await card.locator('img').first().getAttribute('alt')).includes('전체 장면 배경'));
    check('ordinary core retains its cutout control', await page.getByRole('button', { name: '에너지 코어 누끼 보기', exact: true }).isVisible());
    await capture(page, '01-original-background-card.png', '.pane[aria-labelledby="ip-pane-title"]');
    await page.getByRole('button', { name: '✎ 게임 설계', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '게임 설계' });
    await drawer.locator(`input[aria-label="${background.name} 출연 IP 선택"]`).check();
    check('native drawer defaults this IP to background', await drawer.locator(`select[aria-label="${background.name} 게임 역할"]`).inputValue() === 'background');
    const castCard = drawer.locator('.cast-card').filter({ has: page.getByRole('checkbox', { name: `${background.name} 출연 IP 선택`, exact: true }) });
    const thumbnail = await decode(castCard.locator('.cast-thumb img'));
    report.decodedThumbnail = thumbnail;
    check('loaded background thumbnail uses the full original image', thumbnail.src === original.src
      && thumbnail.naturalWidth === original.naturalWidth && thumbnail.naturalHeight === original.naturalHeight);
    check('loaded landscape thumbnail fills a square frame', thumbnail.complete && thumbnail.width >= 80
      && thumbnail.height >= 80 && Math.abs(thumbnail.width - thumbnail.parentWidth) < 1
      && Math.abs(thumbnail.height - thumbnail.parentHeight) < 1 && thumbnail.objectFit === 'contain');
    await capture(page, '02-decoded-background-selection.png', '.design-drawer');
    await drawer.getByRole('button', { name: '닫기', exact: true }).click();
    const summary = page.locator('#game-panel-preview .game-design-summary');
    await summary.waitFor();
    check('saved summary describes the actual image binding', (await summary.innerText()).includes('원본 이미지 연결 · 화면 배경'));
    await page.locator('.game-start-btn').click();
    const iframe = page.locator('#game-panel-preview iframe');
    await iframe.waitFor({ timeout: 60000 });
    check('main panel embeds the original generated game', await iframe.getAttribute('src') === source.case.previewUrl);
    const frame = await (await iframe.elementHandle()).contentFrame();
    assert.ok(frame, 'ACTUAL_GAME_FRAME_REQUIRED');
    await frame.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready', null, { timeout: 180000 });
    report.readyState = await frame.evaluate(() => window.__ipverseGameState());
    const bg = report.readyState.background;
    check('same full image remains loaded after UI repair', bg?.loaded === true && bg.ipId === source.case.backgroundIpId
      && bg.mode === 'image' && bg.static === true && bg.collectible === false && bg.automatic3DTerrain === false);
    const startButton = frame.getByRole('button', { name: '임무 시작', exact: true });
    report.startControl = { phase: report.readyState.phase, text: await startButton.innerText(), visible: await startButton.isVisible() };
    check('ready iframe exposes its actual mission start button', report.startControl.phase === 'ready' && report.startControl.visible);
    await startButton.click();
    await frame.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing', null, { timeout: 30000 });
    report.playingState = await frame.evaluate(() => window.__ipverseGameState());
    check('native existing game start reaches playing', report.playingState.phase === 'playing');
    await capture(page, '03-existing-game-desktop.png', '#game-panel-preview .preview');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#game-panel-preview .preview').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    check('390px main studio has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await capture(page, '04-existing-game-mobile.png', '#game-panel-preview .preview');
    check('no API mutation or browser error', report.apiMutations === 0 && report.blockedMutations.length === 0 && report.errors.length === 0);
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAILED';
    report.failure = redact(error.message, secrets);
    process.exitCode = 1;
  } finally {
    if (browser) { await browser.close(); report.browserClosed = true; }
    secrets.fill(''); credentials.username = ''; credentials.password = '';
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, apiMutations: report.apiMutations,
    errors: report.errors.length, browserClosed: report.browserClosed, report: output }));
}
