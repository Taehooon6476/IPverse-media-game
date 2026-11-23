import { useReducer, useRef, useState, type CSSProperties } from 'react';
import { lang, t } from '../i18n';
import { getSession, runTool, runToolAsync } from '../api';
import { SKILLS, assetName, namedAfter, type Skill, type SkillAsset } from '../skills';
import { JOB_KIND_DOING, JOB_KIND_LABEL, THREE_D_TOTAL, gameThreeD, imageState, josa, type GameDesignRequest, type Ip, type Snapshot } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { useDialog } from './useDialog';

interface Props {
  snap: Snapshot;
  onClose: () => void;
  /** The game request goes through the chat like the design drawer's. */
  onSend: (text: string, gameDesign: GameDesignRequest) => Promise<void>;
  onNotice: (text: string) => void;
  /** A plain chat request (step 0 asks the agent for a hero). */
  onChat: (text: string) => void;
  onError: (e: unknown) => void;
}

type AssetState = 'ready' | 'mesh' | 'image' | 'failed' | 'missing';
const STATE_LABEL: Record<AssetState, string> = { ready: t('3D 완료'), mesh: t('3D 만드는 중'), image: t('그림 그리는 중'), failed: t('실패'), missing: t('아직 안 만듦') };
const CONCURRENCY = 2; // the image GPU serves a couple of requests at a time; the 3D jobs queue on their own
const NEW_MIN = 12; // about 10 min per mesh still to make (one GPU box), plus 2 per image
const MESH_MIN = 10;

// "<sessionId>:<asset name>" -> status message id, kept for the page so closing the drawer does not forget it
const launched = new Map<string, string>();
const launchKey = (snap: Snapshot, a: SkillAsset) => `${snap.session.sessionId}:${a.name}`; // (the Korean name: the asset's id)
// "<sessionId>:<skill id>" while that skill's IPs are being registered. Kept for the page like `launched`: the loop
// goes on after the drawer closes, and a drawer opened again must not start the same IPs a second time.
const launching = new Set<string>();
/** A skill's own words (web/src/skills.ts, Korean there) in the page's language: their English is in
 * i18n/en-panes.ts. The request goes to the agent as the user's own, so the English page sends it in English and
 * names the IPs it makes in English (skills.ts assetName): an IP is found again by either name (ipFor). */
const said = (skill: Skill) => ({ title: t(skill.title), tagline: t(skill.tagline), module: t(skill.module), request: t(skill.request) });
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function ipFor(snap: Snapshot, a: SkillAsset): Ip | undefined {
  // exact name first, else an IP of the same kind named after it (e.g. '서킷 마샬 라이카' for '서킷 마샬')
  return snap.ips.find((i) => i.kind === a.kind && namedAfter(i.name, a, true))
    ?? snap.ips.find((i) => i.kind === a.kind && namedAfter(i.name, a));
}

/** The running step of an asset's 3D chain, for its badge. */
function stageOf(snap: Snapshot, a: SkillAsset): string {
  const ip = ipFor(snap, a);
  const j = ip && snap.jobs.find((x) => x.input?.ipId === ip.ipId && (x.status === 'running' || x.status === 'queued')
    && ['apose', 'mesh3d', 'rig'].includes(x.kind));
  if (!j) return STATE_LABEL.mesh;
  // the cards' words: what the step is doing while it runs ("움직임 뼈대 넣는 중"), its name while it waits
  return j.status === 'running' ? JOB_KIND_DOING[j.kind as 'apose' | 'mesh3d' | 'rig'] : t('{step} 대기', { step: JOB_KIND_LABEL[j.kind] });
}

/** Minutes left for a skill: about 10 min per mesh still to make (one GPU box), plus 2 per image. */
function etaMin(snap: Snapshot, skill: Skill): number {
  const states = skill.assets.map((a) => stateOf(snap, a));
  return Math.max(1, states.filter((s) => s === 'mesh').length * MESH_MIN + states.filter((s) => s === 'image' || s === 'missing').length * NEW_MIN);
}

