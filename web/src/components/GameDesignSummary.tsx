import { t } from '../i18n';
import type { Game, Ip } from '../types';
import { genreLabel } from '../types';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {};
const records = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const THEME: Record<string, string> = {
  'neon-arena': t('네온 아레나'), 'ruined-city': t('폐허 도시'), 'desert-outpost': t('사막 전초기지'),
  'ice-station': t('얼음 기지'), 'lava-forge': t('용광로'), 'jungle-ruins': t('정글 유적'),
};
const SKY: Record<string, string> = { space: t('우주'), day: t('낮'), dusk: t('노을'), storm: t('폭풍'), night: t('밤') };
const LAYOUT: Record<string, string> = { pillars: t('기둥 아레나'), open: t('벌판'), maze: t('미로'), ring: t('원형 성벽') };
const STAGE: Record<string, string> = {
  kills: t('처치'), eliminate: t('처치'), defeat: t('처치'), boss: t('보스 처치'), survive: t('생존'), collect: t('수집'),
  reach: t('도달'), hold: t('거점 확보'), interact: t('상호작용'), talk: t('대화'), escort: t('호위'), drive: t('주행'),
};
const DISTRICT_STYLE: Record<string, string> = {
  downtown: t('도심'), residential: t('주거'), industrial: t('산업'), waterfront: t('수변'),
};
// a mission whose stages are all of one kind, by the 게임 설계 drawer's name for that kind of game
const KIND: Record<string, string> = { kills: t('섬멸전'), eliminate: t('섬멸전'), defeat: t('섬멸전'), survive: t('생존전'), boss: t('보스전'), collect: t('수집전'),
  reach: t('거점 확보'), hold: t('거점 확보') };
/** What kind of game the saved design is, in the 게임 설계 drawer's words, read off the design the way the game
 * reads it (game3d/runtime3d.js), else what its mission asks for; the design's own `genre` does not say what it plays
 * like. An older game (version 1) is the RPG it was made as, or its one objective. */
export function gameType(value: unknown, game: Game): string {
  const spec = object(value);
  const stages = records(object(spec.mission).stages).map((stage) => text(stage.type));
  if (spec.version === 2) {
    const world = object(spec.world);
    const mechanics = object(spec.mechanics);
    if (Object.hasOwn(world, 'track')) return t('레이싱');
    if (Object.hasOwn(world, 'city')) return stages.includes('race') ? t('도시 레이싱') : t('도시 오픈월드');
    if (mechanics.style === 'arpg') return t('핵앤슬래시');
    if (object(spec.artDirection).setting === 'sky' || mechanics.fallRespawn === true) return t('점프 플랫포머');
    const kinds = new Set(stages.map((type) => KIND[type] ?? type));
    const [only] = kinds;
    if (kinds.size === 1 && Object.hasOwn(KIND, stages[0])) return only;
    if (stages.length > 1) return t('{n}단계 임무', { n: stages.length });
  } else if (!game.genre.startsWith('rpg-')) {
    const objective = text(object(spec.objective).type);
    if (Object.hasOwn(KIND, objective)) return KIND[objective];
  }
  return genreLabel(game.genre);
}

const ROLE = { player: t('주인공'), enemy: t('적'), prop: t('소품·아이템'), npc: t('NPC·동료'), weapon: t('주인공 무기'), background: t('배경·환경') };
// how an IP is bound in the saved design, and where it stands (in the page's language: the summary is read, not kept)
const LINK = { model: t('3D 연결'), image: t('이미지 연결'), source: t('원본 이미지 연결'), none: t('IP 연결 없음') };
const NO_PLACE = t('배치 없음');
type Role = keyof typeof ROLE;
export interface GameIpBinding {
  ipId: string;
  name: string;
  role: Role;
  /** 3D 연결, 이미지 연결, 원본 이미지 연결 or IP 연결 없음, in the page's language. */
  display: string;
  placement?: string;
}
export interface DesignSummary {
  version: number | undefined;
  sourcePrompt: string;
  missions: { label: string; detail: string }[];
  successText: string;
  world: string[];
  rules: string[];
  bindings: GameIpBinding[];
  warnings: string[];
}

