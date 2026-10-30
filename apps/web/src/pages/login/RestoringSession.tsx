import { useTranslation } from 'react-i18next';

import { LoginLayout } from './LoginLayout';

const MESSAGES = {
  ssoReturn: 'auth.completingSignIn',
  signingIn: 'auth.signingIn',
} as const;

/**
 * The sign-in frame while a sign-in completes (design `login.jsx`, step `restoring`): coming back
 * from the IdP with «Completando el ingreso…» (`ssoReturn`), and after the own sign-in form with
 * «Entrando…» (`signingIn`), until the application is ready. A page load shows `BootScreen`
 * instead (design round 27).
 */
export function RestoringSession({ step }: { step: keyof typeof MESSAGES }) {
  const { t } = useTranslation();
  return (
    <LoginLayout>
      <div className="login-form login-restoring" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>{t(MESSAGES[step])}</span>
      </div>
    </LoginLayout>
  );
}
