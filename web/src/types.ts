// Item shapes from the shared contracts (DynamoDB table `ipverse-main`, API snapshot).
import { lang, t, tn } from './i18n';

export type Genre = 'sf-shooter' | 'sf-survival' | 'rpg-explore' | 'rpg-quest';

export interface Concept {
  title: string;
  logline: string;
  style: string;
  palette: string[];
}

export interface Session {
  sessionId: string;
  userSub?: string;
  title: string;
  genre: Genre;
  concept?: Concept | null;
  createdAt: string;
  updatedAt?: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  genre: Genre;
  createdAt: string;
}

export interface ToolEvent {
  tool: string;
  summary: string;
  ts: string;
}

export interface Message {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'pending' | 'done' | 'failed';
  toolEvents?: ToolEvent[];
  /** A 게임 설계 request: the design it was sent with (server/app.py keeps it on the user message). */
  gameDesign?: GameDesignRequest;
  ts: string;
}

export type IpKind = 'character' | 'prop' | 'weapon' | 'enemy';

export interface Ip {
  ipId: string;
  kind: IpKind;
  name: string;
  description: string;
  role?: string;
  usage?: 'object' | 'background';
  /** Missing while the IP's first picture is still being drawn by its image job (see imageState). */
  imageAssetId?: string;
  cutoutAssetId?: string;
  /** The image job (kind 'image') drawing the IP's newest picture: its first one, a variant or a reroll. */
  imageJobId?: string;
  glbAssetId?: string;
  /** UAL-skeleton GLB from the rigging job (docs/rig-contract.md). */
  riggedGlbAssetId?: string;
  /** enemy only: true = rigged like a character, false = drone/beast with procedural motion. */
  humanoid?: boolean;
  /** weapon only. */
  weaponType?: 'melee' | 'gun';
  turntableAssetId?: string;
  posterAssetId?: string;
  version: number;
  createdAt: string;
}

export type AssetKind =
  | 'image' | 'cutout' | 'action_image' | 'glb' | 'rigged_glb' | 'turntable' | 'poster' | 'shot' | 'trailer' | 'shorts';

export interface Asset {
  assetId: string;
  kind: AssetKind;
  key: string;
  url: string;
  contentType: string;
  ipId?: string;
  jobId?: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** image: a GPU still (Krea 2 Turbo / FLUX.2 klein 9B) for an IP, or an action still for a shot. */
export type JobKind = 'image' | 'apose' | 'mesh3d' | 'rig' | 'render3d' | 'shot' | 'trailer';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  jobId: string;
  kind: JobKind;
  /** bedrock_video: legacy Luma Ray 2 shots made before the switch to mediagen_video. */
  provider: 'mediagen_image' | 'apose' | 'img3d' | 'rig' | 'deadline' | 'mediagen_video' | 'bedrock_video' | 'ffmpeg';
  status: JobStatus;
  externalId?: string;
  input: Record<string, unknown>;
  outputs: string[];
  deps: string[];
  progress: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** When 다시 시도 last re-queued the job (server/jobs.py retry_job): its 경과 counts from here, not from createdAt. */
  retriedAt?: string;
  /** When its work began (server/jobs.py, queued → running): before it the card counts 대기, after it 작업. '' while a
   * job sent to a queue of its provider's waits there: a mesh until the GPU box takes it. */
  startedAt?: string;
  /** When its work ended as its provider says it (server/jobs.py _finished_at: the render farm's endedAt, the mesh
   * box's last status write). A job is settled by the poll that notices it, so updatedAt can be minutes later; absent
   * or '' when the provider says no end (updatedAt stands). */
  finishedAt?: string;
  /** An image's redraw after a failed check, and what it fixes ("head": on input.headModel, mediagen_image.draw_model). */
  redraws?: number;
  redrawFor?: string[];
  /** On a done job that was no plain success, as the server marks it (server/jobs.py): "rejected" = its result was
   * kept out and what was there stays; "check_failed" = its result is in use although its check failed (an older
   * record says it in its note alone: `error` on a done job); "refused" = its provider refused what it was given,
   * so the same try fails again, and `reason` says why. */
  outcome?: 'rejected' | 'check_failed' | 'refused';
  /** Why the provider refused the job (with outcome "refused"): one Korean sentence for the card. */
  reason?: string;
}

export interface Game {
  gameId: string;
  title: string;
  genre: Genre;
  specKey: string;
  previewUrl: string;
  publishedUrl?: string;
  adAssetId?: string;
  createdAt: string;
  publishedAt?: string;
  /** `unreal`: streamed UE5 build (GameLift Streams); previewUrl stays the three.js build. */
  engine?: 'phaser' | 'three' | 'unreal';
  ue5Key?: string;
  /** A revision made from this game (게임 수정). */
  baseGameId?: string;
  castIpIds?: string[];
  /** The request persisted by the server; displayed separately from the actual generated spec. */
  design?: GameDesignMetadata;
}

/** Structured design submitted with the chat message; the server enforces these IP roles. */
export interface GameDesignRequest {
  prompt: string;
  castIpIds: string[];
  playerIpId: string | null;
  weaponIpId?: string | null;
  propIpIds: string[];
  enemyIpIds: string[];
  npcIpIds?: string[];
  backgroundIpId?: string;
  /** 배경 사물: prop IPs placed in the world as their own 3D models (kind model entities). */
  setIpIds?: string[];
}

export interface GameDesignMetadata extends Omit<GameDesignRequest, 'prompt'> {
  sourcePrompt: string;
}

export type GameIpRole = 'player' | 'weapon' | 'prop' | 'enemy' | 'npc' | 'background' | 'set';

/** `/api/sessions/{id}/stream…` (server/streams.py). */
export type StreamStatus =
  | 'ACTIVATING' | 'ACTIVE' | 'CONNECTED' | 'PENDING_CLIENT_RECONNECTION' | 'ERROR' | 'TERMINATING' | 'TERMINATED';

export interface StreamState {
  streamId: string;
  status: StreamStatus;
  signalResponse?: string;
  statusReason?: string;
}

/** `GET /api/sessions/{id}`; every list sorted by createdAt ascending. */
export interface Snapshot {
  session: Session;
  messages: Message[];
  ips: Ip[];
  assets: Asset[];
  jobs: Job[];
  games: Game[];
}

export interface ToastEvent {
  /** warn: it went through, but not as asked (a draw the check kept out of the IP, a tool's warning). */
  level: 'ok' | 'warn' | 'error';
  text: string;
  /** One button on the toast; App handles it by id. Toasts with an action stay until used or closed. */
  action?: { id: string; label: string };
  /** The IP pane's tab a click on the toast opens (Tabs.tsx openTab): where a finished job's result shows, or 작업
   * 현황 for one that failed. */
  open?: string;
}

