import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentNote, Connections, Highlight, Proposal } from './api';
import type { Asset, Game, Ip, Job, Snapshot } from './types';

// The studio in English: each main screen of the panes package holds no Hangul but what a user (or the server, per
// request) wrote. What the server stores in Korean whatever the language (a job's progress line, a check note, a
// refusal's reason) is said in English where the web reads it (types.ts serverLine).
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const HANGUL = /[가-힣]/;
/** Every text a user can read or hear in the page: its text, and the attributes that are words. */
function words(scope: ParentNode = document.body): string[] {
  // (two shared primitives of other packages still speak Korean here: a confirm's 취소 and a tab's count, "… · 3개")
  const page = scope.cloneNode(true) as HTMLElement;
  page.querySelectorAll('.confirm-cancel').forEach((el) => el.remove());
  page.querySelectorAll('[role="tab"][aria-label]').forEach((el) => el.setAttribute('aria-label', el.getAttribute('aria-label')!.replace(/ · \d+개$/, '')));
  const said = [page.textContent ?? ''];
  for (const el of page.querySelectorAll('*')) {
    for (const name of ['title', 'aria-label', 'placeholder', 'alt', 'aria-valuetext']) {
      const value = el.getAttribute(name);
      if (value) said.push(value);
    }
  }
  return said;
}
/** The texts that still hold Hangul once the user's own words (`own`) are taken out. */
const korean = (own: string[] = [], scope?: ParentNode) =>
  words(scope).map((text) => own.reduce((rest, name) => rest.split(name).join(''), text)).filter((text) => HANGUL.test(text));

const at = (clock = '03:10:00') => `2026-11-18T${clock}Z`;
const ip = (ipId: string, kind: Ip['kind'], name: string, extra: Partial<Ip> = {}): Ip => ({ ipId, kind, name, description: '', version: 1,
  imageAssetId: `${ipId}_img`, cutoutAssetId: `${ipId}_cut`, createdAt: at(), ...extra });
const asset = (assetId: string, kind: Asset['kind'], ipId: string, extra: Partial<Asset> = {}): Asset => ({ assetId, kind, key: `k/${assetId}`,
  url: `https://cdn/${assetId}`, contentType: '', ipId, meta: {}, createdAt: at(), ...extra });
const job = (jobId: string, kind: Job['kind'], ipId: string, status: Job['status'], extra: Partial<Job> = {}): Job => ({
  jobId, kind, provider: 'img3d', status, outputs: [], deps: [], progress: '', createdAt: at(), updatedAt: at(), ...extra, input: { ipId, ...extra.input } });
const snapOf = (ips: Ip[], jobs: Job[] = [], extra: Asset[] = [], games: Game[] = []) => ({
  session: { sessionId: 's', title: 'Night run', genre: 'sf-shooter', createdAt: at() }, messages: [], games, ips, jobs,
  assets: [...ips.filter((x) => x.imageAssetId).flatMap((x) => [asset(`${x.ipId}_img`, 'image', x.ipId, { meta: { version: 1 } }), asset(`${x.ipId}_cut`, 'cutout', x.ipId)]), ...extra] }) as Snapshot;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  Element.prototype.scrollIntoView = () => undefined;
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('ipverse.lang', 'en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});
const render = (node: React.ReactNode) => act(async () => root.render(node));
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);

// the lines below are the server's own, as it stores them (server/providers/*.py, server/jobs.py)
const REFUSED = '움직임 뼈대를 넣을 수 없는 모양입니다: not a full body: legs are missing or cut off (hips at 30% of the height)';
const KEPT_OUT = '구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.';

