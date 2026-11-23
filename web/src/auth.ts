// Cognito USER_PASSWORD_AUTH / REFRESH_TOKEN_AUTH over plain fetch; tokens live in sessionStorage.
import { lang, said, t } from './i18n';
import { session } from './storage';

interface Config {
  region: string;
  userPoolId: string;
  clientId: string;
}

interface Tokens {
  access: string;
  refresh?: string;
  /** Access token expiry, epoch ms. */
  exp: number;
  /** The id typed at the login (the tokens name no one the page can show). Absent for the demo account. */
  user?: string;
  /** Logged in with 데모 로그인: the shared demo account. */
  demo?: boolean;
}

interface AuthResult {
  AccessToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
}

const KEY = 'ipverse.tokens';
const MOCK = import.meta.env.VITE_MOCK === '1';
const REFRESH_MARGIN_MS = 60_000;

/** Said when no answer came at all (offline, DNS, a blocked request): never the browser's "Failed to fetch". */
export const OFFLINE = t('서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.');

/** Said when the browser blocks this site's data: the tokens live in sessionStorage, so a login cannot be kept. */
export const NO_STORAGE = t('브라우저에서 쿠키와 사이트 데이터를 허용해야 로그인할 수 있어요.');
const PROBE = 'ipverse.probe';
/** Whether a login can be kept: the tab's storage takes a write. */
export function canKeep(): boolean {
  const ok = session.set(PROBE, '1');
  session.remove(PROBE);
  return ok;
}

let config: Promise<Config> | null = null;

function loadConfig(): Promise<Config> {
  config ??= fetch('/config.json')
    .then((r) => {
      if (!r.ok) throw new Error(`config.json ${r.status}`);
      return r.json() as Promise<Config>;
    })
    .catch(() => {
      config = null; // retry on the next attempt
      throw said(t('로그인 설정을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.'));
    });
  return config;
}

// Cognito's answers in Korean
const COGNITO_ERRORS: Record<string, string> = {
  NotAuthorizedException: t('아이디 또는 비밀번호가 맞지 않아요.'),
  UserNotFoundException: t('아이디 또는 비밀번호가 맞지 않아요.'),
  TooManyRequestsException: t('로그인 시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.'),
  LimitExceededException: t('로그인 시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.'),
  PasswordResetRequiredException: t('비밀번호를 다시 정해야 하는 계정이에요. 관리자에게 문의해 주세요.'),
  UserNotConfirmedException: t('아직 확인되지 않은 계정이에요. 관리자에게 문의해 주세요.'),
};

async function initiateAuth(flow: 'USER_PASSWORD_AUTH' | 'REFRESH_TOKEN_AUTH', params: Record<string, string>): Promise<AuthResult> {
  const { region, clientId } = await loadConfig();
  let res: Response;
  try {
    res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({ AuthFlow: flow, ClientId: clientId, AuthParameters: params }),
    });
  } catch {
    throw said(OFFLINE);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const type = String(data.__type ?? '').split('#').at(-1) ?? '';
    throw said(COGNITO_ERRORS[type] ?? t('로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요. (오류 {status})', { status: res.status }));
  }
  if (!data.AuthenticationResult) throw said(t('추가 인증이 필요한 계정이라 여기서는 로그인할 수 없어요.'));
  return data.AuthenticationResult;
}

function read(): Tokens | null {
  try {
    return JSON.parse(session.get(KEY) ?? 'null');
  } catch {
    return null;
  }
}

function save(r: AuthResult, keep: Pick<Tokens, 'refresh' | 'user' | 'demo'> = {}) {
  const tokens: Tokens = { ...keep, access: r.AccessToken, refresh: r.RefreshToken ?? keep.refresh, exp: Date.now() + r.ExpiresIn * 1000 };
  if (!session.set(KEY, JSON.stringify(tokens))) throw said(NO_STORAGE);
}

export async function login(username: string, password: string): Promise<void> {
  if (MOCK) return save({ AccessToken: 'mock-token', ExpiresIn: 8 * 3600 }, { user: username });
  save(await initiateAuth('USER_PASSWORD_AUTH', { USERNAME: username, PASSWORD: password }), { user: username });
}

/** The login screen's 데모 로그인: the server hands out the shared demo account's tokens (its password never comes here). */
export async function demoLogin(): Promise<void> {
  if (MOCK) return save({ AccessToken: 'mock-token', ExpiresIn: 8 * 3600 }, { demo: true });
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_API_BASE ?? '/api'}/demo-login`, { method: 'POST', headers: { 'X-Lang': lang } }); // not api.ts's request(): the language goes here too
  } catch {
    throw said(OFFLINE);
  }
  if (!res.ok) throw said(t('데모 계정으로 들어가지 못했어요. 잠시 뒤 다시 시도해 주세요. (오류 {status})', { status: res.status }));
  save(await res.json(), { demo: true });
}

/** Current access token, or null when logged out. */
export function token(): string | null {
  return read()?.access ?? null;
}

/** Who is signed in, for the account menu and the start screen. user: the id typed at the login; demo: the shared demo account. */
export function account(): { user: string | null; demo: boolean } | null {
  const t = read();
  return t ? { user: typeof t.user === 'string' && t.user ? t.user : null, demo: t.demo === true } : null;
}

export function clear(): void {
  session.remove(KEY);
}

/** Access token for an API call, refreshed first when it expires within a minute. */
export async function validToken(): Promise<string | null> {
  const t = read();
  if (!t) return null;
  if (MOCK || !t.refresh || t.exp - Date.now() > REFRESH_MARGIN_MS) return t.access;
  // ponytail: concurrent calls near expiry may refresh twice; harmless, dedupe if it ever matters.
  try {
    const r = await initiateAuth('REFRESH_TOKEN_AUTH', { REFRESH_TOKEN: t.refresh });
    save(r, t);
    return r.AccessToken;
  } catch {
    return t.access; // the API answers 401 if it is really expired, which sends the user to the login screen
  }
}
