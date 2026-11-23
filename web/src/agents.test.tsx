import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgents } from './agents';
import {
  ApiError, agentInbox, approveProposal, createAgent, deleteAgent, dismissProposal, listAgents, patchAgent, runAgent, testProposal,
  type Agent, type AgentNote, type Proposal, type Trial,
} from './api';
import { AgentDialog } from './components/AgentDialog';
import { AgentInbox, ProposalCard, ResultsGrid, markdown } from './components/AgentInbox';
import { AgentList } from './components/AgentList';
import { Dropdown } from './components/Dropdown';
import { modelOption } from './components/ChatDock';
import { imageModels, shotModels } from './videoModels';

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  listAgents: vi.fn(), createAgent: vi.fn(), patchAgent: vi.fn(), deleteAgent: vi.fn(), runAgent: vi.fn(), agentInbox: vi.fn(),
  testProposal: vi.fn(), approveProposal: vi.fn(), dismissProposal: vi.fn(),
}));

const agent = (over: Partial<Agent> = {}): Agent => ({
  agentId: 'agt_scout', name: '모델 스카우트', instructions: 'HF 조사', scheduleLabel: '매일 오전 9:00', cron: '0 9 * * *', enabled: true,
  builtin: true, lastRun: { at: '2026-11-09T00:00:00Z', status: 'ok', summary: '후보 1개' }, ...over });
const trial = (over: Partial<Trial> = {}): Trial => ({ trialId: 'trl_1', phase: 'installing', startedAt: '2026-11-09T09:00:00Z',
  finishedAt: null, error: null, results: [], ...over });
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  proposalId: 'prp_1', kind: 'image', hfRepo: 'black-forest-labs/FLUX.2-dev', label: 'FLUX.2 dev', license: 'FLUX.2 Non-Commercial',
  commercialOk: false, vramGb: 40, instance: 'g6e.xlarge', why: '손 표현이 더 좋음', risks: '비상업 라이선스', status: 'proposed', trial: null, ...over });
const note = (noteId: string, createdAt: string, p: Proposal | null = null): AgentNote => ({
  noteId, agentId: 'agt_scout', agentName: '모델 스카우트', createdAt, title: `알림 ${noteId}`, body: '본문', proposal: p });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const render = (node: React.ReactNode) => act(async () => root.render(node));
