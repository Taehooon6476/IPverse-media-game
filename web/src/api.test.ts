/// <reference types="node" />
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as auth from './auth';
import { ApiError, AuthError, diffJobs, errorMessage, getSession, listSessions, liveStart, login, pollInterval, pollStream, sendChat, signup, startStream, stopStream } from './api';
import { JOB_KIND_LABEL, type GameDesignRequest, type Ip, type Job, type Snapshot } from './types';

function job(jobId: string, status: Job['status'], extra: Partial<Job> = {}): Job {
  return {
    jobId, kind: 'render3d', provider: 'deadline', status, input: {}, outputs: [], deps: [], progress: '',
    createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', ...extra,
  };
}

describe('diffJobs', () => {
  test('emits one ok event for queued→done', () => {
    expect(diffJobs([job('a', 'queued')], [job('a', 'done')])).toEqual([{ level: 'ok', text: `${JOB_KIND_LABEL.render3d} 완료`, open: '3d' }]);
  });

  test('emits one error event for running→failed', () => {
    const prev = [job('a', 'running', { kind: 'shot' })];
    const next = [job('a', 'failed', { kind: 'shot', error: '시간 초과' })];
    expect(diffJobs(prev, next)).toEqual([{ level: 'error', text: `${JOB_KIND_LABEL.shot} 실패: 시간 초과`, open: 'pipeline' }]); // 작업 현황 has 다시 시도
  });

  // A whole-scene background's one render makes its panel, which the card and 작업 현황 call 입체 판 (types.ts jobLabel).
  test('names a background\'s panel as its card and 작업 현황 do: 입체 판', () => {
    const glade: Ip = { ipId: 'ip_glade', kind: 'prop', usage: 'background', name: '별빛 숲 공터', description: '', version: 1, createdAt: '' };
    const panel = (s: Job['status'], extra: Partial<Job> = {}) => job('p', s, { kind: 'render3d', provider: 'deadline', input: { ipId: 'ip_glade', model: 'relief' }, ...extra });
    expect(diffJobs([panel('running')], [panel('done')], null, [glade])).toEqual([{ level: 'ok', text: '별빛 숲 공터 입체 판 완료', open: '3d' }]);
    expect(diffJobs([panel('running')], [panel('failed', { error: '렌더 서버에서 작업이 실패했습니다: FAILED' })], null, [glade]))
      .toEqual([{ level: 'error', text: '별빛 숲 공터 입체 판 실패: 렌더 서버에서 작업이 실패했습니다', open: 'pipeline' }]);
  });

  test('offers a game rebuild when a 3D result the game uses lands and a game exists', () => {
    const rig = (s: Job['status']) => job('r', s, { kind: 'rig', input: { ipId: 'ip_1' } });
    const mesh = (s: Job['status']) => job('m', s, { kind: 'mesh3d', input: { ipId: 'ip_1' } });
    const [toast] = diffJobs([rig('running')], [rig('done')], true);
    expect(toast.action?.label).toBe('게임에 반영');
    // a request that was held is a game that does not exist yet: 게임 만들기
    expect(diffJobs([rig('running')], [rig('done')], 'held')[0]).toEqual({ level: 'ok', text: '주인공 3D가 준비됐어요. 요청해 둔 게임을 만들까요?',
      action: { id: 'rebuild-game', label: '게임 만들기' } });
    expect(diffJobs([rig('running')], [rig('done')], 'remake')[0].action?.label).toBe('게임에 반영');
    expect(diffJobs([rig('running')], [rig('done')], false)[0].action).toBeUndefined(); // no game yet
    // the mesh of a rigged IP is not what the game shows; the rig toast is the one that offers it
    expect(diffJobs([mesh('running'), rig('queued')], [mesh('done'), rig('queued')], true)[0].action).toBeUndefined();
  });

  test('toasts a picture that failed its composition check as a check failure, not 이미지 완료 (round 5 R10)', () => {
    // server/providers/mediagen_image.check_note: the done image job's error line
    const image = (jobId: string, status: Job['status'], extra: Partial<Job> = {}) =>
      job(jobId, status, { kind: 'image', provider: 'mediagen_image', input: { ipId: 'ip_u', version: 1 }, ...extra });
    const umbrella: Ip = { ipId: 'ip_u', kind: 'prop', name: '빨간 종이우산', description: 'a red paper umbrella', version: 1,
      imageAssetId: 'ast_u1', cutoutAssetId: 'ast_u1c', imageJobId: 'job_u1', createdAt: '2026-11-06T01:56:49Z' };
    const first = '구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림(2번 그려도 같음). 첫 그림이라 그대로 두었으니 다시 뽑아 주세요.';
    // a first picture is kept as the IP's picture
    expect(diffJobs([image('job_u1', 'running')], [image('job_u1', 'done', { error: first, outputs: ['ast_u1', 'ast_u1c'] })], false, [umbrella]))
      .toEqual([{ level: 'warn', text: '빨간 종이우산 이미지 구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림. 다시 뽑아 보세요.', open: 'props' }]);
    // a new version that failed is kept as a version only: the IP keeps the picture it has
    const kept = '구도 검사 실패: 오른쪽이 프레임에 잘림(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.';
    const katana: Ip = { ...umbrella, ipId: 'ip_k', kind: 'weapon', name: '플라즈마 카타나 II', imageAssetId: 'ast_k1', imageJobId: 'job_k2' };
    expect(diffJobs([image('job_k2', 'running', { input: { ipId: 'ip_k', version: 2 } })],
      [image('job_k2', 'done', { input: { ipId: 'ip_k', version: 2 }, error: kept, outputs: ['ast_k2', 'ast_k2c'] })], false, [umbrella, katana]))
      .toEqual([{ level: 'warn', text: '플라즈마 카타나 II 새 이미지 구도 검사 실패: 오른쪽이 프레임에 잘림. 지금 그림을 그대로 써요.', open: 'props' }]);
    // a picture that passed is still 이미지 완료, with its IP's name and the tab its card is on
    expect(diffJobs([image('job_u1', 'running')], [image('job_u1', 'done', { outputs: ['ast_u1', 'ast_u1c'] })], false, [umbrella]))
      .toEqual([{ level: 'ok', text: '빨간 종이우산 이미지 완료', open: 'props' }]);
  });

  test('toasts a failed job in Korean, never with the raw exception the server passed through (round 6 N13)', () => {
    // the background removal's 503, three saves in a row (server/jobs.py _collect_retry)
    const error = '결과 저장을 반복 실패했습니다: An error occurred (ServiceUnavailableException) when calling the InvokeModel '
      + 'operation (reached max retries: 2): Bedrock is unable to process your request.';
    const image = (status: Job['status'], extra: Partial<Job> = {}) => job('job_l', status, { kind: 'image', provider: 'mediagen_image', ...extra });
    expect(diffJobs([image('running')], [image('failed', { error })])).toEqual([{ level: 'error', text: '이미지 실패: 결과 저장을 반복 실패했습니다', open: 'pipeline' }]);
    expect(diffJobs([image('running')], [image('failed', { error: 'KeyError' })])).toEqual([{ level: 'error', text: '이미지 실패: 알 수 없는 오류가 났어요', open: 'pipeline' }]);
  });

  // A toast names the IP it worked on and opens the tab where the result shows.
  test('a finished job names what it worked on and carries the tab where its result shows', () => {
    const wizard: Ip = { ipId: 'ip_w', kind: 'character', name: '꼬마 마법사', description: '', version: 1, createdAt: '' };
    const wolf: Ip = { ...wizard, ipId: 'ip_e', kind: 'enemy', name: '그림자 늑대' };
    const lantern: Ip = { ...wizard, ipId: 'ip_l', kind: 'prop', name: '등불' };
    const of = (jobId: string, kind: Job['kind'], input: Job['input'], status: Job['status']) => job(jobId, status, { kind, input });
    const all = (status: Job['status']) => [of('i1', 'image', { ipId: 'ip_w' }, status), of('i2', 'image', { ipId: 'ip_e' }, status),
      of('i3', 'image', { ipId: 'ip_l' }, status), of('p', 'apose', { ipId: 'ip_w' }, status), of('m', 'mesh3d', { ipId: 'ip_w' }, status),
      of('s', 'shot', { ipId: 'ip_e' }, status), of('s2', 'shot', { sourceIpId: 'ip_e', edit: 'v2v' }, status),
      of('t', 'trailer', { title: '등불의 숲' }, status), of('a', 'image', {}, status)];
    const k = JOB_KIND_LABEL;
    expect(diffJobs(all('running'), all('done'), null, [wizard, wolf, lantern])).toEqual([
      { level: 'ok', text: '꼬마 마법사 이미지 완료', open: 'characters' },
      { level: 'ok', text: '그림자 늑대 이미지 완료', open: 'characters' }, // an enemy's card is on the 캐릭터 tab
      { level: 'ok', text: '등불 이미지 완료', open: 'props' },
      { level: 'ok', text: `꼬마 마법사 ${k.apose} 완료`, open: '3d' },
      { level: 'ok', text: `꼬마 마법사 ${k.mesh3d} 완료`, open: '3d' },
      { level: 'ok', text: `그림자 늑대 ${k.shot} 완료`, open: 'video' },
      { level: 'ok', text: `그림자 늑대 ${k.shot} 완료`, open: 'video' }, // an edit of her shot
      { level: 'ok', text: `등불의 숲 ${k.trailer} 완료`, open: 'video' },
      { level: 'ok', text: '이미지 완료' }, // a still of no IP on the page: nothing to name, nowhere to send
    ]);
    expect(diffJobs(all('running'), all('failed').map((j) => ({ ...j, error: '시간 초과' })), null, [wizard, wolf, lantern])[7])
      .toEqual({ level: 'error', text: `등불의 숲 ${k.trailer} 실패: 시간 초과`, open: 'pipeline' });
  });

  // An edit that ended done with "수정 검사 실패: …" must not toast "이미지 완료".
  test('a done job that was no plain success is never the green 완료', () => {
    const wizard: Ip = { ipId: 'ip_w', kind: 'character', name: '꼬마 마법사', description: '', version: 1, imageAssetId: 'ast_v1', createdAt: '' };
    const note = '수정 검사 실패: 배경이 숲에서 단색으로 바뀜(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.';
    const edit = (status: Job['status'], extra: Partial<Job> = {}) => job('job_e', status, { kind: 'image', provider: 'mediagen_image',
      input: { ipId: 'ip_w', version: 2, edit: 'add a red scarf' }, ...extra });
    const kept = [{ level: 'warn', text: '꼬마 마법사 수정본(v2)이 검사를 통과하지 못해 적용하지 않았어요: 배경이 숲에서 단색으로 바뀜. 지금 그림을 그대로 써요.', open: 'characters' }];
    // an older record: the check's line on a done job, and outputs the IP does not use
    expect(diffJobs([edit('running')], [edit('done', { error: note, outputs: ['ast_v2', 'ast_v2c'] })], null, [wizard])).toEqual(kept);
    // as the server marks it now (server/jobs.py outcome)
    expect(diffJobs([edit('running')], [{ ...edit('done', { error: note, outputs: ['ast_v2', 'ast_v2c'] }), outcome: 'rejected' } as Job], null, [wizard])).toEqual(kept);
    // a result that is in use although its check failed: a shot's upscale the GPU drew again, replaced by the source enlarged
    const stood = '원본 보존 검사 실패: GPU가 만든 결과가 원본 그림과 달라(화면 평균 차이 12.3, 기준 8.0) 원본을 그대로 2배로 키운 영상으로 대신했습니다.';
    const upscale = (status: Job['status'], extra: object = {}) => job('job_u', status, { kind: 'shot', provider: 'mediagen_video', input: { sourceIpId: 'ip_w' }, ...extra });
    const [toast] = diffJobs([upscale('running')], [upscale('done', { error: stood, outcome: 'check_failed' })], 'remake', [wizard]);
    expect(toast).toEqual({ level: 'warn', text: `꼬마 마법사 ${JOB_KIND_LABEL.shot}: ${stood}`, open: 'video' });
    // an outcome with no line to read still says something, and where to look
    expect(diffJobs([upscale('running')], [upscale('done', { outcome: 'check_failed' })], null, [wizard])[0])
      .toEqual({ level: 'warn', text: `꼬마 마법사 ${JOB_KIND_LABEL.shot}: 결과가 요청한 대로 나오지 않았어요. 작업 현황에서 확인해 주세요.`, open: 'video' });
    // a rig whose result a check kept out offers no game
    const rig = (status: Job['status'], extra: object = {}) => job('job_r', status, { kind: 'rig', input: { ipId: 'ip_w' }, ...extra });
    expect(diffJobs([rig('running')], [rig('done', { outcome: 'rejected', error: '뼈대 검사 실패: 팔이 몸에 붙음' })], 'held', [wizard])[0].action).toBeUndefined();
  });

  test('emits nothing for unchanged jobs', () => {
    const jobs = [job('a', 'running'), job('b', 'done'), job('c', 'failed')];
    expect(diffJobs(jobs, jobs.map((j) => ({ ...j })))).toEqual([]);
  });
});

