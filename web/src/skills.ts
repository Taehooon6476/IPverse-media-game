/**
 * Genre skills (Skills tab). A skill is a recipe: the genre's asset set (each made as an image and then a 3D model,
 * server tool make_skill_asset) and a game request that casts those assets into the genre module the runtime
 * supports. Assets are matched to the session's IPs by name, so a finished asset is never made twice.
 */
import { EN, t } from './i18n';

export type SkillRole = 'set' | 'enemy' | 'npc' | 'weapon';

export interface SkillAsset {
  name: string;
  kind: 'prop' | 'enemy' | 'character' | 'weapon';
  role: SkillRole;
  /** English: the image model prompt. */
  description: string;
  humanoid?: boolean;
  weaponType?: 'melee' | 'gun';
}

export interface Skill {
  id: string;
  title: string;
  tagline: string;
  /** Runtime module this skill drives, shown on the card. */
  module: string;
  accent: string;
  assets: SkillAsset[];
  /** The game request; the cast and roles are attached by the drawer. */
  request: string;
}

/** An asset's name on this page: the IP it becomes is named so (English on the English page; its English is in
 * i18n/en-panes.ts by the Korean name). */
export const assetName = (a: SkillAsset): string => t(a.name);
/** Whether an IP's name is this asset's, or begins with it ('서킷 마샬 라이카' for '서킷 마샬'), in either language: an
 * IP made on the English page is the same asset on the Korean one, and is not made twice. */
export function namedAfter(ipName: string, a: SkillAsset, exact = false): boolean {
  return [a.name, EN[a.name]].some((name) => !!name && (exact ? ipName === name : ipName.startsWith(name)));
}

export const SKILLS: Skill[] = [
  {
    id: 'racing',
    title: '레이싱',
    tagline: '야간 도시 서킷 3랩, AI 라이벌과 순위 경쟁',
    module: '레이스 · 랩 · 라이벌 · 순위',
    accent: '#5de6cf',
    assets: [
      { name: '서킷 마샬', kind: 'character', role: 'npc', description: 'race marshal in a black and cyan racing jacket holding a checkered flag, full body' },
      { name: '타이어 방벽', kind: 'prop', role: 'set', description: 'stack of black racing tyres strapped together as a track barrier, red and white stripes' },
      { name: '출발 게이트', kind: 'prop', role: 'set', description: 'racing start finish gantry arch with checkered banner and LED countdown lights' },
      { name: '네온 체크포인트 기둥', kind: 'prop', role: 'set', description: 'tall futuristic checkpoint pylon with glowing cyan neon stripes on a metal base' },
      { name: '피트 공구 카트', kind: 'prop', role: 'set', description: 'red mechanic tool cart with tyres and a jack, racing pit equipment' },
    ],
    request: '야간 네온 도시 서킷 레이스. 시작부터 레이스카에 탄 채 3초 카운트다운 후 출발해 도로 격자를 도는 순환 코스의 체크포인트 8곳을 순서대로 통과하며 3랩을 달린다. AI 라이벌 3대와 순위를 다툰다. 서킷 마샬이 출발선 옆에 서 있고 타이어 방벽·출발 게이트·체크포인트 기둥·피트 카트를 코스 곳곳에 배치한다. 제한 시간 6분.',
  },
  {
    id: 'platformer',
    title: '점프 플랫포머',
    tagline: '움직이는 발판과 가시 함정, 코인 모아 깃발까지',
    module: '움직이는 발판 · 코인 · 추락 리스폰',
    accent: '#ffc93c',
    assets: [
      { name: '황금 코인', kind: 'prop', role: 'set', description: 'shiny gold coin with a star emblem, thick rim, game collectible' },
      { name: '골인 깃발', kind: 'prop', role: 'set', description: 'tall goal flag pole with a waving red triangle flag on a stone base' },
      { name: '스프링 점프대', kind: 'prop', role: 'set', description: 'cartoon spring jump pad, red metal coil with a round yellow top' },
      { name: '버섯 발판', kind: 'prop', role: 'set', description: 'giant red and white spotted mushroom, wide flat cap, stylized platform' },
    ],
    request: '밝고 경쾌한 숲 속 점프 플랫포머. 떠 있는 발판 계단을 점프로 올라가고, 좌우·위아래로 움직이는 발판 4개와 움직이는 가시 함정 2개를 지나며 황금 코인 8개를 모은 뒤 가장 높은 발판의 골인 깃발에 닿는다. 떨어지면 마지막 발판에서 다시 시작한다. 버섯 발판과 스프링 점프대로 꾸민다. 전투 없음.',
  },
  {
    id: 'dungeon',
    title: '핵앤슬래시 던전',
    tagline: '횃불 켜진 지하 묘지, 칼로 베고 레벨업·드랍',
    module: '실내 던전 · ARPG 콤보 · 보스',
    accent: '#ff7a59',
    assets: [
      { name: '해골 전사', kind: 'enemy', role: 'enemy', humanoid: true, description: 'undead skeleton warrior in rusted armor holding a chipped sword, full body' },
      { name: '묘지의 군주', kind: 'enemy', role: 'enemy', humanoid: true, description: 'towering undead lich king in a tattered crown and black robes, glowing green eyes, full body' },
      { name: '성기사 장검', kind: 'weapon', role: 'weapon', weaponType: 'melee', description: 'holy knight longsword with a gold crossguard and runes on the blade' },
      { name: '석관', kind: 'prop', role: 'set', description: 'ancient stone sarcophagus with carved skull reliefs, cracked lid' },
      { name: '묘비', kind: 'prop', role: 'set', description: 'weathered gothic gravestone with a cross, moss in the cracks' },
      { name: '철창 문', kind: 'prop', role: 'set', description: 'heavy rusted iron portcullis gate in a stone frame' },
    ],
    request: '핵앤슬래시 던전. 횃불이 켜진 지하 묘지(실내)에서 방과 복도를 지나며 해골 전사 무리를 성기사 장검으로 베고 레벨업하며 아이템을 줍는다. 입구 방, 석관이 늘어선 중앙 홀, 철창 문 너머 납골당을 거쳐 마지막 제단 방에서 묘지의 군주를 쓰러뜨린다. 묘비와 석관으로 엄폐물을 만든다.',
  },
  {
    id: 'openworld',
    title: '오픈월드 도시',
    tagline: '불 켜진 밤 대도시, 차를 몰고 의뢰 수행',
    module: '도시 · 차량 · 야간 조명',
    accent: '#a78bfa',
    assets: [
      { name: '심야 의뢰인', kind: 'character', role: 'npc', description: 'mysterious fixer in a long dark coat and neon-lit visor, full body' },
      { name: '네온 광고판', kind: 'prop', role: 'set', description: 'big rooftop neon billboard frame with pink and cyan glowing tubes' },
      { name: '포장마차', kind: 'prop', role: 'set', description: 'korean street food cart with an orange tarp roof, lanterns and stools' },
      { name: '전화 부스', kind: 'prop', role: 'set', description: 'retro red public telephone booth with glass panels' },
    ],
    request: '밤의 대도시 오픈월드. 불 켜진 건물과 가로등 사이를 걷다 차를 타고 달리며 심야 의뢰인의 의뢰 3개를 순서대로 수행한다: 의뢰인과 대화, 차를 몰고 부두까지 이동, 포장마차 앞 접선 지점 도착, 마지막으로 공업지구 목표 지점에 차로 도착. 네온 광고판·포장마차·전화 부스를 거리 곳곳에 배치한다.',
  },
];
