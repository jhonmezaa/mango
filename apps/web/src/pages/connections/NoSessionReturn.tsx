import { useTranslation } from 'react-i18next';

import { MangoIcon } from '../../components/icons';
import { ReturnCard } from './ReturnCard';

/**
 * Back from the provider with no session of Mango in this browser (design `RemoteReturn`,
 * `nosession`). Signing in with Mango's own form does not reload the page, so the consent is
 * closed right after it. Without a session nothing says which service it was: no service line.
 */
export function NoSessionReturn({ onSignIn }: { onSignIn: () => void }) {
  const { t } = useTranslation();
  return (
    <main className="rm-ret-full">
      <div className="rm-ret-brand">
        <MangoIcon size={18} />
        <span>{t('connections.ret.brand')}</span>
      </div>
      <ReturnCard result="nosession" service={null} idp={null}>
        <button type="button" className="btn btn-sm btn-primary" onClick={onSignIn}>
          {t('connections.ret.signIn')}
        </button>
      </ReturnCard>
    </main>
  );
}
