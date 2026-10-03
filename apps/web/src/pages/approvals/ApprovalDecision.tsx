import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import type { Me } from '../../api/schemas';
import { Badge } from '../../components/Badge';
import { CheckIcon, InfoIcon, LockIcon, PlayIcon, WarnIcon, X2Icon } from '../../components/icons';
import { formatRelative } from '../../lib/format';
import {
  NOTE_MAX_LENGTH,
  REJECT_REASONS,
  STATUS_TONE,
  leftText,
  personOf,
  shortId,
  wasApproved,
  type Approval,
} from './model';
import { useDecision } from './useDecision';

type Mode = 'approve' | 'reject' | null;

interface Props {
  api: ApiClient;
  me: Me;
  approval: Approval;
  /** Whether the account may sign requests (hint of the API; it authorizes each decision). */
  canDecide: boolean;
  /** In the chat card: approve in one click, without the note and the "signing as" line. */
  compact?: boolean;
  /** Clock of the page, so "vence en…" moves with the list; the time it was shown when absent. */
  now?: number;
  onUpdated: (approval: Approval) => void;
  notify: (message: string, tone?: 'success' | 'info' | 'error') => void;
}

/**
 * What the account can do with a request (design `ApprovalDecision`): sign or reject it, cancel
 * its own, or run it once it is approved. The buttons mirror the rules; the API enforces them.
 */
