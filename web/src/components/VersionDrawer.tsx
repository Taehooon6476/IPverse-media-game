import { useRef, useState } from 'react';
import { lang, t } from '../i18n';
import { createPortal } from 'react-dom';
import { assetModelLabel, fmtTime, plainLine, type Asset, type Ip, type Job } from '../types';
import { ActionButton } from './ActionButton';
import { useDialog } from './useDialog';

interface Props {
  ip: Ip;
  /** The IP's image assets, oldest first. */
  images: Asset[];
  /** The session's jobs: the one that drew a version keeps its model's label. */
  jobs: Job[];
  onClose: () => void;
  onRestore: (imageAssetId: string) => Promise<void>;
  onReroll: () => Promise<void>;
  onEdit: () => void;
}

const versionOf = (a: Asset) => Number(a.meta?.version ?? 1);

/** The check the server recorded on a version (asset meta.check: the composition check of server/providers/cutout.py
 * _check, with an edit's own check under `edit`, mediagen_image.py _check_edit); null when none ran on it. `edit` =
 * the edit check is the one that failed, as the job's line names it (mediagen_image.py check_name). */
function checkOf(a: Asset): { ok: boolean; problem: string; edit: boolean } | null {
  const c = a.meta?.check as { ok?: unknown; problem?: unknown; edit?: { ok?: unknown } | null } | null | undefined;
  if (typeof c?.ok !== 'boolean') return null;
  const edit = c.edit?.ok === false;
  // the check's finding in the cards' words (a saved one may say 누끼)
  return { ok: c.ok, problem: typeof c.problem === 'string' ? plainLine(c.problem) : '', edit };
}

/** Right-side drawer: every version of one IP's picture with its check, a before/after slider against the one in
 * use, and 이 버전 쓰기 (a version that failed its check says so once it is in use). On <body>: it covers the whole
 * studio, and the pane tells the shell while it is open (IpPane onModal), so the page behind is inert. */