/** Summarize the saved spec; a requested prompt or a newer IP asset never stands in for an actual binding. */
export function summarizeGameDesign(value: unknown, game: Game, ips: Ip[]): DesignSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const spec = object(value);
  const design = Object.keys(object(spec.design)).length ? object(spec.design) : object(game.design);
  const mission = object(spec.mission);
  const stages = records(mission.stages);
  const objective = object(spec.objective);
  const missions = stages.length ? stages.map((stage, index) => {
    const type = text(stage.type);
    const target = number(stage.target);
    const hold = number(stage.holdSec);
    const driveDistance = number(stage.distanceMeters);
    return {
      label: text(stage.label) || t('{n}단계 · {what}', { n: index + 1, what: STAGE[type] ?? type }),
      detail: type === 'drive' ? (driveDistance === undefined ? t('주행 · 거리 미지정') : t('{m}m 주행', { m: driveDistance }))
        : [STAGE[type] ?? type, target === undefined ? '' : type === 'survive' ? t('목표 {n}초', { n: target }) : t('목표 {n}', { n: target }),
          hold === undefined ? '' : t('유지 {n}초', { n: hold })].filter(Boolean).join(' · '),
    };
  }) : [{
    label: text(spec.mission) || text(objective.label) || STAGE[text(objective.type)] || t('미션 내용 없음'),
    detail: [STAGE[text(objective.type)] ?? text(objective.type),
      number(objective.target) === undefined ? '' : objective.type === 'survive' ? t('목표 {n}초', { n: number(objective.target)! }) : t('목표 {n}', { n: number(objective.target)! })].filter(Boolean).join(' · '),
  }];
  const world = object(spec.world);
  const background = object(world.background);
  const city = object(world.city);
  const isCity = spec.version === 2 && Object.keys(city).length > 0;
  const pedestrians = records(city.pedestrians);
  const environment = object(spec.environment);
  const worldLines: string[] = [];
  if (spec.version === 2 && Object.keys(world).length) {
    const width = number(world.width); const depth = number(world.depth);
    worldLines.push(`${isCity ? t('도시 월드') : t('맞춤 월드')}${width === undefined || depth === undefined ? '' : ` · ${width} × ${depth}${isCity ? 'm' : ''}`}`);
    if (isCity) {
      const districts = records(city.districts);
      const names = districts.map((district) => {
        const style = text(district.style);
        return [text(district.name), style ? `(${DISTRICT_STYLE[style] ?? style})` : ''].filter(Boolean).join(' ');
      }).filter(Boolean);
      if (Array.isArray(city.districts)) worldLines.push(`${t('구역 {n}개', { n: districts.length })}${names.length ? `: ${names.join(' · ')}` : ''}`);
      const counts = [
        Array.isArray(city.streets) ? t('도로 {n}개', { n: records(city.streets).length }) : '',
        Array.isArray(city.vehicles) ? t('운전 차량 {n}대', { n: records(city.vehicles).length }) : '',
        Array.isArray(city.pedestrians) ? t('보행자 {n}명', { n: pedestrians.length }) : '',
        number(city.trafficCount) === undefined ? '' : t('교통 차량 {n}대', { n: number(city.trafficCount)! }),
      ].filter(Boolean);
      if (counts.length) worldLines.push(counts.join(' · '));
      if (spec.engine === 'three') worldLines.push(t('엔진: Three.js 브라우저'));
    }
    worldLines.push(t('지형·구조물 {things}개 · 소품 배치 {props}곳 · 적 배치 {enemies}곳',
      { things: records(world.entities).length, props: records(world.propPlacements).length, enemies: records(world.enemySpawns).length }));
  } else {
    const setting = [THEME[text(environment.theme)] ?? text(environment.theme),
      SKY[text(environment.sky)] ?? text(environment.sky), LAYOUT[text(environment.layout)] ?? text(environment.layout)].filter(Boolean);
    if (setting.length) worldLines.push(setting.join(' · '));
    const map = object(spec.map);
    if (number(map.width) !== undefined && number(map.height) !== undefined) worldLines.push(t('지도 {w} × {h}', { w: number(map.width)!, h: number(map.height)! }));
  }
  const rules = object(spec.rules);
  const ruleLines: string[] = [];
  if (number(rules.timeLimitSec) !== undefined) ruleLines.push(rules.timeLimitSec === 0 ? t('시간 제한 없음') : t('제한 시간 {n}초', { n: number(rules.timeLimitSec)! }));
  if (number(rules.playerHp) !== undefined) ruleLines.push(t('주인공 체력 {n}', { n: number(rules.playerHp)! }));
  const difficulty = text(spec.difficulty);
  if (difficulty) ruleLines.push(t('난이도 {level}', { level: { easy: t('쉬움'), normal: t('보통'), hard: t('어려움') }[difficulty] ?? difficulty }));
  const mechanics = object(spec.mechanics);
  const movement = [['dash', t('대시')], ['jump', t('점프')], ['sprint', t('달리기')]].filter(([key]) => mechanics[key] === true).map(([, label]) => label);
  if (movement.length) ruleLines.push(t('이동 기능: {list}', { list: movement.join(' · ') }));
  if (typeof mechanics.autoFire === 'boolean') ruleLines.push(mechanics.autoFire ? t('자동 공격') : t('수동 공격'));
  if (number(mechanics.weaponDamage) !== undefined) ruleLines.push(t('공격력 {n}', { n: number(mechanics.weaponDamage)! }));
  if (number(mechanics.fireIntervalSec) !== undefined) ruleLines.push(t('공격 간격 {n}초', { n: number(mechanics.fireIntervalSec)! }));
  if (number(mechanics.regenPerSec) !== undefined && mechanics.regenPerSec !== 0) ruleLines.push(t('초당 체력 회복 {n}', { n: number(mechanics.regenPerSec)! }));
  if (number(mechanics.interactRadius) !== undefined) ruleLines.push(t('상호작용 거리 {n}', { n: number(mechanics.interactRadius)! }));

  const player = object(spec.player);
  const props = records(spec.props);
  const npc = object(world.npc);
  const npcIndex = number(npc.propIndex);
  const placedProps = records(world.propPlacements);
  const spawnedEnemies = records(world.enemySpawns);
  const slots: { entity: Json; role: Role; placed?: number }[] = [
    { entity: player, role: 'player' },
    ...records(spec.enemies).map((entity, index) => ({ entity, role: 'enemy' as const,
      placed: spec.version === 2 ? spawnedEnemies.filter((spawn) => spawn.enemyIndex === index).length : undefined })),
    ...props.map((entity, index) => ({ entity, role: npcIndex === index ? 'npc' as const : 'prop' as const,
      placed: spec.version === 2 ? placedProps.filter((placement) => placement.propIndex === index).length
        + (npcIndex === index ? 1 : 0) + pedestrians.filter((pedestrian) => pedestrian.propIndex === index).length : undefined })),
  ];
  const weaponId = text(player.weaponIpId);
  if (weaponId) slots.push({ entity: { ipId: weaponId, modelUrl: player.weaponUrl }, role: 'weapon' });
  if (Object.keys(background).length) slots.push({ entity: background, role: 'background' });
  const bindings = slots.map(({ entity, role, placed }): GameIpBinding => {
    const ipId = text(entity.ipId);
    const ip = ips.find((item) => item.ipId === ipId);
    return {
      ipId, name: text(entity.name) || ip?.name || ipId || t('IP 미지정'),
      role, display: role === 'background'
        ? entity.mode === 'image' && text(entity.imageUrl).trim() ? LINK.source
          : entity.mode === 'model' && text(entity.modelUrl).trim() ? LINK.model : LINK.none
        : text(entity.modelUrl) ? LINK.model : text(entity.spriteUrl) ? LINK.image : LINK.none,
      ...(role !== 'background' ? {} : entity.mode === 'image' && text(entity.imageUrl).trim() ? { placement: t('화면 배경') }
        : entity.mode === 'model' && text(entity.modelUrl).trim() ? { placement: t('3D 환경 배치') } : {}),
      ...(placed === undefined ? {} : { placement: placed ? t('배치 {n}곳', { n: placed }) : NO_PLACE }),
    };
  });
  const selected = strings(design.castIpIds).length ? strings(design.castIpIds) : game.castIpIds ?? [];
  const used = new Set(bindings.map((binding) => binding.ipId).filter(Boolean));
  const nameOf = (id: string) => ips.find((ip) => ip.ipId === id)?.name ?? id;
  const warnings: string[] = [];
  const missing = selected.filter((id) => !used.has(id));
  if (missing.length) warnings.push(t('선택했지만 설계에 연결되지 않은 IP: {names}', { names: missing.map(nameOf).join(', ') }));
  const unplaced = bindings.filter((binding) => selected.includes(binding.ipId) && binding.placement === NO_PLACE);
  if (unplaced.length) warnings.push(t('월드 배치가 없는 선택 IP: {names}', { names: unplaced.map((binding) => binding.name).join(', ') }));
  const unexpected = [...used].filter((id) => selected.length && !selected.includes(id));
  if (unexpected.length) warnings.push(t('선택 목록 밖의 IP: {names}', { names: unexpected.map(nameOf).join(', ') }));
  if (selected.length && bindings.some((binding) => !binding.ipId)) warnings.push(t('IP가 지정되지 않은 게임 역할이 있어요.'));
  const expectedRoles: { role: Role; ids: string[] }[] = [
    { role: 'player', ids: text(design.playerIpId) ? [text(design.playerIpId)] : [] },
    { role: 'weapon', ids: text(design.weaponIpId) ? [text(design.weaponIpId)] : [] },
    { role: 'prop', ids: strings(design.propIpIds) }, { role: 'enemy', ids: strings(design.enemyIpIds) },
    { role: 'npc', ids: strings(design.npcIpIds) },
    { role: 'background', ids: text(design.backgroundIpId) ? [text(design.backgroundIpId)] : [] },
  ];
  for (const { role, ids } of expectedRoles) for (const id of ids) {
    if (used.has(id) && !bindings.some((binding) => binding.ipId === id && binding.role === role)) warnings.push(t('{name}: 요청한 {role} 역할과 달라요.', { name: nameOf(id), role: ROLE[role] }));
  }
  const backgroundBinding = bindings.find((binding) => binding.role === 'background');
  if (backgroundBinding?.display === LINK.none)
    warnings.push(t('{name}: 배경·환경 IP가 연결되지 않았어요.', { name: backgroundBinding.name }));
  if (backgroundBinding && bindings.some((binding) => binding.ipId === backgroundBinding.ipId && binding.role !== 'background'))
    warnings.push(t('{name}: 배경·환경을 다른 게임 역할로도 쓰고 있어요.', { name: backgroundBinding.name }));
  return {
    version: number(spec.version), sourcePrompt: text(design.sourcePrompt), missions,
    successText: text(mission.successText), world: worldLines, rules: ruleLines, bindings, warnings,
  };
}

