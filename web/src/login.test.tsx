import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Login, formProblems } from './components/Login';

// The login page: 데모 로그인 is explained, the sign-up rules stay visible while typing, and a password the server
// would refuse is told before the submit.
let container: HTMLDivElement;
let root: Root;
let signups: { username: string; password: string }[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  signups = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input) === '/api/signup') signups.push(JSON.parse(String(init.body)));
    return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
  }));
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (onLogin = vi.fn(() => Promise.resolve()), onDemo = vi.fn(() => Promise.resolve()), notice: string | null = null) =>
  act(async () => root.render(<Login notice={notice} onLogin={onLogin} onDemo={onDemo} />));
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => container.querySelector<T>(sel)!;
const field = (name: string) => $<HTMLInputElement>(`input[name="${name}"]`);
const type = (el: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const submit = async () => {
  await act(async () => { $('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await act(async () => { await Promise.resolve(); });
};
const described = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  .map((id) => container.querySelector(`#${id}`)!.textContent);

describe('the sign-up form states its rules where they are typed, and says what is wrong on the page (R20-40)', () => {
  it('keeps the id and password rules under their fields, with what the server really takes', async () => {
    await render();
    await act(async () => $('#auth-tab-signup').click());
    expect($<HTMLFormElement>('form').noValidate).toBe(true); // the page's own text instead of the browser's bubble
    expect(described(field('username'))).toEqual(['영문, 숫자, 밑줄(_), 마침표(.), 붙임표(-)로 3–32자']);
    expect(described(field('password'))[0]).toContain('12자 이상이고 영문 대문자, 영문 소문자, 숫자, 특수문자가 모두');
    expect([...container.querySelectorAll('.pw-rules li')].map((li) => li.textContent)).toEqual(['12자 이상', '영문 대문자', '영문 소문자', '숫자', '특수문자']);
    // each rule lights up as the password meets it
    await type(field('password'), 'abcdefgh1234');
    expect([...container.querySelectorAll('.pw-rules li.is-met')].map((li) => li.textContent)).toEqual(['12자 이상', '영문 소문자', '숫자']);
    // a label names its field alone: the hints are not read as part of the name
    expect(container.querySelector('label[for="login-username"]')!.textContent).toBe('아이디');
  });

  it('refuses an id with a space and a password with no symbol on the page, at the field, without asking the server', async () => {
    const onLogin = vi.fn(() => Promise.resolve());
    await render(onLogin);
    await act(async () => $('#auth-tab-signup').click());
    await type(field('username'), 'luna studio!');
    await type(field('password'), 'Abcdefgh12345678ij'); // 18 characters, no symbol
    await type(field('confirm'), 'Abcdefgh12345678ij');
    await submit();
    expect(described(field('username')).at(-1)).toBe('아이디는 영문, 숫자, 밑줄(_), 마침표(.), 붙임표(-)만 써서 3–32자로 정해 주세요.');
    expect(described(field('password')).at(-1)).toBe('비밀번호에 빠진 것이 있어요: 특수문자.');
    expect([field('username').getAttribute('aria-invalid'), field('password').getAttribute('aria-invalid')]).toEqual(['true', 'true']);
    expect(document.activeElement).toBe(field('username')); // the first field to fix
    expect(signups).toEqual([]);
    expect(onLogin).not.toHaveBeenCalled();
  });

  // A taken id is said at the id field, as a full sentence, and the field takes the focus.
  it('an id that is taken is said at the id field, which takes the focus', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'exists', message: '이미 있는 아이디예요. 다른 아이디를 써 주세요' }) }) as unknown as Response));
    const onLogin = vi.fn(() => Promise.resolve());
    await render(onLogin);
    await act(async () => $('#auth-tab-signup').click());
    await type(field('username'), 'luna_studio');
    await type(field('password'), 'Moonlight-Garden-7');
    await type(field('confirm'), 'Moonlight-Garden-7');
    await submit();
    expect(onLogin).not.toHaveBeenCalled();
    expect(described(field('username'))).toContain('이미 있는 아이디예요. 다른 아이디를 써 주세요.');
    expect(field('username').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('username'));
    expect(container.querySelector('#login-error')).toBeNull(); // said once, where it is fixed
    expect($<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
  });

  it('takes the ids the server takes (_ . -) and a password that meets every rule', async () => {
    const onLogin = vi.fn(() => Promise.resolve());
    await render(onLogin);
    await act(async () => $('#auth-tab-signup').click());
    await type(field('username'), 'luna_studio.kr-1');
    await type(field('password'), 'Moonlight-Garden7');
    await type(field('confirm'), 'Moonlight-Garden8');
    await submit();
    expect(described(field('confirm'))).toEqual(['비밀번호가 서로 달라요. 한 번 더 확인해 주세요.']);
    expect(signups).toEqual([]);
    await type(field('confirm'), 'Moonlight-Garden7');
    await submit();
    expect(signups).toEqual([{ username: 'luna_studio.kr-1', password: 'Moonlight-Garden7' }]);
    expect(onLogin).toHaveBeenCalledWith('luna_studio.kr-1', 'Moonlight-Garden7');
  });

  it('a login only asks that both fields are filled, in page text', async () => {
    const onLogin = vi.fn(() => Promise.resolve());
    await render(onLogin);
    await submit();
    expect([...container.querySelectorAll('.field .form-error')].map((e) => e.textContent)).toEqual(['아이디를 입력해 주세요.', '비밀번호를 입력해 주세요.']);
    await type(field('username'), 'luna');
    await type(field('password'), 'x');
    await submit();
    expect(onLogin).toHaveBeenCalledWith('luna', 'x');
    expect(container.querySelector('.field .form-error')).toBeNull();
  });

  it('formProblems names every missing password rule and the length limits', () => {
    expect(formProblems('signup', 'ab', 'short', 'short')).toEqual({
      username: '아이디는 영문, 숫자, 밑줄(_), 마침표(.), 붙임표(-)만 써서 3–32자로 정해 주세요.',
      password: '비밀번호에 빠진 것이 있어요: 12자 이상, 영문 대문자, 숫자, 특수문자.' });
    expect(formProblems('signup', 'a'.repeat(33), 'Moonlight-Garden7', 'Moonlight-Garden7').username).toBeDefined();
    expect(formProblems('signup', 'luna', `Aa1!${'x'.repeat(125)}`, '').password).toBe('비밀번호는 128자까지 쓸 수 있어요.');
    expect(formProblems('signup', 'luna', 'Moonlight-Garden7', 'Moonlight-Garden7')).toEqual({});
    expect(formProblems('login', 'any id at all', 'x', '')).toEqual({}); // an account made before the rule logs in as it is
  });
});

