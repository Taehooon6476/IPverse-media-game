import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getGameSpec, heldGame, noSkeleton, readyIp, type HeldMessage } from '../api';
import { lang, t } from '../i18n';
import { Dropdown } from './Dropdown';
import { GENRES, SKELETON_NEEDS, gameThreeD, ownGenre, refusedSkeleton, type Game, type Genre, type Snapshot } from '../types';
import { ActionButton } from './ActionButton';
import { ActionMenu } from './ActionMenu';
import { BigGameModal } from './BigGameModal';
import { readHash, writeHash } from './Tabs';
import { Fold } from './Fold';
import { GameDesignSummary } from './GameDesignSummary';
import { NEEDS_TITLE, NeedsSteps, OTHERS_NOTE, STAND_IN_WHY, gameNeeds, standInLine, toChat } from './GameNeeds';
import { Tabs } from './Tabs';
import { UnrealStream } from './UnrealStream';

interface Props {
  snap: Snapshot;
  onGenre: (genre: Genre) => void;
  onError: (e: unknown) => void;
  /** Open the game design drawer. */
  onDesign: () => void;
  /** Open the expanded game (big play + live broadcast). */
  onExpand: (game: Game, url: string) => void;
  /** Open the drawer that asks the agent for a revised version of this game. */
  onEditGame: (game: Game, version: number) => void;
  /** Ask for the game request the agent held for 3D, now that it can be made (what the toast's button sends). Its
   * promise is the send: settled once the request is in (or was refused), so the button can show it. */
  onMakeHeld: () => Promise<void> | void;
  /** 다시 뽑기 of an IP's picture (the card's own tool): what a held game's hero needs when her skeleton was refused. */
  onReroll?: (ipId: string) => Promise<void>;
  /** 3D로 만들기 of an IP (the card's own tool): the step a session with a character and no 3D is at. */
  onMake3d?: (ipId: string) => Promise<void>;
  /** A chat send is on its way (the shell's): this request from the toast's button, or a line from the message box. */
  sending?: boolean;
}

/** Radio group keys (game version, run mode): arrows wrap, Home/End jump; the new option is checked and focused. */
function radioKey(e: KeyboardEvent<HTMLElement>, ids: string[], current: string | undefined, pick: (id: string) => void, domId: (id: string) => string) {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // Alt+Arrow is the browser's history
  const i = ids.indexOf(current ?? '');
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : d ? (i + d + ids.length) % ids.length : -1;
  if (to < 0) return;
  e.preventDefault();
  pick(ids[to]);
  document.getElementById(domId(ids[to]))?.focus();
}