test('pollInterval is 3 s while a turn or job is in flight, else 10 s', () => {
  const snap = (messages: unknown[], jobs: Job[]) => ({ messages, jobs }) as unknown as Snapshot;
  expect(pollInterval(snap([{ status: 'pending' }], []))).toBe(3000);
  expect(pollInterval(snap([], [job('a', 'queued')]))).toBe(3000);
  expect(pollInterval(snap([], [job('a', 'running')]))).toBe(3000);
  expect(pollInterval(snap([{ status: 'done' }], [job('a', 'done'), job('b', 'failed')]))).toBe(10000);
});


const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Fake network: /config.json, Cognito (answers from `cognito` in order), and the API. */
function stubNetwork(cognito: object[], api: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/config.json') return json({ region: 'us-east-1', userPoolId: 'us-east-1_x', clientId: 'client123' });
    if (url.startsWith('https://cognito-idp.')) return json({ AuthenticationResult: cognito.shift() });
    return api();
  }));
  const cognitoBodies = () => calls.filter((c) => c.url.startsWith('https://cognito-idp.')).map((c) => JSON.parse(String(c.init.body)));
  const apiHeaders = () => calls.filter((c) => c.url.startsWith('/api/')).map((c) => c.init.headers as Record<string, string>);
  return { calls, cognitoBodies, apiHeaders };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