function stateOf(snap: Snapshot, a: SkillAsset): AssetState {
  const ip = ipFor(snap, a);
  if (!ip) {
    const id = launched.get(launchKey(snap, a));
    const msg = id ? snap.messages.find((m) => m.messageId === id) : undefined;
    if (id && (!msg || msg.status === 'pending')) return 'image';
    return msg?.status === 'failed' ? 'failed' : 'missing';
  }
  const picture = imageState(ip, snap.jobs); // the IP exists before its picture does (a background image job)
  if (picture === 'pending') return 'image';
  if (picture === 'failed') return 'failed';
  const jobs = snap.jobs.filter((j) => j.input?.ipId === ip.ipId && ['apose', 'mesh3d', 'rig'].includes(j.kind));
  const rigging = jobs.some((j) => j.kind === 'rig' && (j.status === 'queued' || j.status === 'running'));
  if (ip.glbAssetId && !rigging) return 'ready';
  if (jobs.some((j) => j.status === 'failed')) return 'failed';
  return jobs.length ? 'mesh' : 'missing';
}

/** What 만들기 would start for a skill now, said before the click: the IPs not made or failed (`make`; one whose
 * picture failed is skipped), how many of them get a new picture, and about how long all of it takes. */
function launchPlan(snap: Snapshot, skill: Skill) {
  const todo = skill.assets.filter((a) => ['missing', 'failed'].includes(stateOf(snap, a)));
  // an IP whose picture failed has nothing to make 3D from (render_3d answers image_failed): it is named and
  // skipped, so the rest of the batch still runs; its image job is retried from 작업 현황
  const noImage = todo.filter((a) => { const ip = ipFor(snap, a); return !!ip && imageState(ip, snap.jobs) === 'failed'; });
  const make = todo.filter((a) => !noImage.includes(a));
  const drawn = make.filter((a) => !ipFor(snap, a)); // made new: a picture, then its 3D
  return { todo, noImage, make, drawn, minutes: drawn.length * NEW_MIN + (make.length - drawn.length) * MESH_MIN };
}

/** Skills tab: genre recipes whose assets become 3D on the left, then one request makes the genre game. */
const heroOf = (snap: Snapshot) => snap.ips.find((i) => i.kind === 'character' && !SKILLS.some((s) => s.assets.some((a) => namedAfter(i.name, a))));

