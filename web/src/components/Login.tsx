import { LangToggle } from './LangToggle';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { ApiError, errorMessage, signup } from '../api';
import { t } from '../i18n';

interface Props {
  /** Shown above the form, e.g. after a 401. */
  notice: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
  /** 데모 로그인: straight into the shared demo account, nothing to type. */
  onDemo: () => Promise<void>;
}

const MODES = [{ id: 'login', label: t('로그인') }, { id: 'signup', label: t('회원가입') }] as const;
type Mode = (typeof MODES)[number]['id'];
type Field = 'username' | 'password' | 'confirm';

// The sign-up rules, as the server checks them (server/app.py signup: USERNAME, 12–128 characters, and the user
// pool's policy of an upper-case and a lower-case letter, a digit and a symbol).
const ID_RULE = /^[A-Za-z0-9_.-]{3,32}$/;
const PASSWORD_RULES: { label: string; ok: (p: string) => boolean }[] = [
  { label: t('12자 이상'), ok: (p) => p.length >= 12 },
  { label: t('영문 대문자'), ok: (p) => /[A-Z]/.test(p) },
  { label: t('영문 소문자'), ok: (p) => /[a-z]/.test(p) },
  { label: t('숫자'), ok: (p) => /[0-9]/.test(p) },
  { label: t('특수문자'), ok: (p) => /[^A-Za-z0-9\s]/.test(p) },
];

/** What is wrong with what was typed, by field; empty when it can be sent. Said on the page, next to the field,
 * before the server has to refuse it. */
export function formProblems(mode: Mode, username: string, password: string, confirm: string): Partial<Record<Field, string>> {
  const problems: Partial<Record<Field, string>> = {};
  if (!username) problems.username = t('아이디를 입력해 주세요.');
  else if (mode === 'signup' && !ID_RULE.test(username)) {
    problems.username = t('아이디는 영문, 숫자, 밑줄(_), 마침표(.), 붙임표(-)만 써서 3–32자로 정해 주세요.');
  }
  if (!password) problems.password = t('비밀번호를 입력해 주세요.');
  else if (mode === 'signup') {
    const missing = PASSWORD_RULES.filter((r) => !r.ok(password)).map((r) => r.label);
    if (password.length > 128) problems.password = t('비밀번호는 128자까지 쓸 수 있어요.');
    else if (missing.length) problems.password = t('비밀번호에 빠진 것이 있어요: {missing}.', { missing: missing.join(', ') });
  }
  if (mode === 'signup' && !problems.password && password !== confirm) problems.confirm = t('비밀번호가 서로 달라요. 한 번 더 확인해 주세요.');
  return problems;
}