// What the server says of a job is stored in Korean whatever the page's language (server/providers/*.py,
// server/jobs.py). The English page says such a line in English: the whole line when it is a known one, else its
// known parts (SERVER_PATTERNS: with a number or a name; SERVER_PHRASES: the plain ones), then its times. What none
// of them knows stays as written. The English is in i18n/en-panes.ts, looked up by the Korean.
const EDGE_EN: Record<string, string> = { 위쪽: t('위쪽'), 아래쪽: t('아래쪽'), 왼쪽: t('왼쪽'), 오른쪽: t('오른쪽') };
const SERVER_PATTERNS: [RegExp, (...found: string[]) => string][] = [
  // a check note's three endings (jobNote; a record's older ending too)
  [/이 그림\(v(\d+)\)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요\./g, (drew) => t('이 그림(v{drew})을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요.', { drew })],
  [/새 그림\(v(\d+)\)은 버전 기록에만 두고 지금 그림\(v(\d+)\)을 그대로 (?:써요|씁니다)\./g,
    (drew, kept) => t('새 그림(v{drew})은 버전 기록에만 두고 지금 그림(v{kept})을 그대로 써요.', { drew, kept })],
  [/새 그림\(v(\d+)\)은 버전 기록에만 있고 지금 그림은 다른 버전\(v(\d+)\)이에요\./g,
    (drew, now) => t('새 그림(v{drew})은 버전 기록에만 있고 지금 그림은 다른 버전(v{now})이에요.', { drew, now })],
  // what a check found (server/providers/cutout.py _check, mediagen_image.py check_note)
  [/((?:위쪽|아래쪽|왼쪽|오른쪽)(?:·(?:위쪽|아래쪽|왼쪽|오른쪽))*)이 프레임에 잘림/g,
    (edges) => t('{edges}이 프레임에 잘림', { edges: edges.split('·').map((e) => EDGE_EN[e]).join(', ') })],
  [/\((\d+)번 그려도 같음\)/g, (n) => t('({n}번 그려도 같음)', { n })],
  [/피사체 (\d+)개/g, (n) => tn('피사체 {n}개', Number(n))],
  // a place in a queue, a retry, a chain's pieces (img3d.py _place, mediagen_image.py, mediagen_video.py, jobs.py)
  [/대기열 (\d+)번째/g, (n) => t('대기열 {n}번째', { n })],
  [/시작까지 약 (\d+)\s*분/g, (n) => t('시작까지 약 {n}분', { n })],
  [/앞선 요청 (\d+)개/g, (n) => t('앞선 요청 {n}개', { n })],
  [/\(조각 (\d+)\/(\d+) 완료\)/g, (done, all) => t('(조각 {done}/{all} 완료)', { done, all })],
  [/조각마다 ~(\d+)분/g, (n) => t('조각마다 ~{n}분', { n })],
  [/전체 보통 ~(\d+)분/g, (n) => t('전체 보통 ~{n}분', { n })],
  [/(\d+)초 뒤 다시 시도/g, (n) => t('{n}초 뒤 다시 시도', { n })],
  [/켜는 데 ~([\d–]+)분, 준비에 ~([\d–]+)분/g, (boot, load) => t('켜는 데 ~{boot}분, 준비에 ~{load}분', { boot, load })],
  [/~([\d–]+)분, 이어서 준비 ~([\d–]+)분/g, (boot, load) => t('~{boot}분, 이어서 준비 ~{load}분', { boot, load })],
  [/실패한 샷 (\d+)개 제외/g, (n) => t('실패한 샷 {n}개 제외', { n })],
];
/** The plain parts of a stored line that have English, as the server writes them or as plainLine says them. */
export const SERVER_PHRASES = [
  // what a step is doing (JOB_KIND_DOING, STEP_KO, the providers' PHASES)
  '3D용 자세 그림 그리는 중', '3D 모델 만드는 중', '움직임 뼈대 넣는 중', '3D 회전 영상 만드는 중', '그림 그리는 중', '(GPU 대기 포함)',
  '정지된 GPU 서버 켜는 중', '그림 받는 중', 'AI 모델 불러오는 중', '결과 올리는 중', '화풍 기준 프레임 그리는 중',
  '구도를 다시 그리는 중', '수정 검사에 걸려 다시 그리는 중', '그림 받기', '도구 준비', '모양 만들기', '색과 질감 입히기', '파일 저장', '결과 올리기',
  '렌더 서버 순서 기다리는 중', '렌더 서버 배정 기다리는 중', '렌더 서버 배정됨', '렌더 서버 켜는 중', '렌더 서버 시작하는 중',
  '렌더 서버가 작업을 멈추는 중', '렌더 서버 잠시 멈춤', '멈추는 중', '잠시 멈춤', '앞 단계가 끝나길 기다리는 중', '앞선 영상 샷 대기 중',
  'GPU 대기열에서 순서 기다리는 중', 'GPU 서버에 제출됨', 'GPU 서버 시작 중', 'GPU 서버에 모델 불러오는 중', 'GPU 서버 순서 기다리는 중',
  'GPU 서버 자리가 없어 다시 켜 보는 중', 'GPU 서버가 꺼지는 중이라 다시 켜지기를 기다리는 중', 'GPU 서버가 작업을 놓쳐 다시 시도 중',
  'GPU 서버 켜는 중', 'GPU 서버 켜지는 중', 'GPU 서버 부팅 중', 'GPU 서버가 꺼지는 중, 끝나면 다시 켬', 'GPU 서버 준비 중', 'GPU 용량 부족',
  '다른 가용 영역에 GPU 새로 띄우는 중', '자리가 있는 곳에 GPU 서버를 새로 켜는 중', '중지 전 GPU 작업 이어받는 중', '이미지 GPU가 바빠',
  '영상 생성 중', '영상 마무리 중 (디코딩)', '영상 마무리 중 (인코딩)', '영상 마무리 중', '결과 영상 올리는 중', '영상 편집 시작 중',
  '결과 저장 실패', '결과 저장 중', '제출 중', '제출됨', '대기 중', '배경 제거 이미지',
  // how a job ended (server/jobs.py, the providers' failures in their Korean lead)
  '선행 작업 실패', '사용자가 중지함', '3D 모델을 만들지 못했어요', '3D 모델을 만들지 못했습니다', '렌더 서버 작업 실패',
  '움직임 뼈대를 넣지 못했어요', '움직임 뼈대를 넣을 수 없는 모양입니다', '결과 저장을 반복 실패했습니다', '상태 확인을 반복 실패했습니다',
  '작업 처리가 중단되었습니다 (시간 초과)', 'GPU 서버가 응답하지 않습니다 (신호 끊김)', 'GPU 작업이 시작되지 않았습니다 (시간 초과)',
  '영상 편집을 시작하지 못했습니다 (시간 초과)', '영상 편집을 시작하지 못했습니다', '렌더 서버가 작업을 받지 못했습니다', '원인 미상',
  '이미지 생성 실패', '3D용 자세 그림을 그리지 못했습니다', '3D용 자세 그림을 받지 못했습니다', '3D 회전 영상이 없습니다 (만든 결과 없음)',
  '결과 영상 URL이 없습니다', '이미지 결과 URL이 없습니다', '성공한 영상 샷이 없습니다', '트레일러 렌더 실패',
  '배경 제거가 잠시 응답하지 않아 배경을 지운 그림을 만들지 못했습니다. 다시 시도하면 그려 둔 그림으로 이어서 만듭니다.',
  '원본 샷은 그대로 있고, 다시 시도해도 같은 결과일 수 있습니다.',
  // a check's name and what it found, a refused skeleton's reason (server/providers/rig.py REASONS, OTHER_REASON)
  '구도 검사 실패', '수정 검사 실패', '피사체가 없음', '배경을 지우다 빛나는 부분까지 지워짐', '첫 그림이라 그대로 두었으니 다시 뽑아 주세요.',
  '요청 밖 변경', '요청하지 않은 배경 변경', '화풍이 바뀜(또는 서명·글자가 생김)', '투구·가면으로 가려진 머리가 사람 얼굴로 바뀜',
  '다리가 보이지 않거나 너무 짧아요', '두 다리의 길이가 다르게 보여요(꼬리나 긴 옷자락이 다리처럼 보일 수 있어요)', '뼈대를 맞출 수 없는 모양이에요',
].sort((a, b) => b.length - a.length); // a phrase that holds another goes first
/** A stored Korean line in the page's language (see above). The Korean page: the line itself. */
export function serverLine(line: string): string {
  if (lang !== 'en' || !/[가-힣]/.test(line)) return line;
  const whole = t(line);
  if (whole !== line) return whole;
  let said = line;
  for (const [found, say] of SERVER_PATTERNS) said = said.replace(found, (_whole, ...parts) => say(...(parts as string[])));
  for (const phrase of SERVER_PHRASES) said = said.split(phrase).join(t(phrase));
  return said.replace(/(\d)\s*초/g, (_w, n: string) => t('{n}초', { n })).replace(/(\d)\s*분/g, (_w, n: string) => t('{n}분', { n }))
    .replace(/(\d)\s*시간/g, (_w, n: string) => t('{n}시간', { n })).replace(/보통 ?(?=~?\d)/g, t('보통 {n}', { n: '' })).replace(/약 ?(?=\d)/g, t('약 {n}', { n: '' }));
}
/** A table of such lines, each in the page's language. */
const shown = <K extends string>(table: Record<K, string>) =>
  Object.fromEntries(Object.entries<string>(table).map(([k, v]) => [k, serverLine(v)])) as Record<K, string>;

