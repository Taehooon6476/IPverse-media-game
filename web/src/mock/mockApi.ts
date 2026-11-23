// Dev-only fake backend (`VITE_MOCK=1`). Implements the HTTP API routes in memory; after a chat message
// every `GET /sessions/{id}` runs one scripted step, so the panes fill up the way a real agent turn would.
import type { Reply } from '../api';
import { handleAgents, mockImageModels } from './agentsMock';
import type { Asset, AssetKind, Game, Genre, Ip, Job, Message, Snapshot } from '../types';

const IMG = (seed: string) => `https://picsum.photos/seed/${seed}/512`;
const CUTOUT = (seed: string) => `https://picsum.photos/seed/${seed}/512?grayscale`;
const VIDEO = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const GLB = 'https://modelviewer.dev/shared-assets/models/Astronaut.glb';

type Step = (s: Snapshot) => void;
interface MockSession {
  snap: Snapshot;
  script: Step[];
}

const db = new Map<string, MockSession>();
let liveOn: unknown = null;
const mockServers: { id: string; [k: string]: unknown }[] = [];
let seq = 0;
const newId = (prefix: string) => `${prefix}_${(++seq).toString(16).padStart(6, '0')}mock`;
const iso = (secondsAgo = 0) => new Date(Date.now() - secondsAgo * 1000).toISOString();

function createSession(title: string, genre: Genre, createdAt = iso()): MockSession {
  const sessionId = newId('ses');
  const m: MockSession = {
    snap: { session: { sessionId, title, genre, concept: null, createdAt, updatedAt: createdAt }, messages: [], ips: [], assets: [], jobs: [], games: [] },
    script: [],
  };
  db.set(sessionId, m);
  return m;
}

createSession('숲속 기사 모모', 'rpg-explore', iso(26 * 3600));
createSession('우주 고양이 탐험가 루나', 'sf-shooter', iso(5 * 60));

const ok = (data: unknown, status = 200): Reply => ({ status, data });

/** The watch window's four dummy viewers (server/viewers.py) and one trailer break that gave each its own ad. */
const mockViewer = (viewerId: string, name: string, color: string, genre: string, device: string, ageBand: string, region: string, recent: string[]) => ({
  viewerId, name, initials: name.slice(1), color, bio: '', profile: { ageBand, region, device, genres: [genre] },
  recent: recent.map((text, i) => ({ type: i ? 'play' : 'ad_click', at: iso((i + 1) * 5400), text, ...(i ? {} : { simulated: true }) })),
  events: 36, features: { g1: genre, g2: 'none', skill: 'hi', dev: device, age: ageBand }, provider: 'ipverse',
});
const MOCK_VIEWERS = [
  mockViewer('v-minji', '김민지', '#e5484d', 'arpg', 'pc', '25-34', '서울', ['광고 클릭 · 보스 레이드 (액션 RPG)', '액션 RPG · 그림자 군주: 보스 러시 94분 플레이 (승리)', '구매 · 심연의 던전 (액션 RPG)', '광고 스킵 · 서킷 레전드 (레이싱)']),
  mockViewer('v-junho', '박준호', '#0090ff', 'racing', 'console', '35-44', '부산', ['레이싱 · 서킷 레전드 42분 플레이 (패배)', '찜 · 네온 드리프트 X (레이싱)', '광고 스킵 · 은하 침공 (SF 슈터)']),
  mockViewer('v-seoyeon', '이서연', '#30a46c', 'explore', 'mobile', '25-34', '대전', ['탐험·수집 · 구름섬 수집가 12분 플레이 (승리)', '트레일러 시청 · 보물 정원 (탐험·수집)', '플레이어블 광고 2분 · 골목 탐험 일기']),
  mockViewer('v-hyunwoo', '최현우', '#8e4ec6', 'shooter', 'pc', '18-24', '인천', ['SF 슈터 · 스타 레인저 61분 플레이 (승리)', '광고 클릭 · 메카 프론트라인 (SF 슈터)', '방송 시청 12분 · 좀비 생존 30']),
];
const mockPick = (title: string, reason: string) => ({ title, creative: `cr_${title}`, seconds: 20, reason, reasons: reason.split(' · ') });
const MOCK_BREAK = { round: 2, eventId: 'ivs1', at: iso(), seconds: 30, kind: 'trailer', breakId: 'b_mock', picks: {
  '': mockPick('좀비 생존 30', '기본 광고 (시청자 정보 없음)'),
  'v-minji': mockPick('보스 레이드', '최근 7일 액션 RPG 9시간 2분 (3승) · 액션 RPG 광고 클릭 2회'),
  'v-junho': mockPick('네온 드리프트', '최근 7일 레이싱 4시간 57분 (6승) · 레이싱 게임 구매 1회'),
  'v-seoyeon': mockPick('구름섬 이야기', "최근 7일 탐험·수집 2시간 30분 · '수집' 좋아함"),
  'v-hyunwoo': mockPick('스타 워든', "최근 7일 SF 슈터 5시간 56분 (6승) · '우주' 좋아함"),
} };
const notFound = (message: string): Reply => ({ status: 404, data: { error: 'not_found', message } });

