import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffJobs } from './api';
import { DesignDrawer, designCastProblem } from './components/DesignDrawer';
import { JOB_KIND_LABEL, JOB_TYPICAL, PROVIDER_LABEL, imageState, type Asset, type Ip, type Job, type Snapshot } from './types';

// An IP made with Krea / klein exists before its picture: the image job draws it in the background (server/tools.py).
const job = (jobId: string, status: Job['status']): Job => ({
  jobId, kind: 'image', provider: 'mediagen_image', status, input: { ipId: 'ip_new' }, outputs: [], deps: [], progress: '',
  createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z',
});
const drawing: Ip = { ipId: 'ip_new', kind: 'character', name: '볼트', description: 'a robot knight', version: 1,
  imageJobId: 'job_img', createdAt: '2026-11-04T10:00:00Z' };
const ready: Ip = { ipId: 'ip_old', kind: 'prop', name: '코어', description: 'a core', version: 1,
  imageAssetId: 'ast_img', cutoutAssetId: 'ast_cut', createdAt: '2026-11-04T09:00:00Z' };
const asset = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, key: `k/${assetId}.png`,
  url: `https://cdn/${assetId}.png`, contentType: 'image/png', ipId: 'ip_old', meta: {}, createdAt: '2026-11-04T09:00:00Z' });