export function ApprovalDecision({
  api,
  me,
  approval,
  canDecide,
  compact = false,
  now,
  onUpdated,
  notify,
}: Props) {
  const { t } = useTranslation();
  const { busy, error, decide, clearError } = useDecision(api, onUpdated);
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [shownAt] = useState(() => Date.now());
  const id = t('approvals.id', { id: shortId(approval) });
  const { status } = approval;
  const failure = error ? (
    <div className="g-err" role="alert">
      {t(error)}
    </div>
  ) : null;

  const run = () => {
    void decide(approval, { kind: 'execute' }).then((next) => {
      if (!next) return;
      if (next.status === 'executed') notify(t('approvals.toast.executed', { id }), 'success');
      else if (next.status === 'failed') notify(t('approvals.toast.notExecuted', { id }), 'error');
    });
  };

  const requester = personOf(approval.requested_by_email, approval.requested_by);
  const cancel = (
    <button
      type="button"
      className="btn btn-sm"
      disabled={busy}
      onClick={() => {
        void decide(approval, { kind: 'cancel' }).then((next) => {
          if (next) notify(t('approvals.toast.cancelled', { id }), 'info');
        });
      }}
    >
      {t('approvals.decision.cancelRequest')}
    </button>
  );
  /** Design `Done`: the final state and who closed it, in one line. */
  const closed = (children: ReactNode) => (
    <div className="ap-closed">
      <Badge tone={STATUS_TONE[status]}>{t(`approvals.status.${status}`)}</Badge>
      {children}
    </div>
  );
  const by = (who: string, at: string | null | undefined) =>
    who && at
      ? t('approvals.decision.closedBy', { who, when: formatRelative(at) })
      : at
        ? formatRelative(at)
        : null;

  if (status === 'executing') {
    return (
      <div className="ap-decision">
        {failure}
        <div className="ap-reason" role="status">
          <span className="g-spin" aria-hidden="true" /> {t('approvals.decision.executing')}
        </div>
      </div>
    );
  }
  if (status === 'executed') {
    return (
      <div className="ap-decision">
        {failure}
        {closed(by(requester, approval.executed_at))}
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="ap-decision">
        {failure}
        {closed(by(requester, approval.executed_at))}
        {approval.error ? (
          <div className="mc-alert red" role="alert">
            <X2Icon size={14} />
            {/* The error is a code of the API, shown as text. */}
            <div className="mono ap-error-code">{approval.error}</div>
          </div>
        ) : null}
        <div className="ap-reason">
          <InfoIcon size={12} /> {t('approvals.decision.failedNote')}
        </div>
      </div>
    );
  }
  if (status === 'cancelled' || status === 'rejected') {
    return (
      <div className="ap-decision">
        {failure}
        {closed(
          <>
            {by(personOf(approval.decided_by_email, approval.decided_by), approval.decided_at)}
            {status === 'rejected' && approval.note
              ? t('approvals.decision.closedNote', { note: approval.note })
              : null}
          </>,
        )}
      </div>
    );
  }
  if (status === 'expired') {
    return (
      <div className="ap-decision">
        {failure}
        {closed(
          <>
            {wasApproved(approval)
              ? t('approvals.decision.expiredApproved')
              : t('approvals.decision.expiredUnsigned')}{' '}
            {t('approvals.decision.askAgain')}
          </>,
        )}
      </div>
    );
  }
  if (status === 'approved') {
    const left = leftText(t, approval, now ?? shownAt);
    if (!approval.mine) {
      return (
        <div className="ap-decision">
          {failure}
          <div className="ap-reason" role="status">
            <CheckIcon size={12} />{' '}
            {t('approvals.decision.waitingRequester', { who: requester, left })}
          </div>
        </div>
      );
    }
    return (
      <div className="ap-decision">
        {failure}
        {approval.error ? (
          // Released by the API: the call never reached the tool, so it can be run again.
          <div className="mc-alert amber" role="alert">
            <WarnIcon size={14} />
            <div>{t('approvals.decision.retryRun')}</div>
          </div>
        ) : null}
        <div className="ap-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={run}>
            <PlayIcon size={11} />{' '}
            {busy ? t('approvals.decision.running') : t('approvals.decision.run')}
          </button>
          {cancel}
          <span className={compact ? 'mk-meta' : 'mk-meta ap-as'}>
            {t('approvals.decision.runBefore', { left })}
          </span>
        </div>
      </div>
    );
  }

  const needed = approval.approvals_needed;
  const given = approval.signatures.length;
  const signed = approval.signatures.some((signature) => signature.user_id === me.user_id);

  if (approval.mine) {
    // Who asked never signs, here or in the chat card: another person must (the API refuses it).
    return (
      <div className="ap-decision">
        {failure}
        <div className="ap-actions">
          <span className="ap-reason ap-own">
            <LockIcon size={12} /> {t('approvals.decision.own')}
          </span>
          {cancel}
        </div>
      </div>
    );
  }
  if (signed) {
    return (
      <div className="ap-reason" role="status">
        <CheckIcon size={12} /> {t('approvals.decision.alreadySigned', { count: needed - given })}
      </div>
    );
  }
  if (!canDecide || !approval.can_sign) {
    return (
      <div className="ap-reason">
        <LockIcon size={12} /> {t('approvals.decision.waitingCentral')}
      </div>
    );
  }

  const last = given + 1 >= needed;
  const approve = () => {
    void decide(approval, { kind: 'approve', note: note.trim() }).then((next) => {
      if (!next) return;
      notify(
        next.status === 'pending'
          ? t('approvals.toast.signed')
          : t('approvals.toast.approved', { id, who: requester }),
        'success',
      );
      setMode(null);
      setNote('');
    });
  };
  const reject = () => {
    setTried(true);
    const reason = note.trim();
    if (!reason) return;
    void decide(approval, { kind: 'reject', reason }).then((next) => {
      if (next) notify(t('approvals.toast.rejected', { id }), 'info');
    });
  };
  const back = () => {
    setMode(null);
    setNote('');
    setTried(false);
    clearError();
  };
  const reasonMissing = tried && !note.trim();
  const fieldId = `ap-note-${approval.approval_id}`;

  return (
    <div className="ap-decision">
      {failure}
      {mode === 'reject' ? (
        <>
          <label htmlFor={fieldId}>{t('approvals.decision.rejectReason')}</label>
          <div className="ap-chips">
            {REJECT_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                className="tk-chip"
                onClick={() => {
                  setNote(t(`approvals.decision.reasons.${reason}`));
                }}
              >
                {t(`approvals.decision.reasons.${reason}`)}
              </button>
            ))}
          </div>
          <textarea
            id={fieldId}
            className={reasonMissing ? 'input has-error' : 'input'}
            rows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            placeholder={t('approvals.decision.rejectPlaceholder')}
            aria-invalid={reasonMissing}
            aria-describedby={reasonMissing ? `${fieldId}-error` : undefined}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          {reasonMissing ? (
            <div id={`${fieldId}-error`} className="ap-field-error" role="alert">
              {t('approvals.decision.rejectRequired')}
            </div>
          ) : null}
        </>
      ) : null}
      {mode === 'approve' ? (
        <>
          <label htmlFor={fieldId}>
            {t('approvals.decision.note')}{' '}
            <span className="ap-optional">{t('approvals.decision.optional')}</span>
          </label>
          <textarea
            id={fieldId}
            className="input"
            rows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            placeholder={t('approvals.decision.notePlaceholder')}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </>
      ) : null}
      <div className="ap-actions">
        {mode === null ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={
                compact
                  ? approve
                  : () => {
                      setMode('approve');
                    }
              }
            >
              <CheckIcon size={12} />{' '}
              {last ? t('approvals.decision.approve') : t('approvals.decision.sign')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                setMode('reject');
              }}
            >
              {t('approvals.decision.reject')}
            </button>
          </>
        ) : null}
        {mode === 'approve' ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={approve}
            >
              <CheckIcon size={12} />{' '}
              {last ? t('approvals.decision.confirmApprove') : t('approvals.decision.confirmSign')}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={back}>
              {t('approvals.decision.cancel')}
            </button>
          </>
        ) : null}
        {mode === 'reject' ? (
          <>
            <button type="button" className="btn btn-sm mk-danger" disabled={busy} onClick={reject}>
              {t('approvals.decision.confirmReject')}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={back}>
              {t('approvals.decision.cancel')}
            </button>
          </>
        ) : null}
        {compact ? null : (
          <span className="mk-meta ap-as">
            {t('approvals.decision.signAs', { who: me.email ?? me.user_id })}
          </span>
        )}
      </div>
    </div>
  );
}