export async function handle(method: string, path: string, body?: unknown): Promise<Reply> {
  await new Promise((r) => setTimeout(r, 400));
  const b = (body ?? {}) as Record<string, unknown>;
  if (path.startsWith('/agents')) return handleAgents(method, path, b);
  if (path === '/live/viewers') return ok({ viewers: MOCK_VIEWERS });
  if (path === '/live/token') return ok({ playbackUrl: '', expiresAt: Math.floor(Date.now() / 1000) + 1200, persona: b.persona, personaName: '', provider: 'ipverse' });
  if (path === '/sessions' && method === 'GET') {
    const sessions = [...db.values()]
      .map(({ snap: { session: s } }) => ({ sessionId: s.sessionId, title: s.title, genre: s.genre, createdAt: s.createdAt }))
      .sort((a, z) => z.createdAt.localeCompare(a.createdAt));
    return ok({ sessions });
  }
  if (path === '/connections' && method === 'GET') { // a fake platform list; user servers live in this module
    return ok({ platform: [
      { id: 'imagegen', kind: 'mcp', name: '이미지 생성 MCP', endpoint: 'https://mock/mcp', status: 'connected', toolCount: 4, tools: ['generate_image', 'edit_image', 'status', 'models'], models: mockImageModels() },
      { id: 'bedrock-agent', kind: 'aws', name: 'Amazon Bedrock · 에이전트', endpoint: 'bedrock-runtime', status: 'connected' },
    ], servers: mockServers });
  }
  if (path === '/connections' && method === 'POST') {
    const server = { id: `mcp_${mockServers.length + 1}`, name: String(b.name), url: String(b.url), status: 'connected', enabled: true, toolCount: 1, tools: ['echo'] };
    mockServers.push(server);
    return ok(server, 200);
  }
  if (path.startsWith('/connections/')) {
    const id = decodeURIComponent(path.split('/')[2]);
    const i = mockServers.findIndex((x) => x.id === id);
    if (i < 0) return notFound('연결을 찾지 못했습니다');
    if (method === 'DELETE') { mockServers.splice(i, 1); return ok({ deleted: id }); }
    Object.assign(mockServers[i], typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {});
    return ok(mockServers[i]);
  }
  if (path === '/sessions' && method === 'POST') {
    const m = createSession(String(b.title || '새 세션'), (b.genre as Genre) || 'sf-shooter');
    return ok({ session: m.snap.session }, 201);
  }
  const [, , rawId, action] = path.split('/');
  const m = rawId ? db.get(decodeURIComponent(rawId)) : undefined;
  if (!m) return notFound('세션을 찾을 수 없습니다.');
  const s = m.snap;
  if (method === 'DELETE' && !action) {
    db.delete(s.session.sessionId);
    return ok({ deleted: s.session.sessionId });
  }
  if (method === 'GET' && !action) {
    m.script.shift()?.(s);
    return ok(structuredClone(s));
  }
  if (method === 'PATCH' && !action) {
    if (b.genre) s.session.genre = b.genre as Genre;
    if (b.title) s.session.title = String(b.title);
    s.session.updatedAt = iso();
    return ok(structuredClone(s));
  }
  if (method === 'POST' && action === 'chat') {
    const text = String(b.text ?? '');
    s.messages.push({ messageId: newId('msg'), role: 'user', text, status: 'done', ts: iso() });
    const reply: Message = { messageId: newId('msg'), role: 'assistant', text: '', status: 'pending', toolEvents: [], ts: iso() };
    s.messages.push(reply);
    m.script = s.ips.length ? replyScript(reply, text) : mainScript(reply);
    return ok({ messageId: reply.messageId }, 202);
  }
  if (action === 'live') { // POST starts, DELETE stops, GET reports (a fake channel that is RUNNING at once)
    const idle = { active: false, channelState: 'IDLE', broadcaster: 'none', playbackUrl: '', job: null, stream: null };
    if (method === 'POST') {
      liveOn = { active: true, channelState: 'RUNNING', broadcaster: 'running', playbackUrl: '',
        job: { gameId: String(b.gameId), everyRounds: Number(b.everyRounds), adSeconds: 10, startedAt: iso() },
        stream: { state: 'starting', rounds: 2, breaks: [MOCK_BREAK], updatedAt: iso() } };
    }
    if (method === 'DELETE') liveOn = null;
    return ok(liveOn ?? idle);
  }
  const [, , , , name, mode] = path.split('/');
  if (method === 'POST' && action === 'tools') return mockTool(m, decodeURIComponent(name ?? ''), b, mode === 'async');
  if (method === 'POST' && action === 'jobs' && mode === 'cancel') {
    const j = s.jobs.find((x) => x.jobId === decodeURIComponent(name ?? ''));
    if (!j || (j.status !== 'queued' && j.status !== 'running')) return { status: 400, data: { error: 'bad_request', message: '대기 중이거나 진행 중인 작업만 중지할 수 있습니다' } };
    setJob(j, 'failed', '', { error: '사용자가 중지함' });
    return ok({ canceled: j.jobId });
  }
  if (method === 'POST' && action === 'jobs' && mode === 'retry') {
    const j = s.jobs.find((x) => x.jobId === decodeURIComponent(name ?? ''));
    if (!j || j.status !== 'failed') return { status: 400, data: { error: 'bad_request', message: '실패한 작업만 다시 시도할 수 있습니다' } };
    setJob(j, 'queued', '다시 시도 대기 중', { error: undefined });
    m.script.push(() => setJob(j, 'running', '다시 실행 중'), () => setJob(j, 'done', ''));
    return ok({ retried: [j.jobId] });
  }
  if (method === 'POST' && action === 'publish') {
    const game = s.games.find((g) => g.gameId === b.gameId);
    if (!game) return notFound('게임을 찾을 수 없습니다.');
    const ad = s.assets.find((a) => a.assetId === b.adAssetId);
    game.adAssetId = ad?.assetId;
    game.publishedAt = iso();
    game.publishedUrl = gamePage(game.title, ad ? `광고: ${ad.kind === 'shorts' ? '쇼츠' : '트레일러'} · ${Number(b.skipAfterSec ?? 5)}초 후 건너뛰기` : '광고 없음');
    return ok({ publishedUrl: game.publishedUrl });
  }
  if (method === 'DELETE' && action === 'publish') { // 게시 내리기 (server/app.py unpublish)
    const game = s.games.find((g) => g.gameId === decodeURIComponent(name ?? ''));
    if (!game) return notFound('게임을 찾을 수 없습니다.');
    delete game.publishedUrl; delete game.publishedAt; delete game.adAssetId;
    return ok({ unpublished: game.gameId });
  }
  return notFound(`목업에 없는 경로입니다: ${method} ${path}`);
}