export function GamePane({ snap, onGenre, onDesign, onExpand, onEditGame, onMakeHeld, onReroll, onMake3d, sending = false }: Props) {
  // every game is a version (v1 = the first made); the newest is shown when it appears, any other one on click
  const games = [...snap.games].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const newestId = games.at(-1)?.gameId ?? null;
  const [selId, setSelId] = useState<string | null>(null);
  const seenNewest = useRef<string | null>(null);
  const [tabsKey, setTabsKey] = useState(0);
  // Sticky Header: the toolbar casts a shadow once the preview has scrolled under it
  const stuckSentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = stuckSentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  });
  useEffect(() => {
    if (newestId === seenNewest.current) return;
    const arrived = seenNewest.current !== null && newestId !== null;
    seenNewest.current = newestId; setSelId(newestId);
    if (arrived) { writeHash('game', 'preview'); setTabsKey((k) => k + 1); } // a new game: show its preview
  }, [newestId]);
  const game = games.find((g) => g.gameId === selId) ?? games.at(-1);
  useEffect(() => { // the selected version (the newest on arrival) is visible in a long strip, unless 게임 설정 is folded
    const el = game && document.getElementById(`game-ver-${game.gameId}`);
    if (el && !el.closest('[inert]')) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [game?.gameId]);
  const version = game ? games.indexOf(game) + 1 : 0;
  const versionOf = (id?: string) => games.findIndex((g) => g.gameId === id) + 1;
  const url = game && (game.publishedUrl ?? game.previewUrl);
  // What a game needs before 게임 설계 can succeed: a character whose 3D is finished (the server refuses a 3D game whose
  // player is not ready). The 게임 설계 drawer reads the same (GameNeeds.tsx), and both offer the step to do now as a
  // button.
  const needs = gameNeeds(snap.ips, snap.assets, snap.jobs);
  const heroReady = needs.ready;

  const [spec, setSpec] = useState<{ gameId: string; value?: unknown; text?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!game) return;
    let alive = true;
    getGameSpec(game).then(
      (s) => alive && setSpec({ gameId: game.gameId, value: s, text: JSON.stringify(s, null, 2) }),
      // (the saved design is 게임 설계; 게임 설정 is the fold above with the genre, the version and the run mode)
      () => alive && setSpec({ gameId: game.gameId, error: t('게임 설계를 불러오지 못했어요.') }),
    );
    return () => {
      alive = false;
    };
  }, [game?.gameId, game?.specKey]); // refetch only when the shown game changes

  // Unreal games: the streamed UE5 build first; three.js games: the browser first, GameLift Streams the other option.
  // The bar above (크게 보기 · ⋯) stays the same in both.
  const unreal = game?.engine === 'unreal';
  // plain names; the service that runs the cloud option is its tooltip
  const engineTabs: { id: string; label: string; title?: string }[] = [{ id: 'browser', label: t('브라우저 미리보기') },
    { id: 'stream', label: unreal ? t('Unreal (클라우드)') : t('클라우드 플레이'), title: t('클라우드 GPU 서버에서 실행해 이 창으로 보여 줘요 (Amazon GameLift Streams)') }];
  if (unreal) engineTabs.reverse();
  // 실행 방식 is switched in the 게임 설정 fold, away from the preview it drives. The choice stays in the hash under
  // `engine` as with the Tabs it replaces; until one is made, each game opens on its own first option.
  const [enginePick, setEnginePick] = useState(() => readHash('engine'));
  const engine = engineTabs.find((o) => o.id === enginePick)?.id ?? engineTabs[0].id;
  const [big, setBig] = useState(false);
  const pickEngine = (id: string) => { setEnginePick(id); writeHash('engine', id); setBig(false); };
  const canPreview = !!game && (!!url || unreal);

  const onVersionKey = (e: KeyboardEvent<HTMLButtonElement>) =>
    radioKey(e, games.map((g) => g.gameId), game?.gameId, setSelId, (id) => `game-ver-${id}`);
  const caption = (g: Game, i: number) => (g.baseGameId ? t('v{n} 수정', { n: versionOf(g.baseGameId) }) : i > 0 && games[i - 1].title === g.title ? t('새로 만듦') : '');
  const versions = () =>
    games.length > 6 ? (
      <span className="ver-select">
        <select value={game?.gameId} onChange={(e) => setSelId(e.target.value)} aria-labelledby="game-ver-label">
          {games.map((g, i) => <option key={g.gameId} value={g.gameId}>v{i + 1} · {g.title}{caption(g, i) ? ` (${caption(g, i)})` : ''}</option>)}
        </select>
      </span>
    ) : (
      <div className="ver-tabs" role="radiogroup" aria-labelledby="game-ver-label">
        {games.map((g, i) => {
          const on = g.gameId === game?.gameId;
          return (
            <button key={g.gameId} id={`game-ver-${g.gameId}`} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
              className="ver-tab" onClick={() => setSelId(g.gameId)} onKeyDown={onVersionKey}
              title={g.baseGameId ? t('v{n}의 수정본', { n: versionOf(g.baseGameId) }) : g.title}>
              <span className="ver-num">v{i + 1}</span>
              <span className="ver-title">{g.title}</span>
              {!g.baseGameId && caption(g, i) && <span className="ver-from">{caption(g, i)}</span>}
              {g.baseGameId && <span className="ver-from" aria-label={t('v{n}의 수정본', { n: versionOf(g.baseGameId) })}>↳v{versionOf(g.baseGameId)}</span>}
            </button>
          );
        })}
      </div>
    );

  // A game request the agent held for 3D stays here until a game answers it. The request is the one api.heldGame
  // looks at (the newest user message that carries a hold or a design; a game made after it has answered it);
  // heldGame itself says only when it can be made, so the wait before that is read here by the same rule. Only a
  // request the agent marked as held is one: a 게임 설계 whose game never came may have failed for another reason.
  const asked = [...snap.messages as HeldMessage[]].reverse().find((m) => m.role === 'user' && (m.gameDesign || m.gameHeld));
  const newestAt = games.at(-1)?.createdAt;
  const held = asked?.gameHeld && !(newestAt && asked.ts <= newestAt) ? asked : null;
  const heldCard = () => {
    if (!held) return null;
    const cast = held.gameHeld!.ipIds.map((id) => snap.ips.find((ip) => ip.ipId === id)).filter((ip) => !!ip);
    const names = cast.map((ip) => ip.name).join(', ') || t('주인공#문장');
    const ready = heldGame(snap)?.messageId === held.messageId;
    const states = cast.map((ip) => gameThreeD(ip, snap.assets, snap.jobs));
    const running = states.find((s) => s.state === 'running'); // the step's name comes from the steps' own table (types.ts)
    // a request that waits for a cast is made once one of them is in 3D: the line names those, not the whole cast,
    // by the offer's own rule (api.readyIp): a hero whose skeleton failed for a passing reason still waits for its
    // retry and is not named as ready
    const made = cast.filter((ip) => readyIp(snap, ip.ipId));
    const done = made.map((ip) => ip.name).join(', ') || names;
    // ... and when every one of those stands without a skeleton because the farm refused it, the game is made with
    // the model as it is (a retry would fail the same way).
    const bare = ready && made.length > 0 && made.every((ip) => refusedSkeleton(ip, snap.assets, snap.jobs) !== null);
    const answering = snap.messages.some((m) => m.status === 'pending'); // that answer may be making this very game
    const line = held.text.split('\n')[0];
    return (
      <section className="held-game" aria-label={t('보류 중인 게임 요청')}>
        <h3>{t('보류 중인 게임 요청')}</h3>
        <p className="held-game-ask">“{line.length > 80 ? `${line.slice(0, 80)}…` : line}”</p>
        <p role="status">{bare ? (lang === 'en' ? t('‘{names}’ 움직임 뼈대를 넣을 수 없는 모습이에요. 걷는 동작 없이 그대로 게임을 만들 수 있어요.', { names: done })
          // (Korean: the name's particle is noSkeleton's own)
          : `${noSkeleton(done)} ${t('걷는 동작 없이 그대로 게임을 만들 수 있어요.')}`)
          : ready ? t('{names} 3D가 준비됐어요. 요청해 둔 게임을 지금 만들 수 있어요.', { names: done })
            : running ? t('{names} 3D가 끝나면 여기에서 만들 수 있어요 · 지금 {phase} 단계', { names, phase: t(running.phase ?? '') })
              : states.every((s) => s.state === 'none') ? t('{names}의 3D가 아직 없어요. 캐릭터 카드의 ‘3D로 만들기’를 누르면, 끝난 뒤 여기에서 만들 수 있어요.', { names })
                : t('{names} 3D가 끝까지 만들어지지 않았어요. ‘작업 현황’ 탭에서 실패한 작업을 다시 시도해 주세요.', { names })}</p>
        {/* One send at a time: the button waits while a send is on its way and while its answer is being made, so two
            presses cannot make two games. An ActionButton: it keeps the focus through the wait. */}
        {ready && (
          <div className="held-game-actions">
            <ActionButton className="btn btn-primary btn-sm" label={t('게임 만들기')} busyLabel={t('보내는 중…')} doneLabel={t('보냈어요')}
              disabled={answering || sending} disabledLabel={answering ? t('답변을 만드는 중…') : t('보내는 중…')} run={async () => { await onMakeHeld(); }} />
            {/* the other way on: a picture a skeleton fits (then her 3D again, from her card) */}
            {bare && onReroll && made.map((ip) => (
              <ActionButton key={ip.ipId} className="btn btn-sm" label={made.length > 1 ? t('{name} 그림 다시 뽑기', { name: ip.name }) : t('그림 다시 뽑기')} busyLabel={t('요청 중…')}
                doneLabel={t('뽑는 중')} ariaLabel={t('{name} 그림 다시 뽑기', { name: ip.name })} run={() => onReroll(ip.ipId)} />
            ))}
          </div>
        )}
        {bare && <p className="held-game-more">{t('걷는 동작을 넣으려면 {needs}으로 다시 뽑은 뒤 3D를 다시 만들어 주세요.', { needs: t(SKELETON_NEEDS) })}</p>}
      </section>
    );
  };
  // What ● 라이브 방송 is for, in one line. It sits under the start button and the version, never on a row of its own
  // above them: on a short window a row there pushes 게임 시작 out of sight
  const liveHint = <p id="preview-live-hint" className="preview-hint">{t('방송을 켜면 가상 시청자마다 다른 광고가 나가는 걸 볼 수 있어요.')}</p>;
  const preview = () =>
    game && (url || unreal) ? (
      <div className="preview">
        <div ref={stuckSentinel} aria-hidden="true" />
        <div className={`preview-bar${stuck ? ' is-stuck' : ''}`}>
          <span className="preview-title">
            {game.title}
            {game.publishedUrl && <span className="badge badge--done">{t('게시됨')}</span>}
          </span>
          {/* 크게 보기 and 라이브 방송 are buttons; 수정 is in the ⋯ menu at the bar's right edge */}
          <span className="figure-actions">
            {(url || engine === 'stream') && <button type="button" className="btn btn-sm btn-primary preview-action-primary"
              aria-label={t('{title} 크게 보기', { title: game.title })} onClick={() => setBig(true)}>⤢ {t('크게 보기')}</button>}
            {url && <button type="button" className="btn btn-sm preview-action-live" aria-label={t('{title} 라이브 방송', { title: game.title })}
              aria-describedby="preview-live-hint" onClick={() => onExpand(game, url)}><span aria-hidden="true">●</span> {t('라이브 방송')}</button>}
            <ActionMenu label={t('{title} 더보기', { title: game.title })} items={[{ label: t('이 게임 수정'), onSelect: () => onEditGame(game, version) }]} />
          </span>
        </div>
        {/* cloud run mode enlarges the stream itself (same <video>, same paid session), never a local browser copy.
            The browser build runs here and nowhere else: 게임 시작 and 크게 보기 both open this one view */}
        {big && url && engine !== 'stream' && <BigGameModal title={game.title} url={url} onClose={() => setBig(false)} />}
        {engine === 'stream' ? (
          <>
            <UnrealStream key={game.gameId} sessionId={snap.session.sessionId} game={game} kind={unreal ? 'unreal' : 'web'}
              big={big} onBigClose={() => setBig(false)} />
            {url && liveHint}
          </>
        ) : url ? (
          // the pane's poster of the game: its title and version, and the button that opens it big
          <div className="media game-poster">
            <div className="game-start">
              <p className="game-start-title">{game.title}</p>
              <button type="button" className="btn btn-primary game-start-btn" aria-describedby="game-keys-note" onClick={() => setBig(true)}>▶ {t('게임 시작')}</button>
              <p className="muted">{t('버전 {n}', { n: version })}{game.baseGameId ? ` · ${t('v{n}에서 수정', { n: versionOf(game.baseGameId) })}` : ''}</p>
              {/* the game page's own sentence (game3d KEYLESS_NOTE), before the press: the stylesheet shows it where
                  the pointer is a finger */}
              <p id="game-keys-note" className="keys-note">{t('이 게임은 키보드와 마우스로 플레이해요. PC에서 열어 주세요.')}</p>
              {liveHint}
            </div>
          </div>
        ) : <p className="muted">{t('브라우저 미리보기가 없는 게임이에요. ‘게임 설정’에서 실행 방식을 클라우드로 바꾸세요.')}</p>}
      </div>
    ) : held ? null : heroReady ? ( // (a held request's card is the pane's word on the game to come)
      <div className="media media-16x9 empty-frame empty-state">
        <span className="empty-state-icon" aria-hidden="true">▶</span>
        <h3>{t('내 IP가 등장하는 게임을 만들어 보세요')}</h3>
        <p>{t('캐릭터와 소품을 고르고, 플레이 방식과 목표를 정하세요.')}</p>
        <button type="button" className="btn btn-primary" onClick={onDesign}>{t('게임 설계')}</button>
        <small>{t('채팅으로 원하는 게임을 요청해도 좋아요.')}</small>
      </div>
    ) : needs.standIn ? (
      // No character, and an IP whose 3D is in: what chat does then (GameNeeds.standIn).
      <div className="media empty-frame empty-state empty-state--needs">
        <h3>{t('채팅으로 요청하면 게임을 만들 수 있어요')}</h3>
        <p>{standInLine(needs.standIn.name)}</p>
        <button type="button" className="btn btn-primary" onClick={toChat}>{t('채팅으로 게임 요청하기')}</button>
        <small>{STAND_IN_WHY} {t('‘게임 설계’는 3D가 끝난 캐릭터가 있을 때 쓸 수 있어요.')}</small>
      </div>
    ) : (
      // no hero in 3D yet: the order, with the step to do now marked and offered as the one lit button (the chat for
      // a character, the hero's 3D); 게임 설계 stays a way in from the pane's head, not the lit action.
      // No ▶ above it: nothing can be played yet, and at 1366x768 its 46 px were what cut the second step off
      <div className="media empty-frame empty-state empty-state--needs">
        <h3>{NEEDS_TITLE}</h3>
        <NeedsSteps needs={needs} />
        {needs.step === 1 ? <button type="button" className="btn btn-primary" onClick={toChat}>{t('채팅으로 캐릭터 만들기')}</button>
          : needs.todo && !needs.making && onMake3d && (
            <ActionButton className="btn btn-primary" label={t('{name} 3D로 만들기', { name: needs.todo.name })} busyLabel={t('시작하는 중…')} doneLabel={t('시작했어요')}
              disabled={!needs.todo.imageAssetId} disabledLabel={t('{name} 그림 그리는 중', { name: needs.todo.name })} run={() => onMake3d(needs.todo!.ipId)} />
          )}
        {needs.step === 1 && needs.others && <small>{OTHERS_NOTE}</small>}
      </div>
    );

  const specView = () => {
    if (!game) return <p className="empty">{t('게임이 준비되면 미션, 세계와 선택한 IP를 여기에서 확인할 수 있어요.')}</p>;
    if (spec?.gameId !== game.gameId) return <p className="muted loading-state" role="status"><span className="spinner" aria-hidden="true" />{t('게임 설계를 불러오고 있어요…')}</p>;
    if (spec.error) return <p className="empty" role="alert">{spec.error}</p>;
    // the raw design behind a fold, by a plain name; the format's name is the fold's tooltip and the block's own
    return <><GameDesignSummary game={game} spec={spec.value} ips={snap.ips} showRequest />
      <details className="game-spec-details"><summary title="GameSpec JSON">{t('개발자용 설계 데이터 보기')}</summary>
        <pre className="spec" tabIndex={0} aria-label={t('게임 설계 데이터 (GameSpec JSON)')}>{spec.text}</pre>
      </details></>;
  };

  return (
    <section className="pane" aria-labelledby="game-pane-title">
      <div className="pane-head">
        <span className="pane-num" aria-hidden="true">02</span>
        <div className="pane-title">
          <h2 id="game-pane-title">GAME <span>STUDIO</span></h2>
          <p className="pane-sub">{t('같은 IP로 게임을 설계하고 바로 플레이하세요')}</p>
        </div>
        <button type="button" className={games.length || heroReady ? 'btn btn-sm btn-edit pane-action' : 'btn btn-sm pane-action'} onClick={onDesign}>✎ {t('게임 설계')}</button>
      </div>
      {/* Genre, version and run mode are settings, not views: one fold above the view tabs, folded by default with
          the current values in its header. The preview they drive stays outside it. */}
      <Fold id="game-settings" className="game-settings" title={t('게임 설정')} storageKey="ipverse.gameSettingsOpen"
        // no genre before the session has a game or one was chosen
        meta={[ownGenre(snap.session, games.length), game && `v${version}`, canPreview && (engine === 'stream' ? t('클라우드') : t('브라우저'))].filter(Boolean).join(' · ')}>
        <div className="game-settings-body">
          <div className="game-setting" role="group" aria-labelledby="genre-label">
            <span id="genre-label" className="game-setting-label">{t('게임 장르')}</span>
            <div className="game-setting-control">
              <Dropdown label={t('게임 장르')} hideLabel value={snap.session.genre} options={GENRES.map((g) => ({ value: g.value, label: g.label }))}
                onChange={(v) => v !== snap.session.genre && onGenre(v)} />
              <span className="muted game-setting-hint">{t('새 게임의 기본 장르예요. 게임 설계에서 유형을 고르면 그쪽이 우선해요.')}</span>
            </div>
          </div>
          {games.length > 1 && (
            <div className="game-setting">
              <span id="game-ver-label" className="game-setting-label">{t('게임 버전')}</span>
              {versions()}
            </div>
          )}
          {canPreview && (
            <div className="game-setting">
              <span id="engine-label" className="game-setting-label">{t('실행 방식')}</span>
              <div className="ver-tabs" role="radiogroup" aria-labelledby="engine-label">
                {engineTabs.map((opt) => (
                  <button key={opt.id} id={`engine-opt-${opt.id}`} type="button" role="radio" aria-checked={opt.id === engine} title={opt.title}
                    tabIndex={opt.id === engine ? 0 : -1} className="ver-tab" onClick={() => pickEngine(opt.id)}
                    onKeyDown={(e) => radioKey(e, engineTabs.map((o) => o.id), engine, pickEngine, (id) => `engine-opt-${id}`)}>{opt.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Fold>
      <Tabs
        key={tabsKey}
        hashKey="game"
        label={t('게임 보기')}
        tabs={[
          { id: 'preview', label: t('미리보기') },
          { id: 'spec', label: t('설계 요약') },
        ]}
      >
        {(tab) =>
          tab === 'preview' ? <>{heldCard()}{preview()}
            {game && spec?.gameId === game.gameId && !spec.error && <GameDesignSummary game={game} spec={spec.value} ips={snap.ips} />}
          </>
            : specView()}
      </Tabs>
    </section>
  );
}
