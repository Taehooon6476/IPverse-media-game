import { useEffect, useRef, useState, type FormEvent } from 'react';
import { lang, t } from '../i18n';
import { THREE_D_TOTAL, chainTypical, gameThreeD, josa, threeDSteps, type Asset, type Game, type GameDesignRequest, type GameIpRole, type GameThreeD, type Ip,
  type Job } from '../types';
import { session } from '../storage';
import { NeedsSteps, OTHERS_NOTE, STAND_IN_WHY, gameNeeds, standInLine } from './GameNeeds';
import { useDialog } from './useDialog';

interface Props {
  /** The session's IPs: picking some limits the game to exactly those (출연 IP). */
  ips: Ip[];
  assets: Asset[];
  /** The session's jobs: an IP whose 3D is still being made shows its step. */
  jobs?: Job[];
  /** A card's 3D로 만들기 (render_3d through the card action); rejects when the server refused it. */
  onMake3d?: (ip: Ip) => Promise<void>;
  /** Close this drawer and go to the chat's message box: the way on when the session has no character yet. */
  onChat?: () => void;
  onClose: () => void;
  /** Sends the brief through the chat; resolves when queued. */
  onSend: (text: string, gameDesign: GameDesignRequest) => Promise<void>;
  /** The session's games: with one on screen the drawer says that it designs a new game, and where that one is edited. */
  games?: Game[];
  /** Open 이 게임 수정 for that game in place of this drawer. */
  onEditGame?: (game: Game, version: number) => void;
}

/** Game types the 3D runtime really plays differently (server/prompts.py maps them to genre + objective.type). */
const briefKey = () => `ipverse:design-brief:${location.hash.match(/s=([^&]+)/)?.[1] ?? ''}`; // per session
const castKey = () => `${briefKey()}:cast`; // the ticked 출연 IP and their roles, kept with the brief
const TYPES = [
  // (the idea box stands above the types)
  { id: '', label: t('요청에 맞게'), hint: t('위에 적은 아이디어대로 설계') },
  { id: 'city-open-world', label: t('도시 오픈월드'), hint: t('구역·도로·차량·보행자와 단계별 임무') },
  { id: 'arpg', label: t('핵앤슬래시 (디아블로풍)'), hint: t('칼싸움 연속 베기·레벨업·아이템 드랍·보스') },
  { id: 'race', label: t('레이싱'), hint: t('도시 서킷 랩·체크포인트·AI 라이벌·순위') },
  { id: 'platformer', label: t('점프 플랫포머'), hint: t('움직이는 발판·코인·추락 리스폰') },
  { id: 'kills', label: t('섬멸전'), hint: t('적 N명 처치') },
  { id: 'survive', label: t('생존전'), hint: t('N초 버티기, 갈수록 적이 늘어남') },
  { id: 'boss', label: t('보스전'), hint: t('거대한 보스 1명 + 졸개') },
  { id: 'collect', label: t('수집전'), hint: t('경기장 곳곳의 코어 회수') },
  { id: 'reach', label: t('거점 확보'), hint: t('차례로 나타나는 지점 점령') },
  { id: 'rpg-explore', label: t('RPG 탐험'), hint: t('마을·지형 탐험하며 아이템 수집') },
  { id: 'rpg-quest', label: t('RPG 퀘스트'), hint: t('NPC 의뢰를 받고 완수') },
];
export const BIOME_CHOICES = [['', t('AI가 정함')], ['forest', t('숲·정글')], ['desert', t('사막·황야')], ['snow', t('설원·빙하')],
  ['ruins', t('폐허·전쟁터')], ['industrial', t('공장·산업')], ['volcanic', t('화산·용암')], ['night-city', t('네온 야경')], ['crypt', t('지하 묘지·던전')], ['temple', t('하늘 신전·성곽·고대 유적')]] as const;
const THEMES = [
  ['', t('요청에 맞게')],
  ['neon-arena', t('네온 아레나')], ['ruined-city', t('폐허 도시')], ['desert-outpost', t('사막 전초기지')],
  ['ice-station', t('얼음 기지')], ['lava-forge', t('용광로')], ['jungle-ruins', t('정글 유적')],
] as const;
const SKIES = [['', t('테마에 맞게')], ['space', t('우주')], ['day', t('낮')], ['dusk', t('노을')], ['storm', t('폭풍')], ['night', t('밤')]] as const;
const LAYOUTS = [['', t('테마에 맞게')], ['pillars', t('기둥 아레나')], ['open', t('탁 트인 벌판')], ['maze', t('미로')], ['ring', t('원형 성벽')]] as const;
const DIFFICULTY = [['', t('요청에 맞게')], ['easy', t('쉬움')], ['normal', t('보통')], ['hard', t('어려움')]] as const;