const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
const click = (el: Element | undefined) => act(async () => { (el as HTMLElement).click(); });
function type(el: Element | null, value: string) {
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const proto = Object.getPrototypeOf(input);
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the Agent part of the sidebar', () => {
  async function list(agents: Agent[], extra: Partial<Parameters<typeof AgentList>[0]> = {}) {
    const props = { agents, unread: 0, onRegister: vi.fn(), onEdit: vi.fn(), onInbox: vi.fn(), putAgent: vi.fn(), onRan: vi.fn(),
      onNotice: vi.fn(), onError: vi.fn(), ...extra };
    await render(<AgentList {...props} />);
    return props;
  }

  it('lists each agent with its schedule, switch and last run; only a custom one can be deleted', async () => {
    await list([agent(), agent({ agentId: 'agt_2', name: '트레일러 트렌드', builtin: false, enabled: false, lastRun: null })], { unread: 3 });
    const rows = [...container.querySelectorAll('.agent-row')];
    expect(rows.map((r) => r.querySelector('.agent-meta')!.textContent)).toEqual([expect.stringMatching(/^매일 오전 9:00 · 성공 /), '매일 오전 9:00']);
    expect(rows.map((r) => r.querySelector('[role="switch"]')!.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(rows.map((r) => !!r.querySelector('.agent-delete'))).toEqual([false, true]);
    expect(rows.every((r) => r.querySelector('.agent-run-now'))).toBe(true);
    expect(container.querySelector('.agent-inbox-btn .agent-unread')!.textContent).toBe('3');
  });

  it('toggles an agent with PATCH enabled', async () => {
    const off = agent({ enabled: false });
    vi.mocked(patchAgent).mockResolvedValue(off);
    const props = await list([agent()]);
    await click(container.querySelector('[role="switch"]')!);
    expect(patchAgent).toHaveBeenCalledWith('agt_scout', { enabled: false });
    expect(props.putAgent).toHaveBeenCalledWith('agt_scout', off);
  });

  it('runs an agent now and says where the result goes', async () => {
    vi.mocked(runAgent).mockResolvedValue({ runId: 'run_1' });
    const props = await list([agent()]);
    await click(button('모델 스카우트 지금 실행'));
    expect(runAgent).not.toHaveBeenCalled(); // it asks first, saying what a run does, takes and costs
    await click(button('지금 실행', document.querySelector('[role="alertdialog"]')!));
    expect(runAgent).toHaveBeenCalledWith('agt_scout');
    expect(props.onNotice).toHaveBeenCalledWith('모델 스카우트 실행을 시작했어요. 결과는 에이전트 받은 편지함에 와요.');
    expect(props.onRan).toHaveBeenCalledOnce();
  });

  it('deletes a custom agent after a confirm', async () => {
    vi.mocked(deleteAgent).mockResolvedValue(null);
    const props = await list([agent({ agentId: 'agt_2', name: '트레일러 트렌드', builtin: false })]);
    await click(button('트레일러 트렌드 삭제'));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('에이전트를 삭제할까요?');
    expect(deleteAgent).not.toHaveBeenCalled();
    await click(button('삭제', dialog));
    expect(deleteAgent).toHaveBeenCalledWith('agt_2');
    expect(props.putAgent).toHaveBeenCalledWith('agt_2', null);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('opens the register dialog, the inbox and an agent to edit', async () => {
    const props = await list([agent()]);
    await click(container.querySelector('.agent-register-btn')!);
    await click(container.querySelector('.agent-inbox-btn')!);
    await click(container.querySelector('.agent-row-name')!);
    expect(props.onRegister).toHaveBeenCalledOnce();
    expect(props.onInbox).toHaveBeenCalledOnce();
    expect(props.onEdit).toHaveBeenCalledWith(agent());
  });
});

describe('+ Agent 등록', () => {
  it('drafts an agent from one sentence, shows its name, instructions and schedule, and saves the edits with PATCH', async () => {
    const made = agent({ agentId: 'agt_9', name: '트레일러 트렌드', instructions: '최신 게임 트레일러 트렌드 조사', builtin: false, lastRun: null });
    vi.mocked(createAgent).mockResolvedValue(made);
    vi.mocked(patchAgent).mockImplementation(async (_id, patch) => ({ ...made, ...patch }));
    const onSaved = vi.fn(), onClose = vi.fn();
    await render(<AgentDialog onSaved={onSaved} onClose={onClose} />);
    const desc = document.querySelector<HTMLTextAreaElement>('#agent-desc')!;
    expect(desc.placeholder).toBe('예: 매일 아침 9시에 최신 게임 트레일러 트렌드를 조사해서 알려줘');
    expect(button('만들기')!.disabled).toBe(true);
    await act(async () => type(desc, '매일 아침 9시에 최신 게임 트레일러 트렌드를 조사해서 알려줘'));
    await click(button('만들기'));
    expect(createAgent).toHaveBeenCalledWith('매일 아침 9시에 최신 게임 트레일러 트렌드를 조사해서 알려줘');
    expect(onSaved).toHaveBeenCalledWith(made);
    const field = (id: string) => document.querySelector<HTMLInputElement>(id)!;
    expect([field('#agent-name').value, field('#agent-instructions').value, field('#agent-cron').value])
      .toEqual(['트레일러 트렌드', '최신 게임 트레일러 트렌드 조사', '0 9 * * *']);
    expect(document.body.textContent).toContain('지금: 매일 오전 9:00');

    await act(async () => { type(field('#agent-name'), '트레일러 레이더'); type(field('#agent-cron'), '0 8 * * 1-5'); });
    await click(button('저장'));
    expect(patchAgent).toHaveBeenCalledWith('agt_9', { name: '트레일러 레이더', cron: '0 8 * * 1-5' }); // only what changed
    expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ name: '트레일러 레이더' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the sentence and shows the error when the draft fails', async () => {
    vi.mocked(createAgent).mockRejectedValue(new ApiError(400, '일정을 알아들을 수 없어요.'));
    await render(<AgentDialog onSaved={vi.fn()} onClose={vi.fn()} />);
    await act(async () => type(document.querySelector('#agent-desc'), '가끔 뭔가 해줘'));
    await click(button('만들기'));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('일정을 알아들을 수 없어요.');
    expect(document.querySelector<HTMLTextAreaElement>('#agent-desc')!.value).toBe('가끔 뭔가 해줘');
  });

  it('edits an existing agent straight away', async () => {
    await render(<AgentDialog agent={agent()} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('#agent-dialog-title')!.textContent).toBe('에이전트 고치기');
    expect(document.querySelector<HTMLInputElement>('#agent-name')!.value).toBe('모델 스카우트');
    expect(document.activeElement?.id).toBe('agent-name');
  });
});

describe('a proposal card, by status', () => {
  const card = async (p: Proposal, onChange = vi.fn()) => { await render(<ProposalCard proposal={p} onChange={onChange} />); return onChange; };
  const actions = () => [...container.querySelectorAll('.proposal-actions button')].map((b) => b.textContent);

  it('shows the model, its HF link, kind, license (non-commercial flagged), VRAM and instance, why and risks', async () => {
    await card(proposal());
    const link = container.querySelector<HTMLAnchorElement>('.proposal-model')!;
    expect([link.textContent, link.href, link.target]).toEqual(['FLUX.2 dev', 'https://huggingface.co/black-forest-labs/FLUX.2-dev', '_blank']);
    expect(container.querySelector('.proposal-kind')!.textContent).toBe('이미지');
    expect(container.querySelector('.proposal-flag')!.textContent).toBe('비상업용');
    expect(container.querySelector('.proposal-facts')!.textContent).toContain('40 GB · g6e.xlarge');
    expect(container.querySelector('.proposal-why')!.textContent).toBe('왜 더 좋은지손 표현이 더 좋음');
    expect(container.querySelector('.proposal-risks')!.textContent).toBe('위험비상업 라이선스');
    expect(container.querySelector('.proposal-status')!.textContent).toBe('제안');
    expect(actions()).toEqual(['테스트', '거절']);
  });

  it('does not flag a commercial-OK license; a video one says 영상', async () => {
    await card(proposal({ commercialOk: true, license: 'Apache-2.0', kind: 'video' }));
    expect(container.querySelector('.proposal-flag')).toBeNull();
    expect(container.querySelector('.proposal-kind')!.textContent).toBe('영상');
  });

  it('testing: the live phase with the elapsed time and the cost line, no buttons', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-09T09:12:05Z') });
    await card(proposal({ status: 'testing', trial: trial() }));
    const line = container.querySelector('.proposal-trial')!;
    expect(line.querySelector('.proposal-phase')!.textContent).toBe('모델 설치 중 · 경과 12:05');
    expect(line.textContent).toContain('보통 30–60분 · GPU 비용 약 $2–3');
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(line.querySelector('.proposal-elapsed')!.textContent).toBe(' · 경과 12:07');
    expect(actions()).toEqual([]);
  });

  it('passed: the results grid with 승인 and 거절', async () => {
    await card(proposal({ status: 'passed', trial: trial({ phase: 'done', results: [
      { prompt: '고양이', mode: 't2i', baseline: { model: 'Krea 2 Turbo', url: 'b.png' }, candidate: { url: 'c.png', seconds: 9 } }] }) }));
    expect(container.querySelector('.trial-results')).not.toBeNull();
    expect(actions()).toEqual(['승인', '거절']);
  });

  it('failed: the error line and 다시 테스트', async () => {
    await card(proposal({ status: 'failed', trial: trial({ error: 'CUDA out of memory' }) }));
    expect(container.querySelector('.proposal-error')!.textContent).toBe('CUDA out of memory');
    expect(actions()).toEqual(['다시 테스트']);
  });

  it('promoted: in the model list and pickable', async () => {
    await card(proposal({ status: 'promoted' }));
    expect(container.querySelector('.proposal-promoted')!.textContent).toBe('모델 목록에 추가됨 · 이미지 모델을 고를 때 선택할 수 있어요');
    expect(actions()).toEqual([]);
  });

  it('dismissed: no buttons', async () => {
    await card(proposal({ status: 'dismissed' }));
    expect(container.querySelector('.proposal-status')!.textContent).toBe('거절함');
    expect(actions()).toEqual([]);
  });

  it('거절 dismisses after its confirm (round 20, R20-44: it acted at once, with no way back)', async () => {
    vi.mocked(dismissProposal).mockResolvedValue(proposal({ status: 'dismissed' }));
    const onChange = await card(proposal());
    await click(button('거절', container));
    expect(dismissProposal).not.toHaveBeenCalled();
    await click(button('거절', document.querySelector('[role="alertdialog"]')!));
    expect(dismissProposal).toHaveBeenCalledWith('prp_1');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'dismissed' }));
  });
});

