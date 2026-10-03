import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Challenge, CognitoAuth, SignInStep } from '../../auth/cognito/flows';
import { CopyIcon, LockIcon } from '../../components/icons';
import { copyText } from '../../lib/clipboard';
import { CodeStep } from './CodeStep';
import { Bold } from './rich';
import { groupSecret, otpauthUri, qrMatrix } from './totp';

const QUIET_ZONE = 2;

// StrictMode runs effects twice; one association per MFA_SETUP session (a second call would
// replace the secret the user is scanning). Entries are removed once settled and consumed.
const associations = new Map<string, Promise<{ secret: string; challenge: Challenge }>>();

function associate(cognito: CognitoAuth, challenge: Challenge) {
  let pending = associations.get(challenge.session);
  if (!pending) {
    pending = cognito.beginMfaSetup(challenge);
    associations.set(challenge.session, pending);
    const forget = () => setTimeout(() => associations.delete(challenge.session), 0);
    pending.then(forget, forget);
  }
  return pending;
}

/** QR as SVG rects built from the matrix: no innerHTML, no data URL, no network. */
function QrCode({ matrix, label }: { matrix: boolean[][]; label: string }) {
  const size = matrix.length + QUIET_ZONE * 2;
  const path = useMemo(
    () =>
      matrix
        .flatMap((row, y) =>
          row.map((dark, x) => (dark ? `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z` : '')),
        )
        .join(''),
    [matrix],
  );
  return (
    <svg
      className="mfa-qr mfa-qr-ready"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/**
 * TOTP enrollment on the first sign-in when MFA is required (design `MfaEnroll`). The secret
 * comes from `AssociateSoftwareToken` with the `MFA_SETUP` session and lives only in this
 * component's state: never in logs, storage or telemetry, and it is dropped on unmount.
 */
export function MfaEnroll({
  cognito,
  challenge,
  email,
  onDone,
  onBack,
  onSessionLost,
}: {
  cognito: CognitoAuth;
  challenge: Challenge;
  email: string;
  onDone: (step: SignInStep) => void;
  onBack: () => void;
  onSessionLost: () => void;
}) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<{ secret: string; challenge: Challenge } | null>(null);
  const [matrix, setMatrix] = useState<boolean[][] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const effect = { active: true };
    associate(cognito, challenge).then(
      (result) => {
        if (!effect.active) return;
        setSetup(result);
        qrMatrix(otpauthUri(result.secret, email)).then(
          (qr) => {
            if (effect.active) setMatrix(qr);
          },
          // The secret stays usable by hand if the QR cannot be drawn.
          () => undefined,
        );
      },
      () => {
        if (effect.active) onSessionLost();
      },
    );
    return () => {
      effect.active = false;
    };
  }, [cognito, challenge, email, onSessionLost]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 1600);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  const copy = () => {
    if (!setup) return;
    copyText(setup.secret.replace(/=+$/, '')).then(
      () => {
        setCopied(true);
      },
      () => undefined,
    );
  };

  const submit = async (code: string) => {
    if (!setup) return;
    onDone(await cognito.completeMfaSetup(setup.challenge, code));
  };

  return (
    <CodeStep
      title={t('auth.enroll.title')}
      subtitle={
        <Bold translate={(slot) => t('auth.enroll.subtitle', { email: slot })} value={email} />
      }
      cta={t('auth.enroll.submit')}
      label={t('auth.enroll.label')}
      backLabel={t('auth.mfa.otherAccount')}
      onBack={onBack}
      onSubmit={submit}
      before={
        <div className="mfa-enroll">
          {matrix ? (
            <QrCode matrix={matrix} label={t('auth.enroll.qr')} />
          ) : (
            <div className="mfa-qr" role="img" aria-label={t('auth.enroll.qr')} aria-busy="true">
              <LockIcon size={18} />
              <span>{t('auth.enroll.qrLoading')}</span>
            </div>
          )}
          <div className="mfa-enroll-body">
            <div className="mfa-enroll-hint">{t('auth.enroll.cantScan')}</div>
            <code className="mfa-secret">{setup ? groupSecret(setup.secret) : '…'}</code>
            <button
              type="button"
              className="btn btn-sm mfa-copy"
              onClick={copy}
              disabled={!setup}
              aria-label={t('auth.enroll.copy')}
            >
              <CopyIcon size={12} /> {copied ? t('auth.enroll.copied') : t('auth.enroll.copy')}
            </button>
            <div className="mfa-enroll-type">{t('auth.enroll.type')}</div>
          </div>
        </div>
      }
    />
  );
}
