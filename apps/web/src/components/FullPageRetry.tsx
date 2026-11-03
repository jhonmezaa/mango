import { useTranslation } from 'react-i18next';

import { RateWaitButton, RateWaitLine } from './RateWait';

/**
 * The application could not start and nothing says the session ended (the renewal or the profile
 * did not answer): design `BootScreen` with `fail`. The design also offers «Cerrar sesión», left
 * out on purpose: with the server down the session cookie cannot be revoked, so the person would
 * walk away from a session that still opens on the next load (owner's choice, 2026-10-30).
 */
export function FullPageRetry({
  onRetry,
  retryAt = null,
}: {
  onRetry: () => void;
  /** A 429: «Reintentar» counts down until then (design round 34 `RateWait`). */
  retryAt?: number | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="boot-cover">
      <div className="boot-fail" role="alert">
        <span className="sb-ws-logo boot-logo" aria-hidden="true">
          m
        </span>
        <h1>{t('auth.bootFail.title')}</h1>
        <p>
          {t('auth.bootFail.body')}
          {retryAt !== null && (
            <>
              {' '}
              <RateWaitLine until={retryAt} />
            </>
          )}
        </p>
        <div className="boot-fail-actions">
          {retryAt !== null ? (
            <RateWaitButton until={retryAt} onRetry={onRetry} className="btn btn-primary" />
          ) : (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              {t('errors.retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
