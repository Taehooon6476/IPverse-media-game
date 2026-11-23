import { describe, expect, it } from 'vitest';
import { JOB_TYPICAL, PROVIDER_LABEL, SHOT_TYPICAL, THREE_D_TOTAL, checkProblem, errorText, imageState, isCommandLine, jobWait, modelLabel,
  toolEventText, type Ip, type Job } from './types';

describe('round 9 M20: a failed trailer never shows its ffmpeg command line', () => {
  // a failed trailer: str(CalledProcessError), the Korean title inside drawtext
  const cmd = "Command '['/opt/bin/ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=2.5', '-vf', "
    + "\"drawtext=text='Starfall Vanguard':fontfile=/opt/fonts/NotoSansKR.ttf:fontsize=64, drawtext=text='은하의 새벽을 지켜라':fontsize=32\", "
    + "'-c:v', 'libx264', '/tmp/tmpf47kjrvt/card_title.mp4']' returned non-zero exit status 8.";

  it('drops the command line, Korean title and all', () => {
    expect(isCommandLine(cmd)).toBe(true);
    const shown = errorText(cmd);
    expect(shown).toBe('영상 처리 명령이 실패했어요');
    expect(shown).not.toMatch(/ffmpeg|drawtext|은하/);
  });

  it("keeps the server's new Korean reason as it is", () => {
    const said = '트레일러 렌더 실패: 제목 카드를 만들지 못했습니다 (ffmpeg 종료 코드 8)';
    expect(isCommandLine(said)).toBe(false);
    expect(errorText(said)).toBe(said);
  });
});

describe("round 9 M19: the chat's 작업 기록 reads as short Korean", () => {
  it('a validator failure is the label plus 실패; the English detail goes behind a disclosure', () => {
    const raw = '게임 생성 실패: GameSpec 검증 실패: world.entities[0].width must be a number 0.3-20; world.entities[1].width mus';
    expect(toolEventText(raw)).toEqual({ label: '게임 생성', failed: true, text: '게임 생성 실패',
      detail: 'GameSpec 검증 실패: world.entities[0].width must be a number 0.3-20; world.entities[1].width mus' });
    // API field names count as internal too
    expect(toolEventText('캐릭터 생성 실패: humanoid는 kind가 enemy일 때만 씁니다')).toMatchObject({ text: '캐릭터 생성 실패',
      detail: 'humanoid는 kind가 enemy일 때만 씁니다' });
  });

  it('a Korean-only reason stays inline', () => {
    expect(toolEventText('3D 렌더 등록 실패: 이미지가 아직 없습니다')).toEqual({ label: '3D 렌더 등록', failed: true,
      text: '3D 렌더 등록 실패: 이미지가 아직 없습니다' });
  });

  it('raw ids and raw tool names never show', () => {
    expect(toolEventText('3D 렌더 등록: job_d98959fdec').text).toBe('3D 렌더 등록');
    expect(toolEventText('게임 생성: gm_ae35bee6b0').text).toBe('게임 생성');
    expect(toolEventText('캐릭터 생성: 노바').text).toBe('캐릭터 생성: 노바');
    expect(toolEventText('트레일러 등록: Starfall Vanguard').text).toBe('트레일러 등록: Starfall Vanguard'); // a title the user named
    expect(toolEventText('stop_job 실패: not_found').text).toBe('도구 실행 실패');
  });
});

describe('modelLabel', () => {
  it('names the mediagen models and passes unknown ids through', () => {
    expect(['ltx', 'minimax-h3', 'kandinsky-6-0-video-pro', 'wan-animate'].map(modelLabel)).toEqual([
      'LTX-2.5',
      'MiniMax H3',
      'Kandinsky 6.0',
      'Wan 2.2 Animate',
    ]);
    expect(['krea', 'klein9', 'stability-ultra'].map(modelLabel)).toEqual([
      'Krea 2 Turbo',
      'FLUX.2 klein 9B',
      'Stable Image Ultra',
    ]);
    expect(modelLabel('new-model')).toBe('new-model');
    expect(modelLabel('')).toBeUndefined();
    expect(modelLabel('constructor')).toBe('constructor');
    expect(modelLabel(undefined)).toBeUndefined();
    expect(PROVIDER_LABEL.mediagen_video).toBe('영상 GPU'); // the model is the card's tooltip
  });
});

