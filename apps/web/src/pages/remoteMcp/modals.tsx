import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Modal } from '../../components/Modal';
import {
  DEFAULT_SECRET_DAYS,
  REASON_MAX_LENGTH,
  SECRET_MAX_LENGTH,
  dayInput,
  expiryError,
  type Registration,
  type RemoteProfile,
} from './model';
import { RmField } from './parts';
import type { RemoteAction } from './useRemoteCatalog';

type Act = (
  action: RemoteAction,
  names: { name: string; organization: string },
) => Promise<string | null>;

/**
 * Design `RotateModal`: a new secret of the Entra app, without another approval (D93 (7)). The
 * secret lives only in this component's state, in a password field, until it is sent.
 */
export function RotateModal({
  registration,
  profile,
  onAct,
  onClose,
}: {
  registration: Registration;
  profile: RemoteProfile;
  onAct: Act;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState('');
  const [expiresOn, setExpiresOn] = useState(() => dayInput(DEFAULT_SECRET_DAYS));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const expiry = expiryError(expiresOn);
  const save = async () => {
    setTried(true);
    if (!secret.trim() || expiry) return;
    setBusy(true);
    setFailure(null);
    const error = await onAct(
      { kind: 'rotate', registration, secret, expiresOn },
      { name: profile.name, organization: registration.organization },
    );
    setBusy(false);
    if (error) {
      setFailure(error);
      return;
    }
    setSecret('');
    onClose();
  };
  return (
    <Modal
      title={t('remoteMcp.rotate.title')}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
            {t('remoteMcp.rotate.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => {
              void save();
            }}
          >
            {t('remoteMcp.rotate.save')}
          </button>
        </>
      }
    >
      <p className="rm-p">{t('remoteMcp.rotate.body')}</p>
      <div className="rm-form">
        <RmField
          id="rm-rs"
          label={t('remoteMcp.rotate.secret')}
          hint={t('remoteMcp.rotate.secretHint')}
          error={tried && !secret.trim() ? t('remoteMcp.rotate.secretRequired') : null}
        >
          <input
            id="rm-rs"
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={SECRET_MAX_LENGTH}
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value);
            }}
            autoFocus
          />
        </RmField>
        <RmField
          id="rm-re"
          label={t('remoteMcp.rotate.expiry')}
          hint={t('remoteMcp.rotate.expiryHint')}
          error={
            tried && expiry
              ? t(`remoteMcp.form.errors.${expiry}` as 'remoteMcp.form.errors.guid')
              : null
          }
        >
          <input
            id="rm-re"
            className="input"
            type="date"
            value={expiresOn}
            onChange={(event) => {
              setExpiresOn(event.target.value);
            }}
          />
        </RmField>
      </div>
      {failure ? (
        <div className="g-err mt-3" role="alert">
          {failure}
        </div>
      ) : null}
    </Modal>
  );
}

/** Design `DisableModal`: the reason is required; agents keep their version without the tools. */
export function DisableModal({
  registration,
  profile,
  onAct,
  onClose,
}: {
  registration: Registration;
  profile: RemoteProfile;
  onAct: Act;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const go = async () => {
    setTried(true);
    if (!reason.trim()) return;
    setBusy(true);
    setFailure(null);
    const error = await onAct(
      { kind: 'disable', registration, reason: reason.trim() },
      { name: profile.name, organization: registration.organization },
    );
    setBusy(false);
    if (error) {
      setFailure(error);
      return;
    }
    onClose();
  };
  return (
    <Modal
      title={t('remoteMcp.disable.title', { name: profile.name })}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
            {t('remoteMcp.disable.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm mk-danger"
            disabled={busy}
            onClick={() => {
              void go();
            }}
          >
            {t('remoteMcp.disable.confirm')}
          </button>
        </>
      }
    >
      <p className="rm-p">{t('remoteMcp.disable.body', { name: profile.name })}</p>
      <p className="rm-p">{t('remoteMcp.disable.again')}</p>
      <RmField
        id="rm-dw"
        label={t('remoteMcp.disable.reason')}
        error={tried && !reason.trim() ? t('remoteMcp.disable.reasonRequired') : null}
      >
        <textarea
          id="rm-dw"
          className="input"
          rows={2}
          maxLength={REASON_MAX_LENGTH}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          autoFocus
        />
      </RmField>
      {failure ? (
        <div className="g-err mt-3" role="alert">
          {failure}
        </div>
      ) : null}
    </Modal>
  );
}

export type { Act };
