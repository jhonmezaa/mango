import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EyeIcon } from '../../components/icons';
import { passwordScore } from './validation';

export function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete = 'current-password',
  invalid = false,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: 'current-password' | 'new-password';
  invalid?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const label = placeholder ?? t('auth.password');
  return (
    <div className="relative">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="login-input login-input-pwd"
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        // Never let the browser or extensions spell-check or capitalize a password.
        spellCheck={false}
        autoCapitalize="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      />
      <button
        type="button"
        className="login-eye"
        aria-label={show ? t('auth.hidePassword') : t('auth.showPassword')}
        aria-pressed={show}
        onClick={() => {
          setShow((v) => !v);
        }}
      >
        <EyeIcon size={16} />
      </button>
    </div>
  );
}

const METER = [0, 1, 2, 3, 4] as const;

/** Design `PwdMeter`: one segment per policy criterion; only "meets the policy" or not. */
export function PasswordMeter({ password }: { password: string }) {
  const { t } = useTranslation();
  if (!password) return null;
  const score = passwordScore(password);
  const ok = score === METER.length;
  const tone = ok ? 'login-meter-good' : 'login-meter-weak';
  return (
    <div className="login-meter" aria-live="polite">
      <span className="login-meter-bars" aria-hidden="true">
        {METER.map((i) => (
          <span key={i} className={i < score ? tone : undefined} />
        ))}
      </span>
      <span>{ok ? t('auth.policy.ok') : t('auth.policy.notYet')}</span>
    </div>
  );
}

/**
 * Design: the password rule is always visible under the field (`.login-hint`) and turns into
 * the error (`.login-err`) after a failed submit.
 */
export function PasswordRule({ id, error }: { id: string; error: boolean }) {
  const { t } = useTranslation();
  return (
    <span id={id} className={error ? 'login-err' : 'login-hint'}>
      {t('auth.validation.password')}
    </span>
  );
}

export function FieldError({ id, message }: { id: string; message: string | null | false }) {
  if (!message) return null;
  return (
    <span className="login-err" id={id}>
      {message}
    </span>
  );
}
