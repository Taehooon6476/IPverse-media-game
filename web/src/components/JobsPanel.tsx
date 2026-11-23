import { useEffect, useReducer } from 'react';
import { lang, t } from '../i18n';
import { SKELETON_NEEDS, STATUS_LABEL, drawLine, errorText, hasFailed, isCommandLine, jobLabel, jobOrder, jobTerm, jobTimes, jobWait, notAsAsked, plainLine,
  providerDetail, providerLabel, rigRefusal, serverLine, type Job, type Snapshot } from '../types';
import { ActionButton } from './ActionButton';
import { jobNote } from '../types';
import { Fold } from './Fold';
import { jobEdit, jobTitle } from '../types';

interface Props {
  snap: Snapshot;
  /** Re-queue a failed job (and the ones that failed because of it). */
  onRetry: (jobId: string) => Promise<void>;
  /** 중지 on a queued or running job, as the top bar's 작업 menu has it. Without it the rows show no 중지. */
  onCancel?: (jobId: string) => Promise<void>;
  /** 다시 뽑기 of an IP's picture: what a refused rig or a flagged picture in use asks for. */
  onReroll?: (ipId: string) => Promise<void>;
  /** Open the IP's 버전 기록: where a picture the IP did not take can be seen (and chosen after all). */
  onVersions?: (ipId: string) => void;
}

const DEP_FAILED = '선행 작업 실패'; // server/jobs.py: retried together with the job that caused it
const CANCELED = '사용자가 중지함'; // server/jobs.py: 중지
/** A stored line as a row's tooltip, in the page's language. A provider's line the English page cannot say whole
 * is no tooltip there: the row's own line says it. */
const hover = (line: string) => {
  const said = serverLine(line);
  return lang === 'en' && /[가-힣]/.test(said) ? undefined : said;
};

/** A job's place in 작업 현황. A done job that was no plain success (a picture that failed its check, a stand-in
 * delivered for the GPU's result) is 'rejected', neither done nor failed. It is told as the toasts tell it (types.ts
 * notAsAsked): by the server's mark on the job, or by its note. */
type Group = 'running' | 'failed' | 'rejected' | 'done';
const groupOf = (j: Job): Group => (j.status === 'queued' || j.status === 'running' ? 'running' : hasFailed(j) ? 'failed' : notAsAsked(j) ? 'rejected' : 'done');

/** 작업 현황: every job of the session (images, 3D, video shots, trailers, games) by status, with what to do next on
 * each: 중지 while it waits or runs, 다시 시도 when it failed, another picture when its picture is the cause. */