const job = (jobId: string, progress: string, extra: Partial<Job> = {}): Job => ({
  jobId, kind: 'shot', provider: 'mediagen_video', status: 'running', input: {}, outputs: [], deps: [], progress,
  createdAt: '2026-11-06T12:12:39Z', updatedAt: '2026-11-06T12:12:39Z', ...extra,
});

describe('a job that states its own wait (round 5 R6/N4)', () => {
  // server/providers/mediagen_video.py: every running line of a chained restyle ends with this
  const own = ' · 조각마다 ~6분, 전체 보통 ~14분';

  it("takes a chained restyle's estimate off its progress line, in place of the usual time of its kind", () => {
    expect(jobWait(job('job_a', `denoising (조각 0/2 완료)${own}`)))
      .toEqual({ progress: '영상 생성 중 (조각 0/2 완료)', usual: '조각마다 ~6분, 전체 보통 ~14분' });
    // (the model that draws the frames is not printed)
    expect(jobWait(job('job_b', `화풍 기준 프레임 그리는 중 (0/1, FLUX.2 klein)${own}`)))
      .toEqual({ progress: '화풍 기준 프레임 그리는 중 (0/1)', usual: '조각마다 ~6분, 전체 보통 ~14분' });
  });

  it('keeps the usual time of its kind for a job that states none', () => {
    expect(jobWait(job('job_c', 'denoising 40%'))).toEqual({ progress: '영상 생성 중 40%', usual: SHOT_TYPICAL.ltx });
    expect(jobWait(job('job_d', 'Hunyuan3D · 텍스처 생성 · 125초', { kind: 'mesh3d', provider: 'img3d' })))
      .toEqual({ progress: '3D 모델 만드는 중 · 125초', usual: '보통 2–8분' }); // the cards' words
    expect(jobWait(job('job_e', 'denoising · ?'))).toEqual({ progress: '영상 생성 중', usual: '보통 5–7분' }); // an LTX shot
    expect(jobWait(job('job_f', ''))).toEqual({ progress: '', usual: '보통 5–7분' });
  });

  it('keeps its own estimate through the lines between that state none (결과 저장 중)', () => {
    jobWait(job('job_g', `denoising (조각 1/2 완료)${own}`));
    expect(jobWait(job('job_g', '결과 저장 중'))).toEqual({ progress: '결과 저장 중', usual: '조각마다 ~6분, 전체 보통 ~14분' });
    expect(jobWait(job('job_h', '결과 저장 중')).usual).toBe('보통 5–7분'); // another job's estimate is its own
  });

  it('takes the estimate the job was queued with (input.etaMinutes) until a running line states its own', () => {
    // server/video_edit.py keeps edit_video_shot's etaMinutes in the job input: the first lines state no wait
    const queued = { input: { edit: 'restyle', etaMinutes: 14 } };
    expect(jobWait(job('job_i', '선행 작업 대기 중', queued))).toEqual({ progress: '앞 단계가 끝나길 기다리는 중', usual: '보통 ~14분' });
    expect(jobWait(job('job_i', `denoising (조각 0/2 완료)${own}`, queued)).usual).toBe('조각마다 ~6분, 전체 보통 ~14분');
    expect(jobWait(job('job_j', '제출 중', { input: { etaMinutes: 'soon' } })).usual).toBe('보통 5–7분'); // not a number
  });
});

describe("a shot's usual time is its model's (round 9, M15)", () => {
  // measured: Kandinsky about 26 min, LTX 5:34–5:53, H3 3:50–4:46
  const shot = (jobId: string, input: Record<string, unknown>) => jobWait(job(jobId, 'denoising step 12/20', { input })).usual;

  it('says ~25 min for Kandinsky, 5–7 for LTX, 4–5 for MiniMax H3, 1–5 for Wan', () => {
    expect(shot('m15_k', { model: 'kandinsky-6-0-video-pro' })).toBe('보통 22–27분');
    expect(shot('m15_l', { model: 'ltx' })).toBe('보통 5–7분');
    expect(shot('m15_h', { model: 'minimax-h3' })).toBe('보통 4–5분');
    expect(shot('m15_w', { model: 'wan-animate', edit: 'restyle' })).toBe('보통 1–5분');
  });

  it('gives an LTX edit its own figure and an unknown model the generic one', () => {
    expect(shot('m15_v', { model: 'ltx', edit: 'v2v', task: 'deblur' })).toBe('보통 6–10분');
    // a 5 s upscale runs in two pieces (about 17 min); with its etaMinutes the card says that instead
    expect(shot('m15_u', { model: 'ltx', edit: 'v2v', task: 'upscale' })).toBe('보통 15–20분');
    expect(shot('m15_ue', { model: 'ltx', edit: 'v2v', task: 'upscale', etaMinutes: 18 })).toBe('보통 ~18분');
    expect(shot('m15_n', { model: 'hunyuan-video-2' })).toBe(JOB_TYPICAL.shot);
    expect(shot('m15_c', { model: 'constructor' })).toBe(JOB_TYPICAL.shot);
  });
});

