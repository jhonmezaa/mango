import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GlobeIcon } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { Soon } from '../../components/Soon';
import { formatRelative } from '../../lib/format';
import { RmTile } from '../remoteMcp/parts';
import { useConnections } from './ConnectionsContext';
import { connectErrorText, idpOf, idpsOf, rowStateOf, type Connection } from './model';

function Row({
  connection,
  already,
  opening,
  error,
  onConnect,
}: {
  connection: Connection;
  already: boolean;
  opening: boolean;
  error: string | null;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  const state = rowStateOf(connection, opening);
  const service = connection.service;
  let line;
  if (error) {
    line = error;
  } else if (already && state === 'on') {
    line = (
      <span className="flex items-center gap-2">
        <span className="dot dot-green" aria-hidden="true" /> {t('connections.row.already')}
      </span>
    );
  } else if (state === 'off') {
    line = t('connections.row.off', { service });
  } else if (state === 'opening') {
    line = (
      <span className="flex items-center gap-2">
        <span className="g-spin" aria-hidden="true" />{' '}
        {t('connections.row.opening', { idp: idpOf(connection) })}
      </span>
    );
  } else if (state === 'on') {
    line = (
      <span className="flex items-center gap-2">
        <span className="dot dot-green" aria-hidden="true" />{' '}
        {connection.connected_at
          ? t('connections.row.onAt', { when: formatRelative(connection.connected_at) })
          : t('connections.row.onNow')}
      </span>
    );
  } else if (state === 'blocked') {
    line = t('connections.row.blocked', { service });
  } else {
    line = t('connections.row.none');
  }
  return (
    <div className="rm-conn">
      <RmTile profile={{ name: service }} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mk-name">{service}</span>
          <span className="mk-meta mono">{connection.organization}</span>
        </div>
        <div className="rm-conn-s" role={error ? 'alert' : 'status'}>
          {line}
        </div>
      </div>
      {state === 'none' && (
        <button type="button" className="btn btn-sm btn-primary" onClick={onConnect}>
          {t('connections.connect')}
        </button>
      )}
      {/* D97: the API disconnects; the button waits for the design's text. */}
      {state === 'on' && (
        <Soon name={t('soon.item', { label: t('connections.disconnect') })}>
          <span className="btn btn-sm">{t('connections.disconnect')}</span>
        </Soon>
      )}
    </div>
  );
}

/** «Mis conexiones» (design remote-views.jsx `MyConnections`), opened from the person's menu. */
export function MyConnections({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { status, list, reload, connect } = useConnections();
  const [already, setAlready] = useState<ReadonlySet<string>>(new Set());
  const [opening, setOpening] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const onConnect = (connection: Connection) => {
    const id = connection.registration_id;
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
    );
    setOpening(id);
    connect(id).then(
      (outcome) => {
        if (outcome === 'already') {
          setOpening(null);
          setAlready((current) => new Set(current).add(id));
        }
        // 'opening': the page is leaving for the provider; the row keeps «Abriendo…».
      },
      (error: unknown) => {
        setOpening(null);
        setErrors((current) => ({
          ...current,
          [id]: connectErrorText(t, error, connection.service),
        }));
      },
    );
  };

  const idps = idpsOf(list);
  return (
    <Modal title={t('connections.title')} onClose={onClose}>
      <p className="rm-p">{t('connections.intro')}</p>
      {list.length === 0 && status === 'loading' ? (
        <p role="status" className="flex items-center gap-2.5 text-muted">
          <span className="spinner" aria-hidden="true" />
          {t('connections.loading')}
        </p>
      ) : list.length === 0 && status === 'error' ? (
        <div className="mc-alert red" role="alert">
          <div className="flex-1">{t('connections.loadError')}</div>
          <button type="button" className="btn btn-sm" onClick={reload}>
            {t('connections.retry')}
          </button>
        </div>
      ) : list.length === 0 ? (
        <div className="rm-empty">
          <GlobeIcon size={18} />
          <div>{t('connections.empty')}</div>
        </div>
      ) : (
        <div className="rm-conns">
          {list.map((connection) => (
            <Row
              key={connection.registration_id}
              connection={connection}
              already={already.has(connection.registration_id)}
              opening={opening === connection.registration_id}
              error={errors[connection.registration_id] ?? null}
              onConnect={() => {
                onConnect(connection);
              }}
            />
          ))}
        </div>
      )}
      {list.length > 0 && (
        <div className="rm-hint mt-3.5">
          {t('connections.hint', {
            idps: idps.join(t('connections.hintOr')),
            idp: idps.length === 1 ? idps[0] : t('connections.hintProvider'),
          })}
        </div>
      )}
    </Modal>
  );
}
