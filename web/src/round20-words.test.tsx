import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_KIND_DOING, JOB_KIND_LABEL, JOB_KIND_TERM, PROVIDER_LABEL, errorText, failedCheck, gameThreeD, jobLabel, jobTerm, jobWait, josa, plainLine,
  providerDetail, providerLabel,
  type Asset, type Ip, type Job, type Snapshot } from './types';

// Studio jargon (A-포즈, 메시, 리깅, 렌더, model and tool names, 누끼) gets a plain Korean word on cards and toasts;
// the studio's own word is a tooltip at most. The server says the same words: 3D용 자세 그림 / 3D 모델 / 움직임 뼈대 /
// 3D 회전 영상; 누끼 → 배경 제거; 숏츠 → 쇼츠.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

// ("렌더 서버" is the entry's own plain name for the farm: the word alone is not on this list)
const STUDIO_WORDS = /A-포즈|메시|리깅|3D 렌더|렌더 중|턴테이블|Hunyuan|Deadline|Blender|mediagen|ffmpeg|klein|PBR|GLB|노드|누끼|컷아웃/;
const at = '2026-11-16T03:12:00Z';
const job = (jobId: string, kind: Job['kind'], provider: Job['provider'], extra: Partial<Job> = {}): Job => ({ jobId, kind, provider,
  status: 'running', input: { ipId: 'ip_lantern' }, outputs: [], deps: [], progress: '', createdAt: at, updatedAt: at, ...extra });

describe('R20-21 a job kind and where it runs, in plain words', () => {
  it("names the four 3D steps in the lead's words, the studio's own word a tooltip at most", () => {
    expect(JOB_KIND_LABEL).toEqual({ image: '이미지', apose: '3D용 자세 그림', mesh3d: '3D 모델', rig: '움직임 뼈대',
      render3d: '3D 회전 영상', shot: '영상 샷', trailer: '트레일러' });
    for (const label of Object.values(JOB_KIND_LABEL)) expect(label).not.toMatch(STUDIO_WORDS);
    expect(JOB_KIND_TERM).toEqual({ apose: 'A-포즈', mesh3d: '3D 메시', rig: '리깅', render3d: '턴테이블' });
    expect(JOB_KIND_DOING).toEqual({ apose: '3D용 자세 그림 그리는 중', mesh3d: '3D 모델 만드는 중', rig: '움직임 뼈대 넣는 중',
      render3d: '3D 회전 영상 만드는 중' });
  });

  it("calls a whole-scene background's one step by what it makes (round20-verify R20-15)", () => {
    const relief = job('j_relief', 'render3d', 'deadline', { input: { ipId: 'ip_bg', model: 'relief' } });
    const turn = job('j_turn', 'render3d', 'deadline', { input: { ipId: 'ip_x', model: 'hunyuan3d' } });
    expect([jobLabel(relief), jobTerm(relief)]).toEqual(['입체 판', undefined]);
    expect([jobLabel(turn), jobTerm(turn)]).toEqual(['3D 회전 영상', '턴테이블']);
    expect(jobLabel(job('j_img', 'image', 'mediagen_image'))).toBe('이미지');
  });

  it('says where a job runs without a service, tool or model name; those are the tooltip', () => {
    expect(PROVIDER_LABEL).toEqual({ mediagen_image: '이미지 GPU', apose: '이미지 GPU', img3d: '3D GPU', rig: '렌더 서버',
      deadline: '렌더 서버', mediagen_video: '영상 GPU', bedrock_video: '영상 서비스', ffmpeg: '영상 편집' });
    const edit = job('j_e', 'image', 'mediagen_image', { input: { model: 'qwen-image-2-1-7b', modelLabel: 'Qwen-Image-2.1 (7B)' } });
    expect([providerLabel(edit), providerDetail(edit)]).toEqual(['이미지 GPU', 'Qwen-Image-2.1 (7B)']);
    const shot = job('j_s', 'shot', 'mediagen_video', { input: { model: 'ltx' } });
    expect([providerLabel(shot), providerDetail(shot)]).toEqual(['영상 GPU', 'LTX-2.5']);
    expect([providerLabel(job('j_m', 'mesh3d', 'img3d')), providerDetail(job('j_m', 'mesh3d', 'img3d'))]).toEqual(['3D GPU', 'Hunyuan3D']);
    expect(providerDetail(job('j_r', 'rig', 'rig'))).toBe('Deadline Cloud · Blender 리깅');
    expect([providerLabel(job('j_t', 'trailer', 'ffmpeg')), providerDetail(job('j_t', 'trailer', 'ffmpeg'))]).toEqual(['영상 편집', 'ffmpeg']);
    expect(providerDetail(job('j_i', 'image', 'mediagen_image', { input: {} }))).toBeUndefined(); // no model known: no tooltip
  });
});

