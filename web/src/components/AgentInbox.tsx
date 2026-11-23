import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { approveProposal, dismissProposal, testProposal, type AgentNote, type Proposal, type ProposalStatus, type TrialResult } from '../api';
import { fmtTime } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { useDialog } from './useDialog';

interface Props {
  notes: AgentNote[] | null;
  putProposal: (p: Proposal) => void;
  onClose: () => void;
}

export const STATUS_LABEL: Record<ProposalStatus, string> = {
  proposed: t('제안'), testing: t('테스트 중'), passed: t('테스트 통과'), failed: t('테스트 실패'), promoted: t('모델 목록에 추가됨'), dismissed: t('거절함'),
};
/** The trial's phase as the server names it; an unknown one shows as it came. */
const PHASE_LABEL: Record<string, string> = {
  queued: t('대기 중'), starting: t('GPU 서버 켜는 중'), booting: t('GPU 서버 켜는 중'), provisioning: t('GPU 서버 준비 중'),
  downloading: t('모델 내려받는 중'), installing: t('모델 설치 중'), loading: t('모델 올리는 중'), warming: t('모델 예열 중'),
  generating: t('결과 만드는 중'), baseline: t('기존 모델로 만드는 중'), candidate: t('새 모델로 만드는 중'), uploading: t('결과 올리는 중'),
  stopping: t('GPU 서버 끄는 중'),
};
const KIND_LABEL = { image: t('이미지'), video: t('영상') } as const;
const MODE_LABEL: Record<TrialResult['mode'], string> = { t2i: t('텍스트→이미지'), i2i: t('이미지→이미지'), t2v: t('텍스트→영상'), i2v: t('이미지→영상') };

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
};

/** 에이전트 받은 편지함: the agents' notes, newest first; a note with a model proposal is a card the trial runs from. A
 * wide drawer like the other tools, so the open session stays where it was and the results compare side by side. */
export function AgentInbox({ notes, putProposal, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose);
  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} />
      <div ref={panel} className="drawer drawer--inbox" role="dialog" aria-modal="true" aria-labelledby="inbox-title">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">AGENT · INBOX</p>
            <h2 id="inbox-title">{t('에이전트 받은 편지함')}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        <div className="dialog-body">
          {notes === null && <p className="muted">{t('받은 편지함을 불러오는 중…')}</p>}
          {notes?.length === 0 && <p className="muted">{t('아직 알림이 없어요. 에이전트가 실행되면 여기에 결과가 와요.')}</p>}
          {notes && notes.length > 0 && (
            <ol className="inbox-list">
              {notes.map((n) => (
                <li key={n.noteId} className="inbox-note">
                  <p className="inbox-note-meta"><strong>{n.agentName}</strong> · <time dateTime={n.createdAt}>{fmtTime(n.createdAt)}</time></p>
                  <h3 className="inbox-note-title">{n.title}</h3>
                  {n.body && <div className="inbox-note-body">{markdown(n.body)}</div>}
                  {n.proposal && <ProposalCard proposal={n.proposal} onChange={putProposal} />}
                </li>
              ))}
            </ol>
          )}
        </div>
        {/* the usual foot of a drawer */}
        <div className="dialog-footer">
          <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>{t('닫기')}</button></div>
        </div>
      </div>
    </div>
  );
}

/** Inline **bold**, `code` and [text](https://…) links, as React nodes (no HTML from the note is ever injected). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] ? <strong key={m.index}>{m[1]}</strong> : m[2] ? <code key={m.index}>{m[2]}</code>
      : <a key={m.index} href={m[4]} target="_blank" rel="noreferrer">{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The note body's markdown: headings, - / * / 1. lists and paragraphs; anything else reads as plain text. */
export function markdown(body: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>);
    para = [];
    if (list) {
      const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
      blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    }
    list = null;
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) { flush(); blocks.push(<h4 key={blocks.length}>{inline(heading[1])}</h4>); }
    else if (bullet || numbered) {
      const ordered = !!numbered;
      if (para.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else { if (list) flush(); para.push(line); }
  }
  flush();
  return blocks;
}

