import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useSession } from '../../auth/useSession';
import { Topbar } from '../../components/Topbar';
import { useConnections } from './ConnectionsContext';
import { capturedReturn, completeConsentOnce } from './consentReturn';
import { UNNAMED_RESULTS, idpOf, returnResultOf, type ReturnResult } from './model';
import { FinishingCard, ReturnCard } from './ReturnCard';

type Outcome = { result: ReturnResult; registrationId: string | null } | null;

/** What the start of the app captured, before any request. */
function initialOutcome(): Outcome {
  const captured = capturedReturn();
  // Nothing in memory: the page was reloaded, or the sign-in went through a full redirect. The
  // pending consent cannot be closed any more: the person presses «Conectar» again (design `lost`).
  if (!captured) return { result: 'lost', registrationId: null };
  if (captured.kind === 'failed') return { result: captured.result, registrationId: null };
  return null;
}

/**
 * `/conexiones/vuelta`, where AgentCore Identity sends the person back (design `connect-return`,
 * P-1): the page closes the consent with `POST /api/oauth/callback` and the person's own access
 * token, and says how it went. The `session_id` was taken from the URL when the app started and
 * only lives in memory (consentReturn.ts).
 */
export function ConnectReturnPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { api } = useSession();
  const { list, ensure, reload, byRegistration, openMine } = useConnections();
  const [outcome, setOutcome] = useState<Outcome>(initialOutcome);

  useEffect(() => {
    ensure();
  }, [ensure]);

  useEffect(() => {
    const captured = capturedReturn();
    if (outcome !== null || captured?.kind !== 'session') return;
    let active = true;
    completeConsentOnce(api, captured.sessionId).then(
      (done) => {
        if (!active) return;
        setOutcome({ result: 'ok', registrationId: done.registration_id });
        reload();
      },
      (error: unknown) => {
        if (active) setOutcome({ result: returnResultOf(error), registrationId: null });
      },
    );
    return () => {
      active = false;
    };
  }, [api, outcome, reload]);

  // The service of the registration that was closed; when it is unknown and the person has only
  // one service, that one (the pilot has one).
  const named = outcome?.registrationId ? byRegistration(outcome.registrationId) : null;
  const services = [...new Set(list.map((item) => item.service))];
  const unnamed = outcome !== null && UNNAMED_RESULTS.has(outcome.result);
  const shown = unnamed ? null : (named ?? (services.length === 1 ? (list[0] ?? null) : null));
  const service = shown?.service ?? null;
  const idp = shown ? idpOf(shown) : null;

  const toChat = () => {
    void navigate('/');
  };
  const toConnections = () => {
    void navigate('/');
    openMine();
  };

  const crumbs = [t('connections.ret.crumb'), ...(service ? [service] : [])];
  return (
    <>
      <Topbar crumbs={crumbs} />
      <div className="content">
        {outcome === null ? (
          <FinishingCard service={service} idp={idp} />
        ) : (
          <ReturnCard result={outcome.result} service={service} idp={idp}>
            {outcome.result === 'ok' ? (
              <>
                <button type="button" className="btn btn-sm btn-primary" onClick={toChat}>
                  {t('connections.ret.toChat')}
                </button>
                <button type="button" className="btn btn-sm" onClick={toConnections}>
                  {t('connections.ret.toConnections')}
                </button>
              </>
            ) : outcome.result === 'notyours' ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={toChat}>
                {t('connections.ret.goChat')}
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-sm btn-primary" onClick={toConnections}>
                  {t('connections.ret.toConnections')}
                </button>
                <button type="button" className="btn btn-sm" onClick={toChat}>
                  {t('connections.ret.toChat')}
                </button>
              </>
            )}
          </ReturnCard>
        )}
      </div>
    </>
  );
}
