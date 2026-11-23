// Real studio login and UI checks. Credentials enter through stdin, stay in RAM,
// and are never written to browser storage-state files, traces, logs, or reports.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const STUDIO = 'https://d12ka835iwfpnx.cloudfront.net';
const require = createRequire(import.meta.url);
const ID = /^(?:ses|gm)_[a-zA-Z0-9]+$/;

export function expectedCases(input) {
  assert.ok(Array.isArray(input?.cases) && input.cases.length === 2, 'LIVE_GAMES_NOT_READY');
  assert.equal(new Set(input.cases.map((c) => c.sessionId)).size, 2, 'DISTINCT_SESSIONS_REQUIRED');
  assert.equal(new Set(input.cases.map((c) => c.gameId)).size, 2, 'DISTINCT_GAMES_REQUIRED');
  return input.cases.map((c) => {
    assert.ok(c.ok === true && ID.test(c.sessionId ?? '') && ID.test(c.gameId ?? ''), 'LIVE_GAMES_NOT_READY');
    const url = new URL(c.previewUrl);
    assert.equal(url.origin, STUDIO, 'UNEXPECTED_GAME_ORIGIN');
    assert.ok(url.pathname.startsWith(`/games/${c.gameId}/`) && !url.search && !url.hash, 'UNEXPECTED_GAME_PATH');
    assert.ok(c.spec?.engine === 'three' && c.spec?.version === 2 && c.spec?.world?.city, 'CITY_SPEC_REQUIRED');
    assert.ok(typeof c.spec.design?.sourcePrompt === 'string' && c.spec.design.sourcePrompt.length, 'SAVED_REQUEST_REQUIRED');
    if (c.prompt) assert.equal(c.spec.design.sourcePrompt, c.prompt, 'SAVED_REQUEST_MISMATCH');
    assert.ok(Array.isArray(c.spec.design.castIpIds) && c.spec.design.castIpIds.length, 'SELECTED_IPS_REQUIRED');
    assert.ok(Array.isArray(c.spec.mission?.stages) && c.spec.mission.stages.some((s) => s.type === 'drive'), 'DRIVE_STAGE_REQUIRED');
    return c;
  });
}

export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[JWT_REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]+/g, '$1?[QUERY_REDACTED]');
}

async function stdinCredentials() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 16384) throw new Error('CREDENTIAL_INPUT_TOO_LARGE');
  }
  let credentials;
  try { credentials = JSON.parse(value); }
  catch { throw new Error('CREDENTIAL_JSON_REQUIRED_ON_STDIN'); }
  value = '';
  assert.ok(typeof credentials.username === 'string' && credentials.username.length > 0, 'USERNAME_REQUIRED');
  assert.ok(typeof credentials.password === 'string' && credentials.password.length > 0, 'PASSWORD_REQUIRED');
  return credentials;
}

function options(argv) {
  const out = {
    input: 'evidence/city-generation-live.json',
    output: 'evidence/city-studio-live.json',
    screenshots: 'evidence/city-studio',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--self-test') out.selfTest = true;
    else if (['--input', '--output', '--screenshots'].includes(key) && argv[i + 1])
      out[key.slice(2)] = argv[++i];
    else throw new Error('UNKNOWN_OR_INCOMPLETE_ARGUMENT');
  }
  return out;
}

const pathOnly = (address) => {
  try { const u = new URL(address); return u.origin + u.pathname; }
  catch { return '[INVALID_URL]'; }
};