test('login sends USER_PASSWORD_AUTH to Cognito and stores the access token', async () => {
  const net = stubNetwork([{ AccessToken: 'tok-1', RefreshToken: 'ref-1', ExpiresIn: 3600 }], () => json({}));
  await login('demo', 'pw');
  const cognito = net.calls.find((c) => c.url.startsWith('https://cognito-idp.'))!;
  expect(cognito.url).toBe('https://cognito-idp.us-east-1.amazonaws.com/');
  expect(cognito.init.headers).toMatchObject({
    'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    'Content-Type': 'application/x-amz-json-1.1',
  });
  expect(net.cognitoBodies()).toEqual([
    { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'client123', AuthParameters: { USERNAME: 'demo', PASSWORD: 'pw' } },
  ]);
  expect(auth.token()).toBe('tok-1');
});

test('api 401 clears token and surfaces relogin', async () => {
  const net = stubNetwork([{ AccessToken: 'tok-1', RefreshToken: 'ref-1', ExpiresIn: 3600 }], () => json({ error: 'unauthorized' }, 401));
  await login('demo', 'pw');
  await expect(getSession('ses_1')).rejects.toBeInstanceOf(AuthError);
  expect(net.apiHeaders()[0]['X-Auth-Token']).toBe('tok-1');
  expect(auth.token()).toBeNull();
});

