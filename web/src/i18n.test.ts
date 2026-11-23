import { afterEach, describe, expect, it, vi } from 'vitest';

const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string; readdirSync: (p: string) => string[] };
const SRC = ['src', 'web/src'].find((p) => fs.existsSync(`${p}/i18n.ts`))!;

afterEach(() => { localStorage.clear(); vi.resetModules(); });

describe('the page in two languages', () => {
  it('is Korean unless English was chosen: a sentence is itself, with its places filled', async () => {
    const { lang, t } = await import('./i18n');
    expect(lang).toBe('ko');
    expect(t('새 세션 시작')).toBe('새 세션 시작');
    expect(t('{n}판마다', { n: 2 })).toBe('2판마다');
  });

  it('a key with a #note is the same Korean with another meaning: the note is not shown, the English is its own', async () => {
    const ko = await import('./i18n');
    expect(ko.t('대기 중#방송')).toBe('대기 중');
    expect(ko.tn('{n}판#판수', 3)).toBe('3판');
    vi.resetModules();
    localStorage.setItem('ipverse.lang', 'en');
    const en = await import('./i18n');
    expect([en.t('대기 중'), en.t('대기 중#방송')]).toEqual(['Waiting', 'Idle']);
    expect(en.t('아직 영어가 없는 말#뜻')).toBe('아직 영어가 없는 말');
  });

  it('a sentence with a count takes the form for it: never "1 rounds"', async () => {
    const ko = await import('./i18n');
    expect([ko.tn('광고 {n}회', 1), ko.tn('광고 {n}회', 2)]).toEqual(['광고 1회', '광고 2회']);
    vi.resetModules();
    localStorage.setItem('ipverse.lang', 'en');
    const { EN, tn } = await import('./i18n');
    EN['{n}번, {who}'] = '{n} time, {who}|{n} times, {who}';
    expect([0, 1, 2].map((n) => tn('{n}번, {who}', n, { who: 'Luna' }))).toEqual(['0 times, Luna', '1 time, Luna', '2 times, Luna']);
    expect([tn('{n}판#판수', 1), tn('{n}판#판수', 3)]).toEqual(['1 round', '3 rounds']);
    expect(tn('판마다', NaN)).toBe('rounds'); // (an emptied number field)
    expect(tn('아직 영어가 없는 문장 {n}', 1)).toBe('아직 영어가 없는 문장 1');
  });

  it('in English a sentence is looked up by its Korean, places filled; one with no English yet stays Korean', async () => {
    localStorage.setItem('ipverse.lang', 'en');
    const { EN, lang, t } = await import('./i18n');
    EN['{n}판마다'] = 'every {n} rounds';
    expect(lang).toBe('en');
    expect(t('{n}판마다', { n: 2 })).toBe('every 2 rounds');
    expect(t('아직 영어가 없는 문장 {n}', { n: 1 })).toBe('아직 영어가 없는 문장 1');
    expect(document.documentElement.lang).toBe('en');
  });

  it('the toggle keeps the choice in this browser and draws the page again', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const { setLang } = await import('./i18n');
    setLang('en');
    expect(localStorage.getItem('ipverse.lang')).toBe('en');
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

// Every sentence a component passes to t() as a literal has its English: a missing one would show Korean in the
// English page. (A sentence built at run time cannot be listed here; keep t()'s first argument a literal.)
describe('English coverage', () => {
  const files = (dir: string): string[] => fs.readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (/\.(test|d)\.tsx?$/.test(name) || name === 'mock' || name === 'i18n' || name === 'i18n.ts') return [];
    return /\.tsx?$/.test(name) ? [path] : fs.existsSync(path) && !name.includes('.') ? files(path) : [];
  });
  it('has an English sentence for every t(\'…\') in the sources', async () => {
    const { EN } = await import('./i18n');
    const missing: string[] = [];
    for (const path of files(SRC)) {
      const text = fs.readFileSync(path, 'utf8');
      for (const m of text.matchAll(/\b(tn?)\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g)) {
        if (m[2] === '`' && m[3].includes('${')) { missing.push(`${path}: ${m[1]}() takes a literal, not a template with \${}`); continue; }
        const key = m[3].replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
        if (!/[가-힣]/.test(key)) continue;
        if (!(key in EN)) missing.push(`${path}: ${key}`);
        // a count's two forms ('one|other') are read by tn() alone: through t() the page would show both
        else if (EN[key].includes('|') !== (m[1] === 'tn')) missing.push(`${path}: ${key}: ${m[1] === 'tn' ? 'tn() needs ‘one|other’' : 'a ‘one|other’ sentence needs tn()'}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
