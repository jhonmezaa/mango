import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckIcon, ExternalIcon, MangoIcon } from '../../components/icons';
import { RmTile } from '../remoteMcp/parts';
import { useConnections } from './ConnectionsContext';
import { CONSENT_TTL_MS, connectErrorOf, finishErrorOf, idpOf, type ConnectError } from './model';

type CardState = 'ask' | 'opening' | 'waiting' | 'finishing' | 'done' | 'expired' | 'error';

function mmss(ms: number): string {
  const left = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, '0')}`;
}

/**
 * «Conecta tu cuenta de {servicio}» (design remote-core.jsx `ConnectCard`): a notice of Mango, not
 * of the agent. It is built from what mango-api said (`remote_connection_required` or the stored
 * `connection_required`) and the person's connections, never from the model's text, and it is
 * drawn outside the Markdown so the answer cannot imitate it. It carries no URL: «Conectar» asks
 * mango-api for one (D98 (20)). The provider opens in another tab and this tab closes the consent
 * when it comes back (D100): «Inicia sesión … en la otra pestaña», «Terminando…», «Conectado».
 */
export function ConnectCard({
  registrationId,
  startedAt,
}: {
  registrationId: string;
  /** When the pending consent began (the event's arrival, or the stored message's time). */
  startedAt: number;
}) {
  const { t } = useTranslation();
  const { ensure, byRegistration, connect, phaseOf, finishErrorOf: finishOf } = useConnections();
  const [error, setError] = useState<ConnectError | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const connection = byRegistration(registrationId);
  const phase = phaseOf(registrationId);
  const finish = finishOf(registrationId);
  const left = startedAt + CONSENT_TTL_MS - now;
  const state: CardState =
    connection?.status === 'connected'
      ? 'done'
      : phase !== null
        ? phase
        : left <= 0 || finish === 'expired'
          ? 'expired'
          : error || finish
            ? 'error'
            : 'ask';

  useEffect(() => {
    ensure();
  }, [ensure]);

  // The countdown runs while the card asks or waits, also after a failed «Conectar» (design).
  const counting = state === 'ask' || state === 'error' || state === 'waiting';
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [counting]);

  // Until the person's connections say which service it is, there is nothing true to show.
  if (!connection) return null;
  const service = connection.service;
  const idp = idpOf(connection);

  // 'already': the list now says «connected» and the card turns to «Conectado».
  const onConnect = () => {
    setError(null);
    connect(registrationId).catch((failure: unknown) => {
      setError(connectErrorOf(t, failure, connection));
    });
  };
  const shown =
    error ?? (finish && finish !== 'expired' ? finishErrorOf(t, finish, connection) : null);

  return (
    <section
      className={`rm-card is-${state}`}
      aria-label={t('connections.card.label', { service })}
    >
      <div className="rm-card-h">
        <MangoIcon size={12} />
        <span>{t('connections.card.head')}</span>
        <span className="rm-card-dot" aria-hidden="true">
          ·
        </span>
        <span>{t('connections.card.notAgent')}</span>
      </div>
      <div className="rm-card-b">
        <RmTile profile={{ name: service }} />
        <div
          className="min-w-0 flex-1"
          role={state === 'error' ? 'alert' : state === 'ask' ? undefined : 'status'}
        >
          {state === 'done' ? (
            <>
              <div className="rm-card-t">{t('connections.card.doneTitle')}</div>
              <div className="rm-card-s">{t('connections.card.doneBody', { service })}</div>
            </>
          ) : state === 'waiting' ? (
            <>
              <div className="rm-card-t">{t('connections.card.waitingTitle', { idp })}</div>
              <div className="rm-card-s">{t('connections.card.waitingBody')}</div>
            </>
          ) : state === 'finishing' ? (
            <>
              <div className="rm-card-t">{t('connections.card.finishingTitle')}</div>
              <div className="rm-card-s">{t('connections.card.finishingBody', { service })}</div>
            </>
          ) : state === 'error' && shown ? (
            <>
              <div className="rm-card-t">{shown.title}</div>
              <div className="rm-card-s">{shown.body}</div>
            </>
          ) : state === 'expired' ? (
            <>
              <div className="rm-card-t">{t('connections.card.expiredTitle')}</div>
              <div className="rm-card-s">
                {t('connections.card.expiredBefore')}
                <MineLink />
                {t('connections.card.expiredAfter')}
              </div>
            </>
          ) : (
            <>
              <div className="rm-card-t">{t('connections.card.askTitle', { service })}</div>
              <div className="rm-card-s">{t('connections.card.askBody', { service, idp })}</div>
            </>
          )}
        </div>
        {(state === 'ask' || state === 'error') && (
          <div className="rm-card-a">
            <button
              type="button"
              className={state === 'ask' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              onClick={onConnect}
            >
              {state === 'error' ? (
                t('connections.retry')
              ) : (
                <>
                  {t('connections.connect')} <ExternalIcon size={11} />
                </>
              )}
            </button>
            <span className="rm-card-timer">
              {t('connections.card.expiresIn', { time: mmss(left) })}
            </span>
          </div>
        )}
        {state === 'waiting' && (
          <div className="rm-card-a">
            <button
              type="button"
              className="btn btn-sm"
              onClick={onConnect}
              title={t('connections.reopenTitle', { idp })}
            >
              {t('connections.reopen')} <ExternalIcon size={11} />
            </button>
            <span className="rm-card-timer">
              {t('connections.card.expiresIn', { time: mmss(left) })}
            </span>
          </div>
        )}
        {state === 'finishing' && (
          <div className="rm-card-a">
            <span className="g-spin" aria-hidden="true" />
          </div>
        )}
        {state === 'opening' && (
          <div className="rm-card-a">
            <span className="rm-card-s flex items-center gap-2" role="status">
              <span className="g-spin" aria-hidden="true" />{' '}
              {t('connections.card.opening', { idp })}
            </span>
          </div>
        )}
        {state === 'done' && (
          <span className="g-dot-lg green" aria-hidden="true">
            <CheckIcon size={12} />
          </span>
        )}
      </div>
    </section>
  );
}

function MineLink() {
  const { t } = useTranslation();
  const { openMine } = useConnections();
  return (
    <button type="button" className="sr-link" onClick={openMine}>
      {t('connections.menu')}
    </button>
  );
}