describe('테스트 and 승인 ask first', () => {
  it('테스트: the GPU cost confirm; 취소 sends nothing, the confirm starts the trial', async () => {
    vi.mocked(testProposal).mockResolvedValue(proposal({ status: 'testing', trial: trial({ phase: 'queued' }) }));
    const onChange = vi.fn();
    await render(<ProposalCard proposal={proposal()} onChange={onChange} />);
    await click(button('테스트', container));
    let dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('GPU 비용이 약 $2–3 들어요'); // and what runs, how long, and that it cannot be stopped
    expect(document.activeElement).toBe(button('취소', dialog)); // a paid start: Enter right after the press must not start it
    await click(button('취소', dialog));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(testProposal).not.toHaveBeenCalled();

    await click(button('테스트', container));
    dialog = document.querySelector('[role="alertdialog"]')!;
    await click(button('테스트 시작', dialog));
    expect(testProposal).toHaveBeenCalledWith('prp_1');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'testing' }));
  });

  it('테스트: a 409 (another trial running) shows the server message on the card', async () => {
    vi.mocked(testProposal).mockRejectedValue(new ApiError(409, '다른 모델을 테스트하고 있어요. 끝난 뒤 다시 눌러 주세요.'));
    const onChange = vi.fn();
    await render(<ProposalCard proposal={proposal()} onChange={onChange} />);
    await click(button('테스트', container));
    await click(button('테스트 시작', document.querySelector('[role="alertdialog"]')!));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('다른 모델을 테스트하고 있어요. 끝난 뒤 다시 눌러 주세요.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('승인: the confirm that says what it adds, then approve', async () => {
    vi.mocked(approveProposal).mockResolvedValue(proposal({ status: 'promoted' }));
    const onChange = vi.fn();
    await render(<ProposalCard proposal={proposal({ status: 'passed', trial: trial({ results: [] }) })} onChange={onChange} />);
    await click(button('승인', container));
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('이 모델을 이미지 모델 목록에 추가해요');
    expect(approveProposal).not.toHaveBeenCalled();
    await click(button('승인', dialog));
    expect(approveProposal).toHaveBeenCalledWith('prp_1');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'promoted' }));
  });
});

