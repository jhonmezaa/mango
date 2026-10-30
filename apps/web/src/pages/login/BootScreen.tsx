import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Design login.jsx `BootScreen`: the thin bar shows only when the wait is long (cold start). */
const SLOW_AFTER_MS = 1200;

// Widths of the skeleton rows, as the design draws them (classes, not `style`, for the CSP).
const NAV_ROWS = ['w72', 'w88', 'w64', 'w80', 'w70'] as const;
const MORE_ROWS = ['w60', 'w76', 'w54'] as const;

/**
 * What a page load shows while the session is renewed (design round 27, «Recargar la página»):
 * the app frame with skeletons when this tab had a session, a neutral cover (background and logo)
 * when it did not. No text in either case. `had` is a local UI hint only: what follows is decided
 * by the renewal, never by it.
 */
export function BootScreen({ had }: { had: boolean }) {
  const { t } = useTranslation();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSlow(true);
    }, SLOW_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);
  const bar = slow && (
    <div className="boot-bar" aria-hidden="true">
      <i />
    </div>
  );
  if (!had) {
    return (
      <div
        className="boot-cover"
        role="progressbar"
        aria-label={t('auth.loading')}
        aria-busy="true"
      >
        {bar}
        <span className="sb-ws-logo boot-logo" aria-hidden="true">
          m
        </span>
      </div>
    );
  }
  return (
    <div className="boot-app" role="progressbar" aria-label={t('auth.loading')} aria-busy="true">
      {bar}
      <aside className="boot-sb">
        <div className="boot-ws">
          <span className="sb-ws-logo" aria-hidden="true">
            m
          </span>
          <span className="skeleton boot-ws-name" />
        </div>
        {NAV_ROWS.map((width) => (
          <div key={width} className="boot-row">
            <span className="skeleton boot-icon" />
            <span className={`skeleton boot-line boot-${width}`} />
          </div>
        ))}
        <div className="boot-gap" />
        {MORE_ROWS.map((width) => (
          <div key={width} className="boot-row">
            <span className={`skeleton boot-line boot-${width}`} />
          </div>
        ))}
        <div className="boot-me">
          <span className="skeleton boot-avatar" />
          <span className="skeleton boot-line boot-w50" />
        </div>
      </aside>
      <div className="boot-main">
        <div className="boot-top">
          <span className="skeleton boot-crumb" />
        </div>
        <div className="boot-body">
          <span className="skeleton boot-title" />
          <span className="skeleton boot-text boot-w64" />
          <span className="skeleton boot-text boot-w58" />
        </div>
        <div className="boot-compose skeleton" />
      </div>
    </div>
  );
}
