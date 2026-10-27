import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckIcon, ExternalIcon, MangoIcon } from '../../components/icons';
import { RmTile } from '../remoteMcp/parts';
import { useConnections } from './ConnectionsContext';
import { CONSENT_TTL_MS, connectErrorText, idpOf } from './model';

type CardState = 'ask' | 'opening' | 'done' | 'expired';

function mmss(ms: number): string {
  const left = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, '0')}`;
}

/**
 * «Conecta tu cuenta de {servicio}» (design remote-core.jsx `ConnectCard`): a notice of Mango, not
 * of the agent. It is built from what mango-api said (`remote_connection_required` or the stored
 * `connection_required`) and the person's connections, never from the model's text, and it is
 * drawn outside the Markdown so the answer cannot imitate it. It carries no URL: «Conectar» asks
 * mango-api for one (D98 (20)).
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
  const { ensure, byRegistration, connect } = useConnections();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const connection = byRegistration(registrationId);
  const left = startedAt + CONSENT_TTL_MS - now;
  const state: CardState =
    connection?.status === 'connected'
      ? 'done'
      : opening
        ? 'opening'
        : left <= 0
          ? 'expired'
          : 'ask';

  useEffect(() => {
    ensure();
  }, [ensure]);

  // The countdown only runs while the card asks.
  useEffect(() => {
    if (state !== 'ask') return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [state]);

  // Until the person's connections say which service it is, there is nothing true to show.
  if (!connection) return null;
  const service = connection.service;
  const idp = idpOf(connection);

  const onConnect = () => {
    setError(null);
    setOpening(true);
    connect(registrationId).then(
      (outcome) => {
        // 'already': the list now says «connected» and the card turns to «Conectado».
        if (outcome === 'already') setOpening(false);
      },
      (failure: unknown) => {
        setOpening(false);
        setError(connectErrorText(t, failure, service));
      },
    );
  };

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
        <div className="min-w-0 flex-1" role={state === 'expired' ? 'status' : undefined}>
          {state === 'done' ? (
            <>
              <div className="rm-card-t">{t('connections.card.doneTitle')}</div>
              <div className="rm-card-s">{t('connections.card.doneBody', { service })}</div>
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
          {error && (
            <div className="rm-err" role="alert">
              {error}
            </div>
          )}
        </div>
        {state === 'ask' && (
          <div className="rm-card-a">
            <button type="button" className="btn btn-sm btn-primary" onClick={onConnect}>
              {t('connections.connect')} <ExternalIcon size={11} />
            </button>
            <span className="rm-card-timer">
              {t('connections.card.expiresIn', { time: mmss(left) })}
            </span>
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