export interface Brief {
  prompt?: string;
  type: string; theme: string; sky: string; layout: string; mission: string; clear: string; fail: string;
  /** photoreal CC0 environment (server/prompts.py artDirection.biome); '' = the agent picks */
  biome?: string;
  /** set pieces to create first (AI image → Hunyuan3D), comma separated */
  newSets?: string;
  enemies: string; difficulty: string; extra: string;
  /** What the AI needs beyond the idea to design an example the runtime plays (spec field names, exact numbers). Sent
   * with the request, never typed into the idea box. */
  spec?: string;
}

const EMPTY: Brief = { prompt: '', type: '', theme: '', sky: '', layout: '', mission: '', clear: '', fail: '', enemies: '', difficulty: '', extra: '' };
// (an example is sent to the agent as the user's own design: the English page's examples are English)
const PRESETS: { name: string; brief: Brief }[] = [
  { name: t('도시 코어 운송'), brief: { ...EMPTY, type: 'city-open-world', sky: 'day', difficulty: 'easy',
    prompt: t('주인공이 안내 NPC의 부탁을 받고 소품을 되찾아, 차를 몰고 다른 구역의 배송 지점까지 운반하는 도시 게임을 만들어줘. ')
      + t('도심·주거·산업 구역 세 곳이 도로로 이어져 있고, 거리에는 보행자가 걸어 다녀.'),
    spec: t('선택한 출연 IP와 지정한 주인공·소품·NPC·무기·적 역할을 그대로 사용해. ')
      + t('version 2, engine three, world.city로 설계하고, 월드는 600 × 600m로 해줘(지원 범위는 300–1200m). ')
      + t('districts에 서로 다른 도심(downtown)·주거(residential)·산업(industrial) 구역 3개를 실제 좌표와 크기로 배치해줘. ')
      + t('streets에는 각 축 최소 2개의 연결된 도로를 만들고, 도로 외곽과 월드 경계 사이에는 16m 이상 여유를 남겨줘. ')
      + t('vehicles에 운전할 차량을 놓고 E로 승하차, WASD로 운전, Space로 제동하게 해줘. ')
      + t('pedestrians에는 선택한 NPC 캐릭터 IP를 재사용한 보행자 4명과 서로 다른 순환 경로를 넣어줘. ')
      + t('안내 NPC와 대화 → 선택한 소품 IP 회수 → 지정 차량으로 150m 운전 → 다른 구역 배송 지점 도달의 4단계 임무를 만들어줘. ')
      + t('주행 단계는 type drive, target 1, entityIds에 실제 차량 ID 하나, distanceMeters 150으로 하고, 도달 목표를 주행으로 이름만 바꾸지 마. ')
      + t('플레이어·NPC·소품·적·무기는 선택한 출연 IP만 사용하고, 건물·도로·차량은 제공된 도시 환경 키트를 사용해줘. ')
      + t('선택하지 않은 적이나 무기를 추가하지 말고, 필요한 NPC·소품 역할이 없으면 부족한 역할을 알려줘. Three.js 브라우저 게임이야.'),
    mission: t('코어를 회수해 차량으로 다른 구역에 운송'),
    clear: t('NPC 대화, 소품 회수, 지정 차량 150m 주행, 배송 지점 도달을 순서대로 완료'),
    fail: t('주인공 체력이 0이면 실패, 시간 제한 없음'), extra: t('대시와 달리기를 쓸 수 있고, 자동 공격은 꺼 둬.') } },
  { name: t('폐허 핵앤슬래시'), brief: { ...EMPTY, type: 'arpg', biome: 'ruins', mission: t('폐허가 된 성채의 언데드 무리를 베고 리치 왕을 쓰러뜨려라'),
    clear: t('무리 3번을 처치하고 보스를 쓰러뜨리면 클리어'), fail: t('체력이 0이 되면 실패'), enemies: t('좀비 무리가 계속 몰려오고 마지막에 보스'), difficulty: 'normal', extra: t('근접 무기로 싸우고, 레벨업하며 장비를 모은다') } },
  { name: t('용광로 보스전'), brief: { ...EMPTY, type: 'boss', theme: 'lava-forge', sky: 'night', layout: 'open', mission: t('용광로 심장부의 거대 전투 로봇을 쓰러뜨려라'),
    clear: t('보스 체력을 0으로 만들면 클리어'), fail: t('4분 안에 못 잡거나 체력이 0이 되면 실패'), enemies: t('보스 1명 + 작은 수리 드론이 계속 나옴'), difficulty: 'hard', extra: t('플레이어 체력 200') } },
  { name: t('사막 코어 회수'), brief: { ...EMPTY, type: 'collect', theme: 'desert-outpost', sky: 'day', layout: 'maze', mission: t('모래폭풍이 오기 전에 에너지 코어 6개 회수'),
    clear: t('코어 6개를 모두 주우면 클리어'), fail: t('5분 제한, 시간이 다 되면 실패'), enemies: t('빠른 정찰 드론 위주, 적은 적게'), difficulty: 'normal', extra: '' } },
  { name: t('눈보라 거점전'), brief: { ...EMPTY, type: 'reach', theme: 'ice-station', sky: 'storm', layout: 'ring', mission: t('눈보라 속 통신탑 3곳을 차례로 확보'),
    clear: t('각 지점에 잠시 머물러 3곳 모두 확보'), fail: t('체력이 0이 되면 실패'), enemies: t('느리지만 튼튼한 경비병'), difficulty: 'normal', extra: t('경기장을 크게') } },
];