async function run(args) {
  // Fail before reading credentials or launching a browser when generation is incomplete.
  const input = JSON.parse(await readFile(resolve(args.input), 'utf8'));
  const cases = expectedCases(input);
  const credentials = await stdinCredentials();
  const secrets = [credentials.username, credentials.password];
  const expectedConfig = credentials.expectedConfig;
  const output = resolve(args.output), screenshots = resolve(args.screenshots);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(screenshots, { recursive: true });
  const report = {
    status: 'RUNNING', startedAt: new Date().toISOString(),
    studio: STUDIO, source: args.input,
    toolSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    scope: 'Native Cognito UI login, saved city/IP/request summary, embedded game readiness/start. No generation or movement.',
    browser: 'Owned ephemeral Playwright Chromium; no persistent profile or storageState export.',
    authentication: { method: 'Native login form', flows: [], statuses: [], errorTypes: [], tokensSavedToFiles: false },
    mutationsBlocked: [], cases: [], errors: [], browserClosed: false,
  };
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE ||
    '/opt/homebrew/Cellar/agent-browser/0.16.3/libexec/lib/node_modules/agent-browser/node_modules/playwright-core');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    // Browser app may POST only its normal Cognito login/refresh. Nothing can
    // create sessions, send chat, change genres, register jobs, or start streams.
    await context.route('**/*', async (route) => {
      const request = route.request(), method = request.method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
      const target = new URL(request.url());
      const cognito = method === 'POST' && /^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/.test(target.hostname)
        && target.protocol === 'https:' && request.headers()['x-amz-target'] === 'AWSCognitoIdentityProviderService.InitiateAuth';
      if (cognito) {
        let body;
        try { body = request.postDataJSON(); } catch { body = null; }
        if (['USER_PASSWORD_AUTH', 'REFRESH_TOKEN_AUTH'].includes(body?.AuthFlow)) {
          if (expectedConfig && (body.ClientId !== expectedConfig.clientId
            || target.hostname !== `cognito-idp.${expectedConfig.region}.amazonaws.com`)) {
            report.errors.push({ kind: 'auth-protocol', message: 'NATIVE_AUTH_CONFIG_DOES_NOT_MATCH_ACTUAL_POOL' });
            return route.abort('blockedbyclient');
          }
          if (body.AuthFlow === 'USER_PASSWORD_AUTH'
            && (body.AuthParameters?.USERNAME !== secrets[0] || body.AuthParameters?.PASSWORD !== secrets[1])) {
            report.errors.push({ kind: 'auth-protocol', message: 'NATIVE_FORM_CREDENTIALS_DID_NOT_MATCH_STDIN' });
            return route.abort('blockedbyclient');
          }
          report.authentication.flows.push(body.AuthFlow);
          return route.continue();
        }
      }
      report.mutationsBlocked.push({ method, path: pathOnly(request.url()) });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push({ kind: 'pageerror', message: redact(error.message, secrets) }));
    page.on('console', (message) => {
      if (message.type() === 'error')
        report.errors.push({ kind: 'console', message: redact(message.text(), secrets) });
    });
    page.on('response', async (response) => {
      if (/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\//.test(response.url())) {
        report.authentication.statuses.push(response.status());
        if (response.status() >= 400) {
          try {
            const body = await response.json();
            report.authentication.errorTypes.push(redact(body.__type ?? 'UNKNOWN_AUTH_ERROR', secrets));
          } catch { report.authentication.errorTypes.push('UNREADABLE_AUTH_ERROR'); }
        }
      }
    });
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' });
    report.frontendModule = await page.locator('script[type="module"][src*="/assets/index-"]').first().getAttribute('src');
    if (expectedConfig) {
      const observed = await page.evaluate(async () => {
        const response = await fetch('/config.json');
        return { config: await response.json(), cache: response.headers.get('x-cache'),
          age: response.headers.get('age'), status: response.status };
      });
      report.nativeConfiguration = {
        clientMatches: observed.config.clientId === expectedConfig.clientId,
        poolMatches: observed.config.userPoolId === expectedConfig.userPoolId,
        regionMatches: observed.config.region === expectedConfig.region,
        cache: observed.cache, age: observed.age, status: observed.status,
      };
      assert.ok(report.nativeConfiguration.clientMatches && report.nativeConfiguration.poolMatches
        && report.nativeConfiguration.regionMatches, 'NATIVE_CONFIG_DIFFERS_FROM_ACTUAL_POOL');
    }
    await page.locator('input[name="username"]').fill(credentials.username);
    await page.locator('input[name="password"]').fill(credentials.password);
    assert.ok(await page.locator('input[name="username"]').inputValue() === credentials.username, 'NATIVE_USERNAME_FILL_MISMATCH');
    assert.ok(await page.locator('input[name="password"]').inputValue() === credentials.password, 'NATIVE_PASSWORD_FILL_MISMATCH');
    await page.locator('.login-card button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#game-pane-title')
      || document.querySelector('.login-card .form-error'), null, { timeout: 60000 });
    if (await page.locator('.login-card .form-error').count()) throw new Error('NATIVE_COGNITO_LOGIN_REJECTED');
    await page.locator('#game-pane-title').waitFor({ timeout: 60000 });
    assert.ok(report.authentication.flows.includes('USER_PASSWORD_AUTH'), 'NATIVE_COGNITO_LOGIN_NOT_OBSERVED');
    assert.ok(report.authentication.statuses.includes(200), 'COGNITO_LOGIN_NOT_SUCCESSFUL');
    credentials.username = ''; credentials.password = '';
    report.authentication.success = true;

    for (const c of cases) {
      const result = { type: c.type, sessionId: c.sessionId, gameId: c.gameId,
        studioUrl: `${STUDIO}/#s=${encodeURIComponent(c.sessionId)}&game=preview`,
        previewUrl: c.previewUrl, checks: [], screenshots: [], viewports: [] };
      report.cases.push(result);
      const check = (name, passed, detail) => {
        result.checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
        assert.ok(passed, name);
      };
      await page.setViewportSize({ width: 1440, height: 1080 });
      // Hash-only page.goto keeps the existing App's selected session. Reload
      // each shared URL as a fresh document while retaining native tab auth.
      await page.goto(result.studioUrl, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      result.observedStudioUrl = page.url();
      await page.locator('#game-pane-title').waitFor({ timeout: 60000 });
      const version = page.locator(`#game-ver-${c.gameId}`);
      if (await version.count()) await version.click();
      const summary = page.locator('#game-panel-preview .game-design-summary');
      await summary.waitFor({ timeout: 60000 });
      const text = await summary.innerText();
      result.summary = text;
      const w = c.spec.world, city = w.city;
      check('saved dimensions visible', text.includes(`${w.width} × ${w.depth}m`));
      check('actual road and vehicle counts visible', text.includes(`도로 ${city.streets.length}개`)
        && text.includes(`운전 차량 ${city.vehicles.length}대`) && text.includes(`보행자 ${city.pedestrians.length}명`));
      check('Three.js engine named accurately', text.includes('엔진: Three.js 브라우저'));
      check('all ordered mission labels visible', c.spec.mission.stages.every((stage) => text.includes(stage.label)));
      const drive = c.spec.mission.stages.find((s) => s.type === 'drive');
      check('drive requirement shown as actual distance', text.includes(`${drive.distanceMeters}m 주행`));
      const bindingRows = await summary.locator('.game-ip-bindings li').allInnerTexts();
      const slots = [{ entity: c.spec.player, role: '주인공' },
        ...c.spec.props.map((entity, i) => ({ entity, role: i === w.npc.propIndex ? 'NPC·동료' : '소품·아이템' }))];
      for (const { entity, role } of slots) {
        const name = entity.name || input.sourceAssetInventory?.find((ip) => ip.ipId === entity.ipId)?.name || entity.ipId;
        check(`selected IP displayed: ${entity.ipId}`,
          bindingRows.some((row) => row.includes(name) && row.includes(role) && row.includes('3D 연결')));
      }
      check('no selected-IP binding warnings', await summary.locator('.game-design-warnings').count() === 0);
      await page.getByRole('button', { name: '✎ 게임 설계', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: '게임 설계', exact: true });
      await drawer.waitFor();
      await drawer.getByRole('button', { name: '도시 코어 운송', exact: true }).click();
      check('city type preset selects the real city contract',
        await drawer.getByRole('radio', { name: /도시 오픈월드/ }).isChecked());
      await drawer.locator('#game-design-prompt').fill(c.spec.design.sourcePrompt);
      const roles = [{ id: c.spec.design.playerIpId, role: 'player' },
        ...(c.spec.design.propIpIds ?? []).map((id) => ({ id, role: 'prop' })),
        ...(c.spec.design.npcIpIds ?? []).map((id) => ({ id, role: 'npc' }))];
      result.drawerRoles = [];
      for (const role of roles) {
        const name = input.sourceAssetInventory?.find((ip) => ip.ipId === role.id)?.name
          || slots.find((s) => s.entity.ipId === role.id)?.entity.name;
        assert.ok(name, 'DRAWER_IP_NAME_REQUIRED');
        await drawer.getByRole('checkbox', { name: `${name} 출연 IP 선택`, exact: true }).check();
        const choice = drawer.getByRole('combobox', { name: `${name} 게임 역할`, exact: true });
        await choice.selectOption(role.role);
        check(`drawer role selectable: ${role.id}`, await choice.inputValue() === role.role);
        result.drawerRoles.push({ ipId: role.id, role: role.role });
      }
      check('drawer accepts complete saved prompt', await drawer.locator('#game-design-prompt').inputValue() === c.spec.design.sourcePrompt);
      check('valid city cast enables design action without submitting',
        await drawer.getByRole('button', { name: '이 설계로 게임 만들기', exact: true }).isEnabled());
      await summaryScreenshot(page, result, screenshots, `${c.type}-desktop-drawer.png`, '.design-drawer');
      await drawer.getByRole('button', { name: '닫기', exact: true }).click();
      await page.locator('#game-tab-spec').click();
      await page.locator('.game-spec-details summary').click();
      await page.locator('.spec[aria-label="GameSpec JSON"]').waitFor({ timeout: 30000 });
      const actual = JSON.parse(await page.locator('.spec[aria-label="GameSpec JSON"]').innerText());
      check('saved request exactly matches actual GameSpec', actual.design.sourcePrompt === c.spec.design.sourcePrompt);
      check('saved cast and roles match generated result',
        isDeepStrictEqual(actual.design, c.spec.design));
      check('rendered GameSpec world matches generation evidence',
        isDeepStrictEqual(actual.world, c.spec.world));
      await page.locator('.game-source-prompt summary').click();
      check('original request visible in studio', await page.locator('.game-source-prompt p').innerText() === c.spec.design.sourcePrompt);
      await summaryScreenshot(page, result, screenshots, `${c.type}-desktop-request.png`, '.game-source-prompt');
      await page.locator('#game-tab-preview').click();
      await page.locator('#game-panel-preview .game-start-btn').click();
      const iframe = page.locator('#game-panel-preview iframe');
      await iframe.waitFor({ timeout: 30000 });
      check('embedded URL is this actual game', await iframe.getAttribute('src') === c.previewUrl);
      const frame = await (await iframe.elementHandle()).contentFrame();
      assert.ok(frame, 'GAME_FRAME_UNAVAILABLE');
      await frame.waitForFunction(() => {
        const s = window.__ipverseGameState?.();
        return s?.phase === 'ready' && s.city?.assetModelsLoaded > 0;
      }, null, { timeout: 180000 });
      const initial = await frame.evaluate(() => window.__ipverseGameState());
      check('real city kit and selected actor loaded', initial.city.assetModelsLoaded >= 46
        && ['model', 'rigged'].includes(initial.actorKind));
      check('runtime actor IDs match saved selected IPs', initial.playerIpId === c.spec.player.ipId
        && isDeepStrictEqual(initial.propIpIds, c.spec.props.map((p) => p.ipId)));
      check('iframe city dimensions and drive vehicle match saved game',
        initial.city.width === w.width && initial.city.depth === w.depth
        && initial.city.vehicles.some((v) => v.id === drive.entityIds[0]));
      const briefingControls = await frame.locator('.briefing-controls').innerText();
      check('actual vehicle keyboard controls visible', ['차량 탑승·하차 E', '운전 WASD', '브레이크 Space']
        .every((label) => briefingControls.includes(label)));
      result.initialState = initial;
      result.briefingControls = briefingControls;
      await frame.locator('.briefing-start').click();
      await frame.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing', null, { timeout: 30000 });
      result.playingState = await frame.evaluate(() => window.__ipverseGameState());
      check('embedded native start reaches playing', result.playingState.phase === 'playing');
      await summaryScreenshot(page, result, screenshots, `${c.type}-desktop-playing.png`, '#game-panel-preview .preview');
      result.viewports.push({ width: 1440, height: 1080, iframe: await iframe.boundingBox(), phase: 'playing' });
      await page.setViewportSize({ width: 390, height: 844 });
      await iframe.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const mobile = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      check('390px studio has no horizontal overflow', mobile.width <= mobile.viewport + 1, mobile);
      const frameBox = await iframe.boundingBox();
      check('390px embedded game remains visible', frameBox?.width > 200 && frameBox.width <= 390);
      const mobileHint = await frame.locator('#hint').innerText();
      check('390px game preserves vehicle controls', mobileHint.includes('차량 탑승·하차 E') && mobileHint.includes('브레이크 Space'));
      await summaryScreenshot(page, result, screenshots, `${c.type}-mobile-playing.png`, '#game-panel-preview .preview');
      await summaryScreenshot(page, result, screenshots, `${c.type}-mobile-summary.png`, '#game-panel-preview .game-design-summary');
      result.viewports.push({ width: 390, height: 844, iframe: frameBox, phase: 'playing',
        scope: 'Responsive display and documented keyboard controls; not a touch-driving playtest.' });
      result.ok = true;
      await save();
    }
    assert.equal(report.mutationsBlocked.length, 0, 'UNEXPECTED_MUTATING_REQUEST');
    assert.equal(report.errors.length, 0, 'BROWSER_ERRORS_OBSERVED');
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAILED';
    report.failure = redact(error.message, secrets);
  } finally {
    if (browser) await browser.close();
    report.browserClosed = true;
    report.finishedAt = new Date().toISOString();
    secrets.fill('');
    await save();
  }
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length,
    checks: report.cases.reduce((n, c) => n + c.checks.length, 0), errors: report.errors.length,
    browserClosed: report.browserClosed, report: args.output }));
  if (report.status !== 'PASS') process.exitCode = 1;
}

