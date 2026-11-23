import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, approveProposal, createAgent, dismissProposal, patchAgent, runAgent, testProposal, type Agent, type Proposal, type Trial } from './api';
import { AgentDialog, SCHEDULE_EXAMPLES } from './components/AgentDialog';
import { AgentInbox, ProposalCard } from './components/AgentInbox';
import { AgentList } from './components/AgentList';

// The agent dialog: the schedule hint's example is one the server takes, the 테스트 confirm says the price, the time
// and that it cannot be stopped, and 거절 and ▶ 지금 실행 ask first.
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  createAgent: vi.fn(), patchAgent: vi.fn(), runAgent: vi.fn(), testProposal: vi.fn(), approveProposal: vi.fn(), dismissProposal: vi.fn(),
}));

const agent = (over: Partial<Agent> = {}): Agent => ({ agentId: 'agt_news', name: '트레일러 트렌드', instructions: '최신 게임 트레일러 트렌드를 조사해 알려 준다.',
  scheduleLabel: '매일 08:00 KST', cron: 'cron(0 8 * * ? *)', enabled: true, builtin: false, lastRun: null, ...over });
const trial = (over: Partial<Trial> = {}): Trial => ({ trialId: 'trl_1', phase: 'done', startedAt: '2026-11-16T04:00:00Z', finishedAt: '2026-11-16T04:40:00Z',
  error: null, results: [], ...over });