describe('데모 로그인 says what it is before it is pressed (R20-40)', () => {
  it('sits under the form with a line that the account is shared', async () => {
    const onDemo = vi.fn(() => Promise.resolve());
    await render(vi.fn(() => Promise.resolve()), onDemo);
    const button = $<HTMLButtonElement>('.login-demo button');
    expect(button.textContent).toBe('데모 로그인');
    expect(button.closest('form')).not.toBeNull(); // in the form's column, not a corner of the page
    expect(described(button)).toEqual(['가입 없이 둘러볼 수 있어요. 여러 사람이 함께 쓰는 공용 계정이라, 다른 사람이 만든 세션이 함께 보이고 내가 만든 것도 다른 사람에게 보여요.']);
    expect(button.type).toBe('button'); // never the form's submit
    await act(async () => button.click());
    expect(onDemo).toHaveBeenCalledOnce();
  });

  it('says in one line what the product is, also where the picture is not shown, and what IP means', async () => {
    await render();
    expect($('.login-what').textContent).toBe('아이디어 한 줄로 캐릭터·소품 그림, 3D, 영상, 게임, 라이브 방송까지 만드는 스튜디오예요. 여기서 만든 캐릭터·소품을 IP라고 불러요.');
  });

  it('a failed login reads as a sentence, never the error class or the browser text', async () => {
    await render(vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await type(field('username'), 'luna');
    await type(field('password'), 'x');
    await submit();
    expect($('#login-error').textContent).toBe('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
  });
});