export function SkillsDrawer({ snap, onClose, onSend, onNotice, onError, onChat }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null); // the skill whose game request is being sent
  const [asking, setAsking] = useState<Skill | null>(null); // the skill whose 만들기 waits for its confirm
  const [heroStart, setHeroStart] = useState<'busy' | 'started' | null>(null); // step 0's 3D로 만들기
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const sid = snap.session.sessionId;
  const registering = (skill: Skill) => launching.has(`${sid}:${skill.id}`);

  async function makeAssets(skill: Skill) {
    const key = `${sid}:${skill.id}`;
    if (launching.has(key)) return;
    const { todo, noImage, make, drawn, minutes } = launchPlan(snap, skill);
    if (!todo.length) { onNotice(t('만들 IP가 없어요. 진행 중인 3D는 작업 현황에서 볼 수 있어요.')); return; }
    if (noImage.length) onNotice(t('{names}: 이미지가 실패해 건너뛰었어요. 작업 현황에서 이미지 작업을 다시 시도해 주세요.', { names: noImage.map(assetName).join(', ') }));
    if (!make.length) return;
    launching.add(key);
    rerender();
    const failed: string[] = []; // the IPs that could not be started; the others still are
    let error: unknown;
    const start = async (a: SkillAsset, run: () => Promise<unknown>) => {
      try { return await run(); } catch (e) { failed.push(a.name); error ??= e; return undefined; } // (by the Korean name, the asset's id)
    };
    try {
      // an IP made earlier whose 3D failed or never started only needs its 3D again
      for (const a of make.filter((x) => ipFor(snap, x))) await start(a, () => runTool(sid, 'render_3d', { ipId: ipFor(snap, a)!.ipId }));
      const queue = [...drawn]; // the workers drain the queue
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          const asset = a;
          const made = await start(asset, () => runToolAsync(sid, 'make_skill_asset', {
            kind: asset.kind, name: assetName(asset), description: asset.description, role: t('{title} 스킬', { title: said(skill).title }),
            ...(asset.kind === 'enemy' ? { humanoid: !!asset.humanoid } : {}),
            ...(asset.kind === 'weapon' ? { weapon_type: asset.weaponType ?? 'melee' } : {}),
          })) as { messageId: string } | undefined;
          if (!made) continue;
          launched.set(`${sid}:${asset.name}`, made.messageId); rerender();
          for (let turn = 0; turn < 120; turn++) { // until its status line settles (its image and 3D jobs are registered)
            await sleep(3000);
            // a poll that fails is asked again on the next round: it must not end this worker while the other still
            // drains the queue
            const m = (await getSession(sid).catch(() => null))?.messages.find((x) => x.messageId === made.messageId);
            if (m && m.status !== 'pending') break;
          }
        }
      };
      await Promise.allSettled(Array.from({ length: CONCURRENCY }, worker));
      const started = make.length - failed.length;
      const left = minutes - failed.reduce((n, name) => n + (drawn.some((a) => a.name === name) ? NEW_MIN : MESH_MIN), 0);
      const missed = failed.length ? ` ${t('시작하지 못한 IP: {names}.', { names: failed.map((name) => t(name)).join(', ') })}` : '';
      // make_skill_asset settles once its image and 3D jobs are registered: the pictures are still being drawn
      if (started > 0) {
        onNotice(drawn.some((a) => !failed.includes(a.name))
          ? `${t('{title} 스킬의 IP {n}개를 등록했어요. 지금 그림을 그리고 있어요. 그림이 나오면 3D가 이어서 만들어져요 (모두 약 {min}분).', { title: said(skill).title, n: started, min: left })}${missed}`
          : `${t('{title} 스킬 IP의 3D를 다시 시작했어요. 작업 현황에서 이어서 진행돼요 (약 {min}분).', { title: said(skill).title, min: left })}${missed}`);
      }
      if (error) onError(error);
    } finally {
      launching.delete(key);
      rerender();
    }
  }

  async function makeHero3d(hero: Ip) {
    setHeroStart('busy');
    try {
      await runTool(sid, 'render_3d', { ipId: hero.ipId });
      setHeroStart('started');
    } catch (e) {
      setHeroStart(null);
      onError(e);
    }
  }

  async function makeGame(skill: Skill) {
    const hero = heroOf(snap);
    if (!hero) return; // step 0 says so and offers to make one
    const mine = skill.assets.map((a) => ({ a, ip: ipFor(snap, a) })).filter((x): x is { a: SkillAsset; ip: Ip } => !!x.ip?.glbAssetId);
    const of = (role: string) => mine.filter((x) => x.a.role === role).map((x) => x.ip.ipId);
    const weapon = of('weapon')[0] ?? null;
    const design = {
      castIpIds: [hero.ipId, ...mine.map((x) => x.ip.ipId)], playerIpId: hero.ipId, weaponIpId: weapon,
      propIpIds: [], enemyIpIds: of('enemy'), npcIpIds: of('npc').slice(0, 1), setIpIds: of('set'),
    };
    design.castIpIds = design.castIpIds.filter((id) => id === hero.ipId || id === weapon || [...design.enemyIpIds, ...design.npcIpIds, ...design.setIpIds].includes(id));
    // (the first line and the skill line's frame are for the agent and the chat bubble, which shows chips for them
    // (ChatDock userText): the same in either language; the skill's words and its request are in the page's)
    const words = said(skill);
    const text = `[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n[스킬 ${words.title}] 장르 모듈: ${words.module}\n${t('게임 요청: {request}', { request: words.request })}`;
    setSending(skill.id);
    try {
      await onSend(text, { prompt: text, ...design });
      onClose();
    } catch {
      /* onSend already reported it */
    } finally {
      setSending(null);
    }
  }

  const hero = heroOf(snap);
  // a 3D game is played by its hero in 3D: the server makes none before it is done (server/tools.py _needs_3d)
  const hero3d = hero ? gameThreeD(hero, snap.assets, snap.jobs) : null;
  const heroIs = !hero ? '' : lang === 'en' ? t('게임의 주인공은 {name}이에요.', { name: hero.name })
    : `게임의 주인공은 ${hero.name}${josa(hero.name, '이에요', '예요', '(이)에요')}.`;
  const plan = asking ? launchPlan(snap, asking) : null;

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} />
      <div ref={panel} className="drawer drawer--skills" role="dialog" aria-modal="true" aria-labelledby="skills-title" aria-describedby="skills-intro">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">SKILLS · GENRE</p>
            <h2 id="skills-title">{t('장르 스킬')}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        <div className="dialog-body">
          <p id="skills-intro" className="dialog-lead muted">{t('장르에 맞는 적과 사물을 IP로 만들어 3D까지 준비하고, 그 IP로 장르 게임을 만들어요.')}</p>
          <ul className="skill-cards">
            {SKILLS.map((skill) => {
              const states = skill.assets.map((a) => stateOf(snap, a));
              const ready = states.filter((s) => s === 'ready').length;
              const on = openId === skill.id;
              return (
                <li key={skill.id}>
                  <button type="button" className={`skill-card${on ? ' is-open' : ''}`} style={{ '--skill': skill.accent } as CSSProperties}
                    aria-expanded={on} aria-controls={`skill-${skill.id}`} onClick={() => setOpenId(on ? null : skill.id)}>
                    <span className="skill-card-title">{said(skill).title}</span>
                    <span className="skill-card-line">{said(skill).tagline}</span>
                    <span className="skill-card-meta">{said(skill).module}</span>
                    <span className="skill-card-progress" aria-label={t('IP {ready}/{all}개 준비', { ready, all: skill.assets.length })}>
                      <i style={{ width: `${(ready / skill.assets.length) * 100}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {SKILLS.filter((s) => s.id === openId).map((skill) => {
            const states = skill.assets.map((a) => stateOf(snap, a));
            const ready = states.filter((s) => s === 'ready').length;
            const allReady = ready === skill.assets.length;
            const busy = registering(skill);
            const working = busy || states.some((s) => s === 'image' || s === 'mesh');
            const { make, minutes } = launchPlan(snap, skill);
            const heroBlocked = !hero || hero3d?.state !== 'ready';
            const title = said(skill).title;
            // why 게임 만들기 is off, the first reason that holds
            const why = !hero ? t('0단계의 주인공이 있어야 게임을 만들 수 있어요.')
              : hero3d?.state === 'none' ? t('주인공 {name}의 3D가 있어야 게임을 만들 수 있어요. 0단계에서 3D를 먼저 만들어 주세요.', { name: hero.name })
                : hero3d?.state === 'running' ? t('주인공 {name}의 3D를 만들고 있어요. 끝나면 게임을 만들 수 있어요.', { name: hero.name })
                  : !allReady ? t('‘{title} 게임 만들기’는 1단계의 IP {all}개가 모두 3D로 준비되면 누를 수 있어요 (지금 {ready}/{all}개). 기다리지 않으려면 ‘지금 있는 IP로’ 만들 수 있어요.',
                    { title, all: skill.assets.length, ready }) : '';
            return (
              <section key={skill.id} id={`skill-${skill.id}`} className="skill-steps" aria-label={t('{title} 스킬 실행 단계', { title })}>
                <details className="skill-step" open={heroBlocked}>
                  <summary><span className="skill-step-num">0</span> {t('주인공 캐릭터')} <small>{!hero ? t('필요')
                    : `${hero.name} · ${hero3d?.state === 'ready' ? t('3D 완료') : hero3d?.state === 'running' ? t('3D 만드는 중') : t('3D 필요')}`}</small></summary>
                  {!hero ? (
                    <>
                      <p className="muted">{t('장르 게임에는 플레이할 주인공이 필요해요. 채팅으로 한 명 만들고 3D까지 걸어 둘게요.')}</p>
                      <button type="button" className="btn btn-primary" onClick={() => { onChat(t('{title} 게임의 주인공 캐릭터를 한 명 만들고 3D로도 만들어줘.', { title })); onClose(); }}>
                        {t('주인공 만들기')}
                      </button>
                    </>
                  ) : hero3d?.state === 'ready' ? (
                    <p className="muted">{heroIs} {t('3D 모델이 준비됐어요.')}</p>
                  ) : hero3d?.state === 'running' ? (
                    <p className="muted">{heroIs} {t('3D를 만들고 있어요 ({phase}). 끝나면 게임을 만들 수 있어요.', { phase: hero3d.phase ?? '' })}</p>
                  ) : (
                    <>
                      {/* no game is made before the hero's 3D is done */}
                      <p className="muted">{heroIs} {t('게임을 만들려면 {name}의 3D가 먼저 필요해요 (보통 {total}).', { name: hero.name, total: THREE_D_TOTAL })}</p>
                      {heroStart === 'started' ? <p className="field-hint" role="status">{t('{name}의 3D를 만들기 시작했어요. 보통 {total} 걸려요.', { name: hero.name, total: THREE_D_TOTAL })}</p> : (
                        <button type="button" className="btn btn-primary" disabled={heroStart === 'busy' || !hero.imageAssetId} onClick={() => void makeHero3d(hero)}>
                          {heroStart === 'busy' ? t('시작하는 중…') : t('{name} 3D로 만들기', { name: hero.name })}
                        </button>
                      )}
                    </>
                  )}
                </details>
                <details className="skill-step" open>
                  <summary><span className="skill-step-num">1</span> {t('IP 만들기 (그림 → 3D)')} <small>{ready}/{skill.assets.length}</small></summary>
                  <ul className="skill-assets">
                    {skill.assets.map((a, i) => {
                      const st = states[i];
                      return st === 'image' ? (
                        <li key={a.name} className="skill-asset is-loading" aria-busy="true">
                          <span className="skel skill-skel-thumb" aria-hidden="true" />
                          <span className="skill-asset-text"><strong>{assetName(a)}</strong><span className="skel skill-skel-line" aria-hidden="true" /></span>
                          <span className="skill-badge skill-badge--image">{STATE_LABEL[st]}</span>
                        </li>
                      ) : (
                        <li key={a.name} className="skill-asset">
                          <span className="skill-asset-kind" aria-hidden="true">{a.role === 'enemy' ? t('적') : a.role === 'npc' ? 'NPC' : a.role === 'weapon' ? t('무기') : t('사물')}</span>
                          <span className="skill-asset-text" title={a.description}><strong>{assetName(a)}</strong><small className="muted">{a.kind === 'enemy' ? (a.humanoid ? t('적 · 사람 모양') : t('적 · 사람 모양이 아님')) : a.kind === 'character' ? t('NPC 캐릭터') : a.kind === 'weapon' ? t('근접 무기') : t('배경 사물 · 3D 모델로 배치')}</small></span>
                          <span className={`skill-badge skill-badge--${st}`}>{st === 'mesh' ? stageOf(snap, a) : STATE_LABEL[st]}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {/* what the click starts, on the button; the confirm repeats it with the pictures and models counted */}
                  <button type="button" className="btn btn-primary" disabled={allReady || busy || (!make.length && working)}
                    onClick={() => (make.length ? setAsking(skill) : void makeAssets(skill))}>
                    {allReady ? t('IP 준비 완료') : busy ? t('등록하는 중…') : make.length ? t('IP {n}개 만들기 · 약 {min}분', { n: make.length, min: minutes }) : working ? t('IP 만드는 중…') : t('IP 만들기')}
                  </button>
                </details>
                <details className="skill-step" open={allReady}>
                  <summary><span className="skill-step-num">2</span> {t('게임 만들기')}</summary>
                  <p className="muted">{said(skill).request}</p>
                  <div className="row">
                    <button type="button" className="btn btn-primary" disabled={!allReady || busy || !!sending || heroBlocked} onClick={() => void makeGame(skill)}>
                      {t('{title} 게임 만들기', { title })}
                    </button>
                    {!allReady && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !!sending || heroBlocked} onClick={() => void makeGame(skill)}
                        title={t('3D가 끝난 IP만 넣고 지금 만들어요')}>
                        {t('지금 있는 IP로')}
                      </button>
                    )}
                  </div>
                  {why && <p className="field-hint skill-why" role="status">{why}</p>}
                  {/* What the page is needed for. The loop that registers the IPs runs in this page; once a job is registered
                      the server carries its chain on. */}
                  {busy ? <p className="field-hint skill-wait" role="status">{t('IP를 차례로 등록하는 중이에요. 등록이 끝날 때까지 이 탭을 닫지 마세요.')}</p>
                    : working && !allReady && (
                      <p className="field-hint skill-wait" role="status">
                        {t('남은 예상 시간은 약 {min}분이에요 (GPU 한 대에서 차례로 처리). 등록된 작업은 탭을 닫아도 이어서 만들어져요.', { min: etaMin(snap, skill) })}
                      </p>
                    )}
                </details>
              </section>
            );
          })}
        </div>
        <div className="dialog-footer">
          <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>{t('닫기')}</button></div>
        </div>
      </div>
      {asking && plan && (
        <ConfirmDialog title={t('{title} 스킬의 IP {n}개를 만들까요?', { title: said(asking).title, n: plan.make.length })} confirmLabel={t('만들기 시작')}
          message={plan.drawn.length
            ? t('그림 {pictures}장과 3D {models}개를 만들어요. GPU 한 대에서 차례로 처리해 약 {min}분 걸려요. 시작한 뒤에는 화면 위쪽의 작업 메뉴나 ‘작업 현황’ 탭에서 하나씩 중지할 수 있어요.',
              { pictures: plan.drawn.length, models: plan.make.length, min: plan.minutes })
            : t('3D {models}개를 만들어요. GPU 한 대에서 차례로 처리해 약 {min}분 걸려요. 시작한 뒤에는 화면 위쪽의 작업 메뉴나 ‘작업 현황’ 탭에서 하나씩 중지할 수 있어요.',
              { models: plan.make.length, min: plan.minutes })}
          onConfirm={() => { const skill = asking; setAsking(null); void makeAssets(skill); }} onCancel={() => setAsking(null)} />
      )}
    </div>
  );
}