const KIND_LABEL: Record<Ip['kind'], string> = { character: t('캐릭터#하나'), enemy: t('적'), weapon: t('무기'), prop: t('소품#하나') };
export const GAME_ROLE_LABEL: Record<GameIpRole, string> = { player: t('주인공'), weapon: t('주인공 무기'), prop: t('소품·아이템'), enemy: t('적'), npc: t('NPC·동료'), background: t('배경·환경'), set: t('배경 사물 (3D)') };
const ROLE_CHOICES: Record<Ip['kind'], GameIpRole[]> = {
  character: ['player', 'npc', 'enemy'], enemy: ['enemy', 'npc'], weapon: ['weapon'], prop: ['prop', 'set', 'background'],
};

export function defaultRole(ip: Ip, roles: Record<string, GameIpRole>): GameIpRole {
  if (ip.kind === 'character') return Object.values(roles).includes('player') ? 'npc' : 'player';
  if (ip.kind === 'prop' && ip.usage === 'background') return 'background';
  return ip.kind === 'weapon' ? 'weapon' : ip.kind === 'enemy' ? 'enemy' : 'prop';
}

/** The 3D rule's line for the player (server/tools.py _needs_3d): a 3D game is played by its protagonist, and one
 * without a finished 3D is a flat cutout panel, so the game waits for it. */
export function playerThreeDProblem(name: string, threeD: GameThreeD): string | null {
  if (threeD.state === 'ready') return null;
  return threeD.state === 'running'
    ? t('주인공 ‘{name}’의 3D가 아직 만들어지고 있어요({phase}). 3D가 끝나면 게임을 만들 수 있어요.', { name, phase: threeD.phase ?? '' })
    : t('주인공 ‘{name}’의 3D가 없어요. 카드의 ‘3D로 만들기’로 3D를 먼저 만들어 주세요(보통 {total}). 3D가 끝나야 게임을 만들 수 있어요.', { name, total: THREE_D_TOTAL });
}

/** What blocks the cast. `threeD` (the drawer's): the player must be 3D-ready, so the game has at least one IP in 3D;
 * a background's or a set piece's 3D does not count. */
export function designCastProblem(cast: Ip[], roles: Record<string, GameIpRole>, threeD?: (ip: Ip) => GameThreeD): string | null {
  if (!cast.length) return null;
  const drawing = cast.find((ip) => !ip.imageAssetId); // the server refuses a game until its pictures exist
  if (drawing) return t('‘{name}’의 이미지가 아직 만들어지고 있어요. 이미지가 나타난 뒤에 출연 IP로 고를 수 있어요.', { name: drawing.name });
  if (cast.some((ip) => !ROLE_CHOICES[ip.kind].includes(roles[ip.ipId]))) return t('선택한 IP의 게임 역할을 지정해 주세요.');
  if (cast.filter((ip) => roles[ip.ipId] === 'player').length !== 1) return t('주인공이 될 캐릭터를 정확히 1명 골라 주세요.');
  if (cast.filter((ip) => roles[ip.ipId] === 'weapon').length > 1) return t('주인공이 사용할 무기는 1개만 골라 주세요.');
  if (cast.filter((ip) => roles[ip.ipId] === 'npc').length > 1) return t('NPC 캐릭터는 1명까지 고를 수 있어요. 도시 보행자는 그 NPC와 같은 모습으로 나와요.');
  if (cast.filter((ip) => roles[ip.ipId] === 'background').length > 1) return t('배경·환경은 1개만 골라 주세요.');
  const flat = cast.find((ip) => roles[ip.ipId] === 'set' && !ip.glbAssetId);
  if (flat) {
    return lang === 'en' ? t('‘{name}’을(를) 배경 사물로 쓰려면 3D 모델이 필요해요. 왼쪽 카드에서 ‘3D로 만들기’를 먼저 눌러 주세요.', { name: flat.name })
      : `‘${flat.name}’${josa(flat.name, '을', '를')} 배경 사물로 쓰려면 3D 모델이 필요해요. 왼쪽 카드에서 ‘3D로 만들기’를 먼저 눌러 주세요.`;
  }
  const player = cast.find((ip) => roles[ip.ipId] === 'player')!;
  return threeD ? playerThreeDProblem(player.name, threeD(player)) : null;
}