export function GameDesignSummary({ game, spec, ips, showRequest = false }: { game: Game; spec: unknown; ips: Ip[]; showRequest?: boolean }) {
  const summary = summarizeGameDesign(spec, game, ips);
  if (!summary) return <p className="muted">{t('저장된 게임 설계를 확인할 수 없어요.')}</p>;
  return (
    <section className="game-design-summary" aria-label={t('생성된 게임 설계')}>
      <div className="game-summary-head">
        <h3>{t('생성된 게임 설계')}</h3>
        <span className="muted game-summary-meta" title={t('설계 형식: GameSpec v{version}', { version: summary.version ?? '?' })}>
          {gameType(spec, game)}
          <span className="sr-only"> · {t('설계 형식 v{version}', { version: summary.version ?? '?' })}</span>
        </span>
      </div>
      <p className="field-hint">{t('이 게임의 목표와 선택한 IP를 확인하세요.')}</p>
      <div className="game-summary-grid">
        <div>
          <h4>{t('미션 순서')}</h4>
          <ol className="game-stage-list">
            {summary.missions.map((mission, index) => <li key={index}><span>{mission.label}</span>{mission.detail && <small>{mission.detail}</small>}</li>)}
          </ol>
          {summary.successText && <p className="muted">{t('완료 시: {text}', { text: summary.successText })}</p>}
        </div>
        <div>
          <h4>{t('게임 세계')}</h4>
          {summary.world.map((line, index) => <p key={index} className="game-summary-line">{line}</p>)}
          {summary.rules.length > 0 && <details className="game-rules-details">
            <summary>{t('플레이 규칙 보기')}</summary>
            {summary.rules.map((line, index) => <p key={index} className="game-summary-line">{line}</p>)}
          </details>}
          {!summary.world.length && !summary.rules.length && <p className="muted">{t('저장된 세부 설계가 없어요.')}</p>}
        </div>
      </div>
      <h4>{t('캐릭터 · 소품 · 배경 연결')}</h4>
      <ul className="game-ip-bindings">
        {summary.bindings.map((binding, index) => <li key={index}>
          <span><strong>{ROLE[binding.role]}</strong> {binding.name}</span><small>{binding.display}{binding.placement ? ` · ${binding.placement}` : ''}</small>
        </li>)}
      </ul>
      {summary.warnings.length > 0 && <ul className="game-design-warnings" aria-label={t('선택 IP 확인 필요')} role="status">
        {summary.warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>}
      {showRequest && <details className="game-source-prompt">
        <summary>{t('보낸 게임 요청 보기')}</summary>
        {summary.sourcePrompt ? <p>{summary.sourcePrompt}</p> : <p className="muted">{t('이전 버전에는 원본 게임 요청이 저장되지 않았어요.')}</p>}
      </details>}
    </section>
  );
}