describe('the results grid', () => {
  it('puts the baseline and the candidate side by side per prompt: images as img, videos with controls, the i2i reference first', async () => {
    await render(<ResultsGrid candidate="FLUX.2 dev" results={[
      { prompt: '고양이', mode: 't2i', baseline: { model: 'Krea 2 Turbo', url: 'b1.png' }, candidate: { url: 'c1.png', seconds: 9.4 } },
      { prompt: '갑옷 고양이', mode: 'i2i', referenceUrl: 'ref.png', baseline: { model: 'FLUX.2 klein 9B', url: 'b2.png' }, candidate: { url: 'c2.png' } },
      { prompt: '달리는 고양이', mode: 't2v', baseline: { model: 'LTX-2', url: 'b3.mp4' }, candidate: { url: 'c3.mp4' } },
    ]} />);
    const rows = [...container.querySelectorAll('.trial-row')];
    const cells = (r: Element) => [...r.querySelectorAll('figure')].map((f) => ({
      label: f.querySelector('figcaption')!.textContent, tag: f.querySelector('img, video')!.tagName,
      src: f.querySelector('img, video')!.getAttribute('src') }));
    expect(cells(rows[0])).toEqual([{ label: 'Krea 2 Turbo', tag: 'IMG', src: 'b1.png' }, { label: 'FLUX.2 dev · 9초', tag: 'IMG', src: 'c1.png' }]);
    expect(cells(rows[1])).toEqual([{ label: '참조 이미지', tag: 'IMG', src: 'ref.png' }, { label: 'FLUX.2 klein 9B', tag: 'IMG', src: 'b2.png' },
      { label: 'FLUX.2 dev', tag: 'IMG', src: 'c2.png' }]);
    expect(cells(rows[2]).map((c) => c.tag)).toEqual(['VIDEO', 'VIDEO']);
    expect([...rows[2].querySelectorAll('video')].every((v) => v.controls)).toBe(true);
    expect(rows[0].querySelector('.trial-prompt')!.textContent).toBe('텍스트→이미지 고양이');
  });
});

