import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isEmail } from './validation';

/** Design `ForgotStep`: the next step is shown whether or not the account exists (TM-L10). */
export function ForgotStep({
  email,
  onEmailChange,
  onBack,
  onSubmit,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  onBack: () => void;
  onSubmit: (email: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!isEmail(email)) {
      setErr(t('auth.validation.emailForm'));
      return;
    }
    setLoading(true);
    onSubmit(email)
      .catch(() => undefined)
      .finally(() => {
        setLoading(false);
      });
  };

  return (
    <div className="login-form">
      <h1 className="login-title">{t('auth.forgot.title')}</h1>
      <p className="login-sub">{t('auth.forgot.subtitle')}</p>
      <form onSubmit={submit} className="login-fields" noValidate>
        <label className="sr-only" htmlFor="fg-email">
          {t('auth.email')}
        </label>
        <input
          id="fg-email"
          className="login-input"
          type="email"
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="off"
          value={email}
          onChange={(e) => {
            onEmailChange(e.target.value);
            setErr(null);
          }}
          placeholder={t('auth.email')}
          aria-invalid={Boolean(err)}
          aria-describedby="fg-err"
        />
        {err && (
          <span className="login-err" id="fg-err">
            {err}
          </span>
        )}
        <button type="submit" className="login-primary" disabled={loading} aria-busy={loading}>
          {loading ? t('auth.forgot.submitting') : t('auth.forgot.submit')}
        </button>
      </form>
      <div className="login-links">
        <button type="button" className="login-link" onClick={onBack}>
          {t('auth.forgot.back')}
        </button>
      </div>
    </div>
  );
}