test("a refused start keeps the server's code beside its sentence, and a takeover is sent only as asked (C-02)", async () => {
  const net = stubNetwork([{ AccessToken: 'tok-1', ExpiresIn: 3600 }], () => json({ error: 'live_other_session', message: '내 다른 세션에서 방송 중이에요. 그 방송을 먼저 꺼 주세요.' }, 409));
  await login('demo', 'pw');
  const refused = await liveStart('ses_1', { gameId: 'gm_1', everyRounds: 2 }).catch((e: unknown) => e);
  expect(refused).toMatchObject({ name: 'ApiError', status: 409, code: 'live_other_session', message: '내 다른 세션에서 방송 중이에요. 그 방송을 먼저 꺼 주세요.' });
  await liveStart('ses_1', { gameId: 'gm_1', everyRounds: 2, takeover: true }).catch(() => undefined);
  const bodies = net.calls.filter((c) => c.url.startsWith('/api/')).map((c) => JSON.parse(String(c.init.body)));
  expect(bodies[0]).not.toHaveProperty('takeover');
  expect(bodies[1]).toMatchObject({ takeover: true });
});

test('an access token about to expire is refreshed with REFRESH_TOKEN_AUTH before the call', async () => {
  const net = stubNetwork(
    [{ AccessToken: 'tok-1', RefreshToken: 'ref-1', ExpiresIn: 30 }, { AccessToken: 'tok-2', ExpiresIn: 3600 }],
    () => json({ sessions: [] }),
  );
  await login('demo', 'pw');
  await expect(listSessions()).resolves.toEqual({ sessions: [] });
  expect(net.cognitoBodies()[1]).toEqual({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: 'client123', AuthParameters: { REFRESH_TOKEN: 'ref-1' } });
  expect(net.apiHeaders()[0]['X-Auth-Token']).toBe('tok-2');
  expect(auth.token()).toBe('tok-2');
});

