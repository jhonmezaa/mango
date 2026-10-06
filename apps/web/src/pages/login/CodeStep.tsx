import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isCodeError, isSendRejection } from './errors';
import { CODE_LENGTH } from './validation';

const EMPTY = Array.from({ length: CODE_LENGTH }, () => '');

/** Six single-digit cells with paste support (design `useCode`). */
function CodeCells({
  label,
  digits,
  onChange,
}: {
  label: string;
  digits: string[];
  onChange: (digits: string[]) => void;
}) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  const setDigit = (index: number, raw: string) => {
    const value = raw.replace(/\D/g, '');
    if (value.length > 1) {
      const pasted = value.slice(0, CODE_LENGTH).split('');
      onChange([...pasted, ...EMPTY].slice(0, CODE_LENGTH));
      refs.current[Math.min(CODE_LENGTH - 1, pasted.length)]?.focus();
      return;
    }
    const next = [...digits];
    next[index] = value;
    onChange(next);
    if (value && index < CODE_LENGTH - 1) refs.current[index + 1]?.focus();
  };

  return (
    <div className="login-code" role="group" aria-label={label}>
      {digits.map((digit, i) => (
        <input
          // Fixed positions: the index is the identity of each cell.
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="login-input login-code-cell"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={CODE_LENGTH}
          aria-label={t('auth.code.digit', { n: i + 1 })}
          value={digit}
          onChange={(e) => {
            setDigit(i, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digit && i > 0) refs.current[i - 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}

export interface CodeStepProps {
  title: string;
  subtitle: ReactNode;
  cta: string;
  label?: string;
  backLabel?: string;
  onBack: () => void;
  /** Throws a CognitoError on failure; a wrong or expired code shows the design message. */
  onSubmit: (code: string) => Promise<void>;
  /** Resend handler; omitted for authenticator codes. */
  onResend?: () => Promise<void>;
  before?: ReactNode;
  children?: ReactNode;
  /** Error from the parent's own checks (e.g. the new password). */
  error?: string | null;
}

/** Design `CodeStep`: code cells, optional extra fields, resend and back links. */
export function CodeStep({
  title,
  subtitle,
  cta,
  label,
  backLabel,
  onBack,
  onSubmit,
  onResend,
  before,
  children,
  error = null,
}: CodeStepProps) {
  const { t } = useTranslation();
  const [digits, setDigits] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const code = digits.join('');
  const shownError = error ?? err;

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (code.length < CODE_LENGTH || loading) return;
    setLoading(true);
    setErr(null);
    onSubmit(code)
      .catch((e: unknown) => {
        setErr(isCodeError(e) ? t('auth.errors.code') : t('auth.errors.signInFailed'));
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const resend = () => {
    setDigits(EMPTY);
    setErr(null);
    setSent(false);
    // The message is the same whether or not the account exists. Only a rejection that does
    // not depend on the account (WAF block, request rate, network, service) is shown.
    onResend?.().then(
      () => {
        setSent(true);
      },
      (e: unknown) => {
        if (isSendRejection(e)) setErr(t('auth.errors.actionFailed'));
        else setSent(true);
      },
    );
  };

  return (
    <div className="login-form">
      <h1 className="login-title">{title}</h1>
      <p className="login-sub">{subtitle}</p>
      <form onSubmit={submit} className="login-fields">
        {before}
        <CodeCells label={label ?? t('auth.code.label')} digits={digits} onChange={setDigits} />
        {children}
        {shownError && (
          <div className="login-err-box" role="alert">
            {shownError}
          </div>
        )}
        {sent && !shownError && (
          <div className="login-ok-box" role="status">
            {t('auth.code.resent')}
          </div>
        )}
        <button
          type="submit"
          className="login-primary login-primary-spaced"
          disabled={loading || code.length < CODE_LENGTH}
          aria-busy={loading}
        >
          {loading ? t('auth.code.verifying') : cta}
        </button>
      </form>
      <div className="login-links">
        {onResend && (
          <>
            <span>{t('auth.code.notReceived')}</span>
            <button type="button" className="login-link" onClick={resend}>
              {t('auth.code.resend')}
            </button>
            <span aria-hidden="true">·</span>
          </>
        )}
        <button type="button" className="login-link" onClick={onBack}>
          {backLabel ?? t('auth.code.back')}
        </button>
      </div>
    </div>
  );
}
