import { LangToggle } from './LangToggle';
import { useEffect, useState, type MouseEvent } from 'react';
import { t } from '../i18n';
import type { Job, Session } from '../types';
import { ActionMenu } from './ActionMenu';
import { CHAT_BOX_EVENT } from './ChatDock';
import { JobsMenu } from './JobsMenu';

interface Props {
  session: Session | null;
  /** Queued + running jobs: the status pill lists them (with 중지), or shows "자동 저장됨" when idle. */
  activeJobs: { job: Job; name?: string }[];
  onCancelJob: (jobId: string) => Promise<void>;
  navOpen: boolean;
  onMenu: () => void;
  onPublish: () => void;
  onLogout: () => void;
  /** Open the connection settings drawer (account menu). */
  onConnections: () => void;
  /** Who is signed in (auth.ts account): the id typed at the login, or the shared demo account. */
  account?: { user: string | null; demo: boolean } | null;
  /** The open session stopped answering: said in place of 자동 저장됨 until a poll gets through. */
  offline?: boolean;
  /** Back to the start screen (the logo and the first crumb). */
  onHome?: () => void;
  /** A session is open, so the chat's message box is on the page (the second skip link goes there). */
  chat?: boolean;
}

export function TopBar({ session, activeJobs, onCancelJob, navOpen, onMenu, onPublish, onLogout, onConnections, account, offline, onHome, chat }: Props) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  // somewhere to go back from: a session is open, or its address is (one that did not load)
  const away = !!onHome && (!!session || !!chat);
  const home = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // a new tab or window opens the start screen
    e.preventDefault();
    onHome?.();
  };
  const who = account?.demo ? t('데모 계정') : account?.user ?? null;
  const signedIn = account?.demo ? t('공용 데모 계정으로 로그인 중') : account?.user ? t('{user} 님으로 로그인 중', { user: account.user }) : null;

  return (
    <>
      {/* First elements in the DOM. Focus instead of navigating, so the #ip/#game hash state survives. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        {t('작업 공간으로 바로 가기')}
      </a>
      {/* the chat is the last part of the page (under the panes, or the column right of them): one step to its box */}
      {chat && (
        <a
          className="skip-link"
          href="#composer"
          onClick={(e) => {
            e.preventDefault();
            // the chat opens first when it is folded (or the phone's drawer is shut): its box is not shown then
            window.dispatchEvent(new Event(CHAT_BOX_EVENT));
            document.getElementById('composer')?.focus();
          }}
        >
          {t('채팅 입력으로 바로 가기')}
        </a>
      )}
      <header className={scrolled ? 'topbar is-scrolled' : 'topbar'}>
        <button type="button" className="icon-btn menu-btn" aria-label={t('메뉴 열기')} aria-expanded={navOpen} aria-controls="sidebar" onClick={onMenu}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
        {/* With a session open the logo goes to the start screen, at every width (a phone shows no crumb). */}
        {away ? <a className="topbar-logo" href="#" title={t('시작 화면으로')} onClick={home}><span className="brand-mark" aria-hidden="true" />IPverse</a>
          : <span className="topbar-logo"><span className="brand-mark" aria-hidden="true" />IPverse</span>}
        <nav className="breadcrumb" aria-label={t('현재 위치')}>
          {/* 작업 공간 = the studio and its start screen; a session is one project in it */}
          {away ? <a className="breadcrumb-home" href="#" title={t('시작 화면으로')} onClick={home}>{t('작업 공간')}</a> : <span>{t('작업 공간')}</span>}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {/* cut at its width: the whole name on hover */}
          <h1 className="topbar-title" aria-current="page" title={session?.title}>{session?.title ?? t('시작')}</h1>
        </nav>
        {/* outside .topbar-actions: the only per-job stop must stay reachable on phones too */}
        {session && (
          <span className="topbar-jobs">
            {/* in place of 자동 저장됨 while the session does not answer */}
            {offline && <span className="status-pill is-offline" role="status"><span className="status-dot" aria-hidden="true" />{t('연결 끊김 · 다시 연결 중')}</span>}
            {(!offline || activeJobs.length > 0) && <JobsMenu jobs={activeJobs} onCancel={onCancelJob} />}
          </span>
        )}
        <LangToggle />
        <div className="topbar-actions">
          <button type="button" className="btn btn-outline" onClick={onPublish} disabled={!session}
            title={session ? t('게임과 광고 영상을 연결해 게시해요.') : t('세션을 열면 게시할 수 있어요.')}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 13 3m0 0H6m7 0v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {t('게시하기')}
          </button>
          {/* The trigger names who is signed in; without a name (older saved tokens) it reads 계정. Phones use the
              sidebar foot. */}
          <ActionMenu label={who ? t('계정: {who}', { who }) : t('계정')} className="btn btn-ghost menu-trigger topbar-account"
            items={[...(signedIn ? [{ label: signedIn, disabled: true, hint: account?.demo ? t('다른 사람이 만든 세션이 함께 보여요') : undefined }] : []),
              { label: t('연결 설정'), onSelect: onConnections }, { label: t('로그아웃'), onSelect: onLogout }]}>
            <span className="topbar-account-name">{who ?? t('계정')}</span>
            <svg className="topbar-account-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </ActionMenu>
        </div>
      </header>
    </>
  );
}