test('body requests carry x-amz-content-sha256 of the exact UTF-8 body; GET sends none', async () => {
  const net = stubNetwork([{ AccessToken: 'tok-1', RefreshToken: 'ref-1', ExpiresIn: 3600 }], () => json({ messageId: 'msg_1' }, 202));
  const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  await login('demo', 'pw');
  await sendChat('ses_1', 'hi');
  await sendChat('ses_1', '루나 3D로 만들어줘'); // non-ASCII: the hash must cover UTF-8 bytes
  await listSessions();
  const api = net.calls.filter((c) => c.url.startsWith('/api/'));
  const headers = net.apiHeaders();
  expect(api[0].init.body).toBe('{"text":"hi"}');
  expect(headers[0]['x-amz-content-sha256']).toBe(sha256('{"text":"hi"}'));
  expect(headers[1]['x-amz-content-sha256']).toBe(sha256(String(api[1].init.body)));
  expect(api[2].init.body).toBeUndefined();
  expect(headers[2]).not.toHaveProperty('x-amz-content-sha256');
});

test('a game design sends the complete prompt and exact chosen IP roles in the signed chat request', async () => {
  const net = stubNetwork([{ AccessToken: 'tok-1', ExpiresIn: 3600 }], () => json({ messageId: 'msg_design' }, 202));
  const gameDesign: GameDesignRequest = {
    prompt: '[게임 설계] 루나가 코어를 모아 통신탑을 복구하고 탈출한다.\n클리어 조건: 코어 3개와 출구 도달',
    castIpIds: ['ip_luna', 'ip_core', 'ip_npc'],
    playerIpId: 'ip_luna',
    weaponIpId: null,
    propIpIds: ['ip_core'],
    enemyIpIds: [],
    npcIpIds: ['ip_npc'],
  };
  await login('demo', 'pw');
  await sendChat('ses_design', gameDesign.prompt, gameDesign);
  const call = net.calls.find((c) => c.url === '/api/sessions/ses_design/chat')!;
  expect(JSON.parse(String(call.init.body))).toEqual({ text: gameDesign.prompt, gameDesign });
  expect((call.init.headers as Record<string, string>)['x-amz-content-sha256'])
    .toBe(createHash('sha256').update(String(call.init.body), 'utf8').digest('hex'));
});

test('stream wrappers hit /stream routes; DELETE goes out with keepalive', async () => {
  const net = stubNetwork([{ AccessToken: 'tok-1', RefreshToken: 'ref-1', ExpiresIn: 3600 }], () =>
    json({ streamId: 'ses-1', status: 'ACTIVATING' }, 202));
  await login('demo', 'pw');
  await startStream('ses_1', 'offer', 'gm_1');
  await pollStream('ses_1', 'ses-1');
  await stopStream('ses_1', 'ses-1');
  const api = net.calls.filter((c) => c.url.startsWith('/api/'));
  expect(api.map((c) => [c.init.method, c.url])).toEqual([
    ['POST', '/api/sessions/ses_1/stream'],
    ['GET', '/api/sessions/ses_1/stream/ses-1'],
    ['DELETE', '/api/sessions/ses_1/stream/ses-1'],
  ]);
  expect(JSON.parse(String(api[0].init.body))).toEqual({ signalRequest: 'offer', gameId: 'gm_1' });
  expect(api.map((c) => c.init.keepalive)).toEqual([false, false, true]);
});

