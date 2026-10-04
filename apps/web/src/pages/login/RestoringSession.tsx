import { useTranslation } from 'react-i18next';

import { LoginLayout } from './LoginLayout';

/**
 * The sign-in frame while the session cookie is checked (design `login.jsx`, step `restoring`):
 * the sign-in form, if there is no session, appears in the same place without a flash. Coming
 * back from the IdP it is the same frame with «Completando el ingreso…» (`ssoReturn`).
 */
export function RestoringSession({ ssoReturn = false }: { ssoReturn?: boolean }) {
  const { t } = useTranslation();
  return (
    <LoginLayout>
      <div className="login-form login-restoring" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>{t(ssoReturn ? 'auth.completingSignIn' : 'auth.restoring')}</span>
      </div>
    </LoginLayout>
  );
}
