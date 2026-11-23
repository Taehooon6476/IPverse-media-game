// Dev-only /agents routes for `VITE_MOCK=1`: one builtin model scout with a proposal whose trial passes after ~40 s.
import type { Agent, AgentNote, ImageModel, Proposal, Reply } from '../api';

const iso = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const IMG = (seed: string) => `https://picsum.photos/seed/${seed}/512`;
let seq = 0;

const agents: Agent[] = [{
  agentId: 'agt_scout', name: '오픈웨이트 모델 스카우트', builtin: true, enabled: true, cron: '0 9 * * *', scheduleLabel: '매일 오전 9:00',
  instructions: '매일 아침 Hugging Face의 오픈웨이트 이미지·영상 모델을 조사해, 지금 쓰는 모델보다 나은 무료(GPU만 필요) 모델을 제안해줘.',
  lastRun: { at: iso(3 * 3600), status: 'ok', summary: '후보 1개 제안' },
}];
const proposal: Proposal = {
  proposalId: 'prp_1', kind: 'image', hfRepo: 'black-forest-labs/FLUX.2-dev', label: 'FLUX.2 dev', license: 'FLUX.2 Non-Commercial',
  commercialOk: false, vramGb: 40, instance: 'g6e.xlarge', status: 'proposed', trial: null,
  why: '프롬프트 충실도와 손·글자 표현이 Krea 2 Turbo보다 좋고, 참조 이미지 편집(i2i)도 한 모델로 됩니다.',
  risks: '비상업 라이선스라 상용 배포 전 확인이 필요해요. 1장당 약 9초로 Krea보다 느립니다.',
};
const notes: AgentNote[] = [
  { noteId: 'note_2', agentId: 'agt_scout', agentName: '오픈웨이트 모델 스카우트', createdAt: iso(3 * 3600), title: '이미지 모델 후보: FLUX.2 dev', proposal,
    body: '## 오늘의 조사\n- Hugging Face 트렌딩 이미지 모델 **24개** 확인\n- 지금 쓰는 모델: `krea`, `klein9`\n\n자세한 내용은 [모델 카드](https://huggingface.co/black-forest-labs/FLUX.2-dev)에서 볼 수 있어요.' },
  { noteId: 'note_1', agentId: 'agt_scout', agentName: '오픈웨이트 모델 스카우트', createdAt: iso(27 * 3600), title: '어제는 더 나은 모델이 없었어요',
    body: '영상 모델 11개를 봤지만 LTX보다 나은 무료 모델은 없었어요.', proposal: null },
];
let trialStart = 0;
/** The image models the mock connections list (GET /connections → imagegen.models). */
export const mockImageModels = (): ImageModel[] => [
  { id: 'krea', label: 'Krea 2 Turbo' }, { id: 'klein9', label: 'FLUX.2 klein 9B' },
  ...(proposal.status === 'promoted' ? [{ id: 'flux2-dev', label: 'FLUX.2 dev', promoted: true, hfRepo: proposal.hfRepo }] : []),
];

function advance() {
  if (proposal.status !== 'testing' || !proposal.trial) return;
  const s = (Date.now() - trialStart) / 1000;
  proposal.trial.phase = s < 10 ? 'booting' : s < 25 ? 'installing' : 'generating';
  if (s < 40) return;
  Object.assign(proposal, { status: 'passed' });
  Object.assign(proposal.trial, { phase: 'done', finishedAt: iso(), results: [
    { prompt: '네온 도시 위를 나는 우주 고양이', mode: 't2i', baseline: { model: 'Krea 2 Turbo', url: IMG('base1') }, candidate: { url: IMG('cand1'), seconds: 9 } },
    { prompt: '같은 고양이, 갑옷을 입힌 모습', mode: 'i2i', referenceUrl: IMG('ref2'), baseline: { model: 'FLUX.2 klein 9B', url: IMG('base2') }, candidate: { url: IMG('cand2'), seconds: 11 } },
  ] });
}

export function handleAgents(method: string, path: string, b: Record<string, unknown>): Reply {
  advance();
  const ok = (data: unknown, status = 200): Reply => ({ status, data: structuredClone(data) });
  const parts = path.split('/').map(decodeURIComponent); // ['', 'agents', ...]
  if (path === '/agents' && method === 'GET') return ok({ agents });
  if (path === '/agents/inbox') return ok({ notes });
  if (path === '/agents' && method === 'POST') {
    const text = String(b.description ?? '');
    const a: Agent = { agentId: `agt_${++seq}`, name: text.slice(0, 18) || '새 Agent', instructions: text, cron: '0 9 * * *',
      scheduleLabel: '매일 오전 9:00', enabled: true, builtin: false, lastRun: null };
    agents.push(a);
    return ok(a, 201);
  }
  if (parts[2] === 'proposals') {
    const action = parts[4];
    if (action === 'test') {
      Object.assign(proposal, { status: 'testing', trial: { trialId: `trl_${++seq}`, phase: 'queued', startedAt: iso(), finishedAt: null, error: null, results: [] } });
      trialStart = Date.now();
    } else if (action === 'approve') {
      if (proposal.status !== 'passed') return { status: 409, data: { message: '테스트를 통과한 제안만 승인할 수 있어요.' } };
      proposal.status = 'promoted';
    } else if (action === 'dismiss') proposal.status = 'dismissed';
    return ok(proposal, action === 'dismiss' ? 200 : 202);
  }
  const a = agents.find((x) => x.agentId === parts[2]);
  if (!a) return { status: 404, data: { message: 'Agent를 찾지 못했습니다' } };
  if (parts[3] === 'run') { a.lastRun = { at: iso(), status: 'running', summary: '' }; return ok({ runId: `run_${++seq}` }, 202); }
  if (method === 'DELETE') {
    if (a.builtin) return { status: 409, data: { message: '기본 Agent는 지울 수 없어요.' } };
    agents.splice(agents.indexOf(a), 1);
    return { status: 204, data: null };
  }
  const cron = typeof b.cron === 'string' ? b.cron : a.cron;
  Object.assign(a, { ...b, cron, scheduleLabel: cron === a.cron ? a.scheduleLabel : `cron ${cron}` });
  return ok(a);
}
