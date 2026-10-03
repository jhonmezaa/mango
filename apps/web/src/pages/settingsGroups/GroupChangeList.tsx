import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/schemas';
import { Reason } from '../../components/admin/govKit';
import { formatRelative } from '../../lib/format';
import { CHANGE_TTL_HOURS, REASON_MAX_LENGTH, type GroupChange } from './model';

const STATUS_BADGE: Record<GroupChange['status'], string> = {
  pending: 'badge-amber',
  approved: 'badge-green',
  rejected: 'badge-red',
  withdrawn: '',
  expired: '',
};

/** One line saying what the request does (design: `summary` of `S.propose`). */
function useSummary() {
  const { t } = useTranslation();
  const shape = (type: 'central' | 'area' | 'general', area: string | null) => {
    const name = t(`groups.changes.typeNames.${type}`);
    return area ? t('groups.changes.withArea', { type: name, area }) : name;
  };
  return (change: GroupChange): string => {
    if (change.kind === 'delete') {
      return change.agents > 0
        ? t('groups.changes.summaryDeleteUsed', { count: change.agents })
        : t('groups.changes.summaryDeleteUnused');
    }
    const after = change.after;
    if (!after) return '';
    if (change.kind === 'create') {
      const type = t(`groups.changes.typeNames.${after.type}`);
      return after.area
        ? t('groups.changes.summaryCreateArea', { type, area: after.area })
        : t('groups.changes.summaryCreate', { type });
    }
    return t('groups.changes.summaryUpdate', {
      from: change.before ? shape(change.before.type, change.before.area) : '',
      to: shape(after.type, after.area),
    });
  };
}

function ChangeItem({
  change,
  me,
  rejecting,
  onRejecting,
  onWithdraw,
  onApprove,
  onReject,
}: {
  change: GroupChange;
  me: Me;
  /** Whether this request shows its reject note; the list keeps a single one open. */
  rejecting: boolean;
  onRejecting: (open: boolean) => void;
  /** Each action resolves to whether it was applied; a failure is shown by the list. */
  onWithdraw: () => Promise<boolean>;
  onApprove: () => Promise<boolean>;
  onReject: (note: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const summary = useSummary();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Design `ChangeList`: "Rechazar" opens the note with the focus already in it.
  useEffect(() => {
    if (rejecting) noteRef.current?.focus();
  }, [rejecting]);
  const mine = change.proposed_by === me.user_id;
  // The API refuses it (`self_edit`); saying so first spares the round trip. Only a hint.
  const member = change.kind !== 'delete' && me.groups.includes(change.group_id);
  const who = change.proposed_by_email ?? change.proposed_by;
  const decidedBy = change.decided_by_email ?? change.decided_by;
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action().finally(() => {
      setBusy(false);
    });
  };

  return (
    <article className="chg">
      <div className="chg-h">
        <div className="chg-main">
          <div className="chg-title-row">
            <span className="chg-t">
              {t(`groups.changes.titles.${change.kind}`, { id: change.group_id })}
            </span>
            <span className={`badge ${STATUS_BADGE[change.status]}`}>
              {t(`groups.changes.status.${change.status}`)}
            </span>
          </div>
          <div className="chg-m">
            <span>{mine ? t('groups.changes.mine') : t('groups.changes.by', { who })}</span>
            <span>{formatRelative(change.created_at)}</span>
            <span className="mono">{change.change_id.slice(0, 8)}</span>
            {change.status === 'expired' ? (
              <span>{t('groups.changes.expiredMeta', { hours: CHANGE_TTL_HOURS })}</span>
            ) : null}
            {change.status === 'withdrawn' ? (
              <span>{t('groups.changes.withdrawnBy', { who })}</span>
            ) : null}
            {decidedBy && change.status === 'approved' ? (
              <span>{t('groups.changes.approvedBy', { who: decidedBy })}</span>
            ) : null}
            {decidedBy && change.status === 'rejected' ? (
              <span>{t('groups.changes.rejectedBy', { who: decidedBy })}</span>
            ) : null}
          </div>
        </div>
        {change.status === 'pending' ? (
          <div className="chg-act">
            {mine ? (
              <>
                <Reason>{t('groups.changes.needsOther')}</Reason>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    run(onWithdraw);
                  }}
                >
                  {t('groups.changes.withdraw')}
                </button>
              </>
            ) : member ? (
              <Reason>{t('groups.changes.memberOf')}</Reason>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    onRejecting(true);
                    setNote('');
                  }}
                >
                  {t('groups.changes.reject')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => {
                    run(onApprove);
                  }}
                >
                  {t('groups.changes.approve')}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="chg-diff">
        <span className="new">{summary(change)}</span>
      </div>
      <div className="chg-why">
        <span className="g-diff-k">{t('groups.changes.reasonLabel')}</span> {change.reason}
      </div>
      {change.note ? (
        <div className="chg-why">
          <span className="g-diff-k">{t('groups.changes.rejectReasonLabel')}</span> {change.note}
        </div>
      ) : null}
      {rejecting ? (
        <div className="g-field chg-reject">
          <textarea
            ref={noteRef}
            className="input"
            rows={2}
            maxLength={REASON_MAX_LENGTH}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            placeholder={t('groups.changes.rejectPlaceholder')}
            aria-label={t('groups.changes.rejectReasonLabel')}
          />
          <div className="chg-reject-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                onRejecting(false);
              }}
            >
              {t('groups.changes.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!note.trim() || busy}
              onClick={() => {
                run(async () => {
                  // Design `ChangeList`: a failed reject keeps the note open to try again.
                  if (await onReject(note.trim())) onRejecting(false);
                });
              }}
            >
              {t('groups.changes.reject')}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Requests to create, change or delete a group (design `ChangeList kind="group"`). Reasons and
 * emails come from other administrators and are rendered as text. The buttons mirror the rules;
 * the API enforces them.
 */
export function GroupChangeList({
  changes,
  me,
  error,
  onWithdraw,
  onApprove,
  onReject,
}: {
  changes: readonly GroupChange[];
  me: Me;
  /** Why the last decision was not applied. */
  error: string | null;
  onWithdraw: (change: GroupChange) => Promise<boolean>;
  onApprove: (change: GroupChange) => Promise<boolean>;
  onReject: (change: GroupChange, note: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // Design `ChangeList`: one reject note for the whole list; opening another closes this one.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  if (changes.length === 0) return null;
  return (
    <section className="gr-changes" aria-labelledby="groups-changes">
      <h3 id="groups-changes" className="g-sec-t">
        {t('groups.changes.title')}
      </h3>
      <div className="g-sec-meta mb-2.5">{t('groups.changes.meta')}</div>
      {error ? (
        <div className="g-err mb-2.5" role="alert">
          {error}
        </div>
      ) : null}
      <div className="chg-list">
        {changes.map((change) => (
          <ChangeItem
            key={change.change_id}
            change={change}
            me={me}
            rejecting={rejectingId === change.change_id}
            onRejecting={(open) => {
              setRejectingId((current) =>
                open ? change.change_id : current === change.change_id ? null : current,
              );
            }}
            onWithdraw={() => onWithdraw(change)}
            onApprove={() => onApprove(change)}
            onReject={(note) => onReject(change, note)}
          />
        ))}
      </div>
    </section>
  );
}