// Labels for the contract enums, in the page's language.

// (the labels stay Korean literals here: server/tests/test_round18_image.py holds this table to the server's own;
// t() reads them by the entry, so its English is in i18n/en-panes.ts like any other)
export const GENRES: { value: Genre; label: string }[] = ([
  { value: 'sf-shooter', label: 'SF 슈터' },
  { value: 'sf-survival', label: 'SF 서바이벌' },
  { value: 'rpg-explore', label: 'RPG 탐험' },
  { value: 'rpg-quest', label: 'RPG 퀘스트' },
] as { value: Genre; label: string }[]).map((g) => ({ ...g, label: t(g.label) }));

export const genreLabel = (g: string) => GENRES.find((x) => x.value === g)?.label ?? g;
/** The genre every session is made with (server/store.py DEFAULT_GENRE): the server's choice, nobody's own. */
export const DEFAULT_GENRE: Genre = 'sf-shooter';
/** The session's genre as a label, once it is the session's own: it has a game (`games`: how many), or the genre is
 * not the server's default (somebody chose it). */
export const ownGenre = (session: Pick<Session, 'genre'>, games: number): string | undefined =>
  (games > 0 || session.genre !== DEFAULT_GENRE ? genreLabel(session.genre) : undefined);

/** What a job of each kind usually takes, shown while it runs. A mesh: 66–120 s on a warm GPU box; a stopped box
 * adds its boot and model load, ~5–7 min in all (server/providers/img3d.py BOOT_SEC / RELOAD_SEC / LOAD_SEC). A
 * turntable: a farm worker takes it within ~2 min and renders 2.5–5 min. */
const TYPICAL: Record<JobKind, string> = { image: '보통 20초–3분', apose: '보통 1–2분', mesh3d: '보통 2–8분', rig: '보통 2–4분',
  render3d: '보통 4–7분', shot: '보통 5–10분', trailer: '보통 1–3분' };
/** ... as the page says them ("usually 2–8 min" in English; the sums below read the Korean). */
export const JOB_TYPICAL: Record<JobKind, string> = shown(TYPICAL);
/** A whole 3D chain (A-pose, mesh, rig, turntable, one after another) from its steps' cards: "9–21분". The agent says
 * the same (server/waits.py TOTAL). */
export const THREE_D_TOTAL = (() => {
  const spans = (['apose', 'mesh3d', 'rig', 'render3d'] as const).map((k) => TYPICAL[k].match(/(\d+)–(\d+)분/)!);
  return serverLine(`${spans.reduce((n, m) => n + Number(m[1]), 0)}–${spans.reduce((n, m) => n + Number(m[2]), 0)}분`);
})();
/** What a chain of these steps usually takes, their cards added up as the agent's figure is (server/waits.py
 * chain_total): "보통 6–15분" for a mesh and its turntable. */
export function chainTypical(kinds: JobKind[]): string {
  const spans = kinds.map((k) => TYPICAL[k].match(/(\d+)–(\d+)분/)).filter((m) => m !== null);
  return spans.length === kinds.length && kinds.length
    ? serverLine(`보통 ${spans.reduce((n, m) => n + Number(m[1]), 0)}–${spans.reduce((n, m) => n + Number(m[2]), 0)}분`) : '';
}
/** The 3D steps the card's 3D button starts for an IP, in the order they run (server/tools.py render_3d): a whole-scene
 * background is one render of a panel with thickness (no mesh); a character or a humanoid enemy is drawn again in the
 * rig's pose, meshed, then rigged and filmed; any other IP is meshed and filmed. */
export function threeDSteps(ip: Ip): JobKind[] {
  if (ip.usage === 'background') return ['render3d'];
  return ip.kind === 'character' || ip.humanoid === true ? ['apose', 'mesh3d', 'rig', 'render3d'] : ['mesh3d', 'render3d'];
}
/** The 3D chain of an IP that is in flight, read off the jobs: the jobs one request registered are linked by their deps
 * (the mesh waits for the pose, the rig and the turntable for the mesh). → its steps in THREE_D_ORDER and how many are
 * done; null when no 3D job of the IP is queued or running. An earlier run of the same IP is not counted. */