describe('R20-21 a 3D job says what it is doing in plain words', () => {
  // the lines server/providers/{apose,img3d,deadline,rig}.py and server/jobs.py write
  const lines: [string, string][] = [
    ['A-포즈로 다시 그리는 중 (klein)', '3D용 자세 그림 그리는 중'],
    ['Hunyuan3D · 입력 받는 중 · 3초', '그림 받는 중 · 3초'],
    ['Hunyuan3D · 모델 로딩 중 · 120초', 'AI 모델 불러오는 중 · 120초'],
    ['Hunyuan3D · 3D 형상 생성 중 · 12초', '3D 모델 만드는 중 · 12초'],
    ['Hunyuan3D · PBR 텍스처 생성 중 · 85초', '3D 모델 만드는 중 · 85초'],
    ['Hunyuan3D · GLB 저장 중 · 96초', '3D 모델 만드는 중 · 96초'],
    ['Hunyuan3D · 업로드 중 · 99초', '결과 올리는 중 · 99초'],
    ['GPU 모델 로딩 중 · 대기열 1번째', 'AI 모델 불러오는 중 · 대기열 1번째'],
    ['Blender 렌더 대기열 대기 중 · 1분 15초', '렌더 서버 순서 기다리는 중 · 1분 15초'],
    ['Blender 렌더 노드 배정 대기 중 · 20초', '렌더 서버 배정 기다리는 중 · 20초'],
    ['Blender 렌더 노드 시작 중 · 40초', '렌더 서버 켜는 중 · 40초'],
    ['Blender 턴테이블 렌더 중 · 5분 16초', '3D 회전 영상 만드는 중 · 5분 16초'],
    ['리깅 대기열 대기 중 · 10초', '렌더 서버 순서 기다리는 중 · 10초'],
    ['리깅 노드 배정 대기 중 · 30초', '렌더 서버 배정 기다리는 중 · 30초'],
    ['리깅 노드 배정됨 · 35초', '렌더 서버 배정됨 · 35초'],
    ['리깅 노드 시작 중 · 50초', '렌더 서버 켜는 중 · 50초'],
    ['Blender 리깅 중 (뼈대 맞춤·스키닝) · 2분 3초', '움직임 뼈대 넣는 중 · 2분 3초'],
    ['선행 작업 대기 중', '앞 단계가 끝나길 기다리는 중'],
  ];

  it.each(lines)('%s → %s', (raw, plain) => {
    expect(plainLine(raw)).toBe(plain);
    expect(plain).not.toMatch(STUDIO_WORDS);
    expect(jobWait(job('j_x', 'mesh3d', 'img3d', { progress: raw })).progress).toBe(plain);
  });

  it('leaves a line that already reads plainly, and the video box words it knew before', () => {
    for (const said of ['제출 중', '결과 저장 중', '대기열 3번째', 'GPU 대기 중 · 대기열 3번째', '렌더 서버 순서 기다리는 중',
      // ... and the lines the server writes in plain words pass as they are
      '3D 모델 만드는 중 · 85초', '움직임 뼈대 넣는 중 · 2분 3초', '3D 회전 영상 만드는 중 · 5분 16초']) expect(plainLine(said)).toBe(said);
    expect(jobWait(job('j_v', 'shot', 'mediagen_video', { progress: 'denoising 40%' })).progress).toBe('영상 생성 중 40%');
  });

  it("names a failed step's tool or service in plain words too", () => {
    expect(errorText('Hunyuan3D 실패: CUDA out of memory')).toBe('3D 모델을 만들지 못했어요');
    expect(errorText('Blender 작업 실패')).toBe('렌더 서버 작업 실패');
  });

  it('says 배경 제거 이미지 where a saved line says 누끼 (a check\'s finding, server/providers/cutout.py ERASED), with the particle still right', () => {
    expect(failedCheck('구도 검사 실패: 누끼에서 빛나는 부분이 지워짐. 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.'))
      .toEqual({ name: '구도 검사 실패', problem: '배경 제거 이미지에서 빛나는 부분이 지워짐' });
    expect(errorText('배경 제거가 잠시 응답하지 않아 누끼를 만들지 못했습니다.')).toBe('배경 제거가 잠시 응답하지 않아 배경 제거 이미지를 만들지 못했습니다.');
  });

  it('the phase a game waits for is the plain step name', () => {
    const ip = { ipId: 'ip_fox', kind: 'character', name: '여우', description: '', version: 1, createdAt: at } as Ip;
    expect(gameThreeD(ip, [], [job('j_a', 'apose', 'apose', { input: { ipId: 'ip_fox' } })])).toEqual({ state: 'running', phase: '3D용 자세 그림' });
    expect(gameThreeD(ip, [], [job('j_r', 'rig', 'rig', { input: { ipId: 'ip_fox' } })])).toEqual({ state: 'running', phase: '움직임 뼈대' });
  });
});

