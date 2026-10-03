import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import type { MfaReset } from '../../api/mfaResetSchemas';
import type { Me } from '../../api/schemas';
import { formatRelative } from '../../lib/format';
import { isEmail } from '../../pages/login/validation';
import { Reason } from '../admin/govKit';

/** Must match `REQUEST_LIFETIME` in `apps/api/src/mango_api/mfa_reset.py` (D28). */
export const MFA_RESET_TTL_HOURS = 72;

const STATUS_BADGE: Record<MfaReset['status'], string> = {
  pending: 'badge-amber',
  approved: 'badge-green',
  rejected: 'badge-red',
  withdrawn: '',
  expired: '',
};

const ERROR_KEYS = {
  user_not_found: 'auth.mfaReset.errors.notFound',
  self_reset: 'auth.mfaReset.errors.self',
  already_pending: 'auth.mfaReset.errors.pending',
  // Approve, reject or withdraw on a request that is closed already (design `ChangeList`).
  version_conflict: 'auth.mfaReset.errors.notPending',
  expired: 'auth.mfaReset.errors.notPending',
} as const;

function errorKey(error: unknown) {
  const code = error instanceof ApiError ? error.code : '';
  return code in ERROR_KEYS
    ? ERROR_KEYS[code as keyof typeof ERROR_KEYS]
    : ('auth.mfaReset.errors.generic' as const);
}