export function VersionDrawer({ ip, images, jobs, onClose, onRestore, onReroll, onEdit }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose);
  const current = images.find((a) => a.assetId === ip.imageAssetId) ?? images.at(-1);
  const others = images.filter((a) => a.assetId !== current?.assetId);
  const [picked, setPicked] = useState(others.at(-1)?.assetId ?? current?.assetId);
  const [split, setSplit] = useState(50);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = images.find((a) => a.assetId === picked) ?? current;
  const comparing = current && selected && selected.assetId !== current.assetId;
  // using a picture that failed its check is allowed (it may still be the best one), but never silently
  const restore = async (a: Asset) => {
    setNotice(null);
    await onRestore(a.assetId);
    const check = checkOf(a);
    if (check && !check.ok) {
      const n = versionOf(a);
      setNotice(`${check.edit ? t('수정 검사에 실패한 v{n} 버전을 지금 그림으로 쓰고 있어요', { n }) : t('구도 검사에 실패한 v{n} 버전을 지금 그림으로 쓰고 있어요', { n })}${
        check.problem ? `${lang === 'en' ? ' ' : ''}(${check.problem})` : ''}. `
        + (check.edit ? t('요청하지 않은 곳도 바뀐 그림일 수 있으니 다시 뽑거나 바꿀 점을 좁혀 다시 수정해 보세요.')
          : t('3D도 이 모양대로 나오니 다시 뽑기를 권해요.')));
    }
  };

  // where the IP's 3D button is: on its card, or under ⋯ once it has a model (a whole scene's says 입체 판)
  const button = ip.usage === 'background' ? t('입체 판으로 만들기') : t('3D로 만들기');
  const make3d = ip.glbAssetId ? t('카드의 ⋯ 메뉴에서 ‘{button}’', { button }) : t('카드의 ‘{button}’', { button });
  const failedName = (edit: boolean) => (edit ? t('수정 검사 실패') : t('구도 검사 실패'));
  return createPortal(
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} />
      <div ref={panel} className="drawer" role="dialog" aria-modal="true" aria-labelledby="versions-title" aria-describedby="versions-intro">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">VERSIONS</p>
            <h2 id="versions-title">{t('{name} 버전 기록', { name: ip.name })}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        <div className="dialog-body">
          <p id="versions-intro" className="dialog-lead muted">{t('버전을 골라 지금 그림과 비교해 보세요. 쓰고 싶은 버전은 ‘이 버전 쓰기’로 지금 그림이 돼요.')}</p>
          {!images.length && <p className="empty">{t('아직 저장된 그림이 없어요.')}</p>}
          {current && (
            <figure className="compare">
              <div className="media media-16x9 media--image compare-stage">
                <img src={current.url} alt={t('지금 그림 v{n}', { n: versionOf(current) })} />
                {comparing && (
                  <img src={selected.url} alt={t('비교 v{n}', { n: versionOf(selected) })} className="compare-top" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
                )}
                {comparing && <span className="compare-line" style={{ left: `${split}%` }} aria-hidden="true" />}
                {comparing && <span className="compare-tag compare-tag--left">v{versionOf(selected)}</span>}
                <span className="compare-tag compare-tag--right">{t('지금 v{n}', { n: versionOf(current) })}</span>
              </div>
              {comparing && (
                <label className="compare-range">
                  <span className="sr-only">{t('비교 위치')}</span>
                  <input type="range" min={0} max={100} value={split} aria-valuetext={t('비교 그림 {picked}%, 지금 그림 {now}%', { picked: split, now: 100 - split })} onChange={(e) => setSplit(e.target.valueAsNumber)} />
                </label>
              )}
            </figure>
          )}
          <div className="row">
            <ActionButton className="btn btn-sm btn-edit" label={t('다시 뽑기')} busyLabel={t('요청 중…')} doneLabel={t('뽑는 중')} run={onReroll}
              ariaLabel={t('{name} 같은 요청으로 다시 뽑기', { name: ip.name })} />
            <button type="button" className="btn btn-sm" onClick={onEdit}>{t('수정하기')}</button>
          </div>
          <ol className="version-list" aria-label={t('버전 목록')}>
            {[...images].reverse().map((a) => {
              const isCurrent = a.assetId === current?.assetId;
              const check = checkOf(a);
              const failed = check?.ok === false;
              return (
                <li key={a.assetId} className={a.assetId === picked ? 'version-item is-picked' : 'version-item'}>
                  <button type="button" className="version-pick" aria-pressed={a.assetId === picked} onClick={() => setPicked(a.assetId)}>
                    <img src={a.url} alt="" width={72} height={40} loading="lazy" />
                    <span>
                      <strong>v{versionOf(a)}{isCurrent && <em> · {t('지금 그림')}</em>}</strong>
                      <small>{[assetModelLabel(a, jobs), fmtTime(a.createdAt)].filter(Boolean).join(' · ')}</small>
                      {check && (
                        <small className={failed ? 'version-check is-failed' : 'version-check'}>
                          {failed ? `${failedName(check.edit)}${check.problem ? `: ${check.problem}` : ''}` : t('구도 검사 통과')}
                        </small>
                      )}
                    </span>
                  </button>
                  {!isCurrent && (
                    <ActionButton className="btn btn-sm" label={t('이 버전 쓰기')} busyLabel={t('바꾸는 중…')} doneLabel={t('바꿨어요')}
                      run={() => restore(a)} ariaLabel={`${t('v{n} 버전 쓰기', { n: versionOf(a) })}${failed ? ` (${failedName(!!check?.edit)})` : ''}`} />
                  )}
                </li>
              );
            })}
          </ol>
          {notice && <p className="notice" role="alert">{notice}</p>}
          <p className="muted dialog-lead versions-note">{t('버전을 바꿔도 다른 버전은 지워지지 않아요. 3D와 게임은 이미 만든 결과를 그대로 쓰니, 바뀐 그림으로 다시 만들려면 {where}를 누르세요.', { where: make3d })}</p>
        </div>
        <div className="dialog-footer">
          <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>{t('닫기')}</button></div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
