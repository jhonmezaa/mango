import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiErrorCode } from '../../api/adminErrors';
import { connectivityCheckNames, type Connectivity } from '../../api/adminSchemas';
import { ApiError } from '../../api/errors';
import { useSession } from '../../auth/useSession';
import { CheckIcon, CloudIcon, RefreshIcon, X2Icon } from '../icons';
import { fmtDate } from './govFormat';
import { Banner, Empty, Spinner } from './govKit';
import { MemberAccounts, type MemberAccess } from './MemberAccounts';

/**
 * The API allows 5 checks per minute per admin. After a 429 the button counts down the API's
 * `Retry-After`, or this fallback when the header is missing.
 */
const RATE_LIMIT_WAIT_S = 60;

function isRateLimit(failure: unknown): boolean {
  return (
    apiErrorCode(failure) === 'rate_limited' ||
    (failure instanceof ApiError && failure.status === 429)
  );
}

function waitOf(failure: unknown): number {
  return (failure instanceof ApiError ? failure.retryAfter : null) ?? RATE_LIMIT_WAIT_S;
}

/**
 * Settings › Conectividad (design gov/connectivity.jsx): runs the read-only AdminProbe check
 * and, with it, the check of the read role in the member accounts ("Cuentas miembro").
 * The rate limit is the API's (429); the UI only shows the countdown it implies.
 */
export function ConnectivityTab() {
  const { t } = useTranslation();
  const { api } = useSession();
  const [result, setResult] = useState<Connectivity | null>(null);
  const [members, setMembers] = useState<MemberAccess | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  // The member check failed on its own, with the connection in order: it has its own banner.
  const [membersFailed, setMembersFailed] = useState(false);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => {
      setWait((value) => Math.max(0, value - 1));
    }, 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [wait]);

  const test = async () => {
    setRunning(true);
    setFailed(false);
    // Independent checks, each with its own limit in the API: they run together.
    const [connection, access] = await Promise.allSettled([
      api.runConnectivityCheck(),
      api.call('memberAccessCheck', { body: {} }),
    ]);
    setRunning(false);
    if (connection.status === 'rejected') {
      // Design: the last result stays on screen (both cards).
      if (isRateLimit(connection.reason)) setWait(waitOf(connection.reason));
      else setFailed(true);
      return;
    }
    setResult(connection.value);
    if (access.status === 'fulfilled') {
      setMembers(access.value);
      setMembersFailed(false);
      return;
    }
    if (isRateLimit(access.reason)) {
      setWait(waitOf(access.reason));
      return;
    }
    setMembers(null);
    // With a failed check above, that check already says why the accounts were not read.
    setMembersFailed(connection.value.checks.every((check) => check.status === 'ok'));
  };

  const limited = wait > 0;
  const checks = result?.checks ?? [];
  const failedChecks = checks.filter((check) => check.status !== 'ok').length;
  const byName = new Map(checks.map((check) => [check.name, check] as const));
  // Design order; a check the API did not return is not shown.
  const rows = connectivityCheckNames.filter((name) => byName.has(name) || running);

  return (
    <section className="g-sec mt-0" aria-labelledby="conn-title">
      <div className="g-sec-h">
        <div>
          <h2 id="conn-title" className="g-sec-t">
            {t('settings.conn.title')}
          </h2>
          <div className="g-sec-meta">{t('settings.conn.meta')}</div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={running || limited}
          onClick={() => void test()}
        >
          {running ? (
            <>
              <Spinner />
              {t('settings.conn.running')}
            </>
          ) : limited ? (
            t('settings.conn.wait', { seconds: wait })
          ) : (
            <>
              <RefreshIcon size={12} />
              {t('settings.conn.run')}
            </>
          )}
        </button>
      </div>
      {/* Design gov/connectivity.jsx: fixed body (the check never ran, so the state is unknown);
          the last result stays below. */}
      {failed && (
        <div className="mb-3">
          <Banner tone="error" title={t('settings.conn.failed')}>
            {t('settings.conn.failedBody')}
          </Banner>
        </div>
      )}
      {limited && (
        <div className="mb-3">
          <Banner tone="warn" title={t('settings.conn.limitedTitle')}>
            {t('settings.conn.limitedBody')}
          </Banner>
        </div>
      )}
      <div className="g-card">
        {!result && !running ? (
          <Empty icon={CloudIcon} title={t('settings.conn.emptyTitle')}>
            {t('settings.conn.emptyBody')}
          </Empty>
        ) : (
          <>
            <div className="g-conn-h" aria-live="polite">
              {running ? (
                <>
                  <Spinner />
                  <span>{t('settings.conn.testing')}</span>
                </>
              ) : failedChecks > 0 ? (
                <>
                  <span className="g-dot-lg red">
                    <X2Icon size={12} />
                  </span>
                  <span>
                    <b>
                      {t('settings.conn.someFailed', {
                        failed: failedChecks,
                        total: checks.length,
                      })}
                    </b>
                  </span>
                </>
              ) : (
                <>
                  <span className="g-dot-lg green">
                    <CheckIcon size={12} />
                  </span>
                  <span>
                    <b>{t('settings.conn.allOk')}</b>
                  </span>
                </>
              )}
              {!running && result && (
                <span className="g-sub ml-auto">{fmtDate(result.checked_at)}</span>
              )}
            </div>
            {rows.map((name) => {
              const check = running ? undefined : byName.get(name);
              const ok = check?.status === 'ok';
              return (
                <div key={name} className="g-check">
                  <span className="g-check-i">
                    {running ? (
                      <Spinner />
                    ) : ok ? (
                      <span className="g-dot-lg green sm">
                        <CheckIcon size={10} />
                      </span>
                    ) : (
                      <span className="g-dot-lg red sm">
                        <X2Icon size={10} />
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="mono g-check-n">{name}</span>
                      <span className="g-sub">{t(`settings.conn.checks.${name}.label`)}</span>
                    </div>
                    {/* Probe detail (AWS error text, account IDs): rendered as text only (TM-A8). */}
                    {check && (
                      <div className={ok ? 'g-check-d' : 'g-check-d bad'}>{check.detail}</div>
                    )}
                    {check && !ok && (
                      <div className="g-help">
                        <b>{t('settings.conn.whatToCheck')}</b>{' '}
                        {t(`settings.conn.checks.${name}.help`)}
                      </div>
                    )}
                  </div>
                  {check && (
                    <span className={ok ? 'badge badge-green' : 'badge badge-red'}>
                      {ok ? t('settings.conn.ok') : t('settings.conn.error')}
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
      {/* Design: only after a finished run. Without target accounts the section does not appear;
          when its own check failed it says so itself, not with the banner of the connection. */}
      {result && !running && (membersFailed || (members && members.accounts.length > 0)) ? (
        <MemberAccounts access={membersFailed ? null : members} />
      ) : null}
    </section>
  );
}
