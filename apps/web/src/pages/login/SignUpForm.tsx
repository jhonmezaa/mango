import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { safeHttpsHref } from '../../security/safeUrl';
import { cognitoCode } from './errors';
import { FieldError, PasswordInput, PasswordMeter, PasswordRule } from './fields';
import { domainOf, isEmail, meetsPasswordPolicy, normalizeEmail } from './validation';

const MAX_NAME_LENGTH = 128;

interface Fields {
  name: string;
  email: string;
  password: string;
  terms: boolean;
}

/**
 * Design `SignupForm`. The domain check here is only a hint: the pre sign-up Lambda decides
 * (TM-L4). An existing account gets the same answer as a new one (TM-L10). The AI use policy
 * checkbox only exists when the installation sets `aiPolicyUrl`.
 */
export function SignUpForm({
  domains,
  aiPolicyUrl,
  onSubmit,
}: {
  domains: string[];
  /** Installation parameter; validated again here before it reaches the `href`. */
  aiPolicyUrl?: string | undefined;
  /** Calls Cognito `SignUp`; rejects with a CognitoError. */
  onSubmit: (fields: { name: string; email: string; password: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [f, setF] = useState<Fields>({ name: '', email: '', password: '', terms: false });
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<{
    field: 'email' | 'password' | 'form';
    message: string;
  } | null>(null);
  const domainList = domains.join(', @');
  const policyHref = safeHttpsHref(aiPolicyUrl);
  const name = f.name.trim();

  const errors = {
    name: (!name || name.length > MAX_NAME_LENGTH) && t('auth.validation.name'),
    email: !isEmail(f.email)
      ? t('auth.validation.email')
      : !domains.includes(domainOf(f.email))
        ? t('auth.validation.domain', { domain: domainList })
        : serverError?.field === 'email'
          ? serverError.message
          : null,
    password: !meetsPasswordPolicy(f.password)
      ? t('auth.validation.password')
      : serverError?.field === 'password'
        ? serverError.message
        : null,
    terms: policyHref !== null && !f.terms && t('auth.validation.terms'),
  };
  const valid = !Object.values(errors).some(Boolean);
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    setF((prev) => ({ ...prev, [key]: value }));
    setServerError(null);
  };

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setTouched(true);
    if (!valid || loading) return;
    setLoading(true);
    onSubmit({ name, email: normalizeEmail(f.email), password: f.password })
      .catch((e: unknown) => {
        const code = cognitoCode(e);
        if (code === 'InvalidPasswordException') {
          setServerError({ field: 'password', message: t('auth.validation.password') });
        } else if (code === 'UserLambdaValidationException') {
          // Rejected by the pre sign-up trigger: not a company domain.
          setServerError({
            field: 'email',
            message: t('auth.validation.domain', { domain: domainList }),
          });
        } else {
          setServerError({ field: 'form', message: t('auth.errors.signInFailed') });
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const show = (key: keyof typeof errors) => (touched || serverError ? errors[key] : null);

  return (
    <div className="login-form">
      <h1 className="login-title">{t('auth.signup.title')}</h1>
      <p className="login-sub">{t('auth.signup.subtitle', { domain: domainList })}</p>
      <form onSubmit={submit} className="login-fields" noValidate>
        <label className="sr-only" htmlFor="su-name">
          {t('auth.signup.name')}
        </label>
        <input
          id="su-name"
          className="login-input"
          autoComplete="name"
          maxLength={MAX_NAME_LENGTH}
          placeholder={t('auth.signup.namePlaceholder')}
          value={f.name}
          onChange={(e) => {
            set('name', e.target.value);
          }}
          aria-invalid={Boolean(show('name'))}
          aria-describedby="err-name"
        />
        <FieldError id="err-name" message={show('name')} />
        <label className="sr-only" htmlFor="su-email">
          {t('auth.signup.email')}
        </label>
        <input
          id="su-email"
          className="login-input"
          type="email"
          autoComplete="email"
          spellCheck={false}
          autoCapitalize="off"
          placeholder={t('auth.emailPlaceholder', { domain: domains[0] ?? '' })}
          value={f.email}
          onChange={(e) => {
            set('email', e.target.value);
          }}
          aria-invalid={Boolean(show('email'))}
          aria-describedby="err-email"
        />
        <FieldError id="err-email" message={show('email')} />
        <PasswordInput
          id="su-pwd"
          value={f.password}
          onChange={(v) => {
            set('password', v);
          }}
          autoComplete="new-password"
          invalid={Boolean(show('password'))}
          describedBy="err-pwd"
        />
        <PasswordMeter password={f.password} />
        {show('password') ? (
          <FieldError id="err-pwd" message={show('password')} />
        ) : (
          <PasswordRule id="err-pwd" error={false} />
        )}
        {policyHref && (
          <>
            <label className="login-check">
              <input
                type="checkbox"
                checked={f.terms}
                aria-invalid={Boolean(show('terms'))}
                aria-describedby="err-terms"
                onChange={(e) => {
                  set('terms', e.target.checked);
                }}
              />
              <span>
                {t('auth.signup.termsBefore')}
                <a href={policyHref} target="_blank" rel="noopener noreferrer">
                  {t('auth.signup.termsLink')}
                </a>
                {t('auth.signup.termsAfter')}
              </span>
            </label>
            <FieldError id="err-terms" message={show('terms')} />
          </>
        )}
        {serverError?.field === 'form' && (
          <div className="login-err-box" role="alert">
            {serverError.message}
          </div>
        )}
        <button
          type="submit"
          className="login-primary login-primary-spaced-sm"
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? t('auth.signup.submitting') : t('auth.signup.submit')}
        </button>
      </form>
    </div>
  );
}
