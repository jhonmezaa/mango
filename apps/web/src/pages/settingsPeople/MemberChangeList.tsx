import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/schemas';
import { Reason } from '../../components/admin/govKit';
import { formatRelative } from '../../lib/format';
import { CHANGE_TTL_HOURS, REASON_MAX_LENGTH, isSelf, type MemberChange } from './model';

const STATUS_BADGE: Record<MemberChange['status'], string> = {
  pending: 'badge-amber',
  approved: 'badge-green',
  rejected: 'badge-red',
  withdrawn: '',
  expired: '',
};

function ChangeItem({
  change,
  me,
  rejecting,
  onRejecting,
  onWithdraw,
  onApprove,
  onReject,
}: {
  change: MemberChange;
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
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Design `ChangeList`: "Rechazar" opens the note with the focus already in it.
  useEffect(() => {
    if (rejecting) noteRef.current?.focus();
  }, [rejecting]);
  const mine = change.proposed_by === me.user_id;
  // The API refuses it (`self_change`); saying so first spares the round trip. Only a hint.
  const aboutMe = isSelf(me, { user_id: change.target_user, email: change.target_email });
  const who = change.proposed_by_email ?? change.proposed_by;
  const decidedBy = change.decided_by_email ?? change.decided_by;
  const values = { email: change.target_email, group: change.group ?? '' };
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
            <span className="chg-t">{t(`people.changes.titles.${change.kind}`, values)}</span>
            <span className={`badge ${STATUS_BADGE[change.status]}`}>
              {t(`people.changes.status.${change.status}`)}
            </span>
          </div>
          <div className="chg-m">
            <span>{mine ? t('people.changes.mine') : t('people.changes.by', { who })}</span>
            <span>{formatRelative(change.created_at)}</span>
            <span className="mono">{change.change_id.slice(0, 8)}</span>
            {change.status === 'expired' ? (
              <span>{t('people.changes.expiredMeta', { hours: CHANGE_TTL_HOURS })}</span>
            ) : null}
            {change.status === 'withdrawn' ? (
              <span>{t('people.changes.withdrawnBy', { who })}</span>
            ) : null}
            {/* Only when the API knows it: `null` is «not known» and says nothing. */}
            {change.target_in_directory === false ? (
              <span>{t('people.changes.notInDirectory')}</span>
            ) : null}
            {decidedBy && change.status === 'approved' ? (
              <span>{t('people.changes.approvedBy', { who: decidedBy })}</span>
            ) : null}
            {decidedBy && change.status === 'rejected' ? (
              <span>{t('people.changes.rejectedBy', { who: decidedBy })}</span>
            ) : null}
          </div>
        </div>
        {change.status === 'pending' ? (
          <div className="chg-act">
            {mine ? (
              <>
                <Reason>{t('people.changes.needsOther')}</Reason>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    run(onWithdraw);
                  }}
                >
                  {t('people.changes.withdraw')}
                </button>
              </>
            ) : aboutMe ? (
              <Reason>{t('people.changes.aboutYou')}</Reason>
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
                  {t('people.changes.reject')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => {
                    run(onApprove);
                  }}
                >
                  {t('people.changes.approve')}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="chg-diff">
        <span className="new">{t(`people.changes.summary.${change.kind}`, values)}</span>
      </div>
      <div className="chg-why">
        <span className="g-diff-k">{t('people.changes.reasonLabel')}</span> {change.reason}
      </div>
      {change.note ? (
        <div className="chg-why">
          <span className="g-diff-k">{t('people.changes.rejectReasonLabel')}</span> {change.note}
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
            placeholder={t('people.changes.rejectPlaceholder')}
            aria-label={t('people.changes.rejectReasonLabel')}
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
              {t('people.changes.cancel')}
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
              {t('people.changes.reject')}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Changes of people that need a second administrator (design `ChangeList kind="member"`).
 * Reasons and emails come from other administrators and are rendered as text. The buttons mirror
 * the rules; the API enforces them.
 */
export function MemberChangeList({
  changes,
  me,
  error,
  onWithdraw,
  onApprove,
  onReject,
}: {
  changes: readonly MemberChange[];
  me: Me;
  /** Why the last decision was not applied. */
  error: string | null;
  onWithdraw: (change: MemberChange) => Promise<boolean>;
  onApprove: (change: MemberChange) => Promise<boolean>;
  onReject: (change: MemberChange, note: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // Design `ChangeList`: one reject note for the whole list; opening another closes this one.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  if (changes.length === 0) return null;
  return (
    <section className="pp-changes" aria-labelledby="people-changes">
      <h3 id="people-changes" className="g-sec-t">
        {t('people.changes.title')}
      </h3>
      <div className="g-sec-meta mb-2.5">{t('people.changes.meta')}</div>
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