describe('R20-51 a particle follows the last syllable of the name before it', () => {
  it('picks 이에요 / 예요, 을 / 를, 이 / 가 (round20-verify studio/39: "리라이에요")', () => {
    expect(['리라', '세린', '카이'].map((n) => n + josa(n, '이에요', '예요'))).toEqual(['리라예요', '세린이에요', '카이예요']);
    expect(['반딧불 등불', '코어'].map((n) => n + josa(n, '을', '를'))).toEqual(['반딧불 등불을', '코어를']);
  });
  it('keeps both forms after a name that does not end in Hangul', () => {
    expect(['Luna' + josa('Luna', '을', '를'), 'Luna' + josa('Luna', '이에요', '예요', '(이)에요')]).toEqual(['Luna을(를)', 'Luna(이)에요']);
  });
});

// the cards
const lantern: Ip = { ipId: 'ip_lantern', kind: 'prop', name: '반딧불 등불', role: '핵심 아이템', version: 1, createdAt: at,
  description: 'small antique brass lantern with glass panes filled with glowing fireflies', imageAssetId: 'ast_img', cutoutAssetId: 'ast_cut' };
const asset = (assetId: string, kind: Asset['kind'], extra: Partial<Asset> = {}): Asset => ({ assetId, kind, key: `sessions/s/${assetId}`,
  url: `https://cdn/${assetId}`, contentType: '', ipId: 'ip_lantern', meta: {}, createdAt: at, ...extra });
const pictures = [asset('ast_img', 'image', { jobId: 'j_first', meta: { model: 'krea', version: 1 } }), asset('ast_cut', 'cutout', { jobId: 'j_first' })];
const first = job('j_first', 'image', 'mediagen_image', { status: 'done', input: { ipId: 'ip_lantern', model: 'krea', modelLabel: 'Krea 2 Turbo' }, outputs: ['ast_img', 'ast_cut'] });
const snapOf = (ips: Ip[], jobs: Job[] = [first], assets: Asset[] = pictures) => ({ session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: at },
  messages: [], games: [], ips, assets, jobs }) as Snapshot;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});
const show = async (snap: Snapshot, tab: string) => {
  history.replaceState(null, '', `#ip=${tab}`);
  const { IpPane } = await import('./components/IpPane');
  await act(async () => root.render(<IpPane snap={snap} onAction={vi.fn(async () => undefined)} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} />));
};

describe('R20-21 an IP card in plain words', () => {
  it('calls the cutout view 배경 제거, shows the version alone on the chip and no English prompt as its description', async () => {
    await show(snapOf([lantern]), 'props');
    const card = container.querySelector('article.card')!;
    const toggle = card.querySelector<HTMLButtonElement>('.cutout-toggle')!;
    expect([toggle.textContent, toggle.getAttribute('aria-label'), toggle.getAttribute('aria-pressed')]).toEqual(['배경 제거', '반딧불 등불 배경 제거한 그림 보기', 'false']);
    await act(async () => toggle.click());
    expect(card.querySelector('.card-media img')!.getAttribute('alt')).toBe('반딧불 등불 배경 제거');
    const chip = card.querySelector('.version-btn')!;
    expect([chip.textContent, chip.getAttribute('title')]).toEqual(['v1', '반딧불 등불의 이미지 버전 기록 · Krea 2 Turbo']); // the model: a tooltip
    expect(card.querySelector('.card-role')!.textContent).toBe('핵심 아이템');
    expect(card.querySelector('.card-desc')).toBeNull();
    expect(card.textContent).not.toMatch(/antique|lantern|누끼|Krea/);
  });

  it('keeps a description the IP has in Korean', async () => {
    await show(snapOf([{ ...lantern, description: '반딧불이 든 작은 황동 등불' }]), 'props');
    expect(container.querySelector('.card-desc')!.textContent).toBe('반딧불이 든 작은 황동 등불');
  });
});

