import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { REASON_MAX_LENGTH, type PendingChange, type Units } from '../../api/adminSchemas';
import { diffUnits, proposerOf, type OuNode } from '../../lib/businessUnits';
import { DiffView } from './DiffView';
import { Banner, GovModal } from './govKit';

/** Error shown inside a dialog. `lock`: the action can no longer succeed (only "Cerrar"). */
export interface DialogError {
  title: string;
  body?: string | undefined;
  lock?: boolean;
}

function ErrorBanner({ error }: { error: DialogError | null }) {
  if (!error) return null;
  return (
    <Banner tone="error" title={error.title}>
      {error.body}
    </Banner>
  );
}

function Motivo({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="g-motivo">
      <span className="g-diff-k">{t('settings.areas.reason')}</span>
      <p>{text}</p>
    </div>
  );
}

interface ApproveProps {
  change: PendingChange;
  current: Units;
  currentVersion: number;
  tree: ReadonlyMap<string, OuNode> | null;
  busy: boolean;
  error: DialogError | null;
  sheet: boolean;
  onClose: () => void;
  onApprove: () => void;
}

/** Approval with the full diff and the version bump it causes (design `ApproveModal`). */
export function ApproveModal({
  change,
  current,
  currentVersion,
  tree,
  busy,
  error,
  sheet,
  onClose,
  onApprove,
}: ApproveProps) {
  const { t } = useTranslation();
  return (
    <GovModal
      title={t('settings.areas.approve.title')}
      sub={t('settings.areas.byWho', { who: proposerOf(change) })}
      onClose={onClose}
      width={600}
      sheet={sheet}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {error?.lock ? t('common.close') : t('common.cancel')}
          </button>
          {!error?.lock && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={onApprove}
            >
              {busy ? t('settings.areas.approve.busy') : t('settings.areas.approve.submit')}
            </button>
          )}
        </>
      }
    >
      <ErrorBanner error={error} />
      <Motivo text={change.reason} />
      <DiffView diffs={diffUnits(current, change.units)} tree={tree} />
      <Banner tone="info">
        {t('settings.areas.approve.info', { from: currentVersion, to: currentVersion + 1 })}
      </Banner>
    </GovModal>
  );
}

interface RejectProps {
  change: PendingChange;
  busy: boolean;
  error: DialogError | null;
  sheet: boolean;
  onClose: () => void;
  onReject: (reason: string) => void;
}

/** Rejection with a required reason and a live counter (design `RejectModal`). */
export function RejectModal({ change, busy, error, sheet, onClose, onReject }: RejectProps) {
  const { t } = useTranslation();
  const id = useId();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const fieldError = !reason.trim()
    ? t('settings.areas.reject.required')
    : reason.length > REASON_MAX_LENGTH
      ? t('settings.areas.maxChars')
      : null;
  const submit = () => {
    setTried(true);
    if (!fieldError) onReject(reason.trim());
  };
  return (
    <GovModal
      title={t('settings.areas.reject.title')}
      sub={t('settings.areas.byWho', { who: proposerOf(change) })}
      onClose={onClose}
      sheet={sheet}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {error?.lock ? t('common.close') : t('common.cancel')}
          </button>
          {!error?.lock && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={submit}
            >
              {t('settings.areas.reject.submit')}
            </button>
          )}
        </>
      }
    >
      <ErrorBanner error={error} />
      <div className="g-field">
        <div className="flex items-center justify-between">
          <label htmlFor={id}>{t('settings.areas.reject.label')}</label>
          <span
            className={reason.length > REASON_MAX_LENGTH ? 'g-sub g-num g-err mt-0' : 'g-sub g-num'}
          >
            {reason.length} / {REASON_MAX_LENGTH}
          </span>
        </div>
        <textarea
          id={id}
          className={tried && fieldError ? 'input has-error' : 'input'}
          rows={4}
          value={reason}
          disabled={busy}
          data-autofocus=""
          placeholder={t('settings.areas.reject.placeholder')}
          aria-invalid={tried && fieldError ? true : undefined}
          aria-describedby={`${id}-h`}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        <div id={`${id}-h`} className={tried && fieldError ? 'g-err' : 'g-hint'}>
          {tried && fieldError ? fieldError : t('settings.areas.reasonHint')}
        </div>
      </div>
    </GovModal>
  );
}

interface WithdrawProps {
  change: PendingChange;
  current: Units;
  tree: ReadonlyMap<string, OuNode> | null;
  busy: boolean;
  error: DialogError | null;
  onClose: () => void;
  onWithdraw: () => void;
}

/** Withdraws your own proposal (design: withdraw modal in gov/areas.jsx). */
export function WithdrawModal({
  change,
  current,
  tree,
  busy,
  error,
  onClose,
  onWithdraw,
}: WithdrawProps) {
  const { t } = useTranslation();
  return (
    <GovModal
      title={t('settings.areas.withdraw.title')}
      sub={t('settings.areas.withdraw.sub')}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {error?.lock ? t('common.close') : t('common.cancel')}
          </button>
          {!error?.lock && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={onWithdraw}
            >
              {t('settings.areas.withdraw.submit')}
            </button>
          )}
        </>
      }
    >
      <ErrorBanner error={error} />
      <DiffView diffs={diffUnits(current, change.units)} tree={tree} />
    </GovModal>
  );
}