describe('image jobs in the data layer', () => {
  it('tells pending, updating and failed pictures apart; old IPs are ready', () => {
    expect(imageState(drawing, [job('job_img', 'running')])).toBe('pending');
    expect(imageState({ ...drawing, imageAssetId: 'ast_1' }, [job('job_img', 'queued')])).toBe('updating');
    expect(imageState(drawing, [job('job_img', 'failed')])).toBe('failed');
    expect(imageState({ ...drawing, imageAssetId: 'ast_1' }, [job('job_img', 'failed')])).toBeUndefined();
    expect(imageState(ready, [])).toBeUndefined();
  });

  it('labels image jobs everywhere jobs are listed', () => {
    expect([JOB_KIND_LABEL.image, JOB_TYPICAL.image, PROVIDER_LABEL.mediagen_image]).toEqual(
      ['이미지', '보통 20초–3분', '이미지 GPU']);
    expect(diffJobs([job('job_img', 'running')], [job('job_img', 'done')])).toEqual([{ level: 'ok', text: '이미지 완료' }]);
  });

  it('keeps an IP without a picture out of a game design', () => {
    expect(designCastProblem([drawing], { ip_new: 'player' })).toContain('이미지가 아직 만들어지고 있어요');
    expect(designCastProblem([{ ...drawing, imageAssetId: 'ast_1', cutoutAssetId: 'ast_2' }], { ip_new: 'player' })).toBeNull();
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('an IP whose picture is still being drawn', () => {
  it('renders on the asset tabs without a broken image', async () => {
    const { IpPane } = await import('./components/IpPane');
    const snap = { session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: '' }, messages: [], games: [],
      ips: [drawing, ready], assets: [asset('ast_img', 'image'), asset('ast_cut', 'cutout')],
      jobs: [job('job_img', 'running')] } as Snapshot;
    await act(async () => root.render(<IpPane snap={snap} onAction={vi.fn()} onEdit={vi.fn()} onRetry={vi.fn()} />));
    const cards = [...container.querySelectorAll('article.card')];
    expect(cards.map((c) => c.querySelector('h3')?.textContent)).toEqual(['볼트']);
    expect(cards[0].querySelector('img')).toBeNull();
    expect([...container.querySelectorAll('img')].every((img) => img.getAttribute('src'))).toBe(true);
  });

  it('shows a skeleton with progress text and keeps the picture-only buttons off until it lands', async () => {
    const { IpPane } = await import('./components/IpPane');
    const base = { session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: '' }, messages: [], games: [],
      assets: [asset('ast_img', 'image'), asset('ast_cut', 'cutout')] };
    const running = { ...job('job_img', 'running'), progress: 'GPU 대기 2번째' };
    await act(async () => root.render(<IpPane snap={{ ...base, ips: [drawing], jobs: [running] } as Snapshot} onAction={vi.fn()} onEdit={vi.fn()} onRetry={vi.fn()} />));
    const media = container.querySelector('.card-media')!;
    expect(media.getAttribute('aria-busy')).toBe('true');
    expect(media.querySelector('.card-media-skel')).not.toBeNull();
    expect(media.querySelector('.card-media-status')?.textContent).toBe('그림 그리는 중 · GPU 대기 2번째'); // 그림, as the server's line says it
    expect(media.querySelector('[role="status"]')?.textContent).toBe('볼트 이미지를 그리고 있어요.');
    expect(media.querySelector('.cutout-toggle')).toBeNull();
    const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="볼트 ${label}"]`)!;
    expect(button('3D로 만들기').disabled).toBe(false); // the one visible action: the 3D chain waits on the image job itself
    // the picture-only actions sit in the card's ⋯ menu, disabled with the reason under each
    const menu = async () => {
      const trigger = button('작업 더보기');
      await act(async () => trigger.click());
      const items = [...document.getElementById(trigger.getAttribute('aria-controls')!)!.querySelectorAll('[role="menuitem"]')]
        .map((el) => [el.querySelector('span')?.textContent, el.getAttribute('aria-disabled') === 'true', el.querySelector('small')?.textContent]);
      await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
      return items;
    };
    expect(await menu()).toEqual([['수정하기', true, '이미지 생성 중'], ['다시 뽑기', true, '이미지 생성 중'], ['액션 샷', true, '이미지 생성 중']]);

    // a new version over an existing picture: the old picture stays, with a bar and the same text
    const old = { ...drawing, imageAssetId: 'ast_img', cutoutAssetId: 'ast_cut' };
    await act(async () => root.render(<IpPane snap={{ ...base, ips: [old], jobs: [running] } as Snapshot} onAction={vi.fn()} onEdit={vi.fn()} onRetry={vi.fn()} />));
    expect(container.querySelector('.card-media img')?.getAttribute('src')).toBe('https://cdn/ast_img.png');
    expect(container.querySelector('.card-media-bar')).not.toBeNull();
    expect(container.querySelector('.card-media-status')?.textContent).toBe('새 버전 그리는 중 · GPU 대기 2번째');
    // the old picture can be edited; a re-roll or a shot waits for the new one (the server refuses them until then)
    expect(await menu()).toEqual([['수정하기', false, undefined], ['다시 뽑기', true, '새 버전 그리는 중'], ['액션 샷', true, '새 버전 그리는 중']]);

    // done: the skeleton is replaced by the picture in the same box
    await act(async () => root.render(<IpPane snap={{ ...base, ips: [old], jobs: [job('job_img', 'done')] } as Snapshot} onAction={vi.fn()} onEdit={vi.fn()} onRetry={vi.fn()} />));
    expect(container.querySelector('.card-media')!.hasAttribute('aria-busy')).toBe(false);
    expect(container.querySelector('.card-media-status, .card-media-skel')).toBeNull();

    // failed first picture: says so, no skeleton (the proxy's English stays in 작업 현황's tooltip)
    await act(async () => root.render(<IpPane snap={{ ...base, ips: [drawing], jobs: [{ ...job('job_img', 'failed'), error: 'GPU busy' }] } as Snapshot}
      onAction={vi.fn()} onEdit={vi.fn()} onRetry={vi.fn()} />));
    expect(container.querySelector('.card-media-skel')).toBeNull();
    expect(container.querySelector('.card-media-status.is-failed')?.textContent)
      .toBe('이미지를 만들지 못했어요 · 알 수 없는 오류가 났어요. ‘작업 현황’ 탭에서 다시 시도하세요.');
    expect((await menu()).map((item) => item[2])).toEqual(['이미지 없음', '이미지 없음', '이미지 없음']);
  });

  it('says why a first picture failed in one Korean sentence: no raw exception, no doubled period (round 6 N13)', async () => {
    const { IpPane } = await import('./components/IpPane');
    // the background removal's 503 on three saves; botocore's text ends in a period
    const error = '결과 저장을 반복 실패했습니다: An error occurred (ServiceUnavailableException) when calling the InvokeModel '
      + 'operation (reached max retries: 2): Bedrock is unable to process your request.';
    const show = (why: string) => act(async () => root.render(<IpPane snap={{ session: { sessionId: 's', title: 't', genre: 'sf-shooter',
      createdAt: '' }, messages: [], games: [], ips: [drawing], assets: [], jobs: [{ ...job('job_img', 'failed'), error: why }] } as Snapshot}
      onAction={vi.fn()} onEdit={vi.fn()} onRetry={vi.fn()} />));
    const status = () => container.querySelector('.card-media-status.is-failed')?.textContent;
    await show(error);
    expect(status()).toBe('이미지를 만들지 못했어요 · 결과 저장을 반복 실패했습니다. ‘작업 현황’ 탭에서 다시 시도하세요.');
    // a Korean line that ends its own sentence keeps one period
    await show('작업 처리가 중단되었습니다 (시간 초과).');
    expect(status()).toBe('이미지를 만들지 못했어요 · 작업 처리가 중단되었습니다 (시간 초과). ‘작업 현황’ 탭에서 다시 시도하세요.');
  });

  it('marks a card whose picture failed its composition check until it is re-rolled or replaced (round 5 R10)', async () => {
    const { IpPane } = await import('./components/IpPane');
    // a first picture cut at the top and bottom in both draws
    const note = '구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림(2번 그려도 같음). 첫 그림이라 그대로 두었으니 다시 뽑아 주세요.';
    const drew = { ...job('job_u1', 'done'), input: { ipId: 'ip_old' }, error: note, outputs: ['ast_img', 'ast_cut'] };
    const umbrella = { ...ready, name: '빨간 종이우산', imageJobId: 'job_u1' };
    const assets = [asset('ast_img', 'image'), asset('ast_cut', 'cutout'), asset('ast_img2', 'image'), asset('ast_cut2', 'cutout')];
    const show = (ips: Ip[], jobs: Job[]) => act(async () => root.render(<IpPane snap={{ session: { sessionId: 's', title: 't',
      genre: 'sf-shooter', createdAt: '' }, messages: [], games: [], ips, assets, jobs } as Snapshot} onAction={vi.fn()} onEdit={vi.fn()} onRetry={vi.fn()} />));
    const status = () => container.querySelector('.card-media-status')?.textContent;
    history.replaceState(null, '', '#ip=props');

    await show([umbrella], [drew]);
    expect(status()).toBe('구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림 · 다시 뽑기 권장');
    expect(container.querySelector('.card-media-status')!.className).toContain('is-failed');
    // 다시 뽑기: the new version being drawn takes the place of the mark
    const reroll = { ...job('job_u2', 'running'), input: { ipId: 'ip_old' } };
    await show([{ ...umbrella, imageJobId: 'job_u2' }], [drew, reroll]);
    expect(status()).toBe('새 버전 그리는 중');
    // it failed its check as well: the IP keeps the cut picture, so the mark comes back
    const failedToo = { ...reroll, status: 'done' as const, error: note.replace('첫 그림이라 그대로 두었으니 다시 뽑아 주세요.',
      '새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.'), outputs: ['ast_img2', 'ast_cut2'] };
    await show([{ ...umbrella, imageJobId: 'job_u2' }], [drew, failedToo]);
    expect(status()).toBe('구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림 · 다시 뽑기 권장');
    // a picture that passed replaced it: no mark
    await show([{ ...umbrella, imageJobId: 'job_u2', imageAssetId: 'ast_img2', cutoutAssetId: 'ast_cut2' }],
      [drew, { ...failedToo, error: undefined }]);
    expect(status()).toBeUndefined();
    history.replaceState(null, '', '/');
  });

  it('shows no thumbnail in the game design drawer and blocks it as cast', async () => {
    await act(async () => root.render(<DesignDrawer ips={[drawing, ready]} assets={[asset('ast_img', 'image'), asset('ast_cut', 'cutout')]}
      onClose={vi.fn()} onSend={vi.fn()} />));
    // no hero is in 3D yet, so the drawer opens on what is missing: the form is asked for
    await act(async () => container.querySelector<HTMLButtonElement>('.design-blocked-early')!.click());
    const thumbs = [...container.querySelectorAll('.cast-thumb')];
    expect(thumbs[0].querySelector('img')).toBeNull();
    expect(thumbs[1].querySelector('img')?.getAttribute('src')).toBe('https://cdn/ast_cut.png');
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="볼트 출연 IP 선택"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('볼트');
  });
});
