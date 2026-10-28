import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToasts } from '../../components/admin/useToasts';
import { ExternalIcon, GlobeIcon, X2Icon } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { formatRelative } from '../../lib/format';
import { RmTile } from '../remoteMcp/parts';
import { useConnections, type ConsentPhase } from './ConnectionsContext';
import {
  connectErrorOf,
  finishErrorOf,
  idpOf,
  idpsOf,
  rowStateOf,
  type Connection,
  type ConnectError,
  type FinishError,
} from './model';

function Row({
  connection,
  already,
  phase,
  error,
  finish,
  onConnect,
  onDisconnect,
}: {
  connection: Connection;
  already: boolean;
  phase: ConsentPhase | null;
  error: ConnectError | null;
  finish: FinishError | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const state = rowStateOf(connection, phase);
  const service = connection.service;
  const idp = idpOf(connection);
  // A failed «Conectar», or a consent this tab could not finish (D100, design `FINISH_ERR`).
  const shown: ConnectError | null =
    error ??
    (finish === 'expired'
      ? { title: t('connections.row.expiredTitle'), body: t('connections.row.expiredBody') }
      : finish
        ? finishErrorOf(t, finish, connection)
        : null);
  const failed = shown !== null && state === 'none';
  let line;
  if (failed) {
    line = (
      <span role="alert" className="text-danger">
        <b>{shown.title}.</b> {shown.body}
      </span>
    );
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
        <span className="g-spin" aria-hidden="true" /> {t('connections.row.opening', { idp })}
      </span>
    );
  } else if (state === 'waiting') {
    line = t('connections.row.waiting', { idp });
  } else if (state === 'finishing') {
    line = (
      <span className="flex items-center gap-2">
        <span className="g-spin" aria-hidden="true" /> {t('connections.row.finishing')}
      </span>
    );
  } else if (state === 'onBlocked') {
    line = t('connections.row.onBlocked', { service });
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
        <div className="rm-conn-s" role={failed ? undefined : 'status'}>
          {line}
        </div>
      </div>
      {state === 'none' && (
        <button
          type="button"
          className={failed ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
          onClick={onConnect}
        >
          {failed ? t('connections.retry') : t('connections.connect')}
        </button>
      )}
      {state === 'waiting' && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={onConnect}
          title={t('connections.reopenTitle', { idp })}
        >
          {t('connections.reopen')} <ExternalIcon size={11} />
        </button>
      )}
      {/* D97. With the app's secret expired the API still disconnects a connected account (design
          round 24: «Tu cuenta sigue conectada…»); with nothing connected there is nothing to remove. */}
      {(state === 'on' || state === 'onBlocked') && (
        <button type="button" className="btn btn-sm" onClick={onDisconnect}>
          {t('connections.disconnect')}
        </button>
      )}
    </div>
  );
}

/** «Mis conexiones» (design remote-views.jsx `MyConnections`), opened from the person's menu. */
export function MyConnections({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { status, list, reload, connect, phaseOf, finishErrorOf: finishOf } = useConnections();
  const { notify, stack } = useToasts();
  const [already, setAlready] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, ConnectError>>>({});
  const [leaving, setLeaving] = useState<Connection | null>(null);

  const onConnect = (connection: Connection) => {
    const id = connection.registration_id;
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
    );
    connect(id).then(
      (outcome) => {
        if (outcome === 'already') setAlready((current) => new Set(current).add(id));
        // 'opening': the provider is in another tab; the row says «Inicia sesión … en la otra
        // pestaña» until the return comes back here.
      },
      (error: unknown) => {
        setErrors((current) => ({
          ...current,
          [id]: connectErrorOf(t, error, connection),
        }));
      },
    );
  };

  const idps = idpsOf(list);
  // Design: «Desconectar» takes the place of the list while it is open.
  if (leaving) {
    return (
      <DisconnectModal
        connection={leaving}
        onClose={() => {
          setLeaving(null);
        }}
        onDone={() => {
          setLeaving(null);
          setAlready((current) => {
            const next = new Set(current);
            next.delete(leaving.registration_id);
            return next;
          });
          notify(t('connections.disconnectDialog.done', { service: leaving.service }), 'success');
        }}
      />
    );
  }
  return (
    <>
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
                phase={phaseOf(connection.registration_id)}
                error={errors[connection.registration_id] ?? null}
                finish={finishOf(connection.registration_id)}
                onConnect={() => {
                  onConnect(connection);
                }}
                onDisconnect={() => {
                  setLeaving(connection);
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
      {stack}
    </>
  );
}

/**
 * «Desconectar {servicio}» (design `DisconnectModal`, D97): Mango deletes the person's connection.
 * It never says that the provider took the permission away: it does not.
 */
function DisconnectModal({
  connection,
  onClose,
  onDone,
}: {
  connection: Connection;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { disconnect } = useConnections();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const service = connection.service;
  const idp = idpOf(connection);
  const go = () => {
    setBusy(true);
    setFailed(false);
    disconnect(connection.registration_id).then(
      () => {
        setBusy(false);
        onDone();
      },
      // `disconnect_not_confirmed`, or any other failure: the connection may still be there.
      () => {
        setBusy(false);
        setFailed(true);
      },
    );
  };
  return (
    <Modal
      title={t('connections.disconnectDialog.title', { service })}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
            {t('connections.disconnectDialog.cancel')}
          </button>
          <button type="button" className="btn btn-sm mk-danger" onClick={go} disabled={busy}>
            {busy ? (
              <>
                <span className="g-spin" aria-hidden="true" />{' '}
                {t('connections.disconnectDialog.busy')}
              </>
            ) : failed ? (
              t('connections.retry')
            ) : (
              t('connections.disconnect')
            )}
          </button>
        </>
      }
    >
      <p className="rm-p">{t('connections.disconnectDialog.body', { service })}</p>
      <ul className="rm-ul">
        <li>{t('connections.disconnectDialog.chat')}</li>
        <li>{t('connections.disconnectDialog.tasks')}</li>
        <li>{t('connections.disconnectDialog.again', { idp })}</li>
      </ul>
      <div className="rm-hint">{t('connections.disconnectDialog.provider', { idp })}</div>
      {failed && (
        <div className="mc-alert red mt-3.5" role="alert">
          <X2Icon size={14} />
          <div>
            <b>{t('connections.disconnectDialog.failedTitle')}</b>
            <div>{t('connections.disconnectDialog.failedBody')}</div>
          </div>
        </div>
      )}
    </Modal>
  );
}