describe('R20-21 the words are the same in the IP pane and the top bar', () => {
  it('calls the vertical cut 쇼츠, the turntable 3D 회전 영상 and the rig 움직임 뼈대 in the IP pane', async () => {
    const rigged = { ...lantern, kind: 'character' as const, glbAssetId: 'ast_glb', riggedGlbAssetId: 'ast_rig' };
    const more = [asset('ast_glb', 'glb', { jobId: 'j_mesh' }), asset('ast_rig', 'rigged_glb'), asset('ast_turn', 'turntable', { jobId: 'j_mesh' }),
      asset('ast_short', 'shorts', { ipId: undefined })];
    await show(snapOf([rigged], [first], [...pictures, ...more]), 'video');
    expect([...container.querySelectorAll('.video-section')].map((s) => s.getAttribute('aria-label'))).toEqual(['샷', '트레일러', '쇼츠']);
    expect(container.querySelector('#ip-panel-video')!.textContent).not.toContain('숏츠');
    await act(async () => container.querySelector<HTMLButtonElement>('#ip-tab-3d')!.click());
    expect(container.querySelector('#ip-panel-3d video')!.getAttribute('aria-label')).toBe('반딧불 등불 3D 회전 영상');
    await act(async () => container.querySelector<HTMLButtonElement>('#ip-tab-characters')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('article.card .menu-trigger')!.click());
    expect([...document.querySelectorAll('[role="menuitem"] > span')].map((s) => s.textContent)).toContain('움직임 뼈대만 다시 넣기');
  });

  it('names the step in the top bar menu with the same tooltip', async () => {
    const { JobsMenu } = await import('./components/JobsMenu');
    await act(async () => root.render(<JobsMenu jobs={[{ job: job('j_rig', 'rig', 'rig'), name: '리라' }]} onCancel={vi.fn(async () => undefined)} />));
    await act(async () => container.querySelector<HTMLButtonElement>('.jobs-menu-btn')!.click());
    const label = container.querySelector('.jobs-menu-text strong')!;
    expect([label.textContent, label.getAttribute('title')]).toEqual(['움직임 뼈대 · 리라', '리깅']);
    expect(container.querySelector<HTMLButtonElement>('.jobs-menu-stop')!.getAttribute('aria-label')).toBe('움직임 뼈대 리라 중지');
  });
});

describe('R20-21 a highlight being made names no model or tool', () => {
  it('says what is happening (was "Bedrock Pegasus 1.5가 명장면을 고르고 ffmpeg가 자르는 중…")', async () => {
    const { HighlightCarousel } = await import('./components/HighlightCarousel');
    await act(async () => root.render(<HighlightCarousel items={[{ id: 'h1', round: 2, state: 'analyzing', createdAt: at }]} onSend={vi.fn()} onDelete={vi.fn()} />));
    expect(container.querySelector('.hl-status')!.textContent).toBe('AI가 명장면을 골라 자르는 중…');
  });
});

describe('R20-21 a job card in plain words', () => {
  const chain = [
    job('j_pose', 'apose', 'apose', { progress: 'A-포즈로 다시 그리는 중 (klein)' }),
    job('j_mesh', 'mesh3d', 'img3d', { progress: 'Hunyuan3D · PBR 텍스처 생성 중 · 85초', createdAt: '2026-11-16T03:12:01Z' }),
    job('j_rig', 'rig', 'rig', { progress: '리깅 노드 배정 대기 중 · 30초', createdAt: '2026-11-16T03:12:02Z' }),
    job('j_turn', 'render3d', 'deadline', { status: 'queued', progress: '선행 작업 대기 중', deps: ['j_mesh'], createdAt: '2026-11-16T03:12:03Z' }),
  ];

  it('shows the step, where it runs and what it is doing without a studio word; the raw line is the tooltip', async () => {
    await show(snapOf([lantern], chain), 'pipeline');
    const cards = [...container.querySelectorAll('#jobs-running-region .job')];
    expect(cards.map((c) => c.querySelector('.job-kind')!.textContent)).toEqual(
      ['3D용 자세 그림 · 반딧불 등불', '3D 모델 · 반딧불 등불', '움직임 뼈대 · 반딧불 등불', '3D 회전 영상 · 반딧불 등불']);
    expect(cards.map((c) => c.querySelector('.job-kind')!.getAttribute('title'))).toEqual(['A-포즈', '3D 메시', '리깅', '턴테이블']);
    expect(cards.map((c) => c.querySelector('.job-meta span')!.textContent)).toEqual(['이미지 GPU', '3D GPU', '렌더 서버', '렌더 서버']);
    expect(cards.map((c) => c.querySelector('.job-meta span')!.getAttribute('title'))).toEqual(
      ['FLUX.2 klein 9B', 'Hunyuan3D', 'Deadline Cloud · Blender 리깅', 'Deadline Cloud · Blender']);
    const progress = cards.map((c) => c.querySelector<HTMLElement>('.job-progress')!);
    expect(progress.map((p) => p.textContent)).toEqual(
      ['3D용 자세 그림 그리는 중', '3D 모델 만드는 중 · 85초', '렌더 서버 배정 기다리는 중 · 30초', '앞 단계가 끝나길 기다리는 중']);
    expect(progress.map((p) => p.title)).toEqual(chain.map((j) => j.progress));
    expect(container.querySelector('#ip-panel-pipeline')!.textContent).not.toMatch(STUDIO_WORDS);
  });
});
