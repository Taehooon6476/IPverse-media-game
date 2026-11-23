import { useRef, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { addConnection, removeConnection, updateConnection, type Connection, type Connections } from '../api';
import { errorText } from '../types';
import { ActionButton } from './ActionButton';
import { ConfirmDialog } from './ConfirmDialog';
import { useDialog } from './useDialog';

interface Props {
  connections: Connections | null;
  /** Open with the add form focused. */
  adding?: boolean;
  onChange: (next: Connections) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => void;
  onNotify?: (text: string, action?: { label: string; run: () => void }) => void;
}

export const STATUS: Record<Connection['status'], string> = { connected: t('연결됨'), error: t('연결 실패'), off: t('꺼짐'), unknown: t('확인 중') };

/** The studio's own services in the studio's words; a row this list does not know keeps the server's name. */
const PLAIN: Record<string, string> = { imagegen: t('이미지 생성'), videogen: t('영상 생성'), 'bedrock-agent': t('채팅 AI'), 'bedrock-image': t('이미지 보정 · 배경 제거'),
  'bedrock-pegasus': t('라이브 하이라이트'), deadline: t('3D 렌더'), live: t('라이브 방송 · 광고') };
const SERVICE_WORDS = /Amazon|AWS|Bedrock|MCP|IVS|Deadline|MediaTailor|GameLift/;
/** ... for this drawer's rows and the sidebar's 연결 서비스 fold, which lists the same ones. */
export const plainName = (c: Connection) => (Object.hasOwn(PLAIN, c.id) ? PLAIN[c.id] : c.name);

/** What the studio is connected to (its own services, checked live) and the user's own MCP servers: add, turn on or
 * off for the chat AI, refresh, remove. Names and states only: addresses, ids and tool names are never rendered. */
export function ConnectionsDrawer({ connections, adding, onChange, onRefresh, onClose, onError, onNotify }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose, adding ? '#conn-name' : undefined);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const list = connections ?? { platform: [], servers: [] };
  const replace = (s: Connection) => onChange({ ...list, servers: list.servers.map((x) => (x.id === s.id ? s : x)) });

  // A delete asks first and is done on the server before the row goes. The auth value lives on the server alone, so
  // a deleted connection cannot be put back from here: no undo is offered.
  async function remove(c: Connection) {
    setDeleting(null);
    try {
      await removeConnection(c.id);
      onChange({ ...list, servers: list.servers.filter((x) => x.id !== c.id) });
      onNotify?.(t('{name} 연결을 삭제했어요.', { name: c.name }));
    } catch (e) {
      onError(e);
    }
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setFormError(null);
    try {
      const s = await addConnection({ name: String(f.get('name')).trim(), url: String(f.get('url')).trim(),
        authHeader: String(f.get('authHeader') || 'authorization'), authValue: String(f.get('authValue') || '') });
      onChange({ ...list, servers: [...list.servers, s] });
      form.reset();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const row = (c: Connection, mine: boolean) => {
    const name = mine ? c.name : plainName(c);
    return (
      <li key={c.id} className="conn-row">
        <div className="conn-row-head">
          <span className={`conn-dot conn-dot--${c.status}`} aria-hidden="true" />
          <strong title={name !== c.name && SERVICE_WORDS.test(c.name) ? c.name : undefined}>{name}</strong>
          <span className={`conn-status conn-status--${c.status}`}>{STATUS[c.status]}</span>
        </div>
        {mine && c.toolCount != null && <p className="conn-count">{t('도구 {n}개', { n: c.toolCount })}</p>}
        {/* a service of the studio that fails is nothing the user can fix: said plainly, without the provider's error */}
        {c.status === 'error' && !mine && <p className="conn-error">{t('지금 연결할 수 없어요. 잠시 뒤 ‘상태 새로고침’을 눌러 보세요.')}</p>}
        {mine && c.error && <p className="conn-error">{errorText(c.error)}</p>}
        {mine && (
          <div className="conn-actions">
            <label className="switch">
              <input type="checkbox" checked={!!c.enabled}
                aria-label={t('{name} 채팅 AI가 사용', { name: c.name })}
                onChange={(e) => void updateConnection(c.id, { enabled: e.target.checked }).then(replace, onError)} />
              <span>{t('채팅 AI가 사용')}</span>
            </label>
            <ActionButton className="btn btn-sm btn-ghost" label={t('다시 확인')} busyLabel={t('확인 중…')} doneLabel={t('확인함')}
              run={() => updateConnection(c.id, { refresh: true }).then(replace, (e) => { onError(e); throw e; })} />
            <button type="button" className="btn btn-sm btn-ghost conn-remove" aria-label={t('{name} 연결 삭제', { name: c.name })} onClick={() => setDeleting(c)}>{t('삭제')}</button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} />
      <div ref={panel} className="drawer drawer--conn" role="dialog" aria-modal="true" aria-labelledby="conn-title" aria-describedby="conn-intro">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">SETTINGS · CONNECTIONS</p>
            <h2 id="conn-title">{t('연결 설정')}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        <div className="dialog-body">
          <p id="conn-intro" className="dialog-lead muted">{t('스튜디오가 쓰는 서비스의 연결 상태예요. 모두 ‘연결됨’이면 할 일이 없어요. 아래에서 채팅 AI가 쓸 MCP 서버를 직접 추가할 수도 있어요.')}</p>
          <section aria-labelledby="conn-platform">
            <div className="conn-section-head">
              <h3 id="conn-platform" className="conn-h">{t('스튜디오 서비스')} <small>{list.platform.length}</small></h3>
              <ActionButton className="btn btn-sm btn-ghost" label={t('상태 새로고침')} busyLabel={t('확인 중…')} doneLabel={t('갱신됨')} run={onRefresh} />
            </div>
            <ul className="conn-list">{list.platform.map((c) => row(c, false))}</ul>
            {!connections && <p className="field-hint" role="status">{t('연결 정보를 불러오고 있어요.')}</p>}
          </section>
          <section aria-labelledby="conn-mine">
            <h3 id="conn-mine" className="conn-h">{t('내 MCP 서버')} <small>{list.servers.length}</small></h3>
            {list.servers.length ? <ul className="conn-list">{list.servers.map((c) => row(c, true))}</ul>
              : <p className="muted">{t('아직 없어요. 아래에서 MCP 서버를 추가하면 채팅 AI가 그 도구를 쓸 수 있어요.')}</p>}
          </section>
          <form className="conn-form" onSubmit={add} aria-labelledby="conn-add" aria-busy={busy}>
            <h3 id="conn-add" className="conn-h">{t('MCP 서버 추가')}</h3>
            <label className="field">
              <span>{t('이름')}</span>
              <input id="conn-name" name="name" required maxLength={40} placeholder={t('예: 내 노트 MCP')} />
            </label>
            <label className="field">
              <span>{t('MCP 서버 주소')}</span>
              <input name="url" type="url" required pattern="https://.+" title={t('https:// 로 시작하는 주소만 연결할 수 있어요')} aria-describedby="conn-url-hint" placeholder="https://example.com/mcp" />
              <small id="conn-url-hint" className="field-hint">{t('HTTPS 주소의 Streamable HTTP MCP 서버를 연결할 수 있어요.')}</small>
            </label>
            <div className="conn-auth">
              <label className="field">
                <span>{t('인증 헤더')}</span>
                <input name="authHeader" placeholder="authorization" pattern="[A-Za-z0-9\-]{1,40}" />
              </label>
              <label className="field">
                <span>{t('인증 값')} <small className="muted">{t('(선택)')}</small></span>
                <input name="authValue" type="password" autoComplete="off" aria-describedby="conn-auth-hint" placeholder="Bearer …" />
              </label>
            </div>
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('연결 확인 중…') : t('연결하고 도구 읽기')}</button>
            <p id="conn-auth-hint" className="muted field-hint">{t('추가할 때 연결과 도구 목록을 확인해요. 주소와 인증 값은 서버에만 저장되고 다시 보여 주지 않아요.')}</p>
          </form>
        </div>
        <div className="dialog-footer">
          <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>{t('닫기')}</button></div>
        </div>
      </div>
      {deleting && (
        <ConfirmDialog title={t('{name} 연결을 삭제할까요?', { name: deleting.name })} confirmLabel={t('삭제')} danger
          message={t('삭제하면 채팅 AI가 이 서버의 도구를 쓸 수 없어요. 되돌릴 수 없고, 다시 쓰려면 주소와 인증 값을 새로 넣어 추가해야 해요.')}
          onConfirm={() => void remove(deleting)} onCancel={() => setDeleting(null)} />
      )}
    </div>
  );
}
