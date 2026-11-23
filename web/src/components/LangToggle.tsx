import { lang, setLang } from '../i18n';

/** 한국어 ⇄ English, at the top right of the studio and of the login page. It names the language it switches TO, in
 * that language, so a reader of either finds it. */
export function LangToggle() {
  const next = lang === 'en' ? 'ko' : 'en';
  return (
    <button type="button" className="btn btn-ghost lang-toggle" lang={next} onClick={() => setLang(next)}
      aria-label={next === 'en' ? 'Switch to English' : '한국어로 보기'} title={next === 'en' ? 'Switch to English' : '한국어로 보기'}>
      {next === 'en' ? 'EN' : '한국어'}
    </button>
  );
}
