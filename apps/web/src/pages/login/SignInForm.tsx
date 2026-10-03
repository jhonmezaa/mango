import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PasswordInput } from './fields';
import { Bold } from './rich';
import { isEmail } from './validation';

export function SignInForm({
  email,
  onEmailChange,
  domain,
  notice,
  error,
  ssoAvailable,
  onForgot,
  onSubmit,
  onSso,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  domain: string;
  notice: string | null;
  /** Error from a previous attempt or session (e.g. expired). */
  error: string | null;
  ssoAvailable: boolean;
  onForgot: () => void;
  /** Resolves with an error message to show, or null when the flow moved on. */
  onSubmit: (email: string, password: string) => Promise<string | null>;
  onSso: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(error);
  const [loading, setLoading] = useState<'pwd' | 'sso' | null>(null);

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setErr(null);
    if (!isEmail(email) || !password) {
      setErr(t('auth.validation.credentials'));
      return;
    }
    setLoading('pwd');
    onSubmit(email, password).then(
      (message) => {
        setLoading(null);
        if (message) {
          setPassword('');
          setErr(message);
        }
      },
      () => {
        setLoading(null);
        setErr(t('auth.errors.signInFailed'));
      },
    );
  };

  const sso = () => {
    setLoading('sso');
    onSso().catch(() => {
      setLoading(null);
      setErr(t('auth.errors.signInFailed'));
    });
  };

  return (
    <div className="login-form">
      <h1 className="login-title">{t('auth.title')}</h1>
      <p className="login-sub">
        <Bold translate={() => t('auth.subtitle')} />
      </p>
      {notice && (
        <div className="login-ok-box login-notice" role="status">
          {notice}
        </div>
      )}
      <form onSubmit={submit} className="login-fields" noValidate>
        <label className="sr-only" htmlFor="lg-email">
          {t('auth.email')}
        </label>
        <input
          id="lg-email"
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
          placeholder={t('auth.emailPlaceholder', { domain })}
        />
        <PasswordInput
          id="lg-pwd"
          value={password}
          onChange={(v) => {
            setPassword(v);
            setErr(null);
          }}
        />
        {err && (
          <div className="login-err-box" role="alert">
            {err}
          </div>
        )}
        <button type="button" className="login-forgot login-link" onClick={onForgot}>
          {t('auth.forgotLink')}
        </button>
        <button
          type="submit"
          className="login-primary"
          disabled={loading !== null}
          aria-busy={loading === 'pwd'}
        >
          {loading === 'pwd' ? t('auth.signingIn') : t('auth.signIn')}
        </button>
      </form>
      {ssoAvailable && (
        <>
          <div className="login-divider">
            <span>{t('auth.or')}</span>
          </div>
          <button
            type="button"
            className="login-sso-btn w-full"
            disabled={loading !== null}
            aria-busy={loading === 'sso'}
            onClick={sso}
          >
            {loading === 'sso' ? t('auth.ssoRedirecting') : t('auth.sso')}
          </button>
        </>
      )}
    </div>
  );
}
