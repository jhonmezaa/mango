import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LockIcon } from '../../components/icons';
import { Bold } from './rich';

/** Design `NoAccess`: a verified account without a group (deny by default, D20, TM-L5). */
export function NoAccess({
  email,
  onRecheck,
  onLogout,
}: {
  email: string;
  /** Refreshes the tokens and asks the API again; false while there is still no group. */
  onRecheck: () => Promise<boolean>;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);

  const check = () => {
    setChecking(true);
    onRecheck()
      .then((ok) => {
        if (!ok) setChecked(true);
      })
      .catch(() => {
        setChecked(true);
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
      <h1 className="login-title">{t('auth.pending.title')}</h1>
      <p className="login-sub">
        <Bold translate={(slot) => t('auth.pending.subtitle', { email: slot })} value={email} />
      </p>
      <div className="login-note login-note-box">
        <div className="login-note-title">{t('auth.pending.nextTitle')}</div>
        {t('auth.pending.next')}
      </div>
      {checked && (
        <div className="login-err-box login-status-gap" role="status">
          {t('auth.pending.stillNoGroup')}
        </div>
      )}
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