describe('the server\'s stored Korean lines, in English where the web reads them', () => {
  it('every phrase the web knows of a stored line has its English', async () => {
    const { SERVER_PHRASES } = await import('./types');
    const { EN } = await import('./i18n');
    expect(SERVER_PHRASES.filter((phrase) => !EN[phrase] || HANGUL.test(EN[phrase]))).toEqual([]);
  });

  // (the coverage test of i18n.test.ts reads t('…') literals; these tables stay Korean literals for the server's tests,
  // or are another file's, and are said through t() by a variable)
  it('the sentences read by a variable have their English too: genres, schedule examples, the skills\' own words', async () => {
    const { GENRES } = await import('./types');
    const { SCHEDULE_EXAMPLES } = await import('./components/AgentDialog');
    const { SKILLS } = await import('./skills');
    const { t } = await import('./i18n');
    const said = [...GENRES.map((g) => g.label), ...SCHEDULE_EXAMPLES.map(([label]) => t(label)),
      ...SKILLS.flatMap((s) => [t(s.title), t(s.tagline), t(s.module), t(s.request)])];
    expect(said.filter((text) => HANGUL.test(text))).toEqual([]);
    expect(GENRES.map((g) => g.label)).toEqual(['Sci-fi shooter', 'Sci-fi survival', 'RPG exploration', 'RPG quest']);
  });

  it('a progress line: the step in the cards\' words, its place in a queue, its times', async () => {
    const { JOB_TYPICAL, THREE_D_TOTAL, chainTypical, jobTimes, jobWait, plainLine, progressText } = await import('./types');
    expect(progressText('Hunyuan3D · PBR 텍스처 생성 중')).toBe('Making the 3D model');
    expect(progressText('3D 모델 만드는 중 · 색과 질감 입히기 · 42초')).toBe('Making the 3D model · adding color and texture · 42 s');
    expect(plainLine('Blender 리깅 중 (뼈대 맞춤·스키닝)')).toBe('Adding the rig');
    expect(progressText('denoising 40%')).toBe('Generating the video 40%');
    const mesh = job('m', 'mesh3d', 'x', 'queued', { progress: 'GPU 서버 순서 기다리는 중 · 대기열 3번째 · 시작까지 약 4분' });
    expect(jobWait(mesh)).toEqual({ progress: 'Waiting for a turn on the GPU server · no. 3 in the queue', usual: 'starts in about 4 min' });
    const restyle = job('r', 'shot', 'x', 'running', { provider: 'mediagen_video', progress: '영상 생성 중 (조각 1/3 완료) · 조각마다 ~6분, 전체 보통 ~14분' });
    expect(jobWait(restyle)).toEqual({ progress: 'Generating the video (pieces 1/3 done)', usual: '~6 min per piece, usually ~14 min in all' });
    expect(JOB_TYPICAL).toMatchObject({ image: 'usually 20 s–3 min', mesh3d: 'usually 2–8 min', trailer: 'usually 1–3 min' });
    expect(THREE_D_TOTAL).toBe('9–21 min');
    expect(chainTypical(['mesh3d', 'render3d'])).toBe('usually 6–15 min');
    expect(jobTimes(job('t', 'mesh3d', 'x', 'done', { createdAt: at('03:10:00'), startedAt: at('03:11:30'), updatedAt: at('03:17:54') }))).toBe('waiting 1:30 · working 6:24');
  });

  it('a check note, a refused skeleton and a failure, parsed from the Korean and said in English', async () => {
    const { errorText, failedCheck, failureText, jobLabel, jobNote, jobTitle, rigRefusal, toolEventText } = await import('./types');
    expect(failedCheck(KEPT_OUT)).toEqual({ name: 'Composition check failed', problem: 'cut off by the frame at the top, bottom' });
    const hero = ip('wiz', 'character', 'Wizard', { version: 1 });
    const redraw = job('d', 'image', 'wiz', 'done', { provider: 'mediagen_image', outputs: ['wiz_img2'], error: KEPT_OUT, input: { version: 2 } });
    expect(errorText(jobNote(redraw, [hero]))).toBe('Composition check failed: cut off by the frame at the top, bottom (same after 2 draws). '
      + 'The new picture (v2) is kept in Version history only, and the current picture (v1) stays in use.');
    expect(errorText(jobNote(redraw, [{ ...hero, imageAssetId: 'wiz_img2', version: 2 }])))
      .toMatch(/This picture \(v2\) is now in use, chosen with ‘Use this version’\.$/);
    expect(errorText(jobNote(redraw, [{ ...hero, version: 3 }]))).toMatch(/the current picture is another version \(v3\)\.$/);
    // the three reasons the server gives for a refused 움직임 뼈대 (server/providers/rig.py REASONS, OTHER_REASON)
    const refused = (reason: string) => rigRefusal(job('r', 'rig', 'wiz', 'done', { outcome: 'refused', reason }))?.why;
    expect(refused('다리가 보이지 않거나 너무 짧아요')).toBe('the legs are not in view or are too short');
    expect(refused('두 다리의 길이가 다르게 보여요(꼬리나 긴 옷자락이 다리처럼 보일 수 있어요)')).toBe('the two legs look different in length (a tail or a long hem can look like a leg)');
    expect(refused('뼈대를 맞출 수 없는 모양이에요.')).toBe('this shape cannot be fitted with a skeleton');
    expect(failureText(job('r', 'rig', 'wiz', 'failed', { error: REFUSED }))).toBe('the legs are not in view or are too short');
    // the failures the web already says in Korean
    expect(errorText('Hunyuan3D 실패: CUDA out of memory')).toBe('The 3D model could not be made');
    expect(errorText('결과 저장을 반복 실패했습니다: An error occurred (ServiceUnavailableException) when calling the PutObject operation')).toBe('Saving the result failed repeatedly');
    expect(errorText('KeyError: 0')).toBe('An unknown error occurred');
    expect(errorText("Command '['/opt/bin/ffmpeg', '-y']' returned non-zero exit status 8.")).toBe('The video command failed');
    expect(jobLabel(job('p', 'render3d', 'x', 'done', { input: { model: 'relief' } }))).toBe('Relief panel');
    expect(jobTitle(job('e', 'image', 'wiz', 'done', { input: { version: 3, edit: 'red scarf' } }), [hero])).toBe('Wizard · edit v3');
    expect(toolEventText('make_thing 실패')).toMatchObject({ label: 'Tool run', text: 'Tool run failed' });
  });
});