export function threeDChain(ipId: string, jobs: Job[]): { kinds: JobKind[]; done: number } | null {
  const mine = jobs.filter((j) => THREE_D_ORDER.includes(j.kind) && j.input?.ipId === ipId);
  const chain = new Set(mine.filter((j) => j.status === 'queued' || j.status === 'running'));
  if (!chain.size) return null;
  for (let grew = true; grew;) {
    grew = false;
    for (const j of mine) {
      if (chain.has(j) || ![...chain].some((c) => c.deps.includes(j.jobId) || j.deps.includes(c.jobId))) continue;
      chain.add(j);
      grew = true;
    }
  }
  const steps = [...chain].sort((a, b) => THREE_D_ORDER.indexOf(a.kind) - THREE_D_ORDER.indexOf(b.kind));
  return { kinds: steps.map((j) => j.kind), done: steps.filter((j) => j.status === 'done').length };
}
/** A shot's usual time by its video model (job.input.model), from measured runs; Kandinsky includes a ~4 min boot
 * and model load. A shot of another model keeps JOB_TYPICAL.shot. */
export const SHOT_TYPICAL: Record<string, string> = shown({ ltx: '보통 5–7분', 'minimax-h3': '보통 4–5분',
  'kandinsky-6-0-video-pro': '보통 22–27분', 'wan-animate': '보통 1–5분' });
const LTX_EDIT_TYPICAL = serverLine('보통 6–10분');
/** A 2x upscale runs in one-pass pieces one after another, ~9 min each. The job's etaMinutes
 * (server/providers/mediagen_video.py edit_minutes) counts its pieces; this is for a job queued without one. */
const UPSCALE_TYPICAL = serverLine('보통 15–20분');
function typicalWait(j: Job): string {
  if (j.kind !== 'shot') return JOB_TYPICAL[j.kind];
  const model = typeof j.input?.model === 'string' ? j.input.model : 'ltx';
  const task = typeof j.input?.task === 'string' ? j.input.task : '';
  if (j.input?.edit === 'v2v' && model === 'ltx' && task.split('+').includes('upscale')) return UPSCALE_TYPICAL;
  if (j.input?.edit && model === 'ltx') return LTX_EDIT_TYPICAL;
  return Object.hasOwn(SHOT_TYPICAL, model) ? SHOT_TYPICAL[model] : JOB_TYPICAL.shot;
}
/** Running first, then queued, then the finished ones (newest first): what is moving now is never below the fold. */
export function jobOrder(a: Job, b: Job): number {
  const rank = (j: Job) => (j.status === 'running' ? 0 : j.status === 'queued' ? 1 : 2);
  return rank(a) - rank(b) || (rank(a) === 2 ? b.updatedAt.localeCompare(a.updatedAt) : a.createdAt.localeCompare(b.createdAt));
}
/** Where the IP's picture is (server/tools.py image_state): undefined = ready; 'pending' = its first picture is being
 * drawn (no imageAssetId yet), 'updating' = a new version is, 'failed' = its only image job failed, 'check_failed' =
 * the current picture failed the composition or the edit check (a first picture is kept that way, or such a version
 * restored). */
export type ImageState = 'pending' | 'updating' | 'failed' | 'check_failed' | undefined;
export function imageState(ip: Ip, jobs: Job[]): ImageState {
  const job = ip.imageJobId ? jobs.find((j) => j.jobId === ip.imageJobId) : undefined;
  if (job && (job.status === 'queued' || job.status === 'running')) return ip.imageAssetId ? 'updating' : 'pending';
  if (job?.status === 'failed' && !ip.imageAssetId) return 'failed';
  return pictureCheck(ip, jobs) === null ? undefined : 'check_failed';
}
/** Starts a done image job's error line when its picture failed the composition check even after a redraw
 * (server/providers/mediagen_image.py CHECK_FAILED, check_note). */
const CHECK_FAILED = '구도 검사 실패';
/** ... or the edit check: the edit changed more than asked (mediagen_image.py EDIT_FAILED). */
const EDIT_FAILED = '수정 검사 실패';
/** A job that ended without its result: failed, or refused by its provider (the server's mark, whatever status it
 * leaves on the job). The toasts and 작업 현황 tell it as a failure. */
export const hasFailed = (j: Job): boolean => j.status === 'failed' || (j.status === 'done' && j.outcome === 'refused');
/** A done job that was no plain success: the server's mark on it (Job.outcome), or its note alone on an older
 * record. The toasts and 작업 현황 never tell such a job as the green 완료. */
