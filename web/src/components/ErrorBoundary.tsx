import { t } from '../i18n';
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** What 새로고침 does (the tests' hook). */
  onReload?: () => void;
}

/** Around the whole page: when a part throws while React draws, a sentence and a reload stand in place of a white
 * page; the address still names the session, so the reload opens it again. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main id="main" className="crash">
        <div className="load-error" role="alert">
          <p><strong>{t('화면을 표시하다 문제가 생겼어요.')}</strong> {t('새로고침해 주세요.')}</p>
          <button type="button" className="btn btn-sm" onClick={this.props.onReload ?? (() => location.reload())}>{t('새로고침')}</button>
        </div>
      </main>
    );
  }
}