export function gameDesignRequest(b: Brief, cast: Ip[], roles: Record<string, GameIpRole>): GameDesignRequest {
  const ids = (role: GameIpRole) => cast.filter((ip) => roles[ip.ipId] === role).map((ip) => ip.ipId);
  return {
    prompt: briefMessage(b, cast),
    castIpIds: cast.map((ip) => ip.ipId),
    playerIpId: ids('player')[0] ?? null,
    weaponIpId: ids('weapon')[0] ?? null,
    propIpIds: ids('prop'),
    enemyIpIds: ids('enemy'),
    npcIpIds: ids('npc'),
    ...(ids('background').length ? { backgroundIpId: ids('background')[0] } : {}),
    ...(ids('set').length ? { setIpIds: ids('set') } : {}),
  };
}

/** Python backend counts Unicode code points; include the full brief and cast, never silently truncate it. */
export function gameDesignLengthProblem(prompt: string): string | null {
  return [...prompt].length > 4000 ? t('전체 게임 설계는 4,000자까지 보낼 수 있어요. 요청이나 상세 조건을 줄여 주세요.') : null;
}

/** "[출연 IP cast_ip_ids=…]" line the agent passes to make_game as cast_ip_ids (server/prompts.py). */
export function castLine(cast: Ip[]): string {
  return cast.length ? `[출연 IP cast_ip_ids=${cast.map((i) => i.ipId).join(',')}] ${cast.map((i) => `${i.name}(${KIND_LABEL[i.kind]})`).join(', ')}` : '';
}

// The first line, the [tags], the [ids] and the 설계 지침 line's lead are for the agent and the chat bubble (ChatDock
// userText): the same in either language. The rest is in the page's language.
export function briefMessage(b: Brief, cast: Ip[] = []): string {
  const type = TYPES.find((kind) => kind.id === b.type);
  const pick = (list: readonly (readonly [string, string])[], v: string) => list.find(([id]) => id === v)?.[1] ?? '';
  const lines = [
    b.prompt?.trim() && t('게임 요청: {request}', { request: b.prompt.trim() }),
    b.spec && `설계 지침: ${b.spec}`,
    b.type && t('유형: {label} ({hint}) [{id}]', { label: type?.label ?? '', hint: type?.hint ?? '', id: b.type }),
    (b.theme || b.sky || b.layout) && `${t('환경:')} ${b.theme ? `${pick(THEMES, b.theme)} [${b.theme}]` : t('요청에 맞게')}${b.sky ? `, ${t('하늘 {sky}', { sky: pick(SKIES, b.sky) })} [${b.sky}]` : ''}${b.layout ? `, ${t('배치 {layout}', { layout: pick(LAYOUTS, b.layout) })} [${b.layout}]` : ''}`,
    b.biome && t('실사 환경: {biome} [{id}]', { biome: pick(BIOME_CHOICES, b.biome), id: b.biome }),
    b.newSets?.trim() && t('새로 만들 배경 사물(AI 3D): {list}', { list: b.newSets.trim() }),
    b.mission && t('미션: {text}', { text: b.mission }),
    b.clear && t('클리어 조건: {text}', { text: b.clear }),
    b.fail && t('실패 조건: {text}', { text: b.fail }),
    b.enemies && t('적 구성: {text}', { text: b.enemies }),
    b.difficulty && t('난이도: {level} [{id}]', { level: pick(DIFFICULTY, b.difficulty), id: b.difficulty }),
    b.extra && t('추가 규칙: {text}', { text: b.extra }),
  ].filter(Boolean);
  const only = cast.length ? `\n${castLine(cast)}\n${t('게임에는 위 출연 IP만 나와야 해 (다른 IP나 이름 없는 적·소품 없이).')}` : '';
  return `[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n${lines.join('\n')}${only}`;
}

/** Each 출연 IP card's 3D state: 3D 완료, 3D 만드는 중 · <step>, or 3D 없음. */
const THREE_D_BADGE = (threeD: GameThreeD) => (threeD.state === 'ready' ? t('3D 완료') : threeD.state === 'running' ? t('3D 만드는 중 · {phase}', { phase: threeD.phase ?? '' }) : t('3D 없음'));

