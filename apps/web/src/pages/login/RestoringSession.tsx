import { useTranslation } from 'react-i18next';

import { LoginLayout } from './LoginLayout';

const MESSAGES = {
  restoring: 'auth.restoring',
  ssoReturn: 'auth.completingSignIn',
  signingIn: 'auth.signingIn',
} as const;

/**
 * The sign-in frame while the session cookie is checked (design `login.jsx`, step `restoring`):
 * the sign-in form, if there is no session, appears in the same place without a flash. Coming
 * back from the IdP it is the same frame with «Completando el ingreso…» (`ssoReturn`), and after
 * the own sign-in form with «Entrando…» (`signingIn`), until the application is ready.
 */
export function RestoringSession({ step = 'restoring' }: { step?: keyof typeof MESSAGES }) {
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