describe('a mesh waiting in the GPU queue (round 9 M8/M9)', () => {
  // server/providers/img3d.py _place: the line says its place and when it should start, next to 경과
  const mesh: Partial<Job> = { kind: 'mesh3d', provider: 'img3d' };

  it("shows the queue's wait in place of the usual time, and the place in the progress line", () => {
    expect(jobWait(job('job_q1', 'GPU 대기 중 · 대기열 3번째 · 시작까지 약 4분', mesh)))
      .toEqual({ progress: 'GPU 대기 중 · 대기열 3번째', usual: '시작까지 약 4분' });
    expect(jobWait(job('job_q2', 'GPU 인스턴스 시작 중 (부팅 ~1분, 모델 로딩 ~5분) · 대기열 2번째 · 시작까지 약 8분', mesh)))
      .toEqual({ progress: 'GPU 인스턴스 시작 중 (부팅 ~1분, 모델 로딩 ~5분) · 대기열 2번째', usual: '시작까지 약 8분' });
  });

  // the box's phase with its measured time (boot 26–44 s, model load ~5 min, a warm mesh 66–120 s)
  it("keeps the box's phase and its times in the line, and a mesh's usual time is the measured 2–8 min", () => {
    for (const line of ['GPU 인스턴스 시작 중 (부팅 ~1분, 모델 로딩 ~5분)', 'GPU 부팅 중 (~1분, 이어서 모델 로딩 ~5분)']) {
      expect(jobWait(job('job_b1', line, mesh))).toEqual({ progress: line, usual: '보통 2–8분' });
    }
    expect(jobWait(job('job_b2', 'GPU 모델 로딩 중 · 대기열 1번째 · 시작까지 약 6분', mesh)))
      .toEqual({ progress: 'AI 모델 불러오는 중 · 대기열 1번째', usual: '시작까지 약 6분' });
    expect(JOB_TYPICAL.mesh3d).toBe('보통 2–8분');
  });

  it('drops the wait once the mesh runs: the usual time of a mesh again, not a stale 시작까지', () => {
    jobWait(job('job_q3', 'GPU 대기 중 · 대기열 1번째 · 시작까지 약 1분', mesh));
    expect(jobWait(job('job_q3', 'Hunyuan3D · 3D 형상 생성 중 · 12초', mesh)))
      .toEqual({ progress: '3D 모델 만드는 중 · 12초', usual: JOB_TYPICAL.mesh3d });
  });
});

describe('a picture that failed its composition check (round 5 R10)', () => {
  // server/providers/mediagen_image.check_note: the done image job's error line
  const first = '구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림(2번 그려도 같음). 첫 그림이라 그대로 두었으니 다시 뽑아 주세요.';
  const kept = '구도 검사 실패: 피사체 2개, 오른쪽이 프레임에 잘림. 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.';

  it('reads what the check found off the line', () => {
    expect(checkProblem(first)).toBe('위쪽·아래쪽이 프레임에 잘림');
    expect(checkProblem(kept)).toBe('피사체 2개, 오른쪽이 프레임에 잘림');
    expect(checkProblem('구도 검사 실패')).toBe('');
    expect([checkProblem('GPU busy'), checkProblem(undefined)]).toEqual([null, null]);
  });

  it("is the IP's picture state while the job that drew the current picture says so (server/tools.py image_state)", () => {
    const umbrella: Ip = { ipId: 'ip_u', kind: 'prop', name: '빨간 종이우산', description: 'a red paper umbrella', version: 1,
      imageAssetId: 'ast_u1', cutoutAssetId: 'ast_u1c', imageJobId: 'job_u1', createdAt: '2026-11-06T01:56:49Z' };
    const drew = job('job_u1', '', { kind: 'image', provider: 'mediagen_image', status: 'done', error: first, outputs: ['ast_u1', 'ast_u1c'] });
    expect(imageState(umbrella, [drew])).toBe('check_failed');
    // a re-roll being drawn comes first; one that failed its check too leaves the cut picture current
    const reroll = job('job_u2', '', { kind: 'image', provider: 'mediagen_image', status: 'running' });
    expect(imageState({ ...umbrella, imageJobId: 'job_u2' }, [drew, reroll])).toBe('updating');
    const failedToo = { ...reroll, status: 'done' as const, error: kept, outputs: ['ast_u2', 'ast_u2c'] };
    expect(imageState({ ...umbrella, imageJobId: 'job_u2' }, [drew, failedToo])).toBe('check_failed');
    // replaced by a picture that passed (a re-roll, an edit or a restored version)
    const passed = { ...failedToo, error: undefined };
    expect(imageState({ ...umbrella, imageJobId: 'job_u2', imageAssetId: 'ast_u2', cutoutAssetId: 'ast_u2c' }, [drew, passed])).toBeUndefined();
  });
});