const proposal = (over: Partial<Proposal> = {}): Proposal => ({ proposalId: 'prp_1', kind: 'image', hfRepo: 'acme/lumen-image-2', label: 'Lumen Image 2',
  license: 'apache-2.0', commercialOk: true, vramGb: 17, instance: 'g6e.2xlarge', why: '손이 더 안정적', risks: '한글 글자는 약함', status: 'proposed', trial: null, ...over });

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
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const render = (node: React.ReactNode) => act(async () => root.render(node));
const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)!;
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const type = (el: Element | null, value: string) => act(async () => {
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const cron = () => document.querySelector<HTMLInputElement>('#agent-cron')!;
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const said = () => confirm()!.querySelector('.dialog-lead')!.textContent!;

describe('R20-44 the schedule field shows the forms the server takes', () => {
  // what server/agents.py validate_cron takes: cron(분 시 일 월 요일 연도) with the minutes fixed and ? in one day
  // field, or rate(N hours|days) (server/tests/test_round20_agent_dialog.py runs these very examples through it)
  const taken = (expr: string) => {
    const c = /^cron\((\S+) (\S+) (\S+) (\S+) (\S+) (\S+)\)$/.exec(expr);
    if (c) return /^\d{1,2}(,\d{1,2})*$/.test(c[1]) && [c[3], c[5]].includes('?');
    return /^rate\(\d+ (hour|hours|day|days)\)$/.test(expr);
  };

  it('offers examples that are all in a form it takes, one click to fill each', async () => {
    await render(<AgentDialog agent={agent()} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(SCHEDULE_EXAMPLES.map(([label]) => label)).toEqual(['매일 오전 9시', '평일 오전 9시', '매주 월요일 오전 9시', '6시간마다']);
    for (const [, expr] of SCHEDULE_EXAMPLES) expect(taken(expr), expr).toBe(true);
    expect(taken('0 9 * * *')).toBe(false); // five fields without cron(…)
    const chips = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="일정 예시"] button')];
    expect(chips.map((b) => b.textContent)).toEqual(SCHEDULE_EXAMPLES.map(([label]) => label));
    await click(chips[1]);
    expect(cron().value).toBe('cron(0 9 ? * MON-FRI *)');
    await click(chips[3]);
    expect(cron().value).toBe('rate(6 hours)');
  });

  // The server also takes plain forms like '매주 월요일 09:00' (server/agents.py FORMS): they come first in the hint;
  // the five-field cron is the advanced one.
  it('says under the field the forms the server takes, the plain ones first, with what is saved now', async () => {
    await render(<AgentDialog agent={agent()} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(cron().closest('label')!.querySelector('span')!.textContent).toBe('일정'); // no "(cron)" in the label
    const hint = document.querySelector('#agent-cron-hint')!.textContent!.replace(/\s+/g, ' ');
    expect(hint).toContain('지금: 매일 08:00 KST');
    for (const form of ['‘매일 09:00’', '‘평일 오전 9시’', '‘매주 월요일 09:00’', '‘3시간마다’', '‘수동 실행’', '‘0 9 * * *’(분 시 일 월 요일)']) expect(hint).toContain(form);
    expect(hint.indexOf('‘매일 09:00’')).toBeLessThan(hint.indexOf('‘0 9 * * *’'));
    expect(hint).toContain('한국 시간');
    expect(hint).toContain('비워 두면 ‘지금 실행’을 누를 때만 실행돼요');
    expect(hint).not.toMatch(/rate\(|연도/); // how it is stored is not how it has to be typed
    expect(cron().getAttribute('aria-describedby')).toBe('agent-cron-hint');
  });

  it('shows a refused schedule at the field, in the server\'s words, and points at the examples', async () => {
    vi.mocked(patchAgent).mockRejectedValue(new ApiError(400, '지원하지 않는 일정 식입니다: 0 9 * * *'));
    const onClose = vi.fn();
    await render(<AgentDialog agent={agent()} onSaved={vi.fn()} onClose={onClose} />);
    await type(cron(), '0 9 * * *');
    await click(button('저장'));
    const alert = document.querySelector('#agent-cron-error')!;
    expect([alert.getAttribute('role'), alert.textContent]).toEqual(['alert', '지원하지 않는 일정 식입니다: 0 9 * * * 아래 예시를 누르면 받는 형식으로 채워져요.']);
    expect([cron().getAttribute('aria-invalid'), cron().value]).toEqual(['true', '0 9 * * *']); // what was typed stays
    expect(onClose).not.toHaveBeenCalled();
    await click(button('매일 오전 9시'));
    expect([cron().value, document.querySelector('#agent-cron-error')]).toEqual(['cron(0 9 * * ? *)', null]);
  });

  it('keeps another error (the name, the server) at the foot of the dialog', async () => {
    vi.mocked(patchAgent).mockRejectedValue(new ApiError(0, '서버에 연결할 수 없습니다.'));
    await render(<AgentDialog agent={agent()} onSaved={vi.fn()} onClose={vi.fn()} />);
    await type(document.querySelector('#agent-name'), '트레일러 레이더');
    await click(button('저장'));
    expect(document.querySelector('.dialog-footer [role="alert"]')!.textContent).toBe('서버에 연결할 수 없습니다.');
    expect(document.querySelector('#agent-cron-error')).toBeNull();
  });

  it('takes an empty schedule (run by hand only) and a draft that came without one', async () => {
    vi.mocked(patchAgent).mockImplementation(async (_id, patch) => ({ ...agent(), ...patch, scheduleLabel: '수동 실행' }));
    const onSaved = vi.fn();
    await render(<AgentDialog agent={agent()} onSaved={onSaved} onClose={vi.fn()} />);
    await type(cron(), '');
    expect(button('저장').disabled).toBe(false);
    await click(button('저장'));
    expect(patchAgent).toHaveBeenCalledWith('agt_news', { cron: '' });

    await act(async () => root.unmount());
    root = createRoot(container);
    vi.mocked(createAgent).mockResolvedValue(agent({ cron: null as unknown as string, scheduleLabel: '수동 실행' })); // no time in the request
    await render(<AgentDialog onSaved={vi.fn()} onClose={vi.fn()} />);
    await type(document.querySelector('#agent-desc'), '새 이미지 모델이 나오면 알려줘');
    await click(button('만들기'));
    expect([cron().value, document.querySelector('#agent-cron-hint')!.textContent]).toEqual(['', expect.stringContaining('지금: 수동 실행')]);
  });

  it('says before the draft what an agent can and cannot do', async () => {
    await render(<AgentDialog onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('#agent-dialog-title')!.textContent).toBe('에이전트 등록');
    const hint = document.querySelector('#agent-form .field-hint')!.textContent!;
    expect(hint).toContain('웹과 Hugging Face');
    expect(hint).toContain('받은 편지함');
    expect(hint).toContain('IP나 게임을 만들거나 고치지는 못해요');
  });
});

describe('R20-44 what a press will do, cost and take is said before it', () => {
  it('테스트: what runs, the time, the cost, and that it cannot be stopped', async () => {
    await render(<ProposalCard proposal={proposal()} onChange={vi.fn()} />);
    await click(button('테스트', container));
    expect(said()).toBe('GPU 서버를 새로 켜서 이 모델을 설치하고, 지금 쓰는 모델과 같은 주문으로 결과를 만들어 비교해요. 보통 30–60분 걸리고 GPU 비용이 약 $2–3 들어요. 시작한 뒤에는 멈출 수 없어요.');
    expect(testProposal).not.toHaveBeenCalled();
  });

  it('승인: what it adds, that it is done at once, and what it costs from then on', async () => {
    await render(<ProposalCard proposal={proposal({ status: 'passed', trial: trial() })} onChange={vi.fn()} />);
    await click(button('승인', container));
    expect(said()).toBe('이 모델을 이미지 모델 목록에 추가해요. 바로 끝나고, 다음 요청부터 고를 수 있어요 (기본 모델은 그대로예요). '
      + '모델 서버는 쓸 때만 켜지고 처음 켤 때 약 10분 걸려요. 쓰는 동안에는 GPU 요금이, 꺼져 있는 동안에도 저장 공간 요금(월 약 $24)이 들어요.');
    expect(approveProposal).not.toHaveBeenCalled();
    await click(button('취소', confirm()!));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<ProposalCard proposal={proposal({ kind: 'video', status: 'passed', trial: trial() })} onChange={vi.fn()} />);
    await click(button('승인', container));
    expect(said()).toContain('이 모델을 영상 모델 목록에 추가해요.');
  });

  it('거절: asks first and says it cannot be taken back; 취소 sends nothing', async () => {
    vi.mocked(dismissProposal).mockResolvedValue(proposal({ status: 'dismissed' }));
    const onChange = vi.fn();
    await render(<ProposalCard proposal={proposal()} onChange={onChange} />);
    await click(button('거절', container));
    expect(confirm()!.querySelector('h2')!.textContent).toBe('Lumen Image 2 제안을 거절할까요?');
    expect(said()).toBe('이 제안을 닫아요. 목록에는 ‘거절함’으로 남고, 다시 테스트하거나 승인할 수 없어요. 비용은 들지 않아요.');
    await click(button('취소', confirm()!));
    expect([confirm(), vi.mocked(dismissProposal).mock.calls.length]).toEqual([null, 0]);
    await click(button('거절', container));
    await click(button('거절', confirm()!));
    expect(dismissProposal).toHaveBeenCalledWith('prp_1');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'dismissed' }));
  });

  it('거절 of a model that passed its test says the tested server goes too', async () => {
    await render(<ProposalCard proposal={proposal({ status: 'passed', trial: trial() })} onChange={vi.fn()} />);
    await click(button('거절', container));
    expect(said()).toBe('이 제안을 닫아요. 테스트해 둔 모델 서버도 지워서, 다시 쓰려면 새로 제안받아 테스트해야 해요. 목록에는 ‘거절함’으로 남아요. 비용은 들지 않아요.');
  });

  it('▶ 지금 실행: asks first with what it does, how long it takes and that it costs', async () => {
    vi.mocked(runAgent).mockResolvedValue({ runId: 'run_1' });
    const props = { agents: [agent()], unread: 0, onRegister: vi.fn(), onEdit: vi.fn(), onInbox: vi.fn(), putAgent: vi.fn(), onRan: vi.fn(), onNotice: vi.fn(), onError: vi.fn() };
    await render(<AgentList {...props} />);
    await click(button('트레일러 트렌드 지금 실행'));
    expect(confirm()!.querySelector('h2')!.textContent).toBe('트레일러 트렌드를 지금 실행할까요?');
    expect(said()).toBe('일정과 상관없이 지금 한 번 실행해요. 몇 분 걸리고(길어도 15분), 결과는 에이전트 받은 편지함에 와요. 실행할 때마다 AI 사용료가 조금 들고, 시작한 뒤에는 멈출 수 없어요.');
    expect(runAgent).not.toHaveBeenCalled();
    await click(button('취소', confirm()!));
    expect(runAgent).not.toHaveBeenCalled();
    await click(button('트레일러 트렌드 지금 실행'));
    await click(button('지금 실행', confirm()!));
    expect(runAgent).toHaveBeenCalledWith('agt_news');
    expect(props.onNotice).toHaveBeenCalledWith('트레일러 트렌드 실행을 시작했어요. 결과는 에이전트 받은 편지함에 와요.');
  });
});

describe('R20-44 the inbox drawer', () => {
  it('has 닫기 at its foot like the other drawers, and says 에이전트', async () => {
    const onClose = vi.fn();
    await render(<AgentInbox notes={[]} putProposal={vi.fn()} onClose={onClose} />);
    expect(document.querySelector('#inbox-title')!.textContent).toBe('에이전트 받은 편지함');
    await click(button('닫기', document.querySelector('.dialog-footer')!));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