/** Right-side drawer: describe the game (type, world, mission, win/lose rules) instead of a one-line request. */
export function DesignDrawer({ ips, assets, jobs = [], onMake3d, onChat, onClose, onSend, games = [], onEditGame }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose, '#game-design-prompt, .design-blocked .btn-primary');
  // Without a character whose 3D is finished the form cannot be sent (its player is one), so the drawer says what is
  // missing and offers the way there instead of the form. `early`: asked for all the same, to write the design down
  // while a hero's 3D runs (it is kept for the tab).
  const needs = gameNeeds(ips, assets, jobs);
  const [early, setEarly] = useState(false);
  const blocked = !needs.ready && !early;
  const wasBlocked = useRef(blocked);
  useEffect(() => { // the form took the notice's place (a hero's 3D landed, or it was asked for): the caret goes to its first box
    if (wasBlocked.current && !blocked) panel.current?.querySelector<HTMLElement>('#game-design-prompt')?.focus();
    wasBlocked.current = blocked;
  }, [blocked]);
  // the brief survives an Esc or a misclick outside: it is kept for this tab until it is sent
  const [b, setB] = useState<Brief>(() => { try { return { ...EMPTY, ...JSON.parse(session.get(briefKey()) ?? '{}') }; } catch { return EMPTY; } });
  useEffect(() => { session.set(briefKey(), JSON.stringify(b)); }, [b]);
  const [busy, setBusy] = useState(false);
  // An example takes the place of the whole design; what was typed before it can be brought back.
  const [undo, setUndo] = useState<{ name: string; brief: Brief } | null>(null);
  const typedIn = (x: Brief) => !PRESETS.some((p) => p.brief === x)
    && [x.prompt, x.mission, x.clear, x.fail, x.enemies, x.extra, x.newSets].some((text) => !!text?.trim());
  const useExample = (p: { name: string; brief: Brief }) => {
    setUndo((kept) => (kept ? { ...kept, name: p.name } : typedIn(b) ? { name: p.name, brief: b } : null)); // the first typed design is what comes back
    setB(p.brief);
  };
  // ... and so do the ticked 출연 IP with their roles. A pick whose IP is gone, or whose role its kind cannot play,
  // is no pick any more.
  const [roles, setRoles] = useState<Record<string, GameIpRole>>(() => {
    try {
      const kept: Record<string, GameIpRole> = JSON.parse(session.get(castKey()) ?? '{}');
      return Object.fromEntries(Object.entries(kept).filter(([id, role]) => ips.some((ip) => ip.ipId === id && ROLE_CHOICES[ip.kind].includes(role))));
    } catch { return {}; }
  });
  useEffect(() => { session.set(castKey(), JSON.stringify(roles)); }, [roles]);
  const cast = ips.filter((i) => Object.hasOwn(roles, i.ipId));
  const threeD = (ip: Ip) => gameThreeD(ip, assets, jobs);
  const castProblem = designCastProblem(cast, roles, threeD);
  // the game needs a 3D-ready protagonist picked here (server/tools.py make_game refuses it otherwise)
  const pickProblem = cast.length ? null : t('3D가 완성된 주인공 캐릭터를 출연 IP로 골라야 게임을 만들 수 있어요.');
  const [starting, setStarting] = useState<Set<string>>(() => new Set());
  const make3d = async (ip: Ip) => {
    if (!onMake3d) return;
    setStarting((x) => new Set(x).add(ip.ipId));
    try { await onMake3d(ip); } catch { /* the card action toasts why */ } finally {
      setStarting((x) => { const next = new Set(x); next.delete(ip.ipId); return next; });
    }
  };
  const hasBrief = !!(b.prompt?.trim() || b.mission.trim() || b.extra.trim() || b.type);
  const request = gameDesignRequest(b, cast, roles);
  const lengthProblem = gameDesignLengthProblem(request.prompt);
  const url = new Map<string | undefined, string>(assets.map((a) => [a.assetId, a.url])); // no picture yet → no thumbnail
  const toggle = (ip: Ip) => setRoles((previous) => {
    const next = { ...previous };
    if (Object.hasOwn(next, ip.ipId)) delete next[ip.ipId];
    else next[ip.ipId] = defaultRole(ip, next);
    return next;
  });
  const assignRole = (id: string, role: GameIpRole) => setRoles((previous) => {
    const next = { ...previous };
    if (role === 'player') for (const other of Object.keys(next)) if (next[other] === 'player') next[other] = 'npc';
    next[id] = role;
    return next;
  });
  const set = (k: keyof Brief) => (e: { target: { value: string } }) => setB((x) => ({ ...x, [k]: e.target.value }));
  const rpg = b.type.startsWith('rpg');
  // the game on screen (the newest, v1 = the first made, as the game pane numbers them): this drawer makes a new one
  const made = [...games].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const latest = made.at(-1);

  // with a game on screen the drawer offers 이 게임 수정 in place of this long blank form
  const editOffer = latest && onEditGame && (
    <p className="design-edit-offer">
      {t('여기서는 새 게임을 처음부터 설계해요. 지금 게임 ‘{title}’(v{n})을 조금 고치려면', { title: latest.title, n: made.length })}{' '}
      <button type="button" className="link-btn" onClick={() => onEditGame(latest, made.length)}>{t('이 게임 수정')}</button>{t('을 누르세요.')}
    </p>
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (castProblem || pickProblem || lengthProblem || !hasBrief || busy) return;
    setBusy(true);
    try {
      await onSend(request.prompt, request);
      session.remove(briefKey()); // sent: the next design starts fresh
      session.remove(castKey());
      onClose();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} />
      <div ref={panel} className="drawer design-drawer" role="dialog" aria-modal="true" aria-labelledby="design-title" aria-describedby="design-intro">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">GAME DESIGN</p>
            <h2 id="design-title">{t('새 게임 설계')}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        {blocked ? (
          <>
            <div className="dialog-body design-blocked">
              <p id="design-intro" className="design-blocked-lead"><strong>{t('게임 설계는 3D가 끝난 주인공 캐릭터가 있어야 쓸 수 있어요.')}</strong></p>
              {editOffer}
              <NeedsSteps needs={needs} />
              {needs.heroes.length === 0 ? (
                <>
                  {/* no character: chat is the way on. With an IP in 3D it makes the game as it is, that IP the player
                      (server/tools.py hold_heroes, _needs_3d) */}
                  <p className="design-blocked-now">{needs.standIn ? `${t('지금은 캐릭터가 없어요.')} ${standInLine(needs.standIn.name)} ${STAND_IN_WHY}`
                    : t('지금은 캐릭터가 없어요. 채팅에 원하는 캐릭터를 한 줄로 적으면 그림부터 만들어요.')}</p>
                  <button type="button" className="btn btn-primary" onClick={onChat ?? onClose}>{needs.standIn ? t('채팅으로 게임 요청하기') : t('채팅으로 캐릭터 만들기')}</button>
                  {!needs.standIn && needs.others && <small className="design-blocked-note">{OTHERS_NOTE}</small>}
                </>
              ) : (
                <>
                  <p className="design-blocked-now">{t('주인공이 될 캐릭터의 3D가 아직 없어요. 3D가 끝나면 이 창에서 출연 IP와 역할을 고를 수 있어요.')}</p>
                  <ul className="design-blocked-list">
                    {needs.heroes.map(({ ip, threeD: state3d }) => (
                      <li key={ip.ipId}>
                        <span className="cast-thumb">{url.get(ip.cutoutAssetId) ?? url.get(ip.imageAssetId) ? <img src={url.get(ip.cutoutAssetId) ?? url.get(ip.imageAssetId)} alt="" /> : null}</span>
                        <span className="design-blocked-name">{ip.name}</span>
                        {state3d.state === 'running' ? <span className="badge badge--running">{THREE_D_BADGE(state3d)}</span> : onMake3d && (
                          <>
                            <button type="button" className="btn btn-sm btn-primary" aria-label={t('{name} 3D로 만들기', { name: ip.name })}
                              disabled={starting.has(ip.ipId) || !ip.imageAssetId} onClick={() => void make3d(ip)}>
                              {!ip.imageAssetId ? t('그림 그리는 중') : starting.has(ip.ipId) ? t('시작하는 중…') : t('3D로 만들기')}
                            </button>
                            <small>{chainTypical(threeDSteps(ip))}</small>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="link-btn design-blocked-early" onClick={() => setEarly(true)}>{t('3D를 기다리는 동안 설계 미리 적어 두기')}</button>
                </>
              )}
            </div>
            <div className="dialog-footer">
              <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>{t('닫기')}</button></div>
            </div>
          </>
        ) : (
        <>
        <form id="game-design-form" className="dialog-body" onSubmit={submit} aria-busy={busy}>
          <p id="design-intro" className="dialog-lead muted">{t('아이디어를 적고 사용할 IP를 골라 주세요. 상세 조건은 필요한 항목만 채워도 돼요.')}</p>
          {editOffer}
          <h3 className="dialog-section-heading">{t('아이디어와 출연 IP')}</h3>
          <label className="field"><span>{t('만들고 싶은 게임')}</span>
            <textarea id="game-design-prompt" rows={4} maxLength={4000} value={b.prompt ?? ''} onChange={set('prompt')}
              aria-describedby="game-design-prompt-hint"
              placeholder={t('예: 루나가 폐허 정거장에서 코어를 되찾아 탈출하는 탐험 게임. 전투보다 경로 선택과 NPC 의뢰가 중심이고, 코어를 모으면 탈출 문이 열려야 해.')} />
            <small id="game-design-prompt-hint" className="field-hint">{t('원하는 세계, 플레이 방식, 목표를 적어 주세요. 예시를 고르면 입력한 설계가 예시 내용으로 바뀌고, 바로 되돌릴 수 있어요.')}</small>
          </label>
          {b.spec && (
            <details className="design-spec">
              <summary>{t('이 예시와 함께 보내는 설계 지침 보기')}</summary>
              <p>{b.spec}</p>
              <button type="button" className="link-btn" onClick={() => setB((x) => ({ ...x, spec: undefined }))}>{t('지침 빼기')}</button>
            </details>
          )}
          <div className="chips" aria-label={t('예시 설계')}>
            {PRESETS.map((p) => <button key={p.name} type="button" className="chip-btn" onClick={() => useExample(p)}>{p.name}</button>)}
          </div>
          {undo && (
            <p className="design-undo" role="status">
              {lang === 'en' ? t('예시 ‘{name}’(으)로 바꿨어요.', { name: undo.name }) : <>예시 ‘{undo.name}’{josa(undo.name, '으로', '로')} 바꿨어요.</>}{' '}
              <button type="button" className="link-btn" onClick={() => { setB(undo.brief); setUndo(null); }}>{t('입력하던 설계로 되돌리기')}</button>
            </p>
          )}
          {ips.length > 0 && (
            <fieldset className="field cast">
              <legend>{t('출연 IP')} <small className="muted">{cast.length ? t('{n}개 선택', { n: cast.length }) : t('3D가 완성된 주인공을 골라 주세요')}</small></legend>
              <div className="cast-grid">
                {ips.map((ip) => {
                  const on = Object.hasOwn(roles, ip.ipId);
                  const state3d = threeD(ip);
                  const scene = ip.kind === 'prop' && ip.usage === 'background'; // a whole scene: its 3D is never needed
                  const thumbnail = roles[ip.ipId] === 'background' ? url.get(ip.imageAssetId)
                    : url.get(ip.cutoutAssetId) ?? url.get(ip.imageAssetId);
                  return (
                    <div key={ip.ipId} className={on ? 'cast-card is-on' : 'cast-card'}>
                      <label className="cast-pick">
                        <input type="checkbox" checked={on} onChange={() => toggle(ip)} aria-label={t('{name} 출연 IP 선택', { name: ip.name })} />
                        <span className="cast-thumb">{thumbnail ? <img src={thumbnail} alt="" /> : null}</span>
                        <span className="cast-name">{ip.name}<small>{KIND_LABEL[ip.kind]}</small></span>
                      </label>
                      <div className="cast-3d">
                        <span className={`badge badge--${state3d.state === 'ready' ? 'done' : state3d.state === 'running' ? 'running' : 'queued'}`} data-3d={state3d.state}>{THREE_D_BADGE(state3d)}</span>
                        {state3d.state === 'none' && onMake3d && !scene && (
                          <>
                            <button type="button" className="btn btn-sm" aria-label={t('{name} 3D로 만들기', { name: ip.name })}
                              disabled={starting.has(ip.ipId) || !ip.imageAssetId} onClick={() => void make3d(ip)}>
                              {starting.has(ip.ipId) ? t('시작하는 중…') : t('3D로 만들기')}
                            </button>
                            {/* what the click starts takes this long, as the IP's own card says */}
                            <small className="cast-3d-time">{chainTypical(threeDSteps(ip))}</small>
                          </>
                        )}
                      </div>
                      {on && <label className="cast-role"><span className="sr-only">{t('{name} 게임 역할', { name: ip.name })}</span>
                        <select value={roles[ip.ipId]} onChange={(e) => assignRole(ip.ipId, e.target.value as GameIpRole)} aria-label={t('{name} 게임 역할', { name: ip.name })}>
                          {ROLE_CHOICES[ip.kind].map((role) => <option key={role} value={role}>{GAME_ROLE_LABEL[role]}</option>)}
                        </select>
                      </label>}
                    </div>
                  );
                })}
              </div>
              {castProblem && <p className="form-error" role="alert">{castProblem}</p>}
              {/* one hint in sight, the rest behind 자세히 */}
              <small className="field-hint">{t('주인공은 3D가 끝난 캐릭터여야 해요. 3D가 없는 적과 소품은 납작한 그림판으로 나와요.')}</small>
              <details className="design-more">
                <summary>{t('자세히')}</summary>
                <p>{t('고른 IP와 역할은 요청과 함께 보내요. 주인공의 3D에는 움직임 뼈대까지 들어 있어야 하고, 배경과 배경 사물의 3D는 조건에 들지 않아요.')}</p>
                <p>{t('NPC 캐릭터는 1명까지 고를 수 있어요. 도시 보행자는 그 NPC와 같은 모습으로 나와요.')}</p>
                <p>{t('소품을 배경·환경으로 고르면 원본 그림이 화면 배경이 되고, 걸어 다니는 3D 지형이 되지는 않아요. 준비된 3D 모델은 환경 모델로 쓰고, 배경은 수집 아이템으로 놓지 않아요.')}</p>
              </details>
            </fieldset>
          )}
          <h3 className="dialog-section-heading">{t('세계와 플레이 방식')}</h3>
          <fieldset className="field">
            <legend>{t('게임 유형')}</legend>
            <div className="type-grid">
              {TYPES.map((kind) => (
                <label key={kind.id} className="radio radio--card">
                  {/* an example's design guide is its type's: another type takes it away */}
                  <input type="radio" name="type" checked={b.type === kind.id}
                    onChange={() => setB((x) => ({ ...x, type: kind.id, ...(kind.id === x.type ? {} : { spec: undefined }) }))} />
                  <span>{kind.label}<small>{kind.hint}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="row row--fields">
            <label className="field"><span title={t('Poly Haven의 CC0 환경 소재를 써요')}>{t('실사 환경')}</span>
              <select value={b.biome ?? ''} onChange={set('biome')}>{BIOME_CHOICES.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
            </label>
          </div>
          <label className="field"><span>{t('새로 만들 배경 사물')} <small className="muted">{t('AI 이미지 → 3D로 만들어 맵에 배치 · 쉼표로 구분')}</small></span>
            <input value={b.newSets ?? ''} onChange={set('newSets')} maxLength={200} placeholder={t('예: 부서진 전차, 이끼 낀 고대 석상, 무너진 감시탑')} />
          </label>
          {!rpg && b.type !== 'city-open-world' && (
            <div className="row row--fields">
              <label className="field"><span>{t('환경 테마')}</span>
                <select value={b.theme} onChange={set('theme')}>{THEMES.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
              </label>
              <label className="field"><span>{t('하늘')}</span>
                <select value={b.sky} onChange={set('sky')}>{SKIES.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
              </label>
              <label className="field"><span>{t('배치')}</span>
                <select value={b.layout} onChange={set('layout')}>{LAYOUTS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
              </label>
            </div>
          )}
          {b.type === 'city-open-world' && <p className="field-hint">{t('가로세로 300–1200m 도시에 차량과 보행자가 있는 임무 게임을 설계해요. NPC와 소품 역할을 지정해 주세요.')}</p>}
          <h3 className="dialog-section-heading">{t('목표와 게임 규칙')}</h3>
          <label className="field"><span>{t('미션 (화면 목표 줄에 보여요)')}</span>
            <textarea rows={2} maxLength={120} value={b.mission} onChange={set('mission')} placeholder={t('예: 용광로 심장부의 거대 전투 로봇을 쓰러뜨려라')} />
          </label>
          <label className="field"><span>{t('클리어 조건')}</span>
            <textarea rows={2} value={b.clear} onChange={set('clear')} placeholder={t('예: 보스 체력을 0으로 만들면 클리어')} />
          </label>
          <label className="field"><span>{t('실패 조건 · 제한 시간')}</span>
            <textarea rows={2} value={b.fail} onChange={set('fail')} placeholder={t('예: 4분 안에 못 잡거나 체력이 0이 되면 실패')} />
          </label>
          <label className="field"><span>{t('적 구성 · 행동')}</span>
            <textarea rows={2} value={b.enemies} onChange={set('enemies')} placeholder={t('예: 보스 1명 + 작은 수리 드론이 계속 나옴')} />
          </label>
          <div className="row row--fields">
            <label className="field"><span>{t('난이도')}</span>
              <select value={b.difficulty} onChange={set('difficulty')}>{DIFFICULTY.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
            </label>
          </div>
          <label className="field"><span>{t('추가 규칙 · 이야기')}</span>
            <textarea rows={3} value={b.extra} onChange={set('extra')} placeholder={t('예: 플레이어 체력 200, 시작할 때 동료가 짧게 상황을 알려줌')} />
          </label>
          {/* the whole request as it is sent; nothing while the form is untouched (it read "28 / 4,000자" for its own header line) */}
          <small className="field-hint design-count">{t('전체 설계 {n} / 4,000자', { n: (hasBrief || cast.length ? [...request.prompt].length : 0).toLocaleString('ko-KR') })}</small>
          {lengthProblem && <p className="form-error" role="alert">{lengthProblem}</p>}
        </form>
        <div className="dialog-footer">
          <p id="design-submit-hint" className="field-hint dialog-submit-hint" role="status">
            {busy ? t('설계를 채팅으로 보내고 있어요.') : castProblem || pickProblem || lengthProblem || (!hasBrief ? t('게임 요청이나 유형을 입력하면 만들 수 있어요.') : t('요청을 보내면 AI가 채팅에서 게임을 만들기 시작해요.'))}
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>{t('취소')}</button>
            <button form="game-design-form" type="submit" className="btn btn-primary" aria-describedby="design-submit-hint" disabled={busy || !!castProblem || !!pickProblem || !!lengthProblem || !hasBrief}>{busy ? t('보내는 중…') : t('이 설계로 게임 만들기')}</button>
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