describe("a failed job's error line as people read it (round 6 N13)", () => {
  // Bedrock's background removal answered 503 on all three saves (server/jobs.py _collect_retry)
  const lantern = '결과 저장을 반복 실패했습니다: An error occurred (ServiceUnavailableException) when calling the InvokeModel '
    + 'operation (reached max retries: 2): Bedrock is unable to process your request.';

  it('keeps the Korean part and drops the raw exception after it', () => {
    expect(errorText(lantern)).toBe('결과 저장을 반복 실패했습니다');
    expect(errorText('상태 확인을 반복 실패했습니다: <urlopen error [Errno 61] Connection refused>')).toBe('상태 확인을 반복 실패했습니다');
    expect(errorText('Hunyuan3D 실패: CUDA out of memory')).toBe('3D 모델을 만들지 못했어요'); // the step in plain words, not its tool's name
  });

  it('says a short Korean sentence for an error with no Korean in it', () => {
    for (const raw of ['An error occurred (ValidationException) when calling the InvokeModel operation: Malformed input request',
      "'model'", "start_image: {'status': 'FAILED'}", 'ffmpeg did not report a duration', 'lifecycleStatus: FAILED']) {
      expect(errorText(raw)).toBe('알 수 없는 오류가 났어요');
    }
  });

  it("leaves the server's Korean lines as they are, codes in brackets included", () => {
    for (const said of ['선행 작업 실패', '사용자가 중지함', '작업 처리가 중단되었습니다 (시간 초과)', '이미지 생성 실패: 원인 미상',
      '구도 검사 실패: 오른쪽이 프레임에 잘림(2번 그려도 같음). 첫 그림이라 그대로 두었으니 다시 뽑아 주세요.',
      'GPU 용량 부족: 지금 AWS에 남는 GPU가 없어 LTX-2.5 서버를 켜지 못했습니다. 잠시 뒤 다시 시도해 주세요. (InsufficientInstanceCapacity)',
      // a Korean line with the code at the end stays whole
      '결과 저장을 반복 실패했습니다: 배경 제거(Bedrock)가 잠시 응답하지 않습니다 (ServiceUnavailableException)']) {
      expect(errorText(said)).toBe(said);
    }
    expect([errorText(undefined), errorText('  ')]).toEqual(['', '']);
  });
});

describe('round 12 item 4: one 3D wait for the cards and the agent', () => {
  it('the whole 3D chain is its steps\' cards added up, as server/waits.py TOTAL says it', () => {
    expect(THREE_D_TOTAL).toBe('9–21분'); // 1–2 + 2–8 + 2–4 + 4–7
    expect(JOB_TYPICAL.mesh3d).toBe('보통 2–8분');
  });
  it('a turntable line says its phase in the cards\' words, never Deadline\'s raw status', () => {
    const j = { jobId: 'job_t', kind: 'render3d', status: 'running', progress: 'Blender 렌더 대기열 대기 중 · 1분 15초',
      input: {}, outputs: [], createdAt: '', updatedAt: '' } as unknown as Job;
    expect(jobWait(j)).toEqual({ progress: '렌더 서버 순서 기다리는 중 · 1분 15초', usual: '보통 4–7분' });
  });
});
