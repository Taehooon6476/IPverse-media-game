import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Connections } from '../api';
import { t, tn } from '../i18n';
import { SKILLS } from '../skills';
import { fmtTime, type SessionSummary } from '../types';
import { STATUS, plainName } from './ConnectionsDrawer';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { Fold } from './Fold';

interface Props {
  /** null while the list loads, or (with sessionsError) when it did not load. */
  sessions: SessionSummary[] | null;
  /** Why the list did not load; the list then says so with 다시 시도. */
  sessionsError?: string | null;
  onRetrySessions?: () => void;
  /** Why the connections did not load (connections is null then); the fold then says so with 다시 시도. */
  connectionsError?: string | null;
  onRetryConnections?: () => void;
  /** Who is signed in (auth.ts account), for the phone drawer's foot: phones have no account menu. */
  account?: { user: string | null; demo: boolean } | null;
  currentId: string | null;
  /** Drawer state on tablet and mobile. */
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  /** Back to the start screen: a row of its own while a session is open (phones have no crumb in the top bar). */
  onHome?: () => void;
  /** Resolves false when creation failed; the form then stays open with the typed title. */
  onCreate: (title: string) => Promise<boolean>;
  onPublish: () => void;
  onLogout: () => void;
  connections: Connections | null;
  /** Open the connection settings drawer (adding: with the add-server form focused). */
  onConnections: (adding: boolean) => void;
  /** Open the genre skills drawer (only with a session open). */
  onSkills?: () => void;
  /** Delete a session (after the confirm dialog); rejects with the server's reason to show in the dialog. */
  onDelete?: (id: string) => Promise<void>;
  /** Rename a session from its row (the open one or any other); rejects with the reason, which the row's field shows. */
  onRename?: (id: string, title: string) => Promise<void>;
  /** The Agent part under the skills (AgentList), and how many agents it lists (the fold's count). */
  agents?: ReactNode;
  agentCount?: number;
}

// Accordions, closed by default so the session list keeps the room; the connection header still shows the count and any error
const WORK_OPEN_KEY = 'ipverse.workOpen';
const CONN_OPEN_KEY = 'ipverse.connOpen';
/** From this many sessions the list has a box to find one by name. */
const FILTER_FROM = 9;
const NAME_MAX = 60; // as the new-session form's field

