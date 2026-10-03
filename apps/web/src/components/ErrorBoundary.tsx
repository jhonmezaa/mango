import { Component, type ReactNode } from 'react';
import { Link } from 'react-router';

import i18n from '../i18n';
import { ErrorState } from './ErrorState';
import { RefreshIcon, WarnIcon } from './icons';
import { Topbar } from './Topbar';

interface Props {
  children: ReactNode;
  /** Changing it clears the error (e.g. the route path, so navigating away recovers). */
  resetKey?: string;
}

interface State {
  failed: boolean;
}

/**
 * Keeps a rendering bug in one page (e.g. unexpected data from the API, ADM-02) from blanking the
 * whole app: the shell stays usable and the page shows the design's crash state (system.jsx
 * ErrorBoundary) with "Recargar" and "Ir al chat". The error itself is not logged or shown (the
 * design's `detail` is left out on purpose): it may contain untrusted data or internal messages.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        {/* The page's own topbar crashed with it; this one keeps the mobile menu reachable. */}
        <Topbar />
        <div className="content flex">
          <ErrorState
            icon={WarnIcon}
            tone="red"
            title={i18n.t('errors.crashTitle')}
            description={i18n.t('errors.crashHint')}
            code="RENDER_ERROR"
            actions={
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    window.location.reload();
                  }}
                >
                  <RefreshIcon size={11} />
                  {i18n.t('errors.reload')}
                </button>
                <Link
                  to="/"
                  className="btn btn-sm"
                  onClick={() => {
                    this.setState({ failed: false });
                  }}
                >
                  {i18n.t('errors.home')}
                </Link>
              </>
            }
          />
        </div>
      </>
    );
  }
}
