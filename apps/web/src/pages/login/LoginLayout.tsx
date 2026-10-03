import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { LoginCarousel } from '../../components/LoginCarousel';

/** Login v2 layout: form column (brand, step, footer) and the brand carousel. */
export function LoginLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="login">
      <main className="login-form-col">
        <div className="login-brand">
          <span className="sb-ws-logo" aria-hidden="true">
            m
          </span>
          <span>{t('app.name')}</span>
        </div>
        {children}
        {footer}
      </main>
      <LoginCarousel />
    </div>
  );
}