export const notAsAsked = (j: Job): boolean => j.status === 'done' && !hasFailed(j) && (!!j.outcome || !!j.error?.trim());
/** Which check such a line names and what it found ("위쪽·아래쪽이 프레임에 잘림"), as stored; null for any other line. */
function checkLine(error?: string): { name: string; problem: string } | null {
  const name = [CHECK_FAILED, EDIT_FAILED].find((n) => error?.startsWith(n));
  return name && error ? { name, problem: plainKo(error.slice(name.length).replace(/^\s*:\s*/, '').split(/[(.]/)[0].trim()) } : null;
}
/** ... in the page's language, for the card and the toast. */
export function failedCheck(error?: string): { name: string; problem: string } | null {
  const failed = checkLine(error);
  return failed && { name: serverLine(failed.name), problem: serverLine(failed.problem) };
}
/** What the composition check found off such a line; null for any other line. */
export function checkProblem(error?: string): string | null {
  const failed = checkLine(error);
  return failed?.name === CHECK_FAILED ? serverLine(failed.problem) : null;
}
/** The check the IP's current picture failed and what it found, read off the image job that drew it (server/tools.py
 * _check_note); null when it passed. */
export function pictureCheck(ip: Ip, jobs: Job[]): { name: string; problem: string } | null {
  const image = ip.imageAssetId;
  return image ? failedCheck(jobs.find((j) => j.outputs.includes(image))?.error) : null;
}
// How a check note ends (server/providers/mediagen_image.py check_note, _KEPT): the picture the IP kept when the draw
// was rejected, in the server's current ending ("… 그대로 써요.") and its older one ("… 그대로 씁니다."), which old
// records keep. The pattern and the three sentences below are the server's own, word for word (KEPT_END, USED_END,
// MOVED_END; server/tests/test_round21_copy.py holds this file to them).
const KEPT = /새 그림\(v(\d+)\)은 버전 기록에만 두고 지금 그림\(v(\d+)\)을 그대로 (?:써요|씁니다)\.$/;
/** A job's error line as it holds now (server/tools.py job_note, mediagen_image.note_now): an image job's check note
 * says which picture its IP uses today, after 이 버전 쓰기 or a later draw moved it on, in today's words whichever
 * way the record was written. Any other line is as stored. */
export function jobNote(j: Job, ips: Ip[]): string | undefined {
  const found = j.kind === 'image' ? j.error?.match(KEPT) : null;
  const ip = ips.find((x) => x.ipId === j.input?.ipId);
  if (!j.error || !found || !ip) return j.error;
  const lead = j.error.slice(0, found.index);
  if (ip.imageAssetId && j.outputs.includes(ip.imageAssetId)) return `${lead}이 그림(v${found[1]})을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요.`;
  return ip.version === Number(found[2]) ? `${lead}새 그림(v${found[1]})은 버전 기록에만 두고 지금 그림(v${found[2]})을 그대로 써요.`
    : `${lead}새 그림(v${found[1]})은 버전 기록에만 있고 지금 그림은 다른 버전(v${ip.version})이에요.`;
}
// words that name no part of a picture (server/tools.py _STOP)
const EDIT_STOP = new Set(('the a an and or of to with into from in on at by for its his her their this that make change turn give add adds '
  + 'now new more less very same color colour colored coloured instead wearing wears replace replaced keep only').split(' '));
const editWords = (t: string) => new Set((t.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 2 && !EDIT_STOP.has(w)));
/** An IP's description after an edit that saved no rewrite (server/tools.py merge_edit): the comma parts that name
 * what the change names give way to the change, the first part (the subject) stays, the change comes last. */
export function mergeEdit(description: string, change: string): string {
  const asked = change.trim().replace(/\.+$/, '');
  if (!asked) return description;
  const named = editWords(asked);
  const parts = description.split(',').map((p) => p.trim()).filter(Boolean);
  const kept = [...parts.slice(0, 1), ...parts.slice(1).filter((p) => ![...editWords(p)].some((w) => named.has(w)))];
  return [...kept, asked].join(', ');
}
/** What the IP's current picture shows, in words (server/tools.py current_description): the description its image
 * saved (an edit that landed saves the look after the change), an older edit's change merged in, else the IP's own. */
export function currentDescription(ip: Ip, image?: Asset): string {
  const saved = image?.meta?.description;
  const asked = image?.meta?.edit;
  if (typeof saved === 'string' && saved) return saved;
  return typeof asked === 'string' && asked ? mergeEdit(ip.description ?? '', asked) : ip.description;
}
/** A job's progress text without the GPU proxy's literal "?" for unknown progress. */
export const progressText = (p?: string) => (p ? plainLine(korean(p.replace(/·\s*\?$|\?$/, '').trim())) || t('진행률 정보 없음') : '');
/** What an image job is doing, without the model it is drawn on. Older records carry the model's name in the line
 * ("Krea 2 Turbo 그리는 중 (GPU 대기 포함)"); it is never printed: the model is the card's tooltip (imageModelLabel). */
export const drawLine = (line?: string): string => (line ?? '')
  .replace(/^[^:]*:\s*(?=정지된 GPU 서버 켜는 중)/, '')
  .replace(/^.*?그리는 중(?= \(GPU 대기 포함\))/, '그림 그리는 중');
/** What a 3D step is doing. The server says the same words in its progress lines, replies and wait copy: do not vary them. */
const DOING = { apose: '3D용 자세 그림 그리는 중', mesh3d: '3D 모델 만드는 중', rig: '움직임 뼈대 넣는 중',
  render3d: '3D 회전 영상 만드는 중' } as const;
/** ... in the page's language (STEP_KO below reads the Korean: the stored lines are Korean). */
export const JOB_KIND_DOING = shown(DOING);
/** A 3D step's line as its provider writes it (server/providers/apose.py, img3d.py PHASES, deadline.py PHASES, rig.py
 * RIG_PHASES, server/jobs.py), in plain words. A line that holds none of these passes as it is; the card keeps the
 * line as written for its tooltip. */
const STEP_KO: [RegExp, string][] = [
  [/^Hunyuan3D\s*·\s*/, ''], // the mesh box's name leads each of its lines
  [/^Hunyuan3D 실패/, '3D 모델을 만들지 못했어요'],
  [/Blender 작업 실패/, '렌더 서버 작업 실패'],
  [/^리깅 불가/, '움직임 뼈대를 넣지 못했어요'], // a rig's line on an older record (what it means is read off the job: rigRefusal)
  [/A-포즈로 다시 그리는 중(?:\s*\(klein\))?/, DOING.apose],
  [/입력 받는 중/, '그림 받는 중'],
  [/(?:GPU )?모델 로딩 중/, 'AI 모델 불러오는 중'],
  // the mesh's phases on its box (shape, texture, file): one phrase; the line as written is the card's tooltip
  [/3D 형상 생성 중|(?:PBR )?텍스처 생성(?: 중)?|GLB 저장 중/, DOING.mesh3d],
  [/업로드 중/, '결과 올리는 중'],
  // a restyle's first frames, as older records wrote them with the model that draws them ("(0/1, FLUX.2 klein)")
  [/(화풍 기준 프레임 그리는 중 \(\d+\/\d+), [^)]*\)/, '$1)'],
  [/Blender 턴테이블 렌더 중/, DOING.render3d],
  [/Blender 리깅 중(?:\s*\([^)]*\))?/, DOING.rig],
  [/(?:Blender 렌더|리깅) 대기열 대기 중/, '렌더 서버 순서 기다리는 중'],
  [/(?:Blender 렌더|리깅) 노드 배정 대기 중/, '렌더 서버 배정 기다리는 중'],
  [/(?:Blender 렌더|리깅) 노드 배정됨/, '렌더 서버 배정됨'],
  [/(?:Blender 렌더|리깅) 노드 시작 중/, '렌더 서버 켜는 중'],
  [/(?:Blender 렌더|리깅) 중단 중/, '멈추는 중'],
  [/(?:Blender 렌더|리깅) 일시 정지/, '잠시 멈춤'],
  [/선행 작업 대기(?: 중)?/, '앞 단계가 끝나길 기다리는 중'],
  // a check's finding or an image job's line as saved ("누끼에서 빛나는 부분이 지워짐", server/providers/cutout.py ERASED):
  // the card's button for that picture is 배경 제거. 이미지 ends in a vowel like 누끼: the particle after it stays right
  [/누끼/g, '배경 제거 이미지'],
];
const plainKo = (line: string) => STEP_KO.reduce((text, [studio, plain]) => text.replace(studio, plain), line);
/** ... in the page's language (serverLine). */
export const plainLine = (line: string) => serverLine(plainKo(line));
/** The video box's own English phase words (server/providers/mediagen_video.py PHASES): an older line, or a box word
 * the server does not know yet, never reaches the card raw. */