describe('the inbox', () => {
  function Harness({ open = true }: { open?: boolean }) {
    const s = useAgents(true);
    return (
      <>
        <span className="unread">{s.unread}</span>
        <button type="button" onClick={s.markSeen}>읽음</button>
        {open && <AgentInbox notes={s.notes} putProposal={s.putProposal} onClose={vi.fn()} />}
      </>
    );
  }

  it('lists the notes newest first, renders the markdown body, and counts the unread until they are seen', async () => {
    vi.mocked(listAgents).mockResolvedValue({ agents: [] });
    vi.mocked(agentInbox).mockResolvedValue({ notes: [note('n1', '2026-11-08T09:00:00Z'), note('n2', '2026-11-09T09:00:00Z', proposal())] });
    await render(<Harness />);
    expect([...document.querySelectorAll('.inbox-note-title')].map((t) => t.textContent)).toEqual(['알림 n2', '알림 n1']);
    expect(document.querySelectorAll('.proposal-card')).toHaveLength(1);
    expect(container.querySelector('.unread')!.textContent).toBe('2');
    await click(button('읽음'));
    expect(container.querySelector('.unread')!.textContent).toBe('0');
    expect(localStorage.getItem('ipverse.inboxSeen')).toBe('2026-11-09T09:00:00Z');
  });

  it('polls every 10 s while a trial runs, then slows to a minute once it is done', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-09T09:30:00Z') });
    vi.mocked(listAgents).mockResolvedValue({ agents: [] });
    const testing = note('n1', '2026-11-09T09:00:00Z', proposal({ status: 'testing', trial: trial({ phase: 'booting' }) }));
    const later = note('n1', '2026-11-09T09:00:00Z', proposal({ status: 'testing', trial: trial({ phase: 'generating' }) }));
    const passed = note('n1', '2026-11-09T09:00:00Z', proposal({ status: 'passed', trial: trial({ phase: 'done', results: [
      { prompt: 'p', mode: 't2i', baseline: { model: 'Krea 2 Turbo', url: 'b.png' }, candidate: { url: 'c.png' } }] }) }));
    vi.mocked(agentInbox).mockResolvedValueOnce({ notes: [testing] }).mockResolvedValueOnce({ notes: [later] })
      .mockResolvedValue({ notes: [passed] });
    await render(<Harness />);
    const phase = () => document.querySelector('.proposal-phase')?.textContent;
    expect(phase()).toMatch(/^GPU 서버 켜는 중 · 경과 30:0\d$/);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(agentInbox).toHaveBeenCalledTimes(2);
    expect(phase()).toMatch(/^결과 만드는 중/);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(agentInbox).toHaveBeenCalledTimes(3);
    expect(document.querySelector('.trial-results')).not.toBeNull();
    expect([...document.querySelectorAll('.proposal-actions button')].map((b) => b.textContent)).toEqual(['승인', '거절']);
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(agentInbox).toHaveBeenCalledTimes(3); // nothing testing: once a minute
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(agentInbox).toHaveBeenCalledTimes(4);
  });

  it('reads the model catalog again when a proposal turns promoted', async () => {
    vi.useFakeTimers();
    vi.mocked(listAgents).mockResolvedValue({ agents: [] });
    vi.mocked(agentInbox).mockResolvedValueOnce({ notes: [note('n1', '2026-11-09T09:00:00Z', proposal({ status: 'passed' }))] })
      .mockResolvedValue({ notes: [note('n1', '2026-11-09T09:00:00Z', proposal({ status: 'promoted' }))] });
    const onPromoted = vi.fn();
    function Promo() { useAgents(true, onPromoted); return null; }
    await render(<Promo />);
    expect(onPromoted).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(onPromoted).toHaveBeenCalledOnce();
  });

  it('says so when there are no notes', async () => {
    await render(<AgentInbox notes={[]} putProposal={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('#inbox-title')!.textContent).toBe('에이전트 받은 편지함');
    expect(document.querySelector('.drawer--inbox')!.textContent).toContain('아직 알림이 없어요.');
  });

  it('renders the markdown body as elements, never as HTML', async () => {
    await render(<div>{markdown('## 오늘\n- **24개** 확인\n- `krea` 사용 중\n\n[모델 카드](https://huggingface.co/x) <img src=x onerror=alert(1)>')}</div>);
    expect(container.querySelector('h4')!.textContent).toBe('오늘');
    expect([...container.querySelectorAll('li')].map((li) => li.innerHTML)).toEqual(['<strong>24개</strong> 확인', '<code>krea</code> 사용 중']);
    expect(container.querySelector('a')!.href).toBe('https://huggingface.co/x');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('a promoted model in the chat bar dropdowns', () => {
  it('keeps promoted from the catalog and badges it 신규', async () => {
    const conns = { servers: [], platform: [
      { id: 'imagegen', name: '이미지', status: 'connected' as const, models: [{ id: 'krea', label: 'Krea 2 Turbo' },
        { id: 'flux2-dev', label: 'FLUX.2 dev', promoted: true, hfRepo: 'black-forest-labs/FLUX.2-dev' }] },
      { id: 'videogen', name: '영상', status: 'connected' as const, models: [{ id: 'ltx', label: 'LTX', kinds: ['t2v'], status: 'ready', promoted: false },
        { id: 'wan', label: 'Wan 2.5', kinds: ['i2v'], status: 'ready', promoted: true }] }] };
    expect(imageModels(conns).map(modelOption)).toEqual([{ value: 'krea', label: 'Krea 2 Turbo' },
      { value: 'flux2-dev', label: 'FLUX.2 dev', badge: '신규' }, { value: 'stability-ultra', label: 'Stable Image Ultra' }]);
    expect(shotModels(conns).map(modelOption)).toEqual([{ value: 'ltx', label: 'LTX' }, { value: 'wan', label: 'Wan 2.5', badge: '신규' }]);

    await render(<Dropdown label="이미지 모델" value="flux2-dev" options={[{ value: 'auto', label: '이미지 · 자동' }, ...imageModels(conns).map(modelOption)]}
      onChange={vi.fn()} hideLabel />);
    expect(container.querySelector('.dropdown-button .option-badge')!.textContent).toBe('신규');
    await click(container.querySelector('.dropdown-button')!);
    expect([...container.querySelectorAll('[role="option"]')].map((o) => o.querySelector('.option-badge')?.textContent ?? ''))
      .toEqual(['', '', '신규', '']);
    expect([...container.querySelectorAll('option')].map((o) => o.textContent)).toContain('FLUX.2 dev · 신규');
  });
});
