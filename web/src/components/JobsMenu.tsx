import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { STATUS_LABEL, jobLabel, jobOrder, jobTerm, jobWait, providerDetail, providerLabel, type Job } from '../types';
import { ActionButton } from './ActionButton';

interface Props {
  /** Queued and running jobs, each with the IP or title it works on. */
  jobs: { job: Job; name?: string }[];
  onCancel: (jobId: string) => Promise<void>;
}

/** The top bar's status pill as a dropdown: which jobs are running, and a 중지 button on each. Esc or a click
 * outside closes it and focus returns to the pill. */
export function JobsMenu({ jobs, onCancel }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (!jobs.length) setOpen(false); }, [jobs.length]);

  if (!jobs.length) {
    return <span className="status-pill" role="status" title={t('세션에서 바꾼 내용은 자동으로 저장돼요.')}><span className="status-dot" aria-hidden="true" />{t('자동 저장됨')}</span>;
  }
  return (
    <div className="jobs-menu" ref={root}>
      <button ref={button} type="button" className="status-pill is-busy jobs-menu-btn" aria-expanded={open} aria-controls="jobs-menu-panel"
        aria-label={open ? t('대기 또는 진행 중인 작업 {n}건 · 작업 현황 닫기', { n: jobs.length }) : t('대기 또는 진행 중인 작업 {n}건 · 작업 현황 열기', { n: jobs.length })}
        onClick={() => setOpen((o) => !o)}>
        <span className="status-dot" aria-hidden="true" />
        {t('작업 {n}건', { n: jobs.length })}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div id="jobs-menu-panel" className="jobs-menu-panel" role="region" aria-label={t('진행 중인 작업')}>
          <ul>
            {[...jobs].sort((a, b) => jobOrder(a.job, b.job)).map(({ job: j, name }) => {
              const { progress, usual } = jobWait(j); // the job's own estimate (a chained restyle's) or the usual time
              return (
                <li key={j.jobId} className="jobs-menu-item">
                  <div className="jobs-menu-text">
                    <strong title={jobTerm(j)}>{jobLabel(j)}{name && <span className="job-target"> · {name}</span>}</strong>
                    {/* wraps instead of an ellipsis: the estimate ends the line and was cut off there */}
                    <span className="jobs-menu-state">{STATUS_LABEL[j.status]}{progress ? ` · ${progress}` : ''} · {usual}</span>
                    {j.status === 'running' && <span className="skel job-skel" aria-hidden="true" />}
                    <span className="jobs-menu-provider" title={providerDetail(j)}>{providerLabel(j)}</span>
                  </div>
                  <ActionButton className="btn btn-sm btn-outline jobs-menu-stop" label={t('중지')} busyLabel={t('중지 중…')} doneLabel={t('중지됨')}
                    ariaLabel={t('{label} 중지', { label: `${jobLabel(j)}${name ? ` ${name}` : ''}` })} run={() => onCancel(j.jobId)} />
                </li>
              );
            })}
          </ul>
          <p className="muted jobs-menu-hint">{t('자세한 진행 상황과 다시 시도는 ‘작업 현황’ 탭에서 확인하세요.')}</p>
        </div>
      )}
    </div>
  );
}