async function summaryScreenshot(page, result, directory, name, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(directory, name), animations: 'disabled' });
  result.screenshots.push(resolve(directory, name));
}

function selfTest() {
  const fixture = { ok: true, sessionId: 'ses_fixture', gameId: 'gm_fixture',
    previewUrl: `${STUDIO}/games/gm_fixture/index.html`,
    spec: { version: 2, engine: 'three', world: { city: {} },
      design: { sourcePrompt: '도시 운송', castIpIds: ['ip_hero'] }, mission: { stages: [{ type: 'drive' }] } } };
  const second = { ...structuredClone(fixture), sessionId: 'ses_second', gameId: 'gm_second',
    previewUrl: `${STUDIO}/games/gm_second/index.html` };
  assert.equal(expectedCases({ cases: [fixture, second] }).length, 2);
  assert.throws(() => expectedCases({ cases: [] }), /LIVE_GAMES_NOT_READY/);
  assert.throws(() => expectedCases({ cases: [{ ...fixture, ok: false }, second] }), /LIVE_GAMES_NOT_READY/);
  assert.throws(() => expectedCases({ cases: [{ ...fixture, previewUrl: 'https://foreign.invalid/game' }, second] }), /UNEXPECTED_GAME_ORIGIN/);
  assert.throws(() => expectedCases({ cases: [{ ...fixture, previewUrl: `${STUDIO}/games/gm_other/index.html` }, second] }), /UNEXPECTED_GAME_PATH/);
  assert.throws(() => expectedCases({ cases: [{ ...fixture, prompt: 'different request' }, second] }), /SAVED_REQUEST_MISMATCH/);
  assert.throws(() => expectedCases({ cases: [fixture, fixture] }), /DISTINCT_SESSIONS_REQUIRED/);
  assert.equal(redact('secret-password Bearer token', ['secret-password']), '[REDACTED] Bearer [REDACTED]');
  assert.ok(!redact('https://own.invalid/file?X-Amz-Signature=private').includes('private'));
  console.log(JSON.stringify({ status: 'SELF_TEST_PASS', checks: 9, browserLaunched: false, networkRequests: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = options(process.argv.slice(2));
    if (args.selfTest) selfTest();
    else await run(args);
  } catch (error) {
    // Early errors occur before credentials enter memory. Never print payloads.
    console.error(JSON.stringify({ status: 'PREFLIGHT_FAILED', reason: redact(error.message) }));
    process.exitCode = 1;
  }
}