describe('the IP pane in English', () => {
  const wizard = ip('wiz', 'character', 'Wizard', { glbAssetId: 'wiz_glb', imageJobId: 'wiz_draw2' });
  const wolf = ip('wolf', 'enemy', 'Shadow wolf', { humanoid: false });
  const drawing = ip('new', 'character', 'Scout', { imageAssetId: undefined, cutoutAssetId: undefined, imageJobId: 'new_draw' });
  const lantern = ip('lan', 'prop', 'Lantern', { imageJobId: 'lan_draw' });
  const valley = ip('val', 'prop', 'Valley', { usage: 'background' });
  const blade = ip('bld', 'weapon', 'Blade', { weaponType: 'melee' });
  const jobs: Job[] = [
    job('wiz_pose', 'apose', 'wiz', 'done', { input: { imageKey: 'k/wiz_img' } }), job('wiz_mesh', 'mesh3d', 'wiz', 'done', { deps: ['wiz_pose'] }),
    job('wiz_turn', 'render3d', 'wiz', 'done', { deps: ['wiz_mesh'], provider: 'deadline' }),
    job('wiz_rig', 'rig', 'wiz', 'failed', { deps: ['wiz_mesh'], provider: 'rig', error: REFUSED }),
    job('wiz_draw2', 'image', 'wiz', 'done', { provider: 'mediagen_image', outputs: ['wiz_img2'], error: KEPT_OUT, outcome: 'rejected', input: { version: 2 } }),
    job('new_draw', 'image', 'new', 'running', { provider: 'mediagen_image', progress: '그림 그리는 중 (GPU 대기 포함)', startedAt: at() }),
    job('lan_draw', 'image', 'lan', 'done', { provider: 'mediagen_image', outputs: ['lan_img'], error: '구도 검사 실패: 피사체 2개. 첫 그림이라 그대로 두었으니 다시 뽑아 주세요.', outcome: 'check_failed' }),
    job('wolf_mesh', 'mesh3d', 'wolf', 'running', { progress: 'Hunyuan3D · PBR 텍스처 생성 중', startedAt: at() }),
    job('wolf_turn', 'render3d', 'wolf', 'queued', { deps: ['wolf_mesh'], provider: 'deadline', progress: '선행 작업 대기 중' }),
    job('bld_mesh', 'mesh3d', 'bld', 'failed', { error: 'Hunyuan3D 실패: out of memory' }),
    job('bld_turn', 'render3d', 'bld', 'failed', { deps: ['bld_mesh'], provider: 'deadline', error: '선행 작업 실패' }),
    job('val_turn', 'render3d', 'val', 'failed', { provider: 'deadline', error: '사용자가 중지함', input: { model: 'relief' } }),
    job('shot1', 'shot', 'wiz', 'done', { provider: 'mediagen_video', input: { prompt: 'run', model: 'ltx' } }),
    job('cut1', 'trailer', 'wiz', 'running', { provider: 'ffmpeg', progress: '영상 마무리 중 (인코딩)', input: { title: 'First cut', make_shorts: true } }),
  ];
  const extra = [
    asset('wiz_glb', 'glb', 'wiz', { jobId: 'wiz_mesh' }), asset('wiz_tt', 'turntable', 'wiz', { jobId: 'wiz_turn' }),
    asset('wiz_img2', 'image', 'wiz', { meta: { version: 2 }, jobId: 'wiz_draw2' }),
    asset('wiz_act', 'action_image', 'wiz', { meta: { action: 'running' } }),
    asset('shot_a', 'shot', 'wiz', { jobId: 'shot1', meta: { model: 'ltx' } }),
    asset('shot_b', 'shot', 'wiz', { meta: { edit: 'v2v', task: 'upscale', plain: true, model: 'ffmpeg' } }),
    asset('tr_a', 'trailer', 'wiz', { meta: { seconds: 20 } }),
  ];
  const snap = snapOf([wizard, wolf, drawing, lantern, valley, blade], jobs, extra);
  // the IP's first picture is lan_img, the one its check flagged
  snap.assets.push(asset('lan_img', 'image', 'lan', { jobId: 'lan_draw', meta: { version: 1 } }));
  snap.ips.find((x) => x.ipId === 'lan')!.imageAssetId = 'lan_img';

  const show = async (tab: string) => {
    history.replaceState(null, '', `#ip=${tab}`);
    const { IpPane } = await import('./components/IpPane');
    await render(<IpPane snap={snap} onAction={vi.fn(async () => undefined)} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} onCancelJob={vi.fn(async () => undefined)} />);
  };
  const card = (name: string) => [...container.querySelectorAll('article.card')].find((c) => c.querySelector('h3')?.textContent === name)!;

  it('the tabs and the character cards: badges, the 3D line, a picture being drawn, the two amber notes', async () => {
    await show('characters');
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.replace(/\d+$/, '').trim())).toEqual(['Characters', 'Props', '3D', 'Video', 'Jobs']);
    expect(card('Shadow wolf').querySelector('.kind-badge')).toHaveProperty('textContent', 'Enemy');
    expect(card('Shadow wolf').querySelector('.card-status')?.textContent).toBe('Making 3D · step 1/2 · usually 6–15 min. It appears in the 3D tab when done.');
    expect(card('Scout').querySelector('.card-media-status')?.textContent).toBe('Drawing the picture (incl. GPU wait)');
    expect(card('Scout').querySelector('.card-hint')?.textContent).toBe('Made in 4 steps once the picture is drawn · usually 9–21 min');
    const note = card('Wizard').querySelector('.card-note')!;
    expect(note.querySelector('p')?.textContent).toBe('The new picture (v2) was not used, and the rig could not be added.');
    expect(note.querySelector('details')?.textContent).toContain('The new picture (v2) failed its check and was not used: cut off by the frame at the top, bottom. The current picture (v1) stays in use.');
    expect(note.querySelector('details')?.textContent).toContain('The rig could not be added: the legs are not in view or are too short. '
      + 'Redraw with a picture that shows the figure from head to toe, standing with both legs in view.');
    expect(button('Redraw the picture', note)).toBeTruthy();
    expect(korean()).toEqual([]);
  });

  it('the props tab: a flagged first picture, a whole-scene background, a weapon', async () => {
    await show('props');
    expect(card('Lantern').querySelector('.card-media-status')?.textContent).toBe('Composition check failed: 2 subjects · redraw recommended');
    expect(card('Valley').querySelector('.kind-badge--scene')?.textContent).toBe('Background · whole scene');
    expect(button('Make relief panel', card('Valley'))).toBeTruthy();
    expect(card('Blade').querySelector('.kind-badge')?.getAttribute('title')).toBe('Weapon · melee');
    expect(korean()).toEqual([]);
  });

  it('the 3D and video tabs', async () => {
    await show('3d');
    expect(container.querySelector('.model-stale, .model-source, figcaption')).toBeTruthy();
    expect(container.textContent).toContain('3D model · drag to turn');
    expect(korean()).toEqual([]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await show('video');
    expect([...container.querySelectorAll('.video-section h3')].map((h) => h.firstChild?.textContent?.trim())).toEqual(['Shot', 'Trailer', 'Shorts']);
    expect(container.textContent).toContain('Shot 2 · Wizard · Upscale · Source enlarged');
    expect(container.textContent).toContain('Jobs running: 1…');
    expect(korean()).toEqual([]);
  });

  it('작업 현황: groups, states, waits, reasons and what to do next', async () => {
    await show('pipeline');
    const row = (id: string) => container.querySelector(`[data-job="${id}"]`)!;
    expect([...container.querySelectorAll('.job-group .fold-title, .job-group summary, .job-group h3')].length).toBeGreaterThan(0);
    expect(row('wolf_mesh').querySelector('.job-kind')?.textContent).toBe('3D model · Shadow wolf');
    expect(row('wolf_mesh').querySelector('.badge')?.textContent).toBe('Running');
    expect(row('wolf_mesh').querySelector('.job-progress')?.textContent).toBe('Making the 3D model');
    expect(row('wolf_mesh').querySelector('.job-elapsed')?.textContent).toMatch(/^working [\d:]+ · usually 2–8 min$/);
    expect(row('wolf_turn').querySelector('.job-progress')?.textContent).toBe('Waiting for the previous step to finish');
    expect(row('wiz_rig').querySelector('.job-error')?.textContent).toBe('The legs are not in view or are too short. '
      + 'Redraw with a picture that shows the figure from head to toe, standing with both legs in view, then make 3D again.');
    expect(button('Redraw the picture', row('wiz_rig'))).toBeTruthy();
    expect(button('Retry', row('wiz_rig'))).toBeUndefined();
    expect(row('bld_mesh').querySelector('.job-error')?.textContent).toBe('The 3D model could not be made');
    expect(button('Retry', row('bld_mesh'))).toBeTruthy();
    expect(row('bld_turn').querySelector('.job-error')?.textContent).toBe('The previous step (3D model · Blade) failed, so this one did not start. '
      + 'Press ‘Retry’ on that step and this one starts again with it.');
    expect(row('val_turn').querySelector('.job-kind')?.textContent).toBe('Relief panel · Valley');
    expect(row('val_turn').querySelector('.job-error')?.textContent).toBe('You stopped this job. Press ‘Retry’ to start it again.');
    expect(row('wiz_draw2').querySelector('.badge')?.textContent).toBe('Not applied');
    expect(row('lan_draw').querySelector('.badge')?.textContent).toBe('Check failed');
    expect(row('lan_draw').querySelector('.job-error')?.textContent).toBe('Composition check failed: 2 subjects. This is the first picture, so it was kept. Redraw it.');
    // the line as the server wrote it is the row's tooltip, in the page's language too
    const stored = [...container.querySelectorAll('.job-progress[title], .job-error[title]')].map((el) => el.getAttribute('title')!);
    expect(stored).toEqual(['This shape cannot take a rig: not a full body: legs are missing or cut off (hips at 30% of the height)']);
    expect(korean()).toEqual([]);
  });

  it('the picture, big, and the version drawer', async () => {
    await show('characters');
    await click(button('Version history of Wizard (now v1)'));
    const drawer = document.querySelector('.drawer')!;
    expect(drawer.querySelector('h2')?.textContent).toBe('Version history of Wizard');
    expect(button('Use this version', drawer)).toBeTruthy();
    expect(drawer.querySelector('.versions-note')?.textContent).toContain('press ‘Make 3D’ in the card’s ⋯ menu.');
    expect(korean()).toEqual([]);
  });
});

