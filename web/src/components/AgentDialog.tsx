import { useRef, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { ApiError, createAgent, patchAgent, type Agent } from '../api';
import { useDialog } from './useDialog';

interface Props {
  /** Edit this agent; without it the dialog starts from one natural-language description. */
  agent?: Agent;
  onSaved: (agent: Agent) => void;
  onClose: () => void;
}

const EXAMPLE = t('예: 매일 아침 9시에 최신 게임 트레일러 트렌드를 조사해서 알려줘');
/** Schedules in the forms the server takes (server/agents.py validate_cron: an EventBridge Scheduler expression in
 * Korean time, hourly at most). server/tests/test_round20_agent_dialog.py runs every expression through that parser. */
export const SCHEDULE_EXAMPLES: [label: string, expression: string][] = [
  // (Korean literals: server/tests/test_round20_agent_dialog.py reads this table; the chips say them through t())
  ['매일 오전 9시', 'cron(0 9 * * ? *)'],
  ['평일 오전 9시', 'cron(0 9 ? * MON-FRI *)'],
  ['매주 월요일 오전 9시', 'cron(0 9 ? * MON *)'],
  ['6시간마다', 'rate(6 hours)'],
];

/** + 에이전트 등록: one sentence → the server drafts the agent (POST /agents), whose name, instructions and schedule
 * can be fixed before saving (PATCH). Also opens on an existing agent to edit it. */
export function AgentDialog({ agent: initial, onSaved, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose, initial ? '#agent-name' : '#agent-desc');
  const [description, setDescription] = useState('');
  const [agent, setAgent] = useState<Agent | null>(initial ?? null);
  const [name, setName] = useState(initial?.name ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [cron, setCron] = useState(initial?.cron ?? ''); // '' = no schedule: it runs by 지금 실행 only
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cronError, setCronError] = useState<string | null>(null); // the server's refusal of the schedule, at its field

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const made = await createAgent(description.trim());
      setAgent(made); setName(made.name); setInstructions(made.instructions); setCron(made.cron ?? ''); // a request without a time has none
      onSaved(made); // it exists now: the list shows it even if the edits are not saved
    } catch (err) {
      setError(err instanceof Error ? err.message : t('에이전트를 만들지 못했어요.'));
    } finally { setBusy(false); }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!agent) return;
    const patch = {
      ...(name.trim() !== agent.name ? { name: name.trim() } : {}),
      ...(instructions.trim() !== agent.instructions ? { instructions: instructions.trim() } : {}),
      ...(cron.trim() !== (agent.cron ?? '') ? { cron: cron.trim() } : {}),
    };
    if (!Object.keys(patch).length) { onClose(); return; }
    setBusy(true); setError(null); setCronError(null);
    try {
      onSaved(await patchAgent(agent.agentId, patch));
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('저장하지 못했어요.');
      // a schedule the server does not take is the one thing a 400 on a changed schedule says: shown where it is fixed
      if ('cron' in patch && err instanceof ApiError && err.status === 400) setCronError(message);
      else setError(message);
      setBusy(false);
    }
  }
  const fillCron = (expression: string) => { setCron(expression); setCronError(null); };

  const drafting = !agent;
  return (
    <div className="modal-root">
      <div className="modal-backdrop" onClick={onClose} />
      <div ref={panel} className="modal agent-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-dialog-title">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">AGENT</p>
            <h2 id="agent-dialog-title">{initial ? t('에이전트 고치기') : t('에이전트 등록')}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        {drafting ? (
          <form id="agent-form" className="dialog-body" onSubmit={create}>
            <label className="field">
              <span>{t('어떤 일을 맡길까요?')}</span>
              <textarea id="agent-desc" rows={4} maxLength={1000} value={description} placeholder={EXAMPLE}
                onChange={(e) => setDescription(e.target.value)} />
            </label>
            {/* what the agent can reach, said before it is made */}
            <p className="field-hint">{t('한 문장이면 돼요. 이름, 할 일, 일정은 만든 뒤에 고칠 수 있어요. 에이전트는 정해진 시간에 웹과 Hugging Face의 모델 정보를 찾아보고 결과를 받은 편지함으로 알려 줘요. 세션의 IP나 게임을 만들거나 고치지는 못해요.')}</p>
          </form>
        ) : (
          <form id="agent-form" className="dialog-body" onSubmit={save}>
            {!initial && <p className="dialog-lead muted" role="status">{t('에이전트를 등록했어요. 고칠 곳이 있으면 고친 뒤 저장하세요.')}</p>}
            <label className="field">
              <span>{t('이름')}</span>
              <input id="agent-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('할 일')}</span>
              <textarea id="agent-instructions" rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('일정')}</span>
              <input id="agent-cron" className="agent-cron" value={cron} spellCheck={false} aria-describedby="agent-cron-hint"
                aria-invalid={cronError ? true : undefined} onChange={(e) => { setCron(e.target.value); setCronError(null); }} />
            </label>
            {cronError && <p id="agent-cron-error" className="agent-error" role="alert">{cronError} {t('아래 예시를 누르면 받는 형식으로 채워져요.')}</p>}
            <div className="chips" role="group" aria-label={t('일정 예시')}>
              {SCHEDULE_EXAMPLES.map(([label, expression]) => (
                <button key={expression} type="button" className="chip-btn" title={expression} onClick={() => fillCron(expression)}>{t(label)}</button>
              ))}
            </div>
            {/* the forms the server takes, the plain ones first (server/agents.py FORMS, validate_cron) */}
            {/* the English page names the plain English forms the server reads (server/agents.py _worded_en) */}
            <p id="agent-cron-hint" className="field-hint">{t('지금: {schedule}.', { schedule: agent.scheduleLabel })}{' '}
              {t('‘매일 09:00’, ‘평일 오전 9시’, ‘매주 월요일 09:00’, ‘3시간마다’처럼 적으면 돼요. cron 식 ‘0 9 * * *’(분 시 일 월 요일)도 돼요. 시각은 한국 시간이고, 한 시간에 한 번보다 자주는 안 돼요. ‘수동 실행’이라고 적거나 비워 두면 ‘지금 실행’을 누를 때만 실행돼요.')}</p>
          </form>
        )}
        <div className="dialog-footer">
          {error && <p className="agent-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>{drafting || initial ? t('취소') : t('닫기')}</button>
            <button form="agent-form" type="submit" className="btn btn-primary"
              disabled={busy || (drafting ? !description.trim() : !name.trim() || !instructions.trim())}>
              {busy ? (drafting ? t('만드는 중…#에이전트') : t('저장하는 중…')) : drafting ? t('만들기#에이전트') : t('저장')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