export function JobsPanel({ snap, onRetry, onCancel, onReroll, onVersions }: Props) {
  // re-render every second while a job runs, so elapsed times tick between polls
  const running = snap.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  /** The step that failed by itself behind a job that never started ("선행 작업 실패"), through the blocked ones between. */
  const cause = (j: Job, seen = new Set<string>()): Job | undefined => {
    for (const id of j.deps) {
      const dep = snap.jobs.find((x) => x.jobId === id && x.status === 'failed');
      if (!dep || seen.has(dep.jobId)) continue;
      seen.add(dep.jobId);
      return dep.error === DEP_FAILED ? cause(dep, seen) ?? dep : dep;
    }
    return undefined;
  };
  const named = (j: Job) => [jobLabel(j), jobTitle(j, snap.ips)].filter(Boolean).join(' · ');

  const jobItem = (j: Job) => {
    const name = jobTitle(j, snap.ips);
    const ipId = typeof j.input?.ipId === 'string' ? j.input.ipId : undefined;
    const ip = snap.ips.find((x) => x.ipId === ipId);
    const { progress, usual } = jobWait(j); // next to 경과: the job's own estimate (off its progress line) or the usual time
    const note = jobNote(j, snap.ips); // an image's check note names the picture its IP uses now (되돌리기 moves it)
    const group = groupOf(j);
    const inFlight = group === 'running';
    // What the check turned down, and whether it is in use after all. A picture of an IP is read off the IP as it is
    // now; anything else is as the server marked it when it ended (an unmarked older record is a delivered stand-in).
    const picture = j.kind === 'image' && !!ip?.imageAssetId;
    const inUse = group === 'rejected' && (picture ? j.outputs.includes(ip.imageAssetId!)
      : j.outcome ? j.outcome === 'check_failed' : j.kind !== 'image');
    // a 움직임 뼈대 the farm refused for the figure's shape: the same try fails again, so its row offers another
    // picture and no 다시 시도
    const rig = rigRefusal(j);
    const failed = group === 'failed';
    // refused by its provider, as the server marks it and says why (any kind; a rig's is read by rigRefusal)
    const refused = failed && !rig && j.outcome === 'refused' && j.reason?.trim() ? j.reason.trim() : '';
    const blocked = failed && j.error === DEP_FAILED;
    const stopped = failed && j.error === CANCELED;
    const behind = blocked ? cause(j) : undefined;
    // What happened and what to do. The raw line a provider left is the tooltip, never a command line.
    const why = rig ? t('{why}. {needs}으로 다시 뽑은 뒤 3D를 다시 만들어 주세요.', { why: rig.why.replace(/^[a-z]/, (c) => c.toUpperCase()), needs: SKELETON_NEEDS })
      : refused ? serverLine(refused)
        : blocked ? (behind ? t('앞 단계({step})가 실패해 시작하지 못했어요. 그 단계에서 ‘다시 시도’를 누르면 함께 다시 시작돼요.', { step: named(behind) })
          : t('앞 단계가 실패해 시작하지 못했어요. 실패한 앞 단계에서 ‘다시 시도’를 누르면 함께 다시 시작돼요.'))
          : stopped ? t('중지한 작업이에요. ‘다시 시도’를 누르면 다시 시작돼요.')
            : note ? errorText(note)
              // marked by the server with no line of its own: what the mark says
              : inUse ? (picture ? t('검사를 통과하지 못한 그림이에요. 다시 뽑는 편이 좋아요.') : t('검사를 통과하지 못한 결과예요.'))
                : picture ? t('검사를 통과하지 못해 적용하지 않았어요. 지금 그림을 그대로 써요.') : t('검사를 통과하지 못해 적용하지 않았어요.');
    const state = inFlight ? j.status : group;
    const label = `${jobLabel(j)}${name ? ` ${name}` : ''}`;
    const whose = ip?.name ?? name ?? '';
    return (
      <li key={j.jobId} className={`job job--${state}`} data-job={j.jobId}>
        <div className="job-head">
          {/* the step in the lead's words; the studio's own word for it (리깅, 턴테이블) is the tooltip */}
          <span className="job-kind" title={jobTerm(j)}>
            {jobLabel(j)}
            {name && <span className="job-target" title={jobEdit(j)}> · {name}</span>}
          </span>
          <span className={`badge badge--${state}`}>{group === 'rejected' ? (inUse ? t('검사 실패') : t('적용 안 됨')) : STATUS_LABEL[failed ? 'failed' : j.status]}</span>
        </div>
        <div className="job-meta">
          {/* where it runs in plain words; the service, tool and model are the tooltip */}
          <span title={providerDetail(j)}>{providerLabel(j)}</span>
          <span className="job-elapsed">{jobTimes(j)}{inFlight ? ` · ${usual}` : ''}</span>
        </div>
        {/* what it is doing, and 중지 beside it while it waits or runs (the top bar's 작업 menu has the same button) */}
        {((progress && j.status !== 'done') || (inFlight && onCancel)) && (
          <div className="job-run">
            {/* (the line as written is the tooltip when the card says it another way: a studio word, a model's name;
                in the page's language like the line itself) */}
            {progress && j.status !== 'done' && <p className="job-progress"
              title={plainLine(j.kind === 'image' ? drawLine(j.progress) : j.progress) === serverLine(j.progress) ? undefined : hover(j.progress)}>{progress}</p>}
            {inFlight && onCancel && (
              <ActionButton className="btn btn-sm btn-outline jobs-menu-stop" label={t('중지')} busyLabel={t('중지 중…')} doneLabel={t('중지됨')}
                ariaLabel={t('{label} 중지', { label })} run={() => onCancel(j.jobId)} />
            )}
          </div>
        )}
        {j.status === 'running' && <span className="skel job-skel" aria-hidden="true" />}
        {(note || rig || refused || group === 'rejected') && (
          <div className="job-error-row">
            <p className={group === 'rejected' ? 'job-error job-error--check' : 'job-error'}
              title={!note || why === serverLine(note.trim()) || isCommandLine(note) || blocked || stopped ? undefined : hover(note)}>{why}</p>
            <span className="job-actions">
              {/* a refusal is the provider's answer to this very input: the same try is refused again, whatever the
                  kind, so no 다시 시도 */}
              {failed && !blocked && !rig && j.outcome !== 'refused' && (
                <ActionButton
                  className="btn btn-sm btn-edit"
                  label={t('다시 시도')}
                  busyLabel={t('다시 등록 중…')}
                  doneLabel={t('다시 대기열에')}
                  ariaLabel={t('{label} 다시 시도', { label })}
                  run={() => onRetry(j.jobId)}
                />
              )}
              {/* another picture is what helps: a rig refused for its picture, a flagged picture the IP uses */}
              {(rig || (inUse && picture)) && ipId && onReroll && (
                <ActionButton className="btn btn-sm btn-edit" label={rig ? t('그림 다시 뽑기') : t('다시 뽑기')} busyLabel={t('요청 중…')} doneLabel={t('뽑는 중')}
                  ariaLabel={(rig ? t('{name} 그림 다시 뽑기', { name: whose }) : t('{name} 다시 뽑기', { name: whose })).trim()} run={() => onReroll(ipId)} />
              )}
              {group === 'rejected' && !inUse && j.kind === 'image' && ipId && onVersions && (
                <button type="button" className="btn btn-sm btn-edit" aria-label={t('{name} 버전 기록 보기', { name: whose }).trim()}
                  onClick={() => onVersions(ipId)}>{t('버전 기록 보기')}</button>
              )}
            </span>
          </div>
        )}
      </li>
    );
  };

  // 작업 현황 by status: what is moving, what failed (with 다시 시도) and what a check turned down stay open, the
  // finished ones fold away
  const jobGroups = ([
    { id: 'running', title: t('진행 중'), open: true },
    { id: 'failed', title: t('실패'), open: true },
    { id: 'rejected', title: t('검사 실패'), open: true },
    { id: 'done', title: t('완료'), open: false },
  ] as const).map((g) => ({ ...g, jobs: snap.jobs.filter((j) => groupOf(j) === g.id).sort(jobOrder) }));
  return snap.jobs.length ? (
    <div className="job-groups">
      {jobGroups.filter((g) => g.jobs.length).map((g) => (
        <Fold key={g.id} id={`jobs-${g.id}`} className="job-group" title={g.title} defaultOpen={g.open} storageKey={`ipverse.jobsOpen.${g.id}`}
          meta={<span className={`badge badge--${g.id}`}>{t('{n}건', { n: g.jobs.length })}</span>}>
          <ol className="jobs">{g.jobs.map(jobItem)}</ol>
        </Fold>
      ))}
    </div>
  ) : (
    <div className="empty empty-state">
      <span className="empty-state-icon" aria-hidden="true">◷</span>
      <h3>{t('진행 중인 작업이 없어요')}</h3>
      <p>{t('3D나 영상을 만들기 시작하면 진행 상황과 결과가 여기에 보여요.')}</p>
    </div>
  );
}