// Toasts must not print class names, bare error codes, "요청에 실패했습니다 (500)." or Cognito's English text.
describe('errors read as sentences (R20-43)', () => {
  test('an error turned into a string is its sentence, never its class name', () => {
    expect(String(new ApiError(404, '세션을 찾을 수 없습니다'))).toBe('세션을 찾을 수 없습니다');
    expect(`${new AuthError()}`).toBe('로그인 시간이 지났어요. 다시 로그인하면 하던 작업으로 돌아가요.');
  });

  test('says what the server said when it said a sentence, else what to do, with the status', async () => {
    let answer: Response = json({ error: 'not_found', message: '세션을 찾을 수 없습니다' }, 404);
    stubNetwork([{ AccessToken: 'tok-1', ExpiresIn: 3600 }], () => answer);
    await login('demo', 'pw');
    await expect(getSession('ses_1')).rejects.toMatchObject({ status: 404, message: '세션을 찾을 수 없습니다' });
    answer = json({ error: 'not_found', message: '' }, 404); // a code alone is not shown
    await expect(getSession('ses_1')).rejects.toMatchObject({ message: '요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요. (오류 404)' });
    answer = new Response('<html>502 Bad Gateway</html>', { status: 502 }); // no JSON at all
    await expect(getSession('ses_1')).rejects.toMatchObject({ status: 502, message: '요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요. (오류 502)' });
    await expect(signup('luna', 'x')).rejects.toMatchObject({ message: '가입하지 못했어요. 잠시 뒤 다시 시도해 주세요. (오류 502)' });
  });

  test('no answer at all (offline) is said in words, for the API and for the login', async () => {
    const offline = '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.';
    stubNetwork([{ AccessToken: 'tok-1', ExpiresIn: 3600 }], () => { throw new TypeError('Failed to fetch'); });
    await login('demo', 'pw');
    await expect(listSessions()).rejects.toMatchObject({ status: 0, message: offline });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/config.json') return json({ region: 'us-east-1', userPoolId: 'p', clientId: 'c' });
      throw new TypeError('Failed to fetch');
    }));
    await expect(login('demo', 'pw')).rejects.toThrow(offline);
    await expect(auth.demoLogin()).rejects.toThrow(offline);
  });

  test('a refused login is told in Korean, without Cognito’s own text', async () => {
    const cognito = (type: string, status = 400) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/config.json'
      ? json({ region: 'us-east-1', userPoolId: 'p', clientId: 'c' })
      : json({ __type: type, message: 'Incorrect username or password.' }, status))));
    cognito('NotAuthorizedException');
    await expect(login('demo', 'bad')).rejects.toThrow('아이디 또는 비밀번호가 맞지 않아요.');
    cognito('com.amazonaws.cognito#TooManyRequestsException');
    await expect(login('demo', 'bad')).rejects.toThrow('로그인 시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.');
    cognito('InternalErrorException', 500);
    await expect(login('demo', 'bad')).rejects.toThrow('로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요. (오류 500)');
  });

  test('errorMessage keeps our sentences and replaces anything else', () => {
    expect(errorMessage(new ApiError(409, '진행 중인 작업이 있어 지울 수 없어요.'))).toBe('진행 중인 작업이 있어 지울 수 없어요.');
    expect(errorMessage(new Error('데모 계정으로 들어가지 못했어요.'))).toBe('데모 계정으로 들어가지 못했어요.');
    expect(errorMessage(new TypeError("Cannot read properties of undefined (reading 'jobs')"))).toBe('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
    expect(errorMessage('boom')).toBe('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
  });
});

test('who is signed in is kept with the tokens: the id typed at the login, or the shared demo account (R20-40)', async () => {
  stubNetwork([{ AccessToken: 'tok-1', RefreshToken: 'ref-1', ExpiresIn: 30 }, { AccessToken: 'tok-2', ExpiresIn: 3600 }], () => json({ sessions: [] }));
  expect(auth.account()).toBeNull();
  await login('luna_studio', 'pw');
  expect(auth.account()).toEqual({ user: 'luna_studio', demo: false });
  await listSessions(); // the token is renewed (it had 30 s left): who it is stays
  expect([auth.token(), auth.account()]).toEqual(['tok-2', { user: 'luna_studio', demo: false }]);
  vi.stubGlobal('fetch', vi.fn(async () => json({ AccessToken: 'demo-tok', RefreshToken: 'r', ExpiresIn: 3600 })));
  await auth.demoLogin();
  expect(auth.account()).toEqual({ user: null, demo: true });
});