type Ask = 'test' | 'approve' | 'dismiss' | null;

export function ProposalCard({ proposal: p, onChange }: { proposal: Proposal; onChange: (p: Proposal) => void }) {
  const [ask, setAsk] = useState<Ask>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(fn: (id: string) => Promise<Proposal>) {
    setAsk(null); setBusy(true); setError(null);
    try { onChange(await fn(p.proposalId)); } catch (e) {
      setError(e instanceof Error ? e.message : t('요청이 실패했어요.'));
    } finally { setBusy(false); }
  }

  const trial = p.trial;
  return (
    <article className={`proposal-card proposal-card--${p.status}`} aria-label={t('{label} 모델 제안', { label: p.label })}>
      <header className="proposal-head">
        <span className={`proposal-kind proposal-kind--${p.kind}`}>{KIND_LABEL[p.kind]}</span>
        <a className="proposal-model" href={`https://huggingface.co/${p.hfRepo}`} target="_blank" rel="noreferrer">{p.label}</a>
        <span className={`proposal-status proposal-status--${p.status}`}>{STATUS_LABEL[p.status]}</span>
      </header>
      <p className="proposal-repo">{p.hfRepo}</p>
      <dl className="proposal-facts">
        <div>
          <dt>{t('라이선스')}</dt>
          <dd>{p.license}{!p.commercialOk && <span className="proposal-flag">{t('비상업용')}</span>}</dd>
        </div>
        <div><dt>VRAM</dt><dd>{p.vramGb} GB · {p.instance}</dd></div>
      </dl>
      <section className="proposal-why"><h4>{t('왜 더 좋은지')}</h4><p>{p.why}</p></section>
      <section className="proposal-risks"><h4>{t('위험')}</h4><p>{p.risks}</p></section>

      {p.status === 'testing' && <TrialProgress phase={trial?.phase} startedAt={trial?.startedAt} />}
      {p.status === 'failed' && <p className="proposal-error" role="alert">{trial?.error || t('테스트가 실패했어요.')}</p>}
      {p.status === 'passed' && trial && <ResultsGrid results={trial.results} candidate={p.label} />}
      {p.status === 'promoted' && <p className="proposal-promoted">{t('모델 목록에 추가됨 · {kind} 모델을 고를 때 선택할 수 있어요', { kind: KIND_LABEL[p.kind] })}</p>}
      {error && <p className="proposal-error" role="alert">{error}</p>}

      {(p.status === 'proposed' || p.status === 'passed' || p.status === 'failed') && (
        <div className="proposal-actions">
          {p.status === 'proposed' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => setAsk('test')}>{t('테스트')}</button>}
          {p.status === 'failed' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => setAsk('test')}>{t('다시 테스트')}</button>}
          {p.status === 'passed' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => setAsk('approve')}>{t('승인')}</button>}
          {p.status !== 'failed' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAsk('dismiss')}>{t('거절')}</button>}
        </div>
      )}
      {/* What each press does, takes and costs, said before it. The figures are the server's: a trial's time and cost
          as its progress line says them, a promoted model's first start and its parked disk (server/agents.py approve,
          STOPPED_DISK_MONTHLY). */}
      {ask === 'test' && (
        <ConfirmDialog title={t('{label} 테스트', { label: p.label })} confirmLabel={t('테스트 시작')}
          message={t('GPU 서버를 새로 켜서 이 모델을 설치하고, 지금 쓰는 모델과 같은 주문으로 결과를 만들어 비교해요. 보통 30–60분 걸리고 GPU 비용이 약 $2–3 들어요. 시작한 뒤에는 멈출 수 없어요.')}
          onConfirm={() => void call(testProposal)} onCancel={() => setAsk(null)} />
      )}
      {ask === 'approve' && (
        <ConfirmDialog title={t('{label} 승인', { label: p.label })} confirmLabel={t('승인')}
          message={t('이 모델을 {kind} 모델 목록에 추가해요. 바로 끝나고, 다음 요청부터 고를 수 있어요 (기본 모델은 그대로예요). 모델 서버는 쓸 때만 켜지고 처음 켤 때 약 10분 걸려요. 쓰는 동안에는 GPU 요금이, 꺼져 있는 동안에도 저장 공간 요금(월 약 $24)이 들어요.',
            { kind: KIND_LABEL[p.kind] })}
          onConfirm={() => void call(approveProposal)} onCancel={() => setAsk(null)} />
      )}
      {ask === 'dismiss' && (
        <ConfirmDialog title={t('{label} 제안을 거절할까요?', { label: p.label })} confirmLabel={t('거절')} danger
          message={p.status === 'passed'
            ? t('이 제안을 닫아요. 테스트해 둔 모델 서버도 지워서, 다시 쓰려면 새로 제안받아 테스트해야 해요. 목록에는 ‘거절함’으로 남아요. 비용은 들지 않아요.')
            : t('이 제안을 닫아요. 목록에는 ‘거절함’으로 남고, 다시 테스트하거나 승인할 수 없어요. 비용은 들지 않아요.')}
          onConfirm={() => void call(dismissProposal)} onCancel={() => setAsk(null)} />
      )}
    </article>
  );
}

