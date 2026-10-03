import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { FieldError, PasswordInput, PasswordMeter, PasswordRule } from './fields';
import { meetsPasswordPolicy } from './validation';

/**
 * Design `NewPassword` ("Crea tu contraseña", `login.jsx:216-237`): `NEW_PASSWORD_REQUIRED` for
 * accounts an administrator created with a temporary password. The new password is checked
 * against the policy and its confirmation before anything is sent to Cognito.
 */
export function NewPasswordStep({
  subtitle,
  onBack,
  onSubmit,
}: {
  subtitle: ReactNode;
  onBack: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tried, setTried] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const policyOk = meetsPasswordPolicy(password);
  const mismatch = policyOk && confirm !== password;

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setTried(true);
    if (!policyOk || mismatch || loading) return;
    setLoading(true);
    setErr(null);
    onSubmit(password)
      .catch(() => {
        setErr(t('auth.errors.signInFailed'));
      })
      .finally(() => {
        setLoading(false);
      });
  };

  return (
    <div className="login-form">
      <h1 className="login-title">{t('auth.newPassword.title')}</h1>
      <p className="login-sub">{subtitle}</p>
      <form onSubmit={submit} className="login-fields" noValidate>
        <PasswordInput
          id="np-pwd"
          value={password}
          onChange={setPassword}
          placeholder={t('auth.reset.newPassword')}
          autoComplete="new-password"
          invalid={tried && !policyOk}
          describedBy="np-rule"
        />
        <PasswordMeter password={password} />
        <PasswordRule id="np-rule" error={tried && !policyOk} />
        <PasswordInput
          id="np-pwd2"
          value={confirm}
          onChange={setConfirm}
          placeholder={t('auth.newPassword.confirm')}
          autoComplete="new-password"
          invalid={tried && mismatch}
          describedBy="np-err2"
        />
        <FieldError id="np-err2" message={tried && mismatch && t('auth.newPassword.mismatch')} />
        {err && (
          <div className="login-err-box" role="alert">
            {err}
          </div>
        )}
        <button
          type="submit"
          className="login-primary login-primary-spaced-sm"
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? t('auth.newPassword.submitting') : t('auth.newPassword.submit')}
        </button>
      </form>
      <div className="login-links">
        <button type="button" className="login-link" onClick={onBack}>
          {t('auth.mfa.otherAccount')}
        </button>
      </div>
    </div>
  );
}
