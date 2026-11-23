import { useEffect, useMemo, useRef, useState } from 'react';
import { lang, t, tn } from '../i18n';
import { JOB_TYPICAL, SHOT_TYPICAL, SKELETON_NEEDS, chainTypical, drawLine, errorText, failedCheck, fmtTime, imageModelLabel, imageState, modelPicture,
  notAsAsked, shotModelLabel, pictureCheck, progressText, refusedSkeleton, threeDChain, threeDSteps, type Asset, type Ip, type JobKind, type Snapshot } from '../types';
import { ActionButton } from './ActionButton';
import { assetModelLabel, currentDescription } from '../types';
import { ActionMenu, type MenuItem } from './ActionMenu';
import { CHAT_BOX_EVENT } from './ChatDock';
import type { EditTarget } from './EditDrawer';
import { Fold } from './Fold';
import { JobsPanel } from './JobsPanel';
import { PictureModal } from './PictureModal';
import { VersionDrawer } from './VersionDrawer';
import { Tabs, openTab, readHash, writeHash } from './Tabs';
import { editLabel } from '../types';

interface Props {
  snap: Snapshot;
  /** Run a tool from a card button; background = the tool waits for a GPU image (status line in the chat). */
  onAction: (tool: string, args: Record<string, unknown>, background?: boolean) => Promise<void>;
  /** Open the natural-language edit drawer. */
  onEdit: (target: EditTarget) => void;
  /** Re-queue a failed job (and the ones that failed because of it), from 작업 현황. */
  onRetry: (jobId: string) => Promise<void>;
  /** 중지 on a queued or running job, from 작업 현황 (the session delete's refusal sends the user there). */
  onCancelJob?: (jobId: string) => Promise<void>;
  /** Tells the shell while 버전 기록 or a big picture is open: they render on <body> and cover the whole studio, so
   * the page behind is to be inert as behind the shell's own dialogs. */
  onModal?: (open: boolean) => void;
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const KIND_BADGE: Partial<Record<Ip['kind'], string>> = { enemy: t('적'), weapon: t('무기') };
/** From this many cards a tab has a box to find one by name, as the session list has (Sidebar FILTER_FROM). */
const FIND_FROM = 9;

const kindTitle = (ip: Ip) =>
  ip.kind === 'enemy'
    ? ip.humanoid === false ? t('적 · 사람 모양이 아니에요 (정해진 움직임)') : t('적 · 사람 모양 (움직임 뼈대를 넣어요)')
    : ip.weaponType === 'gun' ? t('무기 · 총') : t('무기 · 근접');
/** A description the IP has in Korean. The image model's English prompt is no description for the card. */
const korean = (text?: string) => (text && /[가-힣]/.test(text) ? text : '');

/** "v1로", "v3으로": the particle after a version number, by how its last digit is read (삼, 육 and 십 end in a consonant;
 * 일, 칠 and 팔 end in ㄹ, which takes 로). */
const vRo = (n: number) => `v${n}${/[036]$/.test(String(n)) ? '으로' : '로'}`;
/** "v2예요", "v3이에요". */
const vYeyo = (n: number) => `v${n}${/[013678]$/.test(String(n)) ? '이에요' : '예요'}`;

/** "4단계 · " before a chain's usual time, when it has more than one step. */
const stepsLead = (kinds: JobKind[]) => (kinds.length > 1 ? `${t('{n}단계', { n: kinds.length })} · ` : '');
// the tabs' names (Korean literals: the server's chat lines name them, server/tests/test_round20_notice.py; t() says
// them in the page's language where they are drawn)
const TABS = [{ id: 'characters', label: '캐릭터' }, { id: 'props', label: '소품' }, { id: '3d', label: '3D' }, { id: 'video', label: '영상' },
  { id: 'pipeline', label: '작업 현황' }] as const;

const chevron = (
  <svg className="menu-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function IpPane({ snap, onAction, onEdit, onRetry, onCancelJob, onModal }: Props) {
  // 작업 현황 was a GAME STUDIO tab (#game=pipeline): an old link opens it here, before the tabs read the hash
  useState(() => {
    if (readHash('game') !== 'pipeline') return;
    writeHash('game', null);
    writeHash('ip', 'pipeline');
  });
  const [versionsOf, setVersionsOf] = useState<string | null>(null);
  // the IP whose picture is open big
  const [pictureOf, setPictureOf] = useState<string | null>(null);
  // The shell is told in the same update that opens or closes one of the two, not from an effect: the page has to be
  // reachable again by the time the dialog hands focus back to the button that opened it (useDialog, on unmount).
  const showVersions = (ipId: string | null) => { setVersionsOf(ipId); onModal?.(ipId !== null); };
  const showPicture = (ipId: string | null) => { setPictureOf(ipId); onModal?.(ipId !== null); };
  const [cutout, setCutout] = useState<Record<string, boolean>>({});
  const [find, setFind] = useState<Record<string, string>>({}); // what each card tab is searched for, by the tab's word
  // keyed by possibly-missing ids: an IP whose first picture is still drawn has no imageAssetId (no <img> then)
  const assetById = useMemo(() => new Map<string | undefined, Asset>(snap.assets.map((a) => [a.assetId, a])), [snap.assets]);
  const versionsIp = versionsOf ? snap.ips.find((x) => x.ipId === versionsOf) : undefined;
  const pictureIp = pictureOf ? snap.ips.find((x) => x.ipId === pictureOf) : undefined;
  // the picture the card shows now, as the big view shows it: the cutout while 배경 제거 is on (a whole-scene background
  // has none)
  const pictureCut = !!pictureIp && pictureIp.usage !== 'background' && !!cutout[pictureIp.ipId];
  const pictureShown = pictureIp && assetById.get(pictureCut ? pictureIp.cutoutAssetId : pictureIp.imageAssetId);
  // ... and when one goes without its close (its IP or its picture's file left the snapshot, the pane itself went
  // away): the shell must not stay inert behind nothing. Counted by what is drawn, not by the IP alone
  const covering = !!versionsIp || !!pictureShown;
  useEffect(() => {
    if (covering) onModal?.(true);
    return () => { if (covering) onModal?.(false); };
  }, [covering, onModal]);
  // The IP whose 3D was started from its card just now: once the snapshot shows its chain, the card's status line is
  // brought into view. A chain found running when the page opens moves nothing.
  const started3d = useRef<string | null>(null);
  useEffect(() => {
    const ipId = started3d.current;
    if (!ipId || !threeDChain(ipId, snap.jobs)) return;
    started3d.current = null;
    document.getElementById(`ip-3d-status-${ipId}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [snap.jobs]);
  const ipName = (ipId?: string) => snap.ips.find((ip) => ip.ipId === ipId)?.name;
  const ofKind = (kind: Asset['kind']) => snap.assets.filter((a) => a.kind === kind);
  const inFlight = (kind: JobKind) => snap.jobs.filter((j) => j.kind === kind && (j.status === 'queued' || j.status === 'running')).length;

  // No extra tabs: enemies sit with characters, weapons with props, each marked by a badge.
  const characters = snap.ips.filter((ip) => ip.kind === 'character' || ip.kind === 'enemy');
  const props = snap.ips.filter((ip) => ip.kind === 'prop' || ip.kind === 'weapon');
  const actionImages = ofKind('action_image');
  const glbs = ofKind('glb');
  // Every 3D run on an IP adds a model: one entry per IP shows its current one (the IP's glbAssetId) and lists the
  // earlier runs under it as versions (v1 = the first made, oldest first like the snapshot).
  const runsByIp = new Map<string, Asset[]>();
  for (const glb of glbs) runsByIp.set(glb.ipId ?? glb.assetId, [...(runsByIp.get(glb.ipId ?? glb.assetId) ?? []), glb]);
  const models = [...runsByIp.values()];
  const shots = ofKind('shot');
  const trailers = ofKind('trailer');
  const shorts = ofKind('shorts');

  const imagesOf = (ipId: string) =>
    snap.assets.filter((a) => a.kind === 'image' && a.ipId === ipId).sort((a, z) => a.createdAt.localeCompare(z.createdAt));
  // A weapon without a picture (its first one still pending, or failed) stays out of action shots; one getting a
  // new version holds them back like the IP's own, since the server waits for every picture involved (_not_ready).
  const weapon = snap.ips.find((x) => x.kind === 'weapon' && !!x.imageAssetId);
  const weaponRedrawing = weapon && imageState(weapon, snap.jobs) === 'updating' ? t('{name} 새 버전 그리는 중', { name: weapon.name }) : undefined;

  const card = (ip: Ip) => {
    const background = ip.kind === 'prop' && ip.usage === 'background';
    const cut = !background && !!cutout[ip.ipId];
    const src = assetById.get(cut ? ip.cutoutAssetId : ip.imageAssetId)?.url;
    const imageModel = assetModelLabel(assetById.get(ip.imageAssetId), snap.jobs);
    // the words of the picture shown: an edit that landed, or a restored version, has its own. They are the image
    // model's prompt, in English: the card says them only when they are Korean
    const prompt = currentDescription(ip, assetById.get(ip.imageAssetId));
    const description = korean(prompt);
    const badge = KIND_BADGE[ip.kind];
    const actions = actionImages.filter((a) => a.ipId === ip.ipId);
    const actor = ip.kind === 'character' || ip.kind === 'enemy';
    const modelReady = !!ip.glbAssetId && assetById.has(ip.glbAssetId);
    // a background image job: 'pending' = the first picture (no image yet), 'updating' = a new version over the old one
    const state = imageState(ip, snap.jobs);
    // what a check found in the current picture (cut, more than one subject, or an edit that changed more than asked):
    // the card says so until a re-roll, an edit or a restored version replaces it
    const cutPicture = state === 'check_failed' ? pictureCheck(ip, snap.jobs) : null;
    const imageJob = ip.imageJobId ? snap.jobs.find((j) => j.jobId === ip.imageJobId) : undefined;
    // why its only image job failed, in Korean and without its own final period: the card's sentence ends after it
    const imageFailure = state === 'failed' ? errorText(imageJob?.error).replace(/\.+$/, '') : '';
    const drawing = state === 'pending' || state === 'updating';
    // What is being drawn, said once and without the model's name (an older server's line named it). The model is the
    // line's tooltip.
    const drawingNow = progressText(drawLine(imageJob?.progress));
    const drawingMore = drawingNow.startsWith(t('그림 그리는 중')) ? drawingNow.slice(t('그림 그리는 중').length) : drawingNow ? ` · ${drawingNow}` : '';
    const noImage = !ip.imageAssetId; // nothing to edit, re-roll, cut out or animate yet (3D waits for the image itself)
    const imageBusy = noImage ? (state === 'failed' ? t('이미지 없음') : t('이미지 생성 중')) : undefined;
    // re-roll and shots also wait while a new version is drawn: the server refuses them until it lands
    const redrawing = imageBusy ?? (state === 'updating' ? t('새 버전 그리는 중') : undefined);
    const openEdit = () => onEdit({ kind: 'ip', ip, imageUrl: assetById.get(ip.imageAssetId)?.url });
    // What the 3D button starts, said before the click: its steps and what they usually take together, the job
    // cards' own times added up. A whole scene becomes one panel with thickness, so its button says that and not 3D.
    const scene = ip.usage === 'background';
    const plan = threeDSteps(ip);
    const make3dLabel = scene ? t('입체 판으로 만들기') : t('3D로 만들기');
    const making = scene ? t('입체 판 만드는 중') : t('3D 만드는 중');
    const make3d = async () => {
      await onAction('render_3d', { ipId: ip.ipId });
      started3d.current = ip.ipId;
    };
    // ... and while its chain runs: the step it is on, the same usual time and where the result lands
    const chain = threeDChain(ip.ipId, snap.jobs);
    const chainSteps = chain && chain.kinds.length > 1 ? ` · ${t('{now}/{all}단계', { now: Math.min(chain.kinds.length, chain.done + 1), all: chain.kinds.length })}` : '';
    const threeDRunning = chain !== null;
    // A figure whose 움직임 뼈대 the farm refused, with nothing being made for it now: the card says why and what
    // helps (a retry fails the same way). Once the picture was drawn again (the model's own picture is no longer the
    // IP's), what is left is the 3D from it.
    const skeleton = !chain && !drawing ? refusedSkeleton(ip, snap.assets, snap.jobs) : null;
    const modelFrom = skeleton && assetById.get(ip.glbAssetId) ? modelPicture(assetById.get(ip.glbAssetId)!, snap.assets, snap.jobs) : undefined;
    const redrawn = !!modelFrom && modelFrom.assetId !== ip.imageAssetId;
    // The IP's newest picture, when a check kept it out: the IP uses the picture it had, and the card says so until
    // another picture is on its way. (A picture taken after all in 버전 기록 is the one in use: its check line is on it.)
    const keptOut = !drawing && imageJob && notAsAsked(imageJob) && !!ip.imageAssetId && !imageJob.outputs.includes(ip.imageAssetId)
      && (imageJob.outcome ? imageJob.outcome === 'rejected' : failedCheck(imageJob.error) !== null) ? imageJob : null;
    // ("새 그림(v2)은" in Korean; in English the version stands apart: "The new picture (v2) …")
    const keptOutV = typeof keptOut?.input?.version === 'number' ? `${lang === 'en' ? ' ' : ''}(v${keptOut.input.version})` : '';
    const keptOutWhy = failedCheck(keptOut?.error)?.problem;
    const edit: MenuItem = { label: t('수정하기'), disabled: noImage, hint: imageBusy, onSelect: openEdit };
    const reroll: MenuItem = { label: t('다시 뽑기'), busyLabel: t('요청 중…'), doneLabel: t('뽑는 중'), disabled: !!redrawing, hint: redrawing,
      onSelect: () => onAction('reroll_ip_image', { ipId: ip.ipId }, true) };
    const threeD: MenuItem = { label: make3dLabel, busyLabel: t('시작하는 중…'), doneLabel: t('시작했어요'), disabled: threeDRunning,
      hint: threeDRunning ? making : `${t('다시 만들어요')} · ${stepsLead(plan)}${chainTypical(plan)}`, onSelect: make3d };
    // a rigged IP: its current mesh rigged again (a fixed floor-slab cleanup reaches it), the look stays the same
    const rigAgain: MenuItem = { label: t('움직임 뼈대만 다시 넣기'), busyLabel: t('시작하는 중…'), doneLabel: t('시작했어요'), disabled: threeDRunning,
      hint: threeDRunning ? making : `${t('모양은 그대로예요')} · ${JOB_TYPICAL.rig}`,
      onSelect: async () => { await onAction('render_3d', { ipId: ip.ipId, rig_only: true }); started3d.current = ip.ipId; } };
    const shotWait = redrawing ?? weaponRedrawing;
    const shot: MenuItem = actor ? {
      label: t('액션 샷'), busyLabel: t('요청 중…'), doneLabel: t('만드는 중'), disabled: !!shotWait, hint: shotWait,
      onSelect: () => onAction('make_action_shot', {
        ipId: ip.ipId,
        action: weapon ? 'running forward holding the weapon, dynamic action pose, cinematic' : 'running forward, dynamic action pose, cinematic',
        ...(weapon ? { weapon_ip_id: weapon.ipId } : {}),
      }, true),
    } : {
      label: t('영상 샷'), busyLabel: t('등록 중…'), disabled: !!redrawing, hint: redrawing,
      onSelect: () => onAction('make_video_shot', { ipId: ip.ipId, prompt: 'slow cinematic orbit around the subject, soft rim light', aspect_ratio: '16:9' }),
    };
    // One visible primary (3D until the IP has a model, then 수정하기); the other three wait behind ⋯.
    const more = modelReady ? [reroll, threeD, ...(ip.riggedGlbAssetId ? [rigAgain] : []), shot] : [edit, reroll, shot];
    // the amber note (below): what it says of a kept-out picture and of a refused skeleton, and the ways on from each
    const edited = !!keptOut?.input?.edit;
    const keptOutLine = `${edited ? t('수정본{v}은 검사를 통과하지 못해 쓰지 않았어요', { v: keptOutV }) : t('새 그림{v}은 검사를 통과하지 못해 쓰지 않았어요', { v: keptOutV })}${
      keptOutWhy ? `: ${keptOutWhy}` : ''}. ${t('지금 그림(v{n})을 그대로 써요.', { n: ip.version })}`;
    const skeletonLine = redrawn ? t('그림이 바뀌었어요. 지금 그림으로 3D를 다시 만들면 움직임 뼈대도 다시 넣어요.')
      : t('움직임 뼈대를 넣지 못했어요: {why}. {needs}으로 다시 뽑아 주세요.', { why: skeleton?.why ?? '', needs: SKELETON_NEEDS });
    // both at once, in one line
    const pairLine = redrawn
      ? (edited ? t('수정본{v}은 쓰지 않았어요. 지금 그림으로 3D를 다시 만들 수 있어요.', { v: keptOutV }) : t('새 그림{v}은 쓰지 않았어요. 지금 그림으로 3D를 다시 만들 수 있어요.', { v: keptOutV }))
      : (edited ? t('수정본{v}은 쓰지 않았고, 움직임 뼈대도 넣지 못했어요.', { v: keptOutV }) : t('새 그림{v}은 쓰지 않았고, 움직임 뼈대도 넣지 못했어요.', { v: keptOutV }));
    const keptOutLinks = keptOut && (
      <>
        <button type="button" className={skeleton ? 'link-btn' : 'btn btn-sm btn-edit'} aria-label={t('{name} 버전 기록 보기', { name: ip.name })} onClick={() => showVersions(ip.ipId)}>{t('버전 기록 보기')}</button>
        <button type="button" className="link-btn" onClick={() => openTab('ip', 'pipeline')}>{t('작업 현황 보기')}</button>
      </>
    );
    const skeletonAction = skeleton && (redrawn ? (
      <>
        <ActionButton className="btn btn-sm btn-primary" label={t('지금 그림으로 3D 다시 만들기')} busyLabel={t('시작하는 중…')} doneLabel={t('시작했어요')}
          ariaLabel={t('{name} 지금 그림으로 3D 다시 만들기', { name: ip.name })} run={make3d} />
        <small>{stepsLead(plan)}{chainTypical(plan)}</small>
      </>
    ) : (
      <ActionButton className="btn btn-sm btn-edit" label={t('그림 다시 뽑기')} busyLabel={t('요청 중…')} doneLabel={t('뽑는 중')}
        ariaLabel={t('{name} 그림 다시 뽑기', { name: ip.name })} run={() => onAction('reroll_ip_image', { ipId: ip.ipId }, true)} />
    ));
    return (
      <article key={ip.ipId} className="card">
        <div className={['card-media', cut && 'is-cutout', !actor && !background && 'is-object'].filter(Boolean).join(' ')}
          aria-busy={drawing ? true : undefined}>
          {state === 'pending' ? <div className="skel card-media-skel" aria-hidden="true" />
            : src && (
              <button type="button" className="card-media-open" aria-label={t('{name} 그림 크게 보기', { name: ip.name })} onClick={() => showPicture(ip.ipId)}>
                <img src={src} alt={background ? t('{name} 전체 장면 배경', { name: ip.name }) : cut ? t('{name} 배경 제거', { name: ip.name }) : ip.name} width={512} height={512} loading="lazy" decoding="async" />
              </button>
            )}
          {drawing && (
            <>
              <span className="sr-only" role="status">{state === 'pending' ? t('{name} 이미지를 그리고 있어요.', { name: ip.name }) : t('{name} 새 버전을 그리고 있어요.', { name: ip.name })}</span>
              {/* progress changes every poll: visible, but not a live region (it would be read out each time) */}
              <p className="card-media-status" title={imageJob ? imageModelLabel(imageJob) : undefined}>
                {state === 'pending' ? t('그림 그리는 중') : t('새 버전 그리는 중')}{drawingMore}
              </p>
              {state === 'updating' && <span className="skel job-skel card-media-bar" aria-hidden="true" />}
            </>
          )}
          {state === 'failed' && <p className="card-media-status is-failed">{t('이미지를 만들지 못했어요')}{imageFailure ? ` · ${imageFailure}` : ''}. {t('‘작업 현황’ 탭에서 다시 시도하세요.')}</p>}
          {cutPicture !== null && <p className="card-media-status is-failed">{cutPicture.name}{cutPicture.problem ? `: ${cutPicture.problem}` : ''} · {t('다시 뽑기 권장')}</p>}
          {badge && <span className={`kind-badge kind-badge--${ip.kind}`} title={kindTitle(ip)}>{badge}</span>}
          {background ? <span className="kind-badge kind-badge--scene" title={t('배경을 지우지 않고 그림 전체를 써요.')}>{t('배경 · 전체 장면')}</span> : !noImage && <button
            type="button"
            className="cutout-toggle"
            aria-pressed={cut}
            aria-label={t('{name} 배경 제거한 그림 보기', { name: ip.name })}
            onClick={() => setCutout((c) => ({ ...c, [ip.ipId]: !cut }))}
          >
            {t('배경 제거')}
          </button>}
        </div>
        <div className="card-body">
          <div className="card-title">
            <h3>{ip.name}</h3>
            <button type="button" className="version version-btn" aria-label={t('{name} 버전 기록 (지금 v{n})', { name: ip.name, n: ip.version })}
              title={`${t('{name}의 이미지 버전 기록', { name: ip.name })}${imageModel ? ` · ${imageModel}` : ''}`} onClick={() => showVersions(ip.ipId)}>
              {/* the version alone: the model that drew it is the tooltip and in 버전 기록 */}
              v{ip.version}
              {imagesOf(ip.ipId).length > 1 && <span className="version-count">{imagesOf(ip.ipId).length}</span>}
            </button>
          </div>
          {ip.role && <p className="card-role">{ip.role}</p>}
          {description && <p className="card-desc" title={description}>{description}</p>}
          {actions.length > 0 && (
            <ul className="action-strip" aria-label={t('{name} 액션 컷', { name: ip.name })}>
              {actions.map((a, i) => (
                <li key={a.assetId}>
                  <a href={a.url} target="_blank" rel="noreferrer" title={String(a.meta?.action ?? '')}>
                    <img src={a.url} alt={t('{name} 액션 컷 {n}', { name: ip.name, n: i + 1 })} width={96} height={96} loading="lazy" decoding="async" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="card-actions">
            {modelReady ? (
              <button
                type="button"
                className="btn btn-sm btn-edit card-action-primary"
                disabled={noImage}
                title={imageBusy}
                aria-label={t('{name} 자연어로 수정하기', { name: ip.name })}
                onClick={openEdit}
              >
                {t('수정하기')}
              </button>
            ) : (
              <ActionButton
                className="btn btn-sm btn-primary"
                label={make3dLabel}
                busyLabel={t('시작하는 중…')}
                doneLabel={t('시작했어요')}
                disabled={threeDRunning}
                disabledLabel={making}
                ariaLabel={scene ? t('{name} 입체 판으로 만들기', { name: ip.name }) : t('{name} 3D로 만들기', { name: ip.name })}
                run={make3d}
              />
            )}
            <ActionMenu label={t('{name} 작업 더보기', { name: ip.name })} items={more} />
          </div>
          {chain ? (
            <p id={`ip-3d-status-${ip.ipId}`} className="card-status" role="status">
              {making}{chainSteps} · {chainTypical(chain.kinds)}. {t('끝나면 3D 탭에 나타나요.')}
            </p>
          ) : !modelReady && (
            <p className="card-hint">
              {scene ? `${t('배경은 걸어 다니는 3D 공간이 아니라 두께만 있는 입체 판으로 만들어져요')} · ${chainTypical(plan)}`
                : `${noImage ? tn('그림이 나온 뒤 {n}단계로 만들어요', plan.length) : tn('{n}단계로 만들어요', plan.length)} · ${chainTypical(plan)}`}
            </p>
          )}
          {keptOut && skeleton ? (
            // Both at once: one block that says both in a line, offers what helps, and keeps the reasons folded, so the card
            // still fits a short panel.
            <div className="card-note card-note--pair" role="note">
              <p>{pairLine}</p>
              {skeletonAction}
              <details className="card-note-more">
                <summary>{t('자세히 보기')}</summary>
                <p>{keptOutLine}</p>
                <p>{skeletonLine}</p>
                <span className="card-note-actions">{keptOutLinks}</span>
              </details>
            </div>
          ) : (keptOut || skeleton) && (
            <div className="card-note" role="note">
              <p>{keptOut ? keptOutLine : skeletonLine}</p>
              {keptOut ? <span className="card-note-actions">{keptOutLinks}</span> : skeletonAction}
            </div>
          )}
        </div>
      </article>
    );
  };

  // A long tab is found by name, as the session list is (FIND_FROM). `subject`: "캐릭터가" or "소품이", the tab's
  // word with its particle.
  const cards = (list: Ip[], of: 'characters' | 'props') => {
    const what = of === 'characters' ? t('캐릭터') : t('소품');
    const findLabel = of === 'characters' ? t('캐릭터 이름으로 찾기') : t('소품 이름으로 찾기');
    const asked = list.length >= FIND_FROM ? (find[what] ?? '').trim() : '';
    const shown = asked ? list.filter((ip) => ip.name.toLowerCase().includes(asked.toLowerCase())) : list;
    return list.length ? (
      <>
        {list.length >= FIND_FROM && (
          <div className="ip-find">
            <label htmlFor={`ip-find-${what}`} className="sr-only">{findLabel}</label>
            <input id={`ip-find-${what}`} type="search" value={find[what] ?? ''} placeholder={findLabel} autoComplete="off"
              onChange={(e) => setFind((f) => ({ ...f, [what]: e.target.value }))} />
            {asked && <span className="ip-find-count" role="status">{shown.length}/{list.length}</span>}
          </div>
        )}
        {shown.length ? <div className="card-grid">{shown.map(card)}</div>
          : <p className="empty empty--sm ip-find-none">{of === 'characters' ? t('‘{asked}’이(가) 들어간 캐릭터가 없어요.', { asked }) : t('‘{asked}’이(가) 들어간 소품이 없어요.', { asked })}</p>}
      </>
    ) : (
      <div className="empty empty-state">
        <span className="empty-state-icon" aria-hidden="true">✦</span>
        <h3>{of === 'characters' ? t('첫 캐릭터를 만들어 보세요') : t('세계에 필요한 소품과 배경을 만드세요')}</h3>
        <p>{t('채팅에 원하는 모습과 역할을 적어 주세요.')}</p>
        {/* where the chat is a shut drawer (a phone: the stylesheet shows this there), the lit way to it */}
        <button type="button" className="btn btn-primary empty-chat-open" onClick={() => window.dispatchEvent(new Event(CHAT_BOX_EVENT))}>{t('채팅 열기')}</button>
        <small>{of === 'characters' ? t('캐릭터가 준비되면 3D, 영상, 게임으로 이어갈 수 있어요.') : t('아이템부터 장소 전체까지, 같은 IP를 게임에 연결할 수 있어요.')}</small>
      </div>
    );
  };

  const threeD = () => {
    if (!glbs.length) {
      const n = inFlight('apose') + inFlight('mesh3d') + inFlight('render3d');
      return (
        <div className="empty empty-state" role={n ? 'status' : undefined}>
          <span className="empty-state-icon" aria-hidden="true">{n ? '◌' : '◇'}</span>
          <h3>{n ? t('3D를 만들고 있어요') : t('만든 IP를 3D로 만나보세요')}</h3>
          <p>{n ? t('3D 작업 {n}건이 기다리거나 진행 중이에요.', { n }) : t('캐릭터나 소품 카드에서 ‘3D로 만들기’를 누르세요.')}</p>
          <small>{n ? t('‘작업 현황’ 탭에서 각 단계를 확인할 수 있어요.') : t('준비된 모델은 이곳에서 돌려 보고 내려받을 수 있어요.')}</small>
        </div>
      );
    }
    // turntable/poster come from the same render job, or from the Blender job chained on a Hunyuan3D mesh job
    // (fallback: same IP)
    const filesOf = (glb: Asset) => {
      const turnJob = snap.jobs.find((j) => glb.jobId && j.deps.includes(glb.jobId))?.jobId;
      const sibling = (kind: Asset['kind']) =>
        snap.assets.find((a) => a.kind === kind && (glb.jobId ? a.jobId === glb.jobId || a.jobId === turnJob : a.ipId === glb.ipId));
      return { turntable: sibling('turntable'), poster: sibling('poster') };
    };
    const downloads = (glb: Asset, turntable?: Asset): MenuItem[] => [
      { label: t('3D 모델 파일 (.glb)'), href: glb.url, download: true },
      ...(turntable ? [{ label: t('3D 회전 영상 (.mp4)'), href: turntable.url, download: true }] : []),
    ];
    // Which picture each model was made from, when its jobs still say: a picture changed since leaves the model as
    // it was, so its card says so and remakes it from here (once the IP has a model its 3D button is under ⋯).
    const listed = models.map((runs) => {
      const ip = snap.ips.find((x) => x.ipId === runs[0].ipId);
      const glb = runs.find((a) => a.assetId === ip?.glbAssetId) ?? runs[runs.length - 1];
      const current = glb.assetId === ip?.glbAssetId; // the model the IP (and its games) use now
      const from = ip && current ? modelPicture(glb, snap.assets, snap.jobs) : undefined;
      return { runs, ip, glb, current, from, stale: !!ip && !!from && from.assetId !== ip.imageAssetId };
    });
    // A model made from an earlier picture comes first, and says so before its views, so the notice is in sight.
    const ordered = [...listed.filter((m) => m.stale), ...listed.filter((m) => !m.stale)];
    return (
      <div className="stack">
        {ordered.map(({ runs, ip, glb, current, from, stale }) => {
          const { turntable, poster } = filesOf(glb);
          const name = ipName(glb.ipId) ?? t('3D 모델');
          const earlier = runs.filter((a) => a !== glb).reverse(); // newest first
          // A 3D run is counted in words ("3번째 3D"), never as "v": that number is the picture's.
          const nth = (a: Asset) => t('{n}번째 3D', { n: runs.indexOf(a) + 1 });
          const run = [runs.length > 1 && nth(glb), current && t('지금 쓰는 모델')].filter(Boolean).join(' · ');
          const fromV = Number(from?.meta?.version ?? 1);
          const scene = ip?.usage === 'background';
          const thing = scene ? '입체 판' : '3D';
          // (the particle after a version is by how its number is read: the Korean page keeps its own sentence)
          const made = lang === 'en' ? (scene ? t('그림 v{n}으로 만든 입체 판이에요.', { n: fromV }) : t('그림 v{n}으로 만든 3D예요.', { n: fromV }))
            : `그림 ${vRo(fromV)} 만든 ${thing}${scene ? '이에요' : '예요'}.`;
          const plan = ip ? threeDSteps(ip) : [];
          return (
            <article key={glb.ipId ?? glb.assetId} className="card">
              {ip && stale && (
                <div className="model-stale">
                  <span className="badge badge--rejected">{scene ? t('이전 그림으로 만든 입체 판') : t('이전 그림으로 만든 3D')}</span>
                  <p className="model-stale-text">{made} {lang === 'en' ? t('지금 그림은 v{n}이에요.', { n: ip.version }) : `지금 그림은 ${vYeyo(ip.version)}.`}</p>
                  <ActionButton className="btn btn-sm btn-primary" label={scene ? t('지금 그림으로 입체 판 다시 만들기') : t('지금 그림으로 3D 다시 만들기')}
                    busyLabel={t('시작하는 중…')} doneLabel={t('시작했어요')}
                    disabled={threeDChain(ip.ipId, snap.jobs) !== null} disabledLabel={scene ? t('입체 판 만드는 중') : t('3D 만드는 중')}
                    run={() => onAction('render_3d', { ipId: ip.ipId })} />
                  <small>{stepsLead(plan)}{chainTypical(plan)}</small>
                </div>
              )}
              <div className="media-pair">
                <figure className="media-fig">
                  <div className="media media-16x9">
                    <model-viewer
                      src={glb.url}
                      poster={poster?.url}
                      alt={t('{name} 3D 모델', { name })}
                      camera-controls=""
                      auto-rotate={reduceMotion ? undefined : ''}
                      shadow-intensity="1"
                    />
                  </div>
                  <figcaption>{t('3D 모델 · 끌어서 돌려 보기')}</figcaption>
                </figure>
                {turntable && (
                  <figure className="media-fig">
                    <div className="media media-16x9">
                      <video src={turntable.url} poster={poster?.url} aria-label={t('{name} 3D 회전 영상', { name })} muted loop playsInline controls autoPlay={!reduceMotion} preload="metadata" />
                    </div>
                    <figcaption>{t('3D 회전 영상')}</figcaption>
                  </figure>
                )}
              </div>
              {ip && from && !stale && <p className="model-source">{made}</p>}
              <footer className="card-foot">
                <h3>{name}</h3>
                {run && <span className={current ? 'version is-current model-run' : 'version model-run'}>{run}</span>}
                <time className="card-foot-time" dateTime={glb.createdAt}>{fmtTime(glb.createdAt)}</time>
                <ActionMenu label={t('{name} 내려받기', { name })} items={downloads(glb, turntable)}>
                  {t('내려받기')}{chevron}
                </ActionMenu>
              </footer>
              {earlier.length > 0 && (
                <Fold id={`model-versions-${glb.ipId ?? glb.assetId}`} className="model-versions" title={t('이전 3D')} meta={t('{n}개', { n: earlier.length })}>
                  <ol className="version-list" aria-label={t('{name} 이전 3D', { name })}>
                    {earlier.map((a) => {
                      const files = filesOf(a);
                      return (
                        <li key={a.assetId} className="version-item">
                          {files.poster && <img src={files.poster.url} alt="" width={72} height={40} loading="lazy" decoding="async" />}
                          <span className="model-version-text">
                            <strong>{nth(a)}</strong>
                            <time dateTime={a.createdAt}>{fmtTime(a.createdAt)}</time>
                          </span>
                          <ActionMenu label={t('{name} {nth} 내려받기', { name, nth: nth(a) })} items={downloads(a, files.turntable)}>
                            {t('내려받기')}{chevron}
                          </ActionMenu>
                        </li>
                      );
                    })}
                  </ol>
                </Fold>
              )}
            </article>
          );
        })}
      </div>
    );
  };

  const isVertical = (a: Asset) =>
    a.kind === 'shorts' ||
    a.meta?.aspect_ratio === '9:16' ||
    snap.jobs.find((j) => j.jobId === a.jobId)?.input?.aspect_ratio === '9:16';

  const jobOf = (a: Asset) => snap.jobs.find((j) => j.jobId === a.jobId);
  const editFor = (a: Asset): EditTarget | null => {
    if (a.kind === 'trailer') return { kind: 'trailer', asset: a };
    if (a.kind !== 'shot' || !a.jobId) return null;
    const inp = jobOf(a)?.input ?? {};
    return {
      kind: 'shot', asset: a, name: ipName(a.ipId),
      prompt: typeof inp.prompt === 'string' ? inp.prompt : undefined,
      model: typeof inp.model === 'string' ? inp.model : undefined,
      seconds: typeof inp.seconds === 'number' ? inp.seconds : undefined,
    };
  };

  // busy: the section's jobs in flight ("작업 1건 진행 중…"), said above the videos it already has too
  const videoSection = (of: 'shot' | 'trailer' | 'shorts', title: string, list: Asset[], hint: string, busy: string, wide = false) => (
    <section className="video-section" aria-label={title}>
      <h3>
        {title} <span className="count">{list.length}</span>
        {of === 'trailer' && (
          <button type="button" className="btn btn-sm btn-edit section-action" onClick={() => onEdit({ kind: 'trailer' })}>
            {t('연출해서 만들기')}
          </button>
        )}
      </h3>
      {busy && list.length > 0 && <p className="empty empty--sm" role="status" style={{ marginBottom: 12 }}>{busy}</p>}
      {list.length ? (
        <div className={wide ? 'video-grid video-grid--wide' : 'video-grid'}>
          {list.map((a, i) => {
            const vertical = isVertical(a);
            const name = ipName(a.ipId);
            const model = shotModelLabel(a);
            // what an edit of a shot does (an upscale or a restyle is told from the shot it was made from);
            // a 250 px card cuts the longer line at the model, so the whole of it is the tooltip
            const what = a.kind === 'shot' ? editLabel(a.meta ?? {}) : undefined;
            const caption = `${title} ${i + 1}${name ? ` · ${name}` : ''}${what ? ` · ${what}` : ''}${model ? ` · ${model}` : ''}`;
            const edit = editFor(a);
            const inp = jobOf(a)?.input;
            // 수정하기 (다시 연출) stays visible when the asset can be edited; re-roll and download wait behind ⋯
            const more: MenuItem[] = [
              ...(a.kind === 'shot' && inp?.ipId && inp.prompt ? [{
                label: t('다시 뽑기'), busyLabel: t('등록 중…'),
                onSelect: () => onAction('make_video_shot', {
                  ipId: inp.ipId, prompt: inp.prompt, aspect_ratio: inp.aspect_ratio ?? '16:9',
                  ...(typeof inp.seconds === 'number' ? { duration: inp.seconds } : {}),
                  ...(typeof inp.model === 'string' ? { model: inp.model } : {}),
                }),
              }] : []),
              { label: t('내려받기'), href: a.url, download: true },
            ];
            return (
              <figure key={a.assetId} className={vertical ? 'video-card is-vertical' : 'video-card'}>
                <div className={vertical ? 'media media-9x16' : 'media media-16x9'}>
                  <video src={a.url} aria-label={`${title} ${i + 1}${name ? ` · ${name}` : ''}`} controls playsInline preload="metadata" />
                </div>
                <figcaption>
                  <span title={caption}>{caption}</span>
                  <span className="figure-actions">
                    {edit && (
                      <button type="button" className="link-btn" aria-label={t('{what} 수정하기', { what: `${title} ${i + 1}` })} onClick={() => onEdit(edit)}>
                        {a.kind === 'trailer' ? t('다시 연출') : t('수정하기')}
                      </button>
                    )}
                    <ActionMenu label={t('{name} 작업 더보기', { name: `${title} ${i + 1}${name ? ` · ${name}` : ''}` })} items={more} />
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : (
        <p className="empty empty--sm" role={busy ? 'status' : undefined}>{busy || hint}</p>
      )}
    </section>
  );

  const video = () => {
    // each section counts only the jobs that make its own kind: shots their shot jobs, trailers the trailer jobs,
    // shorts the trailer jobs that also cut 9:16 shorts
    const waiting = (n: number) => (n ? t('작업 {n}건 진행 중…', { n }) : '');
    const cutsShorts = snap.jobs.filter((j) => j.kind === 'trailer' && j.input?.make_shorts === true
      && (j.status === 'queued' || j.status === 'running')).length;
    return (
      <>
        {/* the hint names both ways in: a character card's 액션 샷 and a prop card's 영상 샷 */}
        {videoSection('shot', t('샷'), shots, t('아직 영상이 없어요. 캐릭터 카드의 ⋯ 메뉴에서 ‘액션 샷’, 소품 카드의 ⋯ 메뉴에서 ‘영상 샷’을 고르거나 채팅으로 요청하세요 (샷 하나에 {usual}).', { usual: SHOT_TYPICAL.ltx }),
          waiting(inFlight('shot')))}
        {videoSection('trailer', t('트레일러'), trailers, t('준비된 영상을 하나로 연결해 보세요. ‘연출해서 만들기’에서 순서와 제목을 정할 수 있어요.'), waiting(inFlight('trailer')), true)}
        {videoSection('shorts', t('쇼츠'), shorts, t('트레일러 연출에서 세로형 쇼츠(9:16)를 함께 만들 수 있어요.'), waiting(cutsShorts))}
      </>
    );
  };

  return (
    <section className="pane" aria-labelledby="ip-pane-title">
      <div className="pane-head">
        <span className="pane-num" aria-hidden="true">01</span>
        <div className="pane-title">
          <h2 id="ip-pane-title">IP &amp; MEDIA <span>STUDIO</span></h2>
          <p className="pane-sub">{t('캐릭터와 소품을 만들고, 3D·영상으로 이어가세요')}</p>
        </div>
      </div>
      <Tabs
        hashKey="ip"
        label={t('IP 보기')}
        tabs={TABS.map((tab) => ({ id: tab.id, label: t(tab.label), count: { characters: characters.length, props: props.length, '3d': models.length,
          video: shots.length + trailers.length + shorts.length, pipeline: snap.jobs.length }[tab.id] }))}
      >
        {(tab) =>
          tab === 'characters' ? cards(characters, 'characters') : tab === 'props' ? cards(props, 'props') : tab === '3d' ? threeD()
            : tab === 'video' ? video() : <JobsPanel snap={snap} onRetry={onRetry} onCancel={onCancelJob}
              onReroll={(ipId) => onAction('reroll_ip_image', { ipId }, true)} onVersions={showVersions} />
        }
      </Tabs>
      {versionsIp && (
        <VersionDrawer
          ip={versionsIp}
          images={imagesOf(versionsIp.ipId)}
          jobs={snap.jobs}
          onClose={() => showVersions(null)}
          onRestore={(imageAssetId) => onAction('restore_ip_version', { ipId: versionsIp.ipId, imageAssetId })}
          onReroll={() => onAction('reroll_ip_image', { ipId: versionsIp.ipId }, true)}
          onEdit={() => {
            showVersions(null);
            onEdit({ kind: 'ip', ip: versionsIp, imageUrl: assetById.get(versionsIp.imageAssetId)?.url });
          }}
        />
      )}
      {pictureIp && pictureShown && (() => {
        // the words it was drawn from, when they are the image model's English prompt: no description for the card,
        // so here behind a fold. Korean words are on the card already
        const words = currentDescription(pictureIp, assetById.get(pictureIp.imageAssetId));
        return (
          <PictureModal title={`${pictureIp.name} · v${pictureIp.version}`} src={pictureShown.url} cutout={pictureCut}
            alt={pictureCut ? t('{name} 배경 제거', { name: pictureIp.name }) : pictureIp.name} prompt={korean(words) ? undefined : words}
            onClose={() => showPicture(null)} />
        );
      })()}
    </section>
  );
}
