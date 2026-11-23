import { useState } from 'react';
import { lang, t } from '../i18n';
import { deleteAgent, patchAgent, runAgent, type Agent } from '../api';
import { fmtTime, josa } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  agents: Agent[] | null;
  /** The server cannot be reached now: the list did not load, and loads again when the connection is back. */
  unreachable?: boolean;
  unread: number;
  onRegister: () => void;
  onEdit: (agent: Agent) => void;
  onInbox: () => void;
  putAgent: (agentId: string, agent: Agent | null) => void;
  /** After 지금 실행: the run lands in the list (lastRun) and its note in the inbox. */
  onRan: () => void;
  onNotice: (text: string) => void;
  onError: (e: unknown) => void;
}

const RUN_LABEL: Record<string, string> = { running: t('실행 중'), ok: t('성공'), success: t('성공'), succeeded: t('성공'), done: t('성공'), error: t('실패'), failed: t('실패') };
export const runLabel = (status: string) => RUN_LABEL[status] ?? status;
const runTone = (status: string) => (runLabel(status) === t('성공') ? 'ok' : runLabel(status) === t('실패') ? 'err' : 'busy');

/** The agent part of the sidebar's 스킬 · Agent 등록 fold: each agent with its schedule, on/off, last run and
 * 지금 실행 (after a confirm), then 받은 편지함 and + 에이전트 등록. */
export function AgentList({ agents, unreachable = false, unread, onRegister, onEdit, onInbox, putAgent, onRan, onNotice, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [asking, setAsking] = useState<Agent | null>(null); // ▶ 지금 실행 waits for its confirm

  async function act(agent: Agent, work: () => Promise<void>) {
    setBusy(agent.agentId);
    try { await work(); } catch (e) { onError(e); } finally { setBusy(null); }
  }
  const toggle = (a: Agent) => act(a, async () => putAgent(a.agentId, await patchAgent(a.agentId, { enabled: !a.enabled })));
  const run = (a: Agent) => act(a, async () => {
    setAsking(null);
    await runAgent(a.agentId);
    onNotice(t('{name} 실행을 시작했어요. 결과는 에이전트 받은 편지함에 와요.', { name: a.name }));
    onRan();
  });
  const remove = (a: Agent) => act(a, async () => {
    setDeleting(null);
    await deleteAgent(a.agentId);
    putAgent(a.agentId, null);
  });

  return (
    <div className="agent-part">
      <p className="agent-part-label label">{t('에이전트')}</p>
      {/* failed is not loading */}
      {agents === null ? <p className="label sidebar-empty" role={unreachable ? 'status' : undefined}>
        {unreachable ? t('에이전트 목록을 불러오지 못했어요. 연결되면 다시 불러와요.') : t('에이전트 목록을 불러오는 중…')}</p> : (
        <ul className="agent-list" aria-label={t('등록된 에이전트')}>
          {agents.map((a) => (
            <li key={a.agentId} className={`agent-row${a.enabled ? '' : ' is-off'}`} aria-busy={busy === a.agentId || undefined}>
              <button type="button" className="agent-row-name" title={`${a.instructions}\n${t('(눌러서 고치기)')}`} onClick={() => onEdit(a)}>
                <span className="agent-name">{a.name}</span>
                <span className="agent-meta">
                  {a.scheduleLabel}
                  {a.lastRun && (
                    <span className={`agent-run agent-run--${runTone(a.lastRun.status)}`} title={a.lastRun.summary}>
                      {' · '}{runLabel(a.lastRun.status)} {fmtTime(a.lastRun.at)}
                    </span>
                  )}
                </span>
              </button>
              <div className="agent-row-actions">
                <button type="button" role="switch" aria-checked={a.enabled} className="gen-switch agent-switch" disabled={busy === a.agentId}
                  aria-label={a.enabled ? t('{name} 켜짐', { name: a.name }) : t('{name} 꺼짐', { name: a.name })} onClick={() => void toggle(a)}>
                  <span className="gen-switch-track" aria-hidden="true"><span className="gen-switch-thumb" /></span>
                </button>
                <button type="button" className="agent-icon-btn agent-run-now" disabled={busy === a.agentId} title={t('지금 실행')}
                  aria-label={t('{name} 지금 실행', { name: a.name })} onClick={() => setAsking(a)}>
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2.2v7.6L9.8 6 3.5 2.2Z" fill="currentColor" /></svg>
                </button>
                {!a.builtin && (
                  <button type="button" className="agent-icon-btn agent-delete" disabled={busy === a.agentId} title={t('삭제')}
                    aria-label={t('{name} 삭제', { name: a.name })} onClick={() => setDeleting(a)}>×</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="side-nav side-nav--skills agent-inbox-btn" onClick={onInbox}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 9.5 4 3.5h8l1.5 6M2.5 9.5v3h11v-3M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        <span className="label">{t('에이전트 받은 편지함')}</span>
        {unread > 0 && <span className="agent-unread" aria-label={t('안 읽은 알림 {n}개', { n: unread })}>{unread}</span>}
      </button>
      <button type="button" className="side-nav side-nav--skills agent-register-btn" onClick={onRegister}>
        <span className="plus" aria-hidden="true">+</span>
        <span className="label">{t('에이전트 등록')}</span>
      </button>
      {deleting && (
        <ConfirmDialog title={t('에이전트를 삭제할까요?')} message={t('{name}의 일정이 멈추고 목록에서 사라져요. 되돌릴 수 없어요.', { name: deleting.name })}
          confirmLabel={t('삭제')} danger onConfirm={() => void remove(deleting)} onCancel={() => setDeleting(null)} />
      )}
      {/* what a run does, takes and costs, before it starts. A run is the server's one pass of the agent, inside its
          15-minute limit (server/agents.py RUN_BUDGET_SEC, the Lambda's) */}
      {asking && (
        <ConfirmDialog title={lang === 'en' ? t('{name}을(를) 지금 실행할까요?', { name: asking.name }) : `${asking.name}${josa(asking.name, '을', '를')} 지금 실행할까요?`} confirmLabel={t('지금 실행')}
          message={t('일정과 상관없이 지금 한 번 실행해요. 몇 분 걸리고(길어도 15분), 결과는 에이전트 받은 편지함에 와요. 실행할 때마다 AI 사용료가 조금 들고, 시작한 뒤에는 멈출 수 없어요.')}
          onConfirm={() => void run(asking)} onCancel={() => setAsking(null)} />
      )}
    </div>
  );
}