const PHASE_KO: Record<string, string> = {
  queued: 'GPU 대기열에서 순서 기다리는 중', pending: 'GPU 대기열에서 순서 기다리는 중', submitted: 'GPU 서버에 제출됨',
  starting: 'GPU 서버 시작 중', loading: 'GPU 서버에 모델 불러오는 중', denoising: '영상 생성 중', running: '영상 생성 중',
  generating: '영상 생성 중', sampling: '영상 생성 중', decoding: '영상 마무리 중 (디코딩)', encoding: '영상 마무리 중 (인코딩)',
  uploading: '결과 영상 올리는 중', postprocessing: '영상 마무리 중',
};
const korean = (line: string) => line.replace(/^([A-Za-z_]+)(?=$|[\s(·%\d])/, (w) => PHASE_KO[w.toLowerCase()] ?? w);

const HANGUL = /[가-힣]/;
// what only a raw exception says: botocore's "An error occurred (X) when calling the Y operation", a traceback, an
// errno, a repr's braces or angle brackets
const RAW = /An error occurred|when calling the|Traceback|Errno|[{}<>]/;
// a subprocess command line, as str(CalledProcessError) prints it: "Command '['/opt/bin/ffmpeg', '-y', …]' returned
// non-zero exit status 8." It can hold Korean (a title card's text), so it is never read as a reason
const COMMAND = /Command '\[|non-zero exit status|'\s*,\s*'-[A-Za-z]/;
export const isCommandLine = (text?: string) => !!text && COMMAND.test(text);
/** The two reasons the rig worker refuses a model with, as it writes them (workers/rig/blender_rig.py PARTIAL and
 * UNEVEN, English; server/providers/rig.py passes them on after its lead), and the server's sentences for them
 * (rig.py REASONS), for a record the server has not marked. Both are caused by the picture. */
const RIG_REASONS: [RegExp, string][] = [
  [/legs of uneven length/, '두 다리의 길이가 다르게 보여요(꼬리나 긴 옷자락이 다리처럼 보일 수 있어요)'],
  [/not a full body/, '다리가 보이지 않거나 너무 짧아요'],
];
const rigReason = (line?: string) => RIG_REASONS.find(([reason]) => reason.test(line ?? ''))?.[1];
/** What the picture of a figure needs for a 움직임 뼈대 (the server's sentence: rig.py PICTURE_NEEDS). Said after a
 * refused one's reason: on its row in 작업 현황, on the IP's card, on a held game's card. */
export const SKELETON_NEEDS = t('머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림');
/** A 움직임 뼈대 the render farm refused for the figure's shape: the same model fails again, only another picture
 * helps (why: as people read it). The server marks such a job (outcome "refused", with its `reason`); an older
 * record is known by the worker's own reason on its line, never by the Korean lead the server writes before it.
 * null: no refusal (a failure that passes: 다시 시도 helps). */
export function rigRefusal(j: Pick<Job, 'kind' | 'status' | 'error' | 'outcome' | 'reason'>): { why: string } | null {
  if (j.kind !== 'rig') return null;
  const known = rigReason(j.error);
  if (j.outcome === 'refused') return { why: serverLine(sentence(j.reason) || known || '뼈대를 맞출 수 없는 모양이에요') };
  return j.status === 'failed' && known ? { why: serverLine(known) } : null;
}
/** A sentence the server wrote for the card, without the full stop it may end in (the card's own sentence goes on
 * after it); '' when it is none (no Korean in it). */
const sentence = (text?: string) => (text && HANGUL.test(text) ? text.trim().replace(/[.\s]+$/, '') : '');
/** The IP's 움직임 뼈대 when the farm refused it and the IP has none: its newest rig job is a refusal (rigRefusal)
 * and no rigged model of it exists. Its game is made with the model as it stands (server/tools.py
 * ready_3d_for_game), and no retry changes that. null: nothing was refused. */
export function refusedSkeleton(ip: Ip, assets: Asset[], jobs: Job[]): { job: Job; why: string } | null {
  if (ip.riggedGlbAssetId && assets.some((a) => a.assetId === ip.riggedGlbAssetId)) return null;
  const rig = jobs.filter((j) => j.kind === 'rig' && j.input?.ipId === ip.ipId).at(-1); // its newest
  const refused = rig ? rigRefusal(rig) : null;
  return rig && refused ? { job: rig, why: refused.why } : null;
}
/** Why a failed job failed, as its card and its toast say it: a refusal's reason (the server's own, or the rig
 * worker's in Korean), else its error line as people read it (errorText). */
export function failureText(j: Job): string {
  return rigRefusal(j)?.why ?? ((j.outcome === 'refused' && serverLine(sentence(j.reason))) || errorText(j.error));
}
/** A failed job's error line as people read it. The server puts a provider's or an AWS call's own text after its
 * Korean lead ("결과 저장을 반복 실패했습니다: An error occurred (ServiceUnavailableException) …", server/jobs.py), or
 * stores a bare exception: the line is cut where the text stops being Korean, and one with no Korean part at all
 * becomes a short sentence. The whole line stays on the job (작업 현황 shows it on hover, but never a command line). */
export function errorText(error?: string): string {
  const text = error?.trim() ?? '';
  const rig = rigReason(text); // the rig worker's reason on the line: what it means, not the lead before it
  if (rig) return serverLine(rig);
  let said = '';
  for (const part of text.split(/(?<=:)\s+/)) { // "a: b: c" → "a:", "b:", "c"
    if (!HANGUL.test(part) || RAW.test(part) || COMMAND.test(part)) break;
    said += (said ? ' ' : '') + part;
  }
  // the step's tool or service in the lead ("Hunyuan3D 실패", "Blender 작업 실패") in the cards' words (plainLine)
  return plainLine(said.replace(/:$/, '')) || (text && (isCommandLine(text) ? t('영상 처리 명령이 실패했어요') : t('알 수 없는 오류가 났어요')));
}

/** The particle that fits the last syllable of the word before it: josa('리라', '이에요', '예요') → '예요',
 * josa('등불', '을', '를') → '을'. After a word that does not end in a Hangul syllable (a Latin name, a digit) both
 * forms stay ("을(를)", or `both`). */
export function josa(word: string, closed: string, open: string, both = `${closed}(${open})`): string {
  const last = word.trim().charCodeAt(word.trim().length - 1);
  if (!(last >= 0xac00 && last <= 0xd7a3)) return both;
  return (last - 0xac00) % 28 ? closed : open;
}

const RAW_ID = /^(?:job|gm|ip|ast|ses|msg|ad|tu)_[0-9a-z]+$/i;
/** One line of the chat's 작업 기록 (server/tools.py summarize: "<label>: <name or id>" or "<label> 실패: <reason>").
 * A failure reads as "<label> 실패"; its reason stays inline only when it is plain Korean, else it is `detail` (a
 * validator's English, API field names) for a disclosure. Raw ids and raw tool names never show. */
export function toolEventText(summary: string): { label: string; failed: boolean; text: string; detail?: string } {
  const s = summary.trim();
  const named = (label: string) => (/^[a-z0-9_]+$/.test(label) ? t('도구 실행') : label); // an unmapped tool's own name
  // ... or as the server writes it for an English page ("{label} failed: {why}", server/i18n.py)
  const fail = s.match(/^(.+?) 실패(?:: ([\s\S]*))?$/) ?? s.match(/^(.+?) failed(?:: ([\s\S]*))?$/);
  const english = !/[가-힣]/.test(s); // an English line's reason is a sentence, not a raw error under Korean text
  if (fail) {
    const label = named(fail[1]);
    const why = (fail[2] ?? '').trim();
    if (!why) return { label, failed: true, text: t('{label} 실패', { label }) };
    return (!english && /[A-Za-z]/.test(why)) || RAW.test(why)
      ? { label, failed: true, text: t('{label} 실패', { label }), detail: why }
      : { label, failed: true, text: t('{label} 실패: {why}', { label, why }) };
  }
  const ok = s.match(/^(.+?): ([\s\S]*)$/);
  if (ok && RAW_ID.test(ok[2].trim())) return { label: named(ok[1]), failed: false, text: named(ok[1]) };
  const label = named(ok ? ok[1] : s);
  return { label, failed: false, text: ok ? s : label };
}

// A part of a progress line that states the job's usual time, e.g. "전체 보통 ~14분"
const OWN_WAIT = /보통\s*~?\d[\d–-]*\s*(?:초|분|시간)/;
// a mesh's wait in the GPU queue ("대기열 3번째 · 시작까지 약 4분", server/providers/img3d.py _place): only while a
// line states it, so it never outlives the queue
const QUEUE_WAIT = /^시작까지 약 \d+\s*(?:초|분|시간)$/;
// a job's own estimate once its progress line stated one: the lines between ("결과 저장 중") state none
const statedWait = new Map<string, string>();
// the estimate a job was queued with (server/video_edit.py keeps edit_video_shot's etaMinutes in its input), for the
// first lines (선행 작업 대기 중, 제출 중) that state none
const queuedWait = (j: Job) => {
  const m = j.input?.etaMinutes;
  return typeof m === 'number' && m > 0 ? `보통 ~${Math.round(m)}분` : undefined;
};
/** What a job is doing and how long it usually takes. The job's own estimate when its progress line states one (a
 * chained restyle's ends with " · 조각마다 ~6분, 전체 보통 ~14분", server/providers/mediagen_video.py) comes off the
 * line and replaces the usual time of its kind or shot model (typicalWait): never both. Before a line states one, the estimate
 * the job was queued with stands in. A mesh's GPU-queue wait replaces it for that line only. */
export function jobWait(j: Job): { progress: string; usual: string } {
  const parts = (j.kind === 'image' ? drawLine(j.progress) : j.progress ?? '').split(' · ');
  const queued = parts.findLastIndex((p) => QUEUE_WAIT.test(p.trim()));
  if (queued >= 0) {
    const usual = parts.splice(queued, 1)[0].trim();
    return { progress: progressText(parts.join(' · ')), usual: serverLine(usual) };
  }
  const own = parts.findLastIndex((p) => OWN_WAIT.test(p));
  if (own >= 0) statedWait.set(j.jobId, parts.splice(own, 1)[0].trim());
  return { progress: progressText(parts.join(' · ')), usual: serverLine(statedWait.get(j.jobId) ?? queuedWait(j) ?? typicalWait(j)) };
}

/** A job's kind as the cards, menus and toasts say it. The server says the same words in its replies, progress lines
 * and wait copy: do not vary them (what a step is doing: JOB_KIND_DOING). */
export const JOB_KIND_LABEL: Record<JobKind, string> = { image: t('이미지'), apose: t('3D용 자세 그림'), mesh3d: t('3D 모델'), rig: t('움직임 뼈대'), render3d: t('3D 회전 영상'), shot: t('영상 샷'), trailer: t('트레일러') };
/** The studio's own word for a 3D step (리깅, 턴테이블): a tooltip at most. */
export const JOB_KIND_TERM: Partial<Record<JobKind, string>> = { apose: t('A-포즈'), mesh3d: t('3D 메시'), rig: t('리깅'), render3d: t('턴테이블') };
const isRelief = (j: Job) => j.kind === 'render3d' && j.input?.model === 'relief';
/** ... and of this job: a whole-scene background's one render makes its panel (server/tools.py render_3d, model
 * relief), which the card's button calls 입체 판. */
export const jobLabel = (j: Job): string => (isRelief(j) ? t('입체 판') : JOB_KIND_LABEL[j.kind]);
export const jobTerm = (j: Job): string | undefined => (isRelief(j) ? undefined : JOB_KIND_TERM[j.kind]);

/** The 3D steps of an IP, in chain order (server/tools.py THREE_D_STEPS). */
const THREE_D_ORDER: JobKind[] = ['apose', 'mesh3d', 'rig', 'render3d'];
export type GameThreeD = { state: 'ready' | 'running' | 'none'; phase?: string };
/** The picture a 3D model was made from, read off the jobs that made it: the mesh (or a background's panel) was given
 * the picture's cutout, a character's mesh the pose drawing drawn from the picture itself (server/tools.py render_3d:
 * cutoutKey, imageKey). undefined when the jobs no longer say. */
export function modelPicture(glb: Asset, assets: Asset[], jobs: Job[]): Asset | undefined {
  const made = jobs.find((j) => j.jobId === glb.jobId);
  const pose = made?.deps.map((id) => jobs.find((j) => j.jobId === id)).find((j) => j?.kind === 'apose');
  const key = pose ? pose.input?.imageKey : made?.input?.cutoutKey;
  const given = typeof key === 'string' ? assets.find((a) => a.key === key && (a.kind === 'image' || a.kind === 'cutout')) : undefined;
  if (!given || given.kind === 'image') return given;
  // a cutout: the picture it was cut from (tagged with it, else the picture of the same draw)
  return assets.find((a) => a.kind === 'image' && (a.assetId === given.meta?.forAssetId || (!!given.jobId && a.jobId === given.jobId)));
}
/** Whether the IP's 3D is finished for a game (server/tools.py game_3d_state): 'ready' = a GLB exists and no rig is still
 * coming for a model without one; 'running' = a 3D job for it is queued or running (phase = its earliest step); 'none'
 * = no 3D was started. make_game refuses a 3D game whose player is not 'ready'. */
export function gameThreeD(ip: Ip, assets: Asset[], jobs: Job[]): GameThreeD {
  const have = new Set(assets.map((a) => a.assetId));
  const running = jobs.filter((j) => THREE_D_ORDER.includes(j.kind) && j.input?.ipId === ip.ipId
    && (j.status === 'queued' || j.status === 'running'));
  const model = [ip.glbAssetId, ip.riggedGlbAssetId].some((id) => !!id && have.has(id));
  const rigging = running.some((j) => j.kind === 'rig') && !(ip.riggedGlbAssetId && have.has(ip.riggedGlbAssetId));
  if (model && !rigging) return { state: 'ready' };
  if (!running.length) return { state: 'none' };
  const first = running.reduce((a, b) => (THREE_D_ORDER.indexOf(b.kind) < THREE_D_ORDER.indexOf(a.kind) ? b : a));
  return { state: 'running', phase: JOB_KIND_LABEL[first.kind] };
}

/** Where a job runs, as its card says it; the service, tool and model are the card's tooltip (providerDetail). */
export const PROVIDER_LABEL: Record<Job['provider'], string> = {
  mediagen_image: t('이미지 GPU'),
  apose: t('이미지 GPU'),
  img3d: '3D GPU',
  rig: t('렌더 서버'),
  deadline: t('렌더 서버'),
  mediagen_video: t('영상 GPU'),
  bedrock_video: t('영상 서비스'),
  ffmpeg: t('영상 편집'),
};
const PROVIDER_TERM: Partial<Record<Job['provider'], string>> = {
  apose: 'FLUX.2 klein 9B', img3d: 'Hunyuan3D', rig: t('Deadline Cloud · Blender 리깅'), deadline: 'Deadline Cloud · Blender',
  bedrock_video: 'Bedrock · Luma Ray 2', ffmpeg: 'ffmpeg',
};

/** Image and video model ids (`asset.meta.model`, `job.input.model`) → display names. */
export const MODEL_LABEL: Record<string, string> = {
  krea: 'Krea 2 Turbo',
  klein9: 'FLUX.2 klein 9B',
  'stability-ultra': 'Stable Image Ultra',
  ltx: 'LTX-2.5',
  'minimax-h3': 'MiniMax H3',
  'kandinsky-6-0-video-pro': 'Kandinsky 6.0',
  'wan-animate': 'Wan 2.2 Animate',
};

export const modelLabel = (m: unknown): string | undefined =>
  typeof m === 'string' && m ? (Object.hasOwn(MODEL_LABEL, m) ? MODEL_LABEL[m] : m) : undefined;

/** What a shot's caption names after the shot: its video model, or for a result no model drew (an upscale delivered
 * as the source enlarged, meta.plain with model "ffmpeg": server/providers/mediagen_video.py) what it is. */
export const shotModelLabel = (a: Asset): string | undefined => (a.meta?.plain ? t('원본 확대') : modelLabel(a.meta?.model));

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
/** The model an image job draws on, by name: the head-keeping redraw's model once a redraw went to it, else the
 * catalog's label the server saved (input.modelLabel, a promoted model's too), else the known names, else the id. */
export function imageModelLabel(j: Job): string | undefined {
  const i = j.input ?? {};
  if (text(i.headModel) && (j.redraws ?? 0) > 0 && j.redrawFor?.includes('head')) return text(i.headLabel) ?? modelLabel(i.headModel);
  return text(i.modelLabel) ?? modelLabel(i.model);
}
/** The model a saved picture was drawn on, by name: the catalog label the job that drew it kept for that model (its
 * own, or the head-keeping redraw's), else the known names, else the id. */
export function assetModelLabel(a: Asset | undefined, jobs: Job[]): string | undefined {
  const id = a?.meta?.model;
  const i = (a?.jobId ? jobs.find((j) => j.jobId === a.jobId)?.input : undefined) ?? {};
  return (id === i.model ? text(i.modelLabel) : id === i.headModel ? text(i.headLabel) : undefined) ?? modelLabel(id);
}

/** Where a job runs: "이미지 GPU", "렌더 서버". */
export const providerLabel = (j: Job): string => PROVIDER_LABEL[j.provider] ?? j.provider;
/** The service or tool behind that, and the model of an image or video job by its label ("Qwen-Image-2.1 (7B)",
 * "LTX-2.5", "Deadline Cloud · Blender 리깅"): the card's tooltip, for whoever chose the model. */
export function providerDetail(j: Job): string | undefined {
  const model = j.provider === 'mediagen_image' ? imageModelLabel(j) : j.provider === 'mediagen_video' ? modelLabel(j.input?.model) : undefined;
  return [PROVIDER_TERM[j.provider], model].filter(Boolean).join(' · ') || undefined;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
};
/** A job card's times: the wait (queued behind its deps, the GPU line or the serial queue) and the work (since it
 * started running, server/jobs.py startedAt) apart, so the work sits next to its usual time. A job sent to its
 * provider's own queue waits until it is taken there (startedAt ''). Counted from 다시 시도 when retried. A job
 * saved before startedAt existed keeps the one 경과. */
export function jobTimes(j: Job, now = Date.now()): string {
  const from = Date.parse(j.retriedAt || j.createdAt);
  const finished = j.status === 'done' || j.status === 'failed';
  // a finished job ends when its provider says the work ended (finishedAt), not when a poll settled it (updatedAt)
  const end = finished ? Date.parse(j.finishedAt || j.updatedAt) : now;
  if (Number.isNaN(from) || Number.isNaN(end)) return t('경과 –');
  if (j.status === 'queued' || j.startedAt === '') return t('대기 {time}', { time: clock(end - from) });
  const began = j.startedAt ? Date.parse(j.startedAt) : NaN;
  if (Number.isNaN(began) || began < from) return t('경과 {time}', { time: clock(end - from) });
  const wait = began - from;
  return `${wait >= 1000 ? `${t('대기 {time}', { time: clock(wait) })} · ` : ''}${t('작업 {time}', { time: clock(end - began) })}`;
}

export const STATUS_LABEL: Record<JobStatus, string> = { queued: t('대기'), running: t('진행 중'), done: t('완료'), failed: t('실패') };

const EDIT_LABEL: Record<string, string> = { restyle: t('화풍 변경'), inpaint: t('부분 수정') };
const TASK_LABEL: Record<string, string> = { upscale: t('업스케일'), deblur: t('흐림 제거'), decompress: t('압축 노이즈 제거'), colorize: t('흑백 채색'),
  day_to_night: t('낮→밤'), relight: t('재조명'), water: t('비·물 효과'), clean_plate: t('인물 지우기') };
/** What an edit of a shot does, off the edit job's input or its result's meta (both carry edit and task,
 * server/video_edit.py), in the agent's words for it: "업스케일", "화풍 변경". An LTX task this list does not know keeps
 * its own name; a shot that is no edit has none. */
export function editLabel(of: Record<string, unknown>): string | undefined {
  if (of.edit === 'v2v') return text(of.task)?.split('+').map((task) => (Object.hasOwn(TASK_LABEL, task) ? TASK_LABEL[task] : task)).join(' + ') ?? t('영상 편집');
  return typeof of.edit === 'string' && Object.hasOwn(EDIT_LABEL, of.edit) ? EDIT_LABEL[of.edit] : undefined;
}
/** What a job card says after the job's kind: the IP it works on (an edit of a shot keeps its source's as sourceIpId,
 * never ipId) or its title, and what an edit of a shot does. */
export function jobTitle(j: Job, ips: Ip[]): string | undefined {
  const i = j.input ?? {};
  const ipId = text(i.ipId) ?? text(i.sourceIpId);
  const target = ipId ? ips.find((ip) => ip.ipId === ipId)?.name : text(i.title);
  return [target, j.kind === 'shot' ? editLabel(i) : j.kind === 'image' ? drawLabel(i) : undefined].filter(Boolean).join(' · ') || undefined;
}
/** Which picture of its IP an image job draws: the version (server/tools.py _queue_image keeps it in the input), as
 * an edit (make_ip_variant) when it is one. An IP's first picture and a still that is no version say nothing. */
function drawLabel(i: Record<string, unknown>): string | undefined {
  const version = typeof i.version === 'number' ? i.version : 0;
  return version > 1 ? (text(i.edit) ? t('수정 v{version}', { version }) : `v${version}`) : undefined;
}
/** The words of an image edit (the change the agent asked of the model), for the card's tooltip. */
export const jobEdit = (j: Job): string | undefined => (j.kind === 'image' ? text(j.input?.edit) : undefined);

/** Model-written colors are data: only `#rrggbb` reaches a style attribute. */
export const isHex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

const timeFormat = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeFormat.format(d);
};