/** GameSpec v1 for the GameSpec tab. */
export function spec(game: Game): unknown {
  return {
    version: 1,
    title: game.title,
    genre: game.genre,
    palette: { bg: '#0b0d12', accent: '#ffb86b', text: '#f5f7fa' },
    player: { ipId: 'ip_luna', name: '루나', spriteUrl: 'assets/ip_luna.png', speed: 2 },
    props: [{ ipId: 'ip_core', name: '플라즈마 코어', spriteUrl: 'assets/ip_core.png', effect: 'score' }],
    enemies: [{ name: '드론', color: '#ff5a5a', shape: 'triangle', speed: 2, hp: 1 }],
    objective: { type: 'kills', target: 15 },
    difficulty: 'normal',
    dialogue: [{ speaker: '루나', text: '코어를 되찾아 궤도를 탈출하자!' }],
    quest: null,
    map: { width: 20, height: 15, seed: 1234 },
  };
}

// --- script helpers ---

function addAsset(s: Snapshot, kind: AssetKind, url: string, extra: Partial<Asset> = {}): Asset {
  const assetId = newId('ast');
  const ext = url.endsWith('.glb') ? 'glb' : url.endsWith('.mp4') ? 'mp4' : kind === 'cutout' ? 'png' : 'jpg';
  const contentType = { glb: 'model/gltf-binary', mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg' }[ext];
  const a: Asset = { assetId, kind, key: `sessions/${s.session.sessionId}/${assetId}.${ext}`, url, contentType, meta: {}, createdAt: iso(), ...extra };
  s.assets.push(a);
  return a;
}

function addIp(s: Snapshot, kind: Ip['kind'], name: string, role: string, description: string, seed: string, extra: Partial<Ip> = {}): Ip {
  const ipId = newId('ip');
  const image = addAsset(s, 'image', IMG(seed), { ipId, meta: { model: 'krea' } });
  const cutout = addAsset(s, 'cutout', CUTOUT(seed), { ipId });
  const ip: Ip = { ipId, kind, name, role, description, imageAssetId: image.assetId, cutoutAssetId: cutout.assetId, version: 1, createdAt: iso(), ...extra };
  s.ips.push(ip);
  return ip;
}

function addJob(s: Snapshot, kind: Job['kind'], provider: Job['provider'], input: Record<string, unknown>, deps: Job[] = []): Job {
  const j: Job = {
    jobId: newId('job'), kind, provider, status: 'queued', input, outputs: [], deps: deps.map((d) => d.jobId),
    progress: deps.length ? '선행 작업 대기' : '대기열 등록', createdAt: iso(), updatedAt: iso(),
  };
  s.jobs.push(j);
  return j;
}

function setJob(j: Job, status: Job['status'], progress: string, extra: Partial<Job> = {}) {
  Object.assign(j, { status, progress, updatedAt: iso() }, extra);
}

function toolEvent(m: Message, tool: string, summary: string) {
  m.toolEvents!.push({ tool, summary, ts: iso() });
}

function finish(m: Message, text: string) {
  Object.assign(m, { status: 'done', text });
}

/** Card buttons: the same tools the server runs for POST /tools/{name}[/async], faked. */
function mockTool(m: MockSession, name: string, b: Record<string, unknown>, background: boolean): Reply {
  const s = m.snap;
  const ip = s.ips.find((x) => x.ipId === b.ipId);
  if (!ip) return notFound('IP를 찾을 수 없습니다.');
  if (background) {
    const msg: Message = { messageId: newId('msg'), role: 'assistant', text: name === 'reroll_ip_image' ? '다시 뽑는 중…' : '액션 샷 준비 중…', status: 'pending', toolEvents: [], ts: iso() };
    s.messages.push(msg);
    m.script.push(() => {
      if (name === 'reroll_ip_image') {
        const version = ip.version + 1;
        const seed = `${ip.ipId}-v${version}`;
        const image = addAsset(s, 'image', IMG(seed), { ipId: ip.ipId, meta: { model: 'klein9', version } });
        const cutout = addAsset(s, 'cutout', CUTOUT(seed), { ipId: ip.ipId, meta: { forAssetId: image.assetId } });
        Object.assign(ip, { version, imageAssetId: image.assetId, cutoutAssetId: cutout.assetId });
        finish(msg, `다시 뽑기: ${ip.name} v${version}`);
      } else {
        addJob(s, 'shot', 'mediagen_video', { ipId: ip.ipId, prompt: String(b.action), model: 'ltx', seconds: 5 });
        finish(msg, `액션 샷 등록: ${ip.name}`);
      }
    });
    return ok({ messageId: msg.messageId }, 202);
  }
  if (name === 'render_3d') {
    const pose = addJob(s, 'apose', 'apose', { ipId: ip.ipId });
    const mesh = addJob(s, 'mesh3d', 'img3d', { ipId: ip.ipId }, [pose]);
    setJob(pose, 'failed', '', { error: 'An error occurred (ServiceUnavailableException): Bedrock is unable to process your request.' });
    setJob(mesh, 'failed', '', { error: '선행 작업 실패' });
    return ok({ result: { jobId: mesh.jobId } });
  }
  if (name === 'make_video_shot') return ok({ result: { jobId: addJob(s, 'shot', 'mediagen_video', { ...b }).jobId } });
  if (name === 'restore_ip_version') {
    const image = s.assets.find((a) => a.assetId === b.imageAssetId);
    if (!image) return notFound('이미지를 찾을 수 없습니다.');
    const cutout = s.assets.find((a) => a.kind === 'cutout' && (a.meta?.forAssetId === image.assetId || a.createdAt >= image.createdAt) && a.ipId === ip.ipId);
    Object.assign(ip, { version: Number(image.meta?.version ?? 1), imageAssetId: image.assetId, cutoutAssetId: cutout?.assetId ?? ip.cutoutAssetId });
    return ok({ result: { version: ip.version } });
  }
  return notFound(`목업에 없는 도구입니다: ${name}`);
}

/** Self-contained page standing in for the Phaser game runtime. */
function gamePage(title: string, badge: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;overflow:hidden;font:600 18px system-ui,sans-serif;color:#f5f7fa;
background:radial-gradient(circle at 30% 25%,#2a3b66,#0b0d12 70%)">
<style>@keyframes f{50%{transform:translateY(-12px)}}.s{font-size:64px;animation:f 2.4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.s{animation:none}}</style>
<div style="text-align:center"><div class="s">🐱🚀</div><p style="margin:12px 0 4px">${title}</p>
<small style="opacity:.7">목업 게임 화면 · ${badge}</small></div></body>`;
  return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
}

// --- scripts ---

function mainScript(reply: Message): Step[] {
  const msg = (s: Snapshot) => s.messages.find((x) => x.messageId === reply.messageId)!;
  let luna: Ip, core: Ip;
  let render: Job, renderCore: Job, shotA: Job, shotB: Job, trailer: Job;
  return [
    (s) => {
      toolEvent(msg(s), 'set_concept', '컨셉 설정: 루나의 궤도 탈출');
      s.session.concept = {
        title: '루나의 궤도 탈출',
        logline: '고장 난 궤도 정거장에 갇힌 고양이 탐험가 루나가 플라즈마 코어를 되찾아 탈출한다.',
        style: '픽사풍 3D 일러스트',
        palette: ['#ffb86b', '#1b2a4a', '#5de6cf'],
      };
    },
    (s) => {
      toolEvent(msg(s), 'create_ip_asset', '캐릭터 생성 중: 루나');
      luna = addIp(s, 'character', '루나', '주인공', '은하 정찰대 소속 고양이 우주비행사. 호기심이 많고 겁이 없다.', 'luna');
    },
    (s) => {
      toolEvent(msg(s), 'create_ip_asset', '소품 생성 중: 플라즈마 코어');
      core = addIp(s, 'prop', '플라즈마 코어', '핵심 아이템', '멈춘 궤도 엔진을 다시 깨우는 푸른 에너지 코어.', 'plasma');
    },
    (s) => {
      const m = msg(s);
      toolEvent(m, 'create_ip_asset', '무기 생성: 펄스 블래스터');
      const blaster = addIp(s, 'weapon', '펄스 블래스터', '루나의 무기', '손잡이가 아래로 선 소형 플라즈마 권총.', 'blaster', { weaponType: 'gun' });
      toolEvent(m, 'create_ip_asset', '적 생성: 정거장 좀비');
      addIp(s, 'enemy', '정거장 좀비', '사람형 적', '전선에 감염된 승무원. 비틀거리며 다가온다.', 'zombie', { humanoid: true });
      toolEvent(m, 'create_ip_asset', '적 생성: 보안 드론');
      addIp(s, 'enemy', '보안 드론', '비사람형 적', '붉은 렌즈의 구형 경비 드론.', 'drone', { humanoid: false });
      toolEvent(m, 'make_action_shot', '액션 샷 등록: 루나');
      addAsset(s, 'action_image', IMG('luna-action'), { ipId: luna.ipId, meta: { action: 'running with the pulse blaster', weaponIpId: blaster.ipId } });
    },
    (s) => {
      const m = msg(s);
      toolEvent(m, 'render_3d', '3D 렌더 등록: 루나');
      render = addJob(s, 'render3d', 'deadline', { ipId: luna.ipId });
      toolEvent(m, 'render_3d', '3D 렌더 등록: 플라즈마 코어');
      renderCore = addJob(s, 'render3d', 'deadline', { ipId: core.ipId });
      toolEvent(m, 'make_video_shot', '영상 샷 등록: 루나 ×2');
      shotA = addJob(s, 'shot', 'mediagen_video', { ipId: luna.ipId, aspect_ratio: '16:9', seconds: 5, model: 'ltx' });
      shotB = addJob(s, 'shot', 'mediagen_video', { ipId: luna.ipId, aspect_ratio: '9:16', seconds: 5, model: 'minimax-h3' });
      toolEvent(m, 'cut_trailer', '트레일러 등록: teal-orange · 쇼츠 포함');
      trailer = addJob(s, 'trailer', 'ffmpeg', { title: '루나의 궤도 탈출', lut: 'teal-orange', make_shorts: true }, [render, shotA, shotB]);
    },
    (s) => {
      setJob(render, 'running', 'STARTING');
      setJob(renderCore, 'running', 'STARTING');
      setJob(shotA, 'running', 'denoising 40%');
      setJob(shotB, 'running', 'starting_instance');
      finish(msg(s), '컨셉과 IP 5개(루나, 플라즈마 코어, 펄스 블래스터, 정거장 좀비, 보안 드론)를 만들고 3D 렌더와 영상 샷 작업을 시작했어요.\n작업이 끝나면 트레일러와 쇼츠로 자르고, 같은 IP로 게임을 만들게요.');
    },
    (s) => {
      const a = addAsset(s, 'shot', VIDEO, { ipId: luna.ipId, jobId: shotA.jobId, meta: { aspect_ratio: '16:9', model: 'ltx' } });
      const b = addAsset(s, 'shot', VIDEO, { ipId: luna.ipId, jobId: shotB.jobId, meta: { aspect_ratio: '9:16', model: 'minimax-h3' } });
      setJob(shotA, 'done', '완료', { outputs: [a.assetId] });
      setJob(shotB, 'done', '완료', { outputs: [b.assetId] });
      setJob(render, 'running', 'Blender 턴테이블 렌더 중 · 1분 5초');
      setJob(renderCore, 'failed', 'FAILED', { error: 'Blender 작업 실패: 실루엣을 찾지 못했습니다 (exit code 1)' });
    },
    (s) => {
      const glb = addAsset(s, 'glb', GLB, { ipId: luna.ipId, jobId: render.jobId });
      const turntable = addAsset(s, 'turntable', VIDEO, { ipId: luna.ipId, jobId: render.jobId });
      const poster = addAsset(s, 'poster', IMG('luna'), { ipId: luna.ipId, jobId: render.jobId });
      Object.assign(luna, { glbAssetId: glb.assetId, turntableAssetId: turntable.assetId, posterAssetId: poster.assetId });
      setJob(render, 'done', 'SUCCEEDED', { outputs: [glb.assetId, turntable.assetId, poster.assetId] });
      setJob(trailer, 'running', 'ffmpeg 그레이딩 · 컷 편집');
    },
    (s) => {
      const t = addAsset(s, 'trailer', VIDEO, { jobId: trailer.jobId });
      const short = addAsset(s, 'shorts', VIDEO, { jobId: trailer.jobId });
      setJob(trailer, 'done', '완료', { outputs: [t.assetId, short.assetId] });
      const gameId = newId('gm');
      s.games.push({
        gameId, title: '루나의 궤도 탈출', genre: s.session.genre, specKey: `games/${gameId}/spec.json`,
        previewUrl: gamePage('루나의 궤도 탈출', '미리보기'), createdAt: iso(),
      });
    },
  ];
}

function replyScript(reply: Message, text: string): Step[] {
  const msg = (s: Snapshot) => s.messages.find((x) => x.messageId === reply.messageId)!;
  return [
    (s) => toolEvent(msg(s), 'plan', '요청 분석 중'),
    (s) => finish(msg(s), `(목업) “${text}” 요청을 받았어요. 실제 환경에서는 에이전트가 필요한 도구를 골라 실행합니다.`),
  ];
}
