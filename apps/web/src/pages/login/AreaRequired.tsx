import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LockIcon } from '../../components/icons';
import { Bold } from './rich';

/** `_AREA_GROUP_RE` of `mango_core.groups`: `bu-<area>`, and `bu-lead` is not one. */
const AREA_GROUP = /^bu-[a-z0-9-]{2,32}$/;

/**
 * Design `AreaRequired`: a bu-lead without finops-central who does not have exactly one area
 * group (403 `area_required`, D60 (10)). Signing in again does not fix it: an administrator does,
 * and «Volver a comprobar» asks for new tokens with the current groups. The groups shown come from
 * the ID token, for display only; mango-api decides.
 */
export function AreaRequired({
  email,
  groups,
  onRecheck,
  onLogout,
}: {
  email: string;
  groups: readonly string[];
  /** Refreshes the tokens and asks the API again; false while it is still refused. */
  onRecheck: () => Promise<boolean>;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [still, setStill] = useState(false);
  const areas = groups.filter((group) => group !== 'bu-lead' && AREA_GROUP.test(group));
  const many = areas.length > 1;

  const check = () => {
    setChecking(true);
    setStill(false);
    onRecheck()
      .then((ok) => {
        if (!ok) setStill(true);
      })
      .catch(() => {
        setStill(true);
      })
      .finally(() => {
        setChecking(false);
      });
  };

  return (
    <div className="login-form">
      <span className="login-lock" aria-hidden="true">
        <LockIcon size={20} />
      </span>
      <h1 className="login-title">{many ? t('auth.area.titleMany') : t('auth.area.titleNone')}</h1>
      <p className="login-sub">
        <Bold translate={(slot) => t('auth.area.lead', { email: slot })} value={email} />{' '}
        <span className="mono">bu-lead</span>
        {t('auth.area.but')}
        {many ? (
          <>
            {t('auth.area.many', { count: areas.length })}{' '}
            <span className="mono">{areas.join(', ')}</span>
            {t('auth.area.tailMany')}
          </>
        ) : (
          t('auth.area.none')
        )}
      </p>
      <div className="login-note login-note-box">
        <div className="login-note-title">{t('auth.area.nextTitle')}</div>
        {t('auth.area.nextLead')} (<span className="mono">bu-…</span>) {t('auth.area.nextTail')}
      </div>
      {still ? (
        <div className="login-err-box login-status-gap" role="status">
          {many ? t('auth.area.stillMany') : t('auth.area.stillNone')} {t('auth.area.stillTail')}
        </div>
      ) : null}
      <div className="login-actions">
        <button
          type="button"
          className="login-primary login-grow"
          onClick={check}
          disabled={checking}
          aria-busy={checking}
        >
          {checking ? t('auth.pending.checking') : t('auth.pending.recheck')}
        </button>
      </div>
      <div className="login-links">
        <button type="button" className="login-link" onClick={onLogout}>
          {t('auth.signOut')}
        </button>
      </div>
    </div>
  );
}