export function Sidebar({ sessions, sessionsError, onRetrySessions, connectionsError, onRetryConnections, account, currentId, open, onClose, onSelect, onHome,
  onCreate, onPublish, onLogout, connections, onConnections, onSkills, onDelete, onRename, agents, agentCount = 0 }: Props) {
  const all = connections ? [...connections.platform, ...connections.servers] : [];
  const ok = all.filter((c) => c.status === 'connected').length;
  const failing = all.filter((c) => c.status === 'error').length;
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [query, setQuery] = useState('');
  const list = sessions ?? [];
  const finding = list.length >= FILTER_FROM;
  const asked = finding ? query.trim().toLowerCase() : '';
  const found = asked ? list.filter((s) => s.title.toLowerCase().includes(asked)) : list;
  const newSessionButton = useRef<HTMLButtonElement>(null);
  const closeNavigation = useRef(onClose);
  // The row whose name is being changed in place: ✎ turns its link into a field (60 characters, with a count), Enter
  // or 저장 saves, Esc or 취소 leaves it.
  const [renaming, setRenaming] = useState<{ id: string; value: string; busy: boolean; error: string | null } | null>(null);
  const renamed = useRef<string | null>(null);
  const navigation = useRef<HTMLDivElement>(null);
  useEffect(() => { // back on the row's ✎ once the field is gone, so the keyboard stays where it was
    if (renaming) { renamed.current = renaming.id; return; }
    const id = renamed.current;
    renamed.current = null;
    if (id) [...navigation.current?.querySelectorAll<HTMLElement>('.session-rename') ?? []].find((b) => b.dataset.session === id)?.focus();
  }, [renaming]);
  async function saveName(e: FormEvent, session: SessionSummary) {
    e.preventDefault();
    const next = renaming?.value.trim();
    if (!renaming || renaming.busy || !next) return;
    if (next === session.title || !onRename) { setRenaming(null); return; }
    setRenaming({ ...renaming, busy: true, error: null });
    try {
      await onRename(session.sessionId, next);
      setRenaming(null);
    } catch (err) {
      setRenaming((r) => r && { ...r, busy: false, error: err instanceof Error && err.message ? err.message : t('이름을 바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요.') });
    }
  }

  useEffect(() => { closeNavigation.current = onClose; }, [onClose]);

  useEffect(() => {
    // where the sidebar is the ☰ drawer (origin.css): under 1680 px
    const narrowScreen = window.matchMedia('(max-width: 1679.98px)');
    if (!open || !narrowScreen.matches) return;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const opener = document.querySelector<HTMLElement>('[aria-controls="sidebar"]');
    const focusable = () => Array.from(sidebar.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
      && !element.closest('[inert]')); // rows in a folded section cannot take focus
    focusable()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || sidebar.closest('[inert]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeNavigation.current();
      } else if (e.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements.at(-1);
        const outside = !sidebar.contains(document.activeElement);
        if ((e.shiftKey && (outside || document.activeElement === first)) || (!e.shiftKey && (outside || document.activeElement === last))) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }
    };
    const onScreenChange = () => { if (!narrowScreen.matches) closeNavigation.current(); };
    document.addEventListener('keydown', onKey);
    narrowScreen.addEventListener('change', onScreenChange);
    return () => {
      document.removeEventListener('keydown', onKey);
      narrowScreen.removeEventListener('change', onScreenChange);
      if (sidebar.contains(document.activeElement) && opener?.isConnected && opener.getClientRects().length > 0
        && !opener.closest('[inert]')) opener.focus();
    };
  }, [open]);

  function cancelCreate() {
    setCreating(false);
    newSessionButton.current?.focus();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const created = await onCreate(title.trim());
    setBusy(false);
    if (!created) return;
    setCreating(false);
    setTitle('');
  }

  return (
    <>
      <div ref={navigation} id="sidebar" className={open ? 'sidebar is-open' : 'sidebar'}
        role={open ? 'dialog' : undefined} aria-modal={open ? true : undefined} aria-label={open ? t('작업 공간 메뉴') : undefined}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">
            <strong>IPverse<span className="brand-dot">.</span></strong>
            <small>IP STUDIO</small>
          </span>
        </div>
        <nav aria-label={t('세션 목록')}>
          <button
            ref={newSessionButton}
            type="button"
            className="new-session"
            title={t('새 세션')}
            aria-expanded={creating}
            aria-controls="new-session-form"
            onClick={() => setCreating((c) => !c)}
          >
            <span className="plus" aria-hidden="true">+</span>
            <span className="label">{t('새 세션')}</span>
          </button>
          {creating && (
            <form
              id="new-session-form"
              className="new-session-form"
              onSubmit={submit}
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
                e.stopPropagation();
                cancelCreate();
              }}
            >
              <label htmlFor="new-session-title">{t('세션 제목')}</label>
              <input
                id="new-session-title"
                autoFocus
                maxLength={60}
                value={title}
                placeholder={t('예: 우주 고양이 탐험가 루나')}
                onChange={(e) => setTitle(e.target.value)}
              />
              {/* what a session is, said once where one is made */}
              <small className="field-hint">{t('세션 하나가 작품 하나예요. 비워 두면 첫 아이디어에서 이름을 따와요.')}</small>
              <div className="row">
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? t('만드는 중…') : t('만들기')}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={cancelCreate}>{t('취소')}</button>
              </div>
            </form>
          )}
          {/* the way to the start screen from a session, where the top bar has no crumb */}
          {onHome && currentId && (
            <button type="button" className="side-nav side-home" onClick={onHome}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5 8 2.8l5.5 4.7M4 6.8v6.4h8V6.8M6.7 13.2V9.6h2.6v3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span className="label">{t('시작 화면')}</span>
            </button>
          )}
          {/* One scroller for the folds and the session list: were the list the only part that could shrink, two open
              folds would leave it no whole row. */}
          <div className="side-scroll">
          <Fold id="work-acc" storageKey={WORK_OPEN_KEY} headClassName="side-fold-head"
            title={<span className="label">{t('스킬 · 에이전트')}</span>}
            meta={<span className="label">{String(SKILLS.length + agentCount).padStart(2, '0')}</span>}>
            <div className="work-fold">
              <button type="button" className="side-nav side-nav--skills" onClick={onSkills} disabled={!onSkills}
                title={onSkills ? t('레이싱·플랫포머·던전·오픈월드 장르 스킬') : t('세션을 먼저 고르세요')}>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 9.6 6l4.4.3-3.4 2.8 1.1 4.3L8 11l-3.7 2.4 1.1-4.3L2 6.3 6.4 6 8 1.8Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                <span className="label">{t('장르 스킬')}</span>
              </button>
              {agents}
            </div>
          </Fold>
          <Fold id="conn-acc" storageKey={CONN_OPEN_KEY} headClassName="side-fold-head"
            title={<><span className={`conn-dot conn-dot--${failing ? 'error' : connections && ok === all.length ? 'connected' : 'unknown'}`} aria-hidden="true" /><span className="label">{t('연결 서비스')}</span></>}
            meta={<span className="label">{connections ? `${failing ? t('오류 {n} · ', { n: failing }) : ''}${ok}/${all.length}` : '–'}</span>}>
              <ul className="conn-mini" aria-label={t('연결된 API·MCP')}>
                {/* The studio's own services by what they do, as the 연결 설정 drawer names them (plainName), and nothing
                    beside the name; a server the user added by its own name with its tool count. */}
                {all.map((c) => {
                  const mine = !!connections?.servers.includes(c);
                  const name = mine ? c.name : plainName(c);
                  const tools = mine && c.toolCount != null ? c.toolCount : null;
                  return (
                    <li key={c.id}>
                      <button type="button" className="conn-mini-row" title={`${name} · ${STATUS[c.status]}${tools !== null ? tn(' · 도구 {n}개', tools) : ''}`}
                        onClick={() => onConnections(false)}>
                        <span className={`conn-dot conn-dot--${c.status}`} aria-hidden="true" />
                        <span className="label conn-mini-name">{name}</span>
                        <span className="label conn-mini-meta">{tools ?? ''}</span>
                        <span className="sr-only">{STATUS[c.status]}</span>
                      </button>
                    </li>
                  );
                })}
                {/* failed is not loading */}
                {!connections && (connectionsError ? (
                  <li className="load-error load-error--side label" role="alert">
                    <p>{t('연결 상태를 불러오지 못했어요.')} {connectionsError}</p>
                    {onRetryConnections && <button type="button" className="btn btn-sm" onClick={onRetryConnections}>{t('다시 시도')}</button>}
                  </li>
                ) : <li className="label sidebar-empty">{t('연결 상태 확인 중…')}</li>)}
              </ul>
              <div className="conn-mini-actions">
                <button type="button" className="side-nav conn-manage" onClick={() => onConnections(false)}>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5M5 7 3.6 8.4a2.5 2.5 0 0 0 3.5 3.5L8.5 10.5M11 9l1.4-1.4a2.5 2.5 0 0 0-3.5-3.5L7.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                  <span className="label">{t('연결 설정')}</span>
                </button>
                <button type="button" className="side-nav conn-manage" onClick={() => onConnections(true)}>
                  <span className="plus" aria-hidden="true">+</span>
                  <span className="label">{t('MCP 서버 추가')}</span>
                </button>
              </div>
          </Fold>
          <p className="side-label side-label--row label">
            <span>{t('최근 세션')}</span>
            <span>{sessions ? (asked ? `${found.length}/${list.length}` : String(list.length).padStart(2, '0')) : '–'}</span>
          </p>
          {/* three states: loading, failed with a retry, and the list */}
          {sessions === null && !sessionsError && (
            <div className="session-loading" aria-busy="true">
              <span className="sr-only" role="status">{t('세션 목록을 불러오고 있어요.')}</span>
              {[0, 1, 2].map((i) => <span key={i} className="skel session-skel" aria-hidden="true" />)}
            </div>
          )}
          {sessions === null && sessionsError && (
            <div className="load-error load-error--side label" role="alert">
              <p>{t('세션 목록을 불러오지 못했어요.')} {sessionsError}</p>
              {onRetrySessions && <button type="button" className="btn btn-sm" onClick={onRetrySessions}>{t('다시 시도')}</button>}
            </div>
          )}
          {sessions && list.length === 0 && <p className="label sidebar-empty">{t('아직 세션이 없어요. 위의 ‘새 세션’으로 시작해 보세요.')}</p>}
          {finding && (
            <div className="session-find label">
              <label htmlFor="session-find" className="sr-only">{t('세션 이름으로 찾기')}</label>
              <input id="session-find" type="search" value={query} placeholder={t('세션 이름으로 찾기')} autoComplete="off"
                onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}
          {asked && found.length === 0 && <p className="label sidebar-empty" role="status">{t('‘{query}’이(가) 들어간 세션이 없어요.', { query: query.trim() })}</p>}
          <ul className="session-list">
            {found.map((s) => (renaming?.id === s.sessionId ? (
              <li key={s.sessionId} className="session-row">
                <form className="session-rename-form" onSubmit={(e) => void saveName(e, s)} aria-busy={renaming.busy}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
                    e.stopPropagation(); // the drawer's own Esc must not close the navigation too
                    setRenaming(null);
                  }}>
                  <label htmlFor={`session-name-${s.sessionId}`} className="sr-only">{t('세션 이름')}</label>
                  <input id={`session-name-${s.sessionId}`} autoFocus maxLength={NAME_MAX} value={renaming.value} readOnly={renaming.busy}
                    aria-invalid={renaming.error ? true : undefined} onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setRenaming({ ...renaming, value: e.target.value })} />
                  {/* at the limit the count says so */}
                  <span className={renaming.value.length >= NAME_MAX ? 'session-rename-count is-full' : 'session-rename-count'} role="status"
                    aria-label={t('{n}자, 최대 {max}자', { n: renaming.value.length, max: NAME_MAX })}>
                    {renaming.value.length}/{NAME_MAX}{renaming.value.length >= NAME_MAX ? t(' · 최대 {max}자예요', { max: NAME_MAX }) : ''}
                  </span>
                  <button type="submit" className="btn btn-sm btn-primary" disabled={renaming.busy || !renaming.value.trim()}>{renaming.busy ? t('저장 중…') : t('저장')}</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)} disabled={renaming.busy}>{t('취소')}</button>
                  {renaming.error && <p className="form-error" role="alert">{renaming.error}</p>}
                </form>
              </li>
            ) : (
              <li key={s.sessionId} className={onRename ? 'session-row session-row--tools' : 'session-row'}>
                <a
                  className="session"
                  href={`#s=${encodeURIComponent(s.sessionId)}`}
                  title={s.title}
                  aria-current={s.sessionId === currentId ? 'page' : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // new tab/window: the browser follows #s=<id>
                    e.preventDefault();
                    onSelect(s.sessionId);
                  }}
                >
                  <span className="session-icon" aria-hidden="true">{Array.from(s.title)[0] ?? '·'}</span>
                  <span className="label">
                    <span className="session-title">{s.title}</span>
                    {/* when it was made, and no genre: a row cannot tell a genre that was chosen from the server's default */}
                    <span className="session-meta">{fmtTime(s.createdAt)}</span>
                  </span>
                </a>
                {onRename && (
                  <button type="button" className="session-rename" data-session={s.sessionId} aria-label={t('{title} 이름 바꾸기', { title: s.title })} title={t('이름 바꾸기')}
                    onClick={() => setRenaming({ id: s.sessionId, value: s.title, busy: false, error: null })}>
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.3 13.7 4.8 5.6 12.9 2.6 13.4 3.1 10.4Z M9.8 3.7l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
                  </button>
                )}
                {onDelete && (
                  <button type="button" className="session-delete" aria-label={t('{title} 세션 삭제', { title: s.title })} title={t('세션 삭제')}
                    onClick={() => setDeleting(s)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                )}
              </li>
            )))}
          </ul>
          </div>
        </nav>
        {/* The mobile header shows only the logo and the menu button, so its actions live here. */}
        <div className="sidebar-foot mobile-only">
          {(account?.demo || account?.user) && (
            <p className="sidebar-who">{account.demo ? t('공용 데모 계정으로 로그인 중') : t('{user} 님으로 로그인 중', { user: account.user ?? '' })}</p>
          )}
          <button type="button" className="btn btn-primary" onClick={onPublish} disabled={!currentId}>{t('게시하기')}</button>
          <button type="button" className="btn btn-ghost" onClick={onLogout}>{t('로그아웃')}</button>
        </div>
      </div>
      {open && <div className="nav-backdrop" onClick={onClose} />}
      {deleting && onDelete && <DeleteSessionDialog session={deleting} onClose={() => setDeleting(null)} onDelete={onDelete} />}
    </>
  );
}