/** The trial's phase (the inbox re-reads it every 10 s) and a ticking elapsed time. */
function TrialProgress({ phase, startedAt }: { phase?: string; startedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const started = startedAt ? Date.parse(startedAt) : NaN;
  return (
    <div className="proposal-trial" role="status">
      <p className="proposal-phase">
        <span className="proposal-pulse" aria-hidden="true" />
        {phase ? PHASE_LABEL[phase] ?? phase : t('테스트 준비 중')}
        {Number.isFinite(started) && <span className="proposal-elapsed"> · {t('경과 {time}', { time: clock(now - started) })}</span>}
      </p>
      <p className="field-hint">{t('보통 30–60분 · GPU 비용 약 $2–3')}</p>
    </div>
  );
}

const isVideo = (mode: TrialResult['mode']) => mode === 't2v' || mode === 'i2v';

/** Per prompt: (the reference picture for i2i / i2v), the model in use, the candidate. */
export function ResultsGrid({ results, candidate }: { results: TrialResult[]; candidate: string }) {
  if (!results.length) return <p className="muted">{t('결과물이 없어요.')}</p>;
  return (
    <ol className="trial-results" aria-label={t('테스트 결과 비교')}>
      {results.map((r, i) => {
        const media = (url: string, label: string) => (isVideo(r.mode)
          ? <video src={url} controls preload="metadata" playsInline aria-label={label} />
          : <img src={url} alt={label} loading="lazy" />);
        return (
          <li key={i} className={`trial-row${r.referenceUrl ? ' has-ref' : ''}`}>
            <p className="trial-prompt"><span className="trial-mode">{MODE_LABEL[r.mode] ?? r.mode}</span> {r.prompt}</p>
            <div className="trial-cells">
              {r.referenceUrl && (
                <figure className="trial-cell trial-cell--ref">
                  <figcaption>{t('참조 이미지')}</figcaption>
                  <img src={r.referenceUrl} alt={t('참조 이미지')} loading="lazy" />
                </figure>
              )}
              <figure className="trial-cell trial-cell--baseline">
                <figcaption>{r.baseline.model}</figcaption>
                {media(r.baseline.url, t('{model} 결과', { model: r.baseline.model }))}
              </figure>
              <figure className="trial-cell trial-cell--candidate">
                <figcaption>{candidate}{r.candidate.seconds != null && <small> · {t('{n}초', { n: Math.round(r.candidate.seconds) })}</small>}</figcaption>
                {media(r.candidate.url, t('{model} 결과', { model: candidate }))}
              </figure>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