/** 로그인 | 회원가입 tabs. Sign-up makes the account at once (no e-mail step) and logs in with it. */
export function Login({ notice, onLogin, onDemo }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState<null | 'form' | 'demo'>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Partial<Record<Field, string>>>({});
  const [password, setPassword] = useState(''); // for the rule marks under the field while it is typed

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const username = String(form.get('username') ?? '').trim();
    const typed = String(form.get('password') ?? '');
    const found = formProblems(mode, username, typed, String(form.get('confirm') ?? ''));
    setProblems(found);
    setError(null);
    const first = (['username', 'password', 'confirm'] as const).find((f) => found[f]);
    if (first) {
      e.currentTarget.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
      return;
    }
    const idField = e.currentTarget.querySelector<HTMLInputElement>('[name="username"]');
    setBusy('form');
    try {
      if (mode === 'signup') await signup(username, typed);
      await onLogin(username, typed);
    } catch (err) {
      // An id that is taken (409) is the id field's to fix: said there, as a whole sentence, and the caret goes there.
      if (mode === 'signup' && err instanceof ApiError && err.status === 409) {
        setProblems({ username: /[.!?]$/.test(err.message.trim()) ? err.message.trim() : `${err.message.trim()}.` });
        idField?.focus();
      } else setError(errorMessage(err));
      setBusy(null);
    }
  }
  async function demo() {
    setBusy('demo');
    setError(null);
    try {
      await onDemo();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }
  const switchTo = (m: Mode) => { setMode(m); setError(null); setProblems({}); };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = mode === 'login' ? 'signup' : 'login';
    switchTo(next);
    document.getElementById(`auth-tab-${next}`)?.focus();
  };
  const signingUp = mode === 'signup';
  /** A field's hint and problem ids, for aria-describedby. */
  const describe = (field: Field, hint?: string) => [hint, problems[field] && `login-${field}-error`].filter(Boolean).join(' ') || undefined;
  const problem = (field: Field) => problems[field] && <small id={`login-${field}-error`} className="form-error" role="alert">{problems[field]}</small>;

  return (
    <main id="main" className="login">
      <section className="login-visual" aria-hidden="true">
        <div className="brand brand--lg">
          <span className="brand-mark" />
          <span className="brand-name">
            <strong>IPverse<span className="brand-dot">.</span></strong>
            <small>IP STUDIO</small>
          </span>
        </div>
        <div className="orbit">
          <span className="ring ring--a" />
          <span className="ring ring--b" />
          <svg className="cube" width="84" height="84" viewBox="0 0 84 84"><path d="M42 10 70 25v34L42 74 14 59V25Z M14 25l28 15 28-15 M42 40v34" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" /></svg>
        </div>
        <div className="login-copy">
          <p className="eyebrow">ONE IDEA. INFINITE WORLDS.</p>
          <p className="login-headline">{t('당신의 아이디어,')}<br /><em>{t('하나의 세계가 되다.')}</em></p>
          <p className="muted">{t('캐릭터에서 시네마틱, 플레이 가능한 게임까지.')}<br />{t('하나의 IP로 만들고 함께 연결하세요.')}</p>
          <ul className="login-tags">
            <li>{t('캐릭터')}</li>
            <li>{t('영상')}</li>
            <li>{t('게임')}</li>
          </ul>
        </div>
      </section>
      <section className="login-side">
        <LangToggle />
        {/* noValidate: what is wrong is said on the page next to its field, not in the browser's bubble */}
        <form className="login-card" onSubmit={submit} aria-busy={busy !== null} noValidate>
          <div>
            <p className="eyebrow eyebrow--orange">WELCOME TO IPVERSE</p>
            <h1>{t('새로운 세계를 시작하세요')}</h1>
            {/* what this is, in one line, where the picture beside the form is not shown either (under 900 px);
                IP is said once */}
            <p className="login-what">{t('아이디어 한 줄로 캐릭터·소품 그림, 3D, 영상, 게임, 라이브 방송까지 만드는 스튜디오예요. 여기서 만든 캐릭터·소품을 IP라고 불러요.')}</p>
            <p className="muted">{signingUp ? t('계정을 만들고 나만의 작업 공간을 시작하세요.') : t('저장한 IP와 게임을 이어서 만들어 보세요.')}</p>
          </div>
          {notice && <p className="notice" role="alert">{notice}</p>}
          <div className="auth-tabs" role="tablist" aria-label={t('로그인 또는 회원가입')}>
            {MODES.map((m) => (
              <button key={m.id} id={`auth-tab-${m.id}`} type="button" role="tab" aria-selected={mode === m.id}
                aria-controls="auth-panel" tabIndex={mode === m.id ? 0 : -1} className="auth-tab"
                onClick={() => switchTo(m.id)} onKeyDown={onTabKey}>
                {m.label}
              </button>
            ))}
          </div>
          <div id="auth-panel" role="tabpanel" aria-labelledby={`auth-tab-${mode}`} className="auth-panel">
            {/* label and field are siblings: a hint inside the label would be read as part of the field's name */}
            <div className="field">
              <label htmlFor="login-username">{t('아이디')}</label>
              <input id="login-username" name="username" autoComplete="username" required autoFocus maxLength={signingUp ? 32 : undefined}
                autoCapitalize="none" spellCheck={false} placeholder={signingUp ? t('예: luna_studio') : t('아이디 입력')}
                aria-invalid={problems.username ? true : undefined} aria-describedby={describe('username', signingUp ? 'login-id-hint' : undefined)} />
              {/* the rule stays under the field while it is typed */}
              {signingUp && <small id="login-id-hint" className="field-hint">{t('영문, 숫자, 밑줄(_), 마침표(.), 붙임표(-)로 3–32자')}</small>}
              {problem('username')}
            </div>
            <div className="field">
              <label htmlFor="login-password">{t('비밀번호')}</label>
              <input id="login-password" name="password" type="password" autoComplete={signingUp ? 'new-password' : 'current-password'} required
                placeholder={signingUp ? t('12자 이상') : t('비밀번호 입력')} onChange={(e) => setPassword(e.target.value)}
                aria-invalid={problems.password ? true : undefined} aria-describedby={describe('password', signingUp ? 'login-pw-hint' : undefined)} />
              {signingUp && (
                <>
                  <small id="login-pw-hint" className="sr-only">{t('12자 이상이고 영문 대문자, 영문 소문자, 숫자, 특수문자가 모두 들어가야 해요. 비밀번호는 다시 찾을 수 없어요.')}</small>
                  {/* the same rules to look at: each lights up as the password meets it */}
                  <ul className="pw-rules" aria-hidden="true">
                    {PASSWORD_RULES.map((r) => <li key={r.label} className={r.ok(password) ? 'is-met' : undefined}>{r.label}</li>)}
                  </ul>
                  <small className="field-hint" aria-hidden="true">{t('비밀번호는 다시 찾을 수 없으니 잘 적어 두세요.')}</small>
                </>
              )}
              {problem('password')}
            </div>
            {signingUp && (
              <div className="field">
                <label htmlFor="login-confirm">{t('비밀번호 확인')}</label>
                <input id="login-confirm" name="confirm" type="password" autoComplete="new-password" required placeholder={t('한 번 더 입력')}
                  aria-invalid={problems.confirm ? true : undefined} aria-describedby={describe('confirm')} />
                {problem('confirm')}
              </div>
            )}
          </div>
          {error && <p id="login-error" className="form-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy !== null}>
            {busy === 'form' ? (signingUp ? t('가입하는 중…') : t('로그인 중…')) : signingUp ? t('가입하고 시작하기') : t('로그인')}
          </button>
          {busy === 'form' && <p className="hint login-progress" role="status">{signingUp ? t('계정을 만든 뒤 작업 공간을 열고 있어요.') : t('작업 공간을 열고 있어요.')}</p>}
          {import.meta.env.VITE_MOCK === '1' && <p className="hint">{t('목업 모드: 아무 아이디와 비밀번호로 로그인돼요.')}</p>}
          {!signingUp && (
            <p className="hint login-foot">{t('처음이세요?')} <button type="button" className="link-btn" onClick={() => switchTo('signup')}>{t('회원가입')}</button>{t('으로 시작하세요.')}</p>
          )}
          {/* 데모 로그인 says what it is before it is pressed: one account shared by every visitor */}
          <div className="login-demo">
            <button type="button" className="btn btn-block" onClick={demo} disabled={busy !== null} aria-describedby="login-demo-hint">
              {busy === 'demo' ? t('데모 계정으로 들어가는 중…') : t('데모 로그인')}
            </button>
            <p id="login-demo-hint" className="hint">{t('가입 없이 둘러볼 수 있어요. 여러 사람이 함께 쓰는 공용 계정이라, 다른 사람이 만든 세션이 함께 보이고 내가 만든 것도 다른 사람에게 보여요.')}</p>
          </div>
        </form>
      </section>
    </main>
  );
}
