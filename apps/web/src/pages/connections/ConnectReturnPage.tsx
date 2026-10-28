import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MangoIcon } from '../../components/icons';
import { RelayingCard, ReturnCard } from './ReturnCard';
import { CLOSE_AFTER_MS, relayOnce, type Outcome } from './returnRelay';

function useRelay(): Outcome | null {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    let active = true;
    void relayOnce().then((next) => {
      if (active) setOutcome(next);
    });
    return () => {
      active = false;
    };
  }, []);
  return outcome;
}

/**
 * `/conexiones/vuelta`, where AgentCore Identity sends the person back (design `connect-return`,
 * round 24, D100). A tab of its own, full screen with the brand, outside the app's frame and
 * without a session: it only passes the `session_id` to the tab that asked, which closes the
 * consent. The `session_id` was taken from the URL before anything rendered (consentReturn.ts).
 */
export function ConnectReturnPage() {
  const { t } = useTranslation();
  const outcome = useRelay();

  // Opened by Mango or not, a script may close it only if the browser lets it; when it does not,
  // the button stays (design: «se cierra sola»; no `window.opener`, see navigation.ts).
  const ok = outcome?.result === 'ok';
  useEffect(() => {
    if (!ok) return;
    const timer = window.setTimeout(() => {
      window.close();
    }, CLOSE_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [ok]);

  const openMango = () => {
    window.location.assign('/');
  };

  return (
    <main className="rm-ret-full">
      <div className="rm-ret-brand">
        <MangoIcon size={18} />
        <span>{t('connections.ret.brand')}</span>
      </div>
      {outcome === null ? (
        <RelayingCard />
      ) : (
        <ReturnCard result={outcome.result} service={outcome.service} idp={outcome.idp}>
          {outcome.result === 'ok' ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                window.close();
                // Still here: the browser did not let the page close itself.
                window.setTimeout(openMango, 300);
              }}
            >
              {t('connections.ret.closeTab')}
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={openMango}>
              {t('connections.ret.openMango')}
            </button>
          )}
        </ReturnCard>
      )}
    </main>
  );
}