function ResetItem({
  item,
  me,
  rejecting,
  onRejecting,
  onWithdraw,
  onApprove,
  onReject,
}: {
  item: MfaReset;
  me: Me;
  /** Whether this request shows its reject note; the list keeps a single one open. */
  rejecting: boolean;
  onRejecting: (open: boolean) => void;
  /** Each action resolves to whether it was applied; a failure is shown by the block. */
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
  const mine = item.proposed_by === me.user_id;
  const aboutMe = item.target_user === me.user_id;
  const who = item.proposed_by_email ?? item.proposed_by;
  const decidedBy = item.decided_by_email ?? item.decided_by;
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
              {t('auth.mfaReset.itemTitle', { email: item.target_email ?? item.target_user })}
            </span>
            <span className={`badge ${STATUS_BADGE[item.status]}`}>
              {t(`auth.mfaReset.status.${item.status}`)}
            </span>
          </div>
          <div className="chg-m">
            <span>{mine ? t('auth.mfaReset.mine') : t('auth.mfaReset.by', { who })}</span>
            <span>{formatRelative(item.created_at)}</span>
            <span className="mono">{item.change_id.slice(0, 8)}</span>
            {item.status === 'expired' && (
              <span>{t('auth.mfaReset.expiredMeta', { hours: MFA_RESET_TTL_HOURS })}</span>
            )}
            {item.status === 'withdrawn' && <span>{t('auth.mfaReset.withdrawnBy', { who })}</span>}
            {decidedBy && item.status === 'approved' && (
              <span>{t('auth.mfaReset.approvedBy', { who: decidedBy })}</span>
            )}
            {decidedBy && item.status === 'rejected' && (
              <span>{t('auth.mfaReset.rejectedBy', { who: decidedBy })}</span>
            )}
          </div>
        </div>
        {item.status === 'pending' && (
          <div className="chg-act">
            {mine ? (
              <>
                <Reason>{t('auth.mfaReset.needsOther')}</Reason>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    run(onWithdraw);
                  }}
                >
                  {t('auth.mfaReset.withdraw')}
                </button>
              </>
            ) : aboutMe ? (
              <Reason>{t('auth.mfaReset.aboutYou')}</Reason>
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
                  {t('auth.mfaReset.reject')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => {
                    run(onApprove);
                  }}
                >
                  {t('auth.mfaReset.approve')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="chg-diff">
        <span className="new">
          {item.identity_verified ? t('auth.mfaReset.summaryVerified') : t('auth.mfaReset.summary')}
        </span>
      </div>
      <div className="chg-why">
        <span className="g-diff-k">{t('auth.mfaReset.reasonLabel')}</span> {item.reason}
      </div>
      {item.note && (
        <div className="chg-why">
          <span className="g-diff-k">{t('auth.mfaReset.rejectReasonLabel')}</span> {item.note}
        </div>
      )}
      {rejecting && (
        <div className="g-field chg-reject">
          <textarea
            ref={noteRef}
            className="input"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
            placeholder={t('auth.mfaReset.rejectPlaceholder')}
            aria-label={t('auth.mfaReset.rejectReasonLabel')}
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
              {t('auth.mfaReset.cancel')}
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
              {t('auth.mfaReset.reject')}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * Settings › General › Autenticación: reset another user's MFA with dual approval (design
 * `MfaResetBlock` + `ChangeList kind="mfa_reset"`, D20). The server enforces every rule,
 * including the out-of-band identity declaration; the UI only mirrors them (REACT-AUTHZ-001).
 * Withdrawn and expired requests stay in the list with their status.
 */
export function MfaResetBlock({
  api,
  me,
  notify,
  exampleDomain,
}: {
  api: ApiClient;
  me: Me;
  notify: (message: string) => void;
  /** Company domain for the example in the email placeholder (design: "usuario3@empresa.com"). */
  exampleDomain?: string | undefined;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MfaReset[]>([]);
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [verified, setVerified] = useState(false);
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Design `ChangeList`: one reject note for the whole list; opening another closes this one.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const own = Boolean(me.email) && email.trim().toLowerCase() === me.email?.toLowerCase();

  const [listError, setListError] = useState(false);

  const load = useCallback(() => {
    api.listMfaResets().then(
      (list) => {
        setItems(list);
        setListError(false);
      },
      () => {
        setListError(true);
      },
    );
  }, [api]);

  useEffect(load, [load]);

  const target = email.trim().toLowerCase();
  const pending = items.some((i) => i.status === 'pending' && i.target_email === target);
  const localError = !target
    ? t('auth.mfaReset.errors.email')
    : !isEmail(target)
      ? t('auth.mfaReset.errors.emailFormat')
      : own
        ? t('auth.mfaReset.errors.self')
        : pending
          ? t('auth.mfaReset.errors.pending')
          : !reason.trim()
            ? t('auth.mfaReset.errors.reason')
            : !verified
              ? t('auth.mfaReset.errors.verified')
              : null;
  const shownError = tried ? (localError ?? serverError) : null;

  const submit = () => {
    setTried(true);
    setServerError(null);
    if (localError || sending) return;
    setSending(true);
    api
      .proposeMfaReset(email, reason, true)
      .then(
        () => {
          notify(t('auth.mfaReset.sent'));
          setEmail('');
          setReason('');
          setVerified(false);
          setTried(false);
          load();
        },
        (error: unknown) => {
          setServerError(t(errorKey(error)));
        },
      )
      .finally(() => {
        setSending(false);
      });
  };

  const act = (action: () => Promise<MfaReset[]>) => async () => {
    setActionError(null);
    try {
      setItems(await action());
      return true;
    } catch (error) {
      setActionError(t(errorKey(error)));
      return false;
    }
  };

  return (
    <section className="mfa-reset">
      <div className="g-sec-t">{t('auth.mfaReset.title')}</div>
      <div className="g-sec-meta">{t('auth.mfaReset.desc', { hours: MFA_RESET_TTL_HOURS })}</div>
      <div className="card mfa-reset-card">
        <div className="mfa-reset-row">
          <input
            className="input mfa-reset-email"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(e) => {
              // Design `MfaResetBlock`: editing the email clears whatever error is showing.
              setEmail(e.target.value);
              setServerError(null);
              setTried(false);
            }}
            placeholder={
              exampleDomain
                ? t('auth.mfaReset.emailPlaceholder', { domain: exampleDomain })
                : t('auth.mfaReset.email')
            }
            aria-label={t('auth.mfaReset.email')}
          />
          <input
            className="input mfa-reset-reason"
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
            placeholder={t('auth.mfaReset.reasonPlaceholder')}
            aria-label={t('auth.mfaReset.reason')}
          />
        </div>
        <label className="mfa-reset-check">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => {
              setVerified(e.target.checked);
            }}
          />
          <span>
            {t('auth.mfaReset.verified')}{' '}
            <span className="mfa-reset-check-hint">{t('auth.mfaReset.verifiedHint')}</span>
          </span>
        </label>
        <div className="mfa-reset-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={submit}
            disabled={sending}
          >
            {t('auth.mfaReset.submit')}
          </button>
        </div>
        {shownError && (
          <div className="g-err" role="alert">
            {shownError}
          </div>
        )}
        {!tried && own && <Reason>{t('auth.mfaReset.ownHint')}</Reason>}
      </div>
      {actionError && (
        <div className="g-err mfa-reset-action-error" role="alert">
          {actionError}
        </div>
      )}
      {listError ? (
        // Design `MfaResetBlock`: the list could not load, so its section shows the error instead.
        <section className="mfa-reset-list">
          <div className="g-sec-t mfa-reset-list-error-title">{t('auth.mfaReset.listTitle')}</div>
          <div className="g-err" role="alert">
            {t('auth.mfaReset.errors.generic')}
          </div>
        </section>
      ) : items.length > 0 ? (
        <section className="mfa-reset-list">
          <div className="g-sec-t">{t('auth.mfaReset.listTitle')}</div>
          <div className="g-sec-meta">{t('auth.mfaReset.listMeta')}</div>
          <div className="chg-list">
            {items.map((item) => (
              <ResetItem
                key={item.change_id}
                item={item}
                me={me}
                rejecting={rejectingId === item.change_id}
                onRejecting={(open) => {
                  setRejectingId((current) =>
                    open ? item.change_id : current === item.change_id ? null : current,
                  );
                }}
                onWithdraw={act(() => api.withdrawMfaReset(item.change_id))}
                onApprove={act(() => api.approveMfaReset(item.change_id))}
                onReject={(note) => act(() => api.rejectMfaReset(item.change_id, note))()}
              />
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
