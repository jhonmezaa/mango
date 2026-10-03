import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert } from '../Alert';
import { Modal } from '../Modal';
import { ArchiveIcon } from './icons';

/** `reason` limit of POST /api/agents/{id}/retire. */
const MAX_REASON = 500;

interface Props {
  name: string;
  /** Resolves to an error message to show, or to null when the agent was retired. */
  onRetire: (reason: string) => Promise<string | null>;
  onClose: () => void;
}

/**
 * «Retirar» with a mandatory reason (design marketplace.jsx `RetireAgent`). The reason goes to
 * the audit trail; the API decides who may retire (`RetireAgent`).
 */
export function RetireAgentModal({ name, onRetire, onClose }: Props) {
  const { t } = useTranslation();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onRetire(trimmed);
    // On success the page closes the dialog.
    if (failure !== null) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('marketplace.retire.title', { name })}
      description={t('marketplace.retire.adminOnly')}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!trimmed || busy}
            onClick={() => void submit()}
          >
            <ArchiveIcon size={11} />
            {busy ? t('marketplace.retire.submitting') : t('marketplace.retire.submit')}
          </button>
        </>
      }
    >
      <p className="mk-retire-note">{t('marketplace.retire.body')}</p>
      <label htmlFor={reasonId} className="mb-1.5 block text-[12.5px]">
        {t('marketplace.retire.reason')}
      </label>
      <textarea
        id={reasonId}
        className="input w-full"
        rows={3}
        maxLength={MAX_REASON}
        value={reason}
        placeholder={t('marketplace.retire.reasonPlaceholder')}
        data-autofocus
        disabled={busy}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      {error ? (
        <Alert tone="red" role="alert" className="mt-3">
          {error}
        </Alert>
      ) : null}
    </Modal>
  );
}
