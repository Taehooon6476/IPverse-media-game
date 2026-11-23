import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { getRelease } from '../api';
import { fmtTime, type Asset, type Game } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { useDialog } from './useDialog';

interface Props {
  games: Game[];
  assets: Asset[];
  onClose: () => void;
  /** Resolves to the published URL. */
  onPublish: (body: { gameId: string; adAssetId?: string; skipAfterSec: number; adEveryRounds: number }) => Promise<string>;
  /** 게시 내리기; rejects when the server refused (the caller says why). Without it the dialog offers none. */
  onUnpublish?: (gameId: string) => Promise<void>;
}

const SKIP_SEC = 5;
const EVERY_ROUNDS = 3;

/** "게시하기" modal: pick the game and the ad before it. A game that is published shows its address at once, with the
 * settings it was published with, 주소 복사 and 게시 내리기. */
export function PublishModal({ games, assets, onClose, onPublish, onUnpublish }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const urlField = useRef<HTMLInputElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  useDialog(panel, onClose);

  // v1 = the first made, as the game pane numbers them; the newest leads the list
  const byAge = [...games].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const newestFirst = [...byAge].reverse();
  // each video with its number in the 영상 tab (snapshot order), the newest first: the newest trailer is the default ad
  const numbered = (kind: Asset['kind']) => assets.filter((a) => a.kind === kind).map((a, i) => ({ a, n: i + 1 })).reverse();
  const ads = [...numbered('trailer'), ...numbered('shorts')];
  const newestAd = ads[0]?.a.assetId ?? '';
  const [gameId, setGameId] = useState(newestFirst[0]?.gameId ?? '');
  // A game made while the modal is open becomes the selection (and enables 게시) until the user picks one.
  const selectedGameId = gameId || newestFirst[0]?.gameId || '';
  const game = games.find((g) => g.gameId === selectedGameId);
  const [adId, setAdId] = useState(newestAd);
  const [skip, setSkip] = useState(SKIP_SEC);
  const [every, setEvery] = useState(EVERY_ROUNDS);
  const [busy, setBusy] = useState<'publish' | 'down' | null>(null);
  // what this dialog did to a game, ahead of the next snapshot: its address after 게시하기, null after 게시 내리기
  const [changed, setChanged] = useState<Record<string, string | null>>({});
  const [fresh, setFresh] = useState(0); // counts the publishes made here: each brings its address into view
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  // the settings each publish made here went out with, by game: what the form shows for that game from then on
  const sent = useRef<Record<string, { adId: string; skip: number; every: number }>>({});
  const addressOf = (g?: Game) => (g && Object.hasOwn(changed, g.gameId) ? changed[g.gameId] : g?.publishedUrl) || null;
  // whole, so it works pasted anywhere: the server names a path alone when it knows no CDN domain (store.public_url)
  const address = addressOf(game) && new URL(addressOf(game)!, location.href).href;
  const justPublished = !!address && !!changed[selectedGameId];
  const takenDown = changed[selectedGameId] === null;

  // The form shows the selected game's own settings: a published game's ad (its item) and that ad's rules (its
  // release.json), a game not published yet the defaults.
  const wasPublished = !!game?.publishedUrl;
  useEffect(() => {
    setCopied(false);
    // Published from this dialog: what was just sent, and no read of its release.json (the read can fail, or the CDN
    // can still serve the file of before the publish).
    const mine = sent.current[selectedGameId];
    if (mine) {
      setAdId(mine.adId); setSkip(mine.skip); setEvery(mine.every);
      return;
    }
    if (!game || !wasPublished) {
      setAdId(newestAd); setSkip(SKIP_SEC); setEvery(EVERY_ROUNDS);
      return;
    }
    setAdId(game.adAssetId && assets.some((a) => a.assetId === game.adAssetId) ? game.adAssetId : '');
    setSkip(SKIP_SEC); setEvery(EVERY_ROUNDS);
    let alive = true;
    getRelease(game).then(({ ad }) => {
      if (!alive || !ad) return;
      setSkip(ad.skipAfterSec);
      setEvery(ad.everyRounds ?? 0); // no everyRounds: the ad plays at the start only
    }, () => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per selected game, not per poll
  }, [selectedGameId, wasPublished]);

  // a publish made here: its address is brought into view and selected
  useEffect(() => {
    if (!fresh) return;
    result.current?.scrollIntoView?.({ block: 'nearest' });
    copyButton.current?.focus();
  }, [fresh]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy('publish');
    try {
      const skipAfterSec = Math.min(30, Math.max(0, Math.round(skip) || 0));
      const adEveryRounds = Math.min(20, Math.max(0, Math.round(every) || 0));
      const url = await onPublish({ gameId: selectedGameId, adAssetId: adId || undefined, skipAfterSec, adEveryRounds });
      sent.current[selectedGameId] = { adId, skip: skipAfterSec, every: adEveryRounds };
      setChanged((c) => ({ ...c, [selectedGameId]: url }));
      setCopied(false);
      setFresh((n) => n + 1);
    } catch {
      // the caller shows the error toast
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      urlField.current?.select(); // clipboard blocked: leave the text selected for ⌘C
    }
  }

  async function takeDown() {
    setAsking(false);
    if (!onUnpublish) return;
    setBusy('down');
    try {
      await onUnpublish(selectedGameId);
      delete sent.current[selectedGameId]; // not published any more: the new-game form
      setChanged((c) => ({ ...c, [selectedGameId]: null }));
    } catch {
      // the caller shows the error toast; the game stays published
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-root">
      <div className="modal-backdrop" onClick={onClose} />
      <div ref={panel} className="modal" role="dialog" aria-modal="true" aria-labelledby="publish-title" aria-describedby={games.length ? 'publish-intro' : 'publish-empty'}>
        <div className="dialog-head">
          <div>
            <p className="eyebrow">PUBLISH</p>
            <h2 id="publish-title">{t('게임 + 광고 게시')}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        {games.length === 0 ? (
          <p id="publish-empty" className="empty dialog-empty">{t('아직 만든 게임이 없어요. 게임 설계나 채팅으로 게임을 먼저 만들어 주세요.')}</p>
        ) : (
          <form id="publish-game-form" className="dialog-body" onSubmit={submit} aria-busy={!!busy}>
            <p id="publish-intro" className="dialog-lead muted">{t('게시하면 주소를 아는 누구나 로그인 없이 이 게임을 할 수 있어요. 게임과, 게임 시작 전에 보여 줄 광고를 고르세요.')}</p>
            <h3 className="dialog-section-heading">{t('게시할 게임')}</h3>
            <label className="field">
              <span>{t('게임')}</span>
              <select value={selectedGameId} onChange={(e) => setGameId(e.target.value)}>
                {newestFirst.map((g) => (
                  <option key={g.gameId} value={g.gameId}>
                    v{byAge.indexOf(g) + 1} · {g.title} · {fmtTime(g.createdAt)}{addressOf(g) ? ` · ${t('게시됨')}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {/* right under the game it belongs to, above the settings: never under the dialog's fold */}
            {address && (
              <div ref={result} className="publish-result" role="status">
                <p><strong>{justPublished ? t('게시됐어요') : t('게시 중인 게임이에요')}</strong> · {t('이 주소를 아는 누구나 로그인 없이 플레이할 수 있어요.')}</p>
                <input ref={urlField} readOnly value={address} aria-label={t('게시 주소')} onFocus={(e) => e.currentTarget.select()} />
                <div className="row publish-result-actions">
                  <button ref={copyButton} type="button" className="btn btn-sm btn-primary" onClick={copy}>{copied ? t('복사했어요') : t('주소 복사')}</button>
                  <a className="btn btn-sm" href={address} target="_blank" rel="noopener noreferrer">{t('열기')}</a>
                  {onUnpublish && <button type="button" className="btn btn-sm btn-ghost publish-down" disabled={!!busy} onClick={() => setAsking(true)}>{busy === 'down' ? t('내리는 중…#게시') : t('게시 내리기')}</button>}
                </div>
              </div>
            )}
            {takenDown && !address && <p className="publish-note" role="status">{t('게시를 내렸어요. 이 게임은 이제 ‘게시됨’으로 표시되지 않고 광고도 나오지 않아요.')}</p>}
            <fieldset className="field">
              <legend>{t('게임 시작 전 광고 영상')}</legend>
              {!ads.length && <p className="field-hint">{t('아직 트레일러나 쇼츠가 없어요. 광고 없이 게시하거나, 영상을 만든 뒤 고를 수 있어요.')}</p>}
              {ads.map(({ a, n }) => {
                const seconds = Number(a.meta?.seconds);
                return (
                  <label key={a.assetId} className="radio">
                    <input type="radio" name="ad" checked={adId === a.assetId} onChange={() => setAdId(a.assetId)} />
                    <span>
                      {/* its number in the 영상 tab and its length: two trailers read alike by kind and time alone */}
                      {a.kind === 'trailer' ? `${t('트레일러 {n}', { n })} · 16:9` : `${t('쇼츠 {n}', { n })} · 9:16`}{seconds > 0 ? ` · ${t('{n}초', { n: Math.round(seconds) })}` : ''}
                      <small>{fmtTime(a.createdAt)}</small>
                    </span>
                  </label>
                );
              })}
              <label className="radio">
                <input type="radio" name="ad" checked={adId === ''} onChange={() => setAdId('')} />
                <span>{t('광고 없음')}</span>
              </label>
            </fieldset>
            <h3 className="dialog-section-heading">{t('광고 재생 규칙')}</h3>
            {!adId && <p className="field-hint">{t('광고 없이 게시해요. 광고 영상을 고르면 아래 재생 규칙을 정할 수 있어요.')}</p>}
            <label className="field">
              <span>{t('건너뛰기 버튼이 나올 때까지 (초)')}</span>
              <input type="number" min={0} max={30} step={1} value={Number.isNaN(skip) ? '' : skip} disabled={!adId} onChange={(e) => setSkip(e.target.valueAsNumber)} />
            </label>
            <label className="field">
              <span>{t('광고 다시 틀기 · 몇 판마다 (0 = 시작할 때만)')}</span>
              <input type="number" min={0} max={20} step={1} value={Number.isNaN(every) ? '' : every} disabled={!adId} onChange={(e) => setEvery(e.target.valueAsNumber)} />
              <small className="field-hint">{t('게임이 이 판수만큼 끝날 때마다 다음 판 전에 광고가 나와요. 라이브 방송의 광고 간격은 라이브 화면에서 따로 정해요.')}</small>
            </label>
          </form>
        )}
        <div className="dialog-footer">
          {games.length > 0 && (
            <p id="publish-submit-hint" className="field-hint dialog-submit-hint" role="status">
              {busy === 'publish' ? t('선택한 게임을 게시하고 있어요.') : busy === 'down' ? t('게시를 내리고 있어요.')
                : justPublished ? t('게시됐어요. 주소를 복사해 공유하세요.')
                  : address ? t('게시 중인 게임이에요. 광고 설정을 바꾸려면 고친 뒤 ‘설정 바꿔 다시 게시’를 누르세요.')
                    : t('선택한 게임과 광고 설정으로 공유 주소를 만들어요.')}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>{address || !games.length ? t('닫기') : t('취소')}</button>
            {/* once the game is published the address's 주소 복사 is the main action: publishing again is the plain one */}
            {games.length > 0 && (
              <button form="publish-game-form" type="submit" className={address ? 'btn' : 'btn btn-primary'} aria-describedby="publish-submit-hint"
                disabled={!!busy || !selectedGameId}>
                {busy === 'publish' ? t('게시하는 중…') : address ? t('설정 바꿔 다시 게시') : t('게시하기')}
              </button>
            )}
          </div>
        </div>
      </div>
      {asking && game && (
        <ConfirmDialog title={t('게시를 내릴까요?')} confirmLabel={t('게시 내리기')} danger onConfirm={() => void takeDown()} onCancel={() => setAsking(false)}
          message={t('‘{title}’의 ‘게시됨’ 표시와 광고 설정이 지워지고, 라이브 방송 광고의 ‘게임 보기’로도 더는 소개되지 않아요. 다만 이 주소는 게임의 미리보기 주소와 같아서, 이미 주소를 받은 사람은 세션을 지울 때까지 게임을 열 수 있어요.',
            { title: game.title })} />
      )}
    </div>
  );
}