describe('the drawers and dialogs in English', () => {
  it('the edit drawer: its chips are English requests, by what the IP is', async () => {
    const { EditDrawer, examplesFor, messageFor } = await import('./components/EditDrawer');
    const hero = ip('wiz', 'character', 'Wizard');
    const send = vi.fn(async () => undefined);
    await render(<EditDrawer target={{ kind: 'ip', ip: hero, imageUrl: 'https://cdn/x' }} onClose={vi.fn()} onSend={send} />);
    expect(document.querySelector('h2')?.textContent).toBe('Edit Wizard');
    expect([...document.querySelectorAll('.chip-btn')].map((b) => b.textContent)).toEqual(['Wrap a red scarf around the neck', 'Change the hair to silver', 'Make the expression more determined']);
    await click(document.querySelector('.chip-btn'));
    expect(document.querySelector('#edit-submit-hint')?.textContent).toBe('After you send, a new version is drawn (usually 20 s–3 min). Progress shows in the chat and in Jobs.');
    await click(button('Request edit'));
    // the tag is the agent's own (and the chat bubble's chip); the request after it is the English chip
    expect(send).toHaveBeenCalledWith('[에셋 수정 ipId=wiz] Wizard: Wrap a red scarf around the neck');
    expect(korean()).toEqual([]);
    for (const target of [{ kind: 'ip', ip: ip('e', 'enemy', 'E') }, { kind: 'ip', ip: ip('p', 'prop', 'P') }, { kind: 'ip', ip: ip('w', 'weapon', 'W') },
      { kind: 'ip', ip: ip('b', 'prop', 'B', { usage: 'background' }) }, { kind: 'shot', asset: asset('s', 'shot', 'wiz') }, { kind: 'trailer' }] as const) {
      expect(examplesFor(target).filter((example) => HANGUL.test(example))).toEqual([]);
    }
    expect(messageFor({ kind: 'trailer' }, 'a calm dawn', { seconds: 20, model: 'ltx' })).toBe('[트레일러 연출] 전체 길이 약 20초, 영상 모델 LTX-2.5. 연출: a calm dawn');
  });

  it('the trailer and shot forms of the edit drawer', async () => {
    const { EditDrawer } = await import('./components/EditDrawer');
    await render(<EditDrawer target={{ kind: 'trailer' }} onClose={vi.fn()} onSend={vi.fn(async () => undefined)} />);
    expect(document.querySelector('h2')?.textContent).toBe('Direct a trailer');
    expect([...document.querySelectorAll('option')].map((o) => o.textContent)).toEqual(expect.arrayContaining(['10 s', '20 s']));
    expect(korean()).toEqual([]);
    await render(<EditDrawer target={{ kind: 'shot', asset: asset('s', 'shot', 'wiz'), name: 'Wizard', model: 'ltx', seconds: 5, prompt: 'run' }} onClose={vi.fn()} onSend={vi.fn(async () => undefined)} />);
    expect(document.querySelector('figcaption')?.textContent).toBe('Wizard · LTX-2.5 · 5 s');
    expect(korean()).toEqual([]);
  });

  it('장르 스킬: the steps, the IP list, the confirm (the IPs keep their names)', async () => {
    const { SkillsDrawer } = await import('./components/SkillsDrawer');
    const { SKILLS } = await import('./skills');
    const names = SKILLS.flatMap((s) => s.assets.map((a) => a.name));
    const hero = ip('wiz', 'character', 'Wizard');
    await render(<SkillsDrawer snap={snapOf([hero])} onClose={vi.fn()} onSend={vi.fn(async () => undefined)} onNotice={vi.fn()} onChat={vi.fn()} onError={vi.fn()} />);
    expect(document.querySelector('h2')?.textContent).toBe('Genre skills');
    expect([...document.querySelectorAll('.skill-card-title')].map((el) => el.textContent)).toEqual(['Racing', 'Jump platformer', 'Hack-and-slash dungeon', 'Open-world city']);
    await click(document.querySelector('.skill-card'));
    expect(document.querySelector('.skill-why')?.textContent).toBe('A game needs the 3D of the hero, Wizard. Make the 3D first in step 0.');
    expect(button('Make IPs (5) · about 60 min')).toBeTruthy();
    await click(button('Make IPs (5) · about 60 min'));
    expect(document.querySelector('[role="alertdialog"], .modal')?.textContent).toContain('This makes pictures (5) and 3D models (5).');
    expect(korean(names)).toEqual([]);
  });

  it('게임 설계: the notice without a 3D hero, then the form, its examples and the request it sends', async () => {
    const { DesignDrawer, briefMessage } = await import('./components/DesignDrawer');
    const hero = ip('wiz', 'character', 'Wizard');
    await render(<DesignDrawer ips={[hero]} assets={snapOf([hero]).assets} jobs={[]} onMake3d={vi.fn()} onClose={vi.fn()} onSend={vi.fn()} />);
    expect(document.querySelector('.design-blocked-lead')?.textContent).toBe('Game design needs a hero character whose 3D is finished.');
    expect([...document.querySelectorAll('.game-needs li')].map((li) => li.textContent)).toEqual(['① Make a character in the chat', '② ‘Make 3D’ on the character card (usually 9–21 min)', '③ Game design']);
    expect(korean()).toEqual([]);
    const ready = { ...hero, glbAssetId: 'wiz_glb' };
    const send = vi.fn(async () => undefined);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<DesignDrawer ips={[ready]} assets={[...snapOf([ready]).assets, asset('wiz_glb', 'glb', 'wiz')]} jobs={[]} onClose={vi.fn()} onSend={send}
      games={[{ gameId: 'g1', title: 'Night run', genre: 'sf-shooter', specKey: '', previewUrl: '', createdAt: at() }]} onEditGame={vi.fn()} />);
    expect(document.querySelector('.design-edit-offer')?.textContent).toBe('This designs a new game from scratch. To change the current game ‘Night run’ (v1) a little, use Edit this game.');
    await click(button('Lava forge boss fight'));
    await click(document.querySelector('input[type="checkbox"]'));
    expect(korean()).toEqual([]);
    await click(button('Make game with this design'));
    const [text] = send.mock.calls[0] as unknown as [string];
    // the first line and the cast tag are the agent's own (the chat bubble shows chips for them); the design is English
    expect(text.split('\n')).toEqual([
      '[게임 설계] 이 설계대로 3D 게임을 만들어줘.',
      'Type: Boss fight (One giant boss and its minions) [boss]',
      'World: Lava forge [lava-forge], sky Night [night], layout Open field [open]',
      'Mission: Defeat the giant battle robot at the heart of the forge',
      'Clear condition: Clear by bringing the boss’s health to 0',
      'Fail condition: Fail if the boss is not beaten in 4 minutes or health reaches 0',
      'Enemies: One boss, plus small repair drones that keep coming',
      'Difficulty: Hard [hard]',
      'Extra rules: Player health 200',
      '[출연 IP cast_ip_ids=wiz] Wizard(Character)',
      'Only the cast IPs above may appear in the game (no other IPs and no unnamed enemies or props).',
    ]);
    // every example, whole: an example is sent as the user's own design
    const { EN } = await import('./i18n');
    expect(Object.entries(EN).filter(([ko]) => /^(주인공이 안내 NPC|선택한 출연 IP와)/.test(ko)).map(([, en]) => en).join('')).not.toMatch(HANGUL);
    expect(briefMessage({ prompt: 'a quiet walk', type: '', theme: '', sky: '', layout: '', mission: '', clear: '', fail: '', enemies: '', difficulty: '', extra: '' }))
      .toBe('[게임 설계] 이 설계대로 3D 게임을 만들어줘.\nGame request: a quiet walk');
  });

  it('설계 요약', async () => {
    const { GameDesignSummary } = await import('./components/GameDesignSummary');
    const hero = ip('wiz', 'character', 'Wizard');
    const game: Game = { gameId: 'g1', title: 'Night run', genre: 'sf-shooter', specKey: '', previewUrl: '', createdAt: at(), castIpIds: ['wiz', 'gone'] };
    const spec = { version: 2, engine: 'three', difficulty: 'hard',
      mission: { stages: [{ type: 'kills', target: 12 }, { type: 'survive', target: 60 }, { type: 'drive', distanceMeters: 150 }, { type: 'hold', holdSec: 5 }], successText: 'Well done' },
      world: { width: 600, depth: 600, entities: [{}], propPlacements: [], enemySpawns: [{ enemyIndex: 0 }],
        city: { districts: [{ name: 'Old town', style: 'downtown' }], streets: [{}, {}], vehicles: [{}], pedestrians: [], trafficCount: 8 } },
      rules: { timeLimitSec: 0, playerHp: 200 }, mechanics: { dash: true, sprint: true, autoFire: false, weaponDamage: 20, fireIntervalSec: 0.4, regenPerSec: 2, interactRadius: 3 },
      player: { ipId: 'wiz', modelUrl: 'm.glb' }, enemies: [{ name: 'Drone' }], props: [] };
    await render(<GameDesignSummary game={game} spec={spec} ips={[hero]} showRequest />);
    const text = container.textContent ?? '';
    for (const said of ['Generated game design', 'Open-world city', 'Stage 1 · Defeat', 'Defeat · Target 12', 'Survive · Target 60 s', 'Drive 150 m', 'Capture points · Hold 5 s',
      'On completion: Well done', 'City world · 600 × 600m', 'Districts (1): Old town (Downtown)', 'Roads: 2 · Drivable vehicles: 1 · Pedestrians: 0 · Traffic vehicles: 8',
      'No time limit', 'Hero health 200', 'Difficulty Hard', 'Movement: Dash · Sprint', 'Manual attack', 'Hero Wizard', '3D linked', 'Enemy Drone', 'No IP linked · Placements: 1',
      'IPs selected but not linked in the design: gone', 'A game role has no IP assigned.']) expect(text).toContain(said);
    expect(korean()).toEqual([]);
  });

  it('the game edit drawer, publish and the session delete dialog', async () => {
    const { GameEditDrawer, editGameMessage } = await import('./components/GameEditDrawer');
    const game: Game = { gameId: 'g1', title: 'Night run', genre: 'sf-shooter', specKey: '', previewUrl: '/p', createdAt: at(), publishedUrl: '/games/g1/' };
    await render(<GameEditDrawer game={game} version={2} onClose={vi.fn()} onSend={vi.fn(async () => undefined)} />);
    expect(document.querySelector('h2')?.textContent).toBe('Edit this game');
    expect([...document.querySelectorAll('.chip-btn')].map((b) => b.textContent)).toContain('Double the number of enemies');
    expect(korean()).toEqual([]);
    expect(editGameMessage(game, 'Make the difficulty easy').split('\n')[1]).toBe('Make the difficulty easy');

    const { PublishModal } = await import('./components/PublishModal');
    await render(<PublishModal games={[game]} assets={[asset('tr', 'trailer', 'wiz', { meta: { seconds: 20 } })]} onClose={vi.fn()} onPublish={vi.fn(async () => '/games/g1/')} onUnpublish={vi.fn(async () => undefined)} />);
    expect(document.querySelector('h2')?.textContent).toBe('Publish game + ad');
    expect(document.querySelector('.publish-result p')?.textContent).toBe('This game is published · Anyone with this link can play without logging in.');
    expect(button('Copy link')).toBeTruthy();
    await click(button('Unpublish'));
    expect(document.body.textContent).toContain('Unpublish?');
    expect(korean()).toEqual([]);

    const { DeleteSessionDialog } = await import('./components/DeleteSessionDialog');
    await render(<DeleteSessionDialog session={{ sessionId: 's', title: 'Night run', genre: 'sf-shooter', createdAt: at() }} onClose={vi.fn()} onDelete={vi.fn(async () => undefined)} />);
    expect(document.querySelector('#session-delete-desc')?.textContent).toBe('Delete the session Night run? All IPs, videos and games of this session are deleted, and this cannot be undone. '
      + 'Game links shared by publishing stop opening too.');
    expect(document.querySelector('#session-delete-desc strong')?.textContent).toBe('Night run');
    expect(korean()).toEqual([]);
  });

  it('agents: the list, the dialog with its schedule forms, the inbox with a proposal', async () => {
    const agent: Agent = { agentId: 'agt_scout', name: 'Model scout', instructions: 'Look for new models', scheduleLabel: 'Daily 09:00 KST', cron: '0 9 * * *', enabled: true,
      builtin: false, lastRun: { at: '2026-11-09T00:00:00Z', status: 'ok', summary: '1 candidate' } };
    const { AgentList } = await import('./components/AgentList');
    await render(<AgentList agents={[agent]} unread={2} onRegister={vi.fn()} onEdit={vi.fn()} onInbox={vi.fn()} putAgent={vi.fn()} onRan={vi.fn()} onNotice={vi.fn()} onError={vi.fn()} />);
    expect(container.querySelector('.agent-run')?.textContent).toMatch(/Succeeded/);
    expect(container.querySelector('.agent-run--ok')).toBeTruthy();
    await click(button('Run Model scout now'));
    expect(document.body.textContent).toContain('Run Model scout now?');
    expect(korean()).toEqual([]);

    const { AgentDialog } = await import('./components/AgentDialog');
    await render(<AgentDialog agent={agent} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('h2')?.textContent).toBe('Edit agent');
    expect([...document.querySelectorAll('.chip-btn')].map((b) => b.textContent)).toEqual(['Every day 09:00 KST', 'Weekdays 09:00 KST', 'Every Monday 09:00 KST', 'Every 6 hours']);
    expect(document.querySelector('#agent-cron-hint')?.textContent).toMatch(/^Now: Daily 09:00 KST\. Write it like ‘every day 09:00’, ‘weekdays 9am’, ‘every Monday 09:00’ or ‘every 3 hours’, or as a cron expression/);
    expect(korean()).toEqual([]);
    await render(<AgentDialog onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('h2')?.textContent).toBe('Add agent');
    expect(korean()).toEqual([]);

    // (a proposal's own texts come from the server as written: here in English, as it writes them for an English page)
    const proposal: Proposal = { proposalId: 'p1', kind: 'image', hfRepo: 'org/model', label: 'FLUX.2 dev', license: 'Non-Commercial', commercialOk: false, vramGb: 40,
      instance: 'g6e.xlarge', why: 'Better hands', risks: 'License', status: 'testing', trial: { trialId: 't', phase: 'installing', startedAt: at(), finishedAt: null, error: null, results: [] } };
    const notes: AgentNote[] = [{ noteId: 'n1', agentId: 'agt_scout', agentName: 'Model scout', createdAt: at(), title: 'A new model', body: 'Details', proposal },
      { noteId: 'n2', agentId: 'agt_scout', agentName: 'Model scout', createdAt: at(), title: 'Passed', body: '', proposal: { ...proposal, proposalId: 'p2', status: 'passed',
        trial: { ...proposal.trial!, results: [{ prompt: 'a cat', mode: 't2i', baseline: { model: 'Krea 2 Turbo', url: 'b.png' }, candidate: { url: 'c.png', seconds: 12 } }] } } }];
    const { AgentInbox } = await import('./components/AgentInbox');
    await render(<AgentInbox notes={notes} putProposal={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('h2')?.textContent).toBe('Agent inbox');
    expect(document.querySelector('.proposal-status')?.textContent).toBe('Testing');
    expect(document.querySelector('.proposal-phase')?.textContent).toMatch(/^Installing the model · elapsed /);
    await click(button('Approve'));
    expect(document.body.textContent).toContain('This model is added to the Image model list.');
    expect(korean()).toEqual([]);
  });

  it('연결 설정, the big picture, highlights and the top bar\'s job menu', async () => {
    const connections: Connections = { platform: [{ id: 'imagegen', name: 'Image MCP', status: 'connected' }, { id: 'deadline', name: 'AWS Deadline Cloud', status: 'error' }],
      servers: [{ id: 'mine', name: 'Notes', status: 'connected', toolCount: 3, enabled: true, error: null }] };
    const { ConnectionsDrawer } = await import('./components/ConnectionsDrawer');
    await render(<ConnectionsDrawer connections={connections} onChange={vi.fn()} onRefresh={vi.fn(async () => undefined)} onClose={vi.fn()} onError={vi.fn()} />);
    expect(document.querySelector('h2')?.textContent).toBe('Connections');
    expect([...document.querySelectorAll('.conn-row strong')].map((el) => el.textContent)).toEqual(['Image generation', '3D rendering', 'Notes']);
    expect([...document.querySelectorAll('.conn-status')].map((el) => el.textContent)).toEqual(['Connected', 'Connection failed', 'Connected']);
    expect(korean()).toEqual([]);

    const { PictureModal } = await import('./components/PictureModal');
    await render(<PictureModal title="Wizard · v2" src="x.png" alt="Wizard" prompt="a small wizard" onClose={vi.fn()} />);
    expect(document.querySelector('summary')?.textContent).toBe('Show this picture’s prompt');
    expect(korean()).toEqual([]);

    const highlights: Highlight[] = [{ id: 'h1', round: 3, state: 'ready', createdAt: at(), title: 'Last-second win', start: 12.5, end: 17.5, clipSeconds: 5, shortUrl: 's.mp4' },
      { id: 'h2', round: 2, state: 'analyzing', createdAt: at() }];
    const { HighlightCarousel } = await import('./components/HighlightCarousel');
    await render(<HighlightCarousel items={highlights} onSend={vi.fn()} onDelete={vi.fn()} />);
    expect(document.querySelector('.hl-meta span')?.textContent).toBe('Round 3 · 5.0 s · 12.5–17.5 s');
    expect(button('Send as ad')).toBeTruthy();
    await click(button('Round 2'));
    expect(document.querySelector('.hl-status')?.textContent).toBe('AI is picking and cutting the best moment…');
    expect(korean()).toEqual([]);

    const { JobsMenu } = await import('./components/JobsMenu');
    await render(<JobsMenu jobs={[]} onCancel={vi.fn(async () => undefined)} />);
    expect(container.textContent).toBe('Saved');
    await render(<JobsMenu jobs={[{ job: job('m', 'mesh3d', 'x', 'running', { progress: 'Hunyuan3D · 3D 형상 생성 중' }), name: 'Wizard' }]} onCancel={vi.fn(async () => undefined)} />);
    await click(container.querySelector('.jobs-menu-btn'));
    expect(container.querySelector('.jobs-menu-state')?.textContent).toBe('Running · Making the 3D model · usually 2–8 min');
    expect(button('Stop 3D model Wizard')).toBeTruthy();
    expect(korean()).toEqual([]);
  });
});
