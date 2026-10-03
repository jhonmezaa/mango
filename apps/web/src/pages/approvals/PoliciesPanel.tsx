import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminErrorKey, apiErrorCode } from '../../api/adminErrors';
import type { ApiClient } from '../../api/client';
import type { Me } from '../../api/schemas';
import { GovErrorState, GovModal, MoneyInput, Reason, Skel } from '../../components/admin/govKit';
import { EditIcon, InfoIcon } from '../../components/icons';
import { formatRelative } from '../../lib/format';
import {
  APPROVER_COUNTS,
  CONDITIONS,
  ENVIRONMENTS,
  EXPIRY_HOURS,
  NOTE_MAX_LENGTH,
  formOf,
  parseAmount,
  parseCount,
  personOf,
  policyAbove,
  policyBelow,
  policySummary,
  ruleOf,
  sameRule,
  type Policies,
  type PolicyChange,
  type PolicyForm,
  type ToolPolicy,
} from './model';

type LoadState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: Policies };
type Notify = (message: string, tone?: 'success' | 'info' | 'error') => void;

const OWN_ERRORS = [
  'already_pending',
  'condition_unsupported',
  'invalid_policy',
  'no_change',
  'same_approver',
] as const;

/** Message of a failed policy action; the server's text is never shown raw. */
function useErrorText() {
  const { t } = useTranslation();
  return (error: unknown): string => {
    const code = OWN_ERRORS.find((known) => known === apiErrorCode(error));
    return code ? t(`approvals.policies.errors.${code}`) : t(adminErrorKey(error));
  };
}

const CHANGE_BADGE: Record<PolicyChange['status'], string> = {
  pending: 'badge-amber',
  approved: 'badge-green',
  rejected: 'badge-red',
  withdrawn: '',
  expired: '',
};

function PolicyModal({
  tool,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  tool: ToolPolicy;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (form: PolicyForm, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PolicyForm>(() => formOf(tool.policy));
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const rule = ruleOf(form);
  const same = rule !== null && sameRule(rule, tool.policy);
  const problem =
    form.condition === 'amount' && parseAmount(form.amount) === null
      ? t('approvals.policies.modal.errors.amount')
      : form.condition === 'count' && parseCount(form.count) === null
        ? t('approvals.policies.modal.errors.count')
        : !reason.trim()
          ? t('approvals.policies.modal.errors.reason')
          : null;
  const patch = (changes: Partial<PolicyForm>) => {
    setForm((current) => ({ ...current, ...changes }));
  };
  const submit = () => {
    setTried(true);
    if (problem || same) return;
    onSubmit(form, reason.trim());
  };
  return (
    <GovModal
      title={t('approvals.policies.modal.title')}
      sub={t('approvals.policies.modal.sub', { tool: tool.tool })}
      onClose={onClose}
      busy={busy}
      sheet
      footer={
        <>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onClose}>
            {t('approvals.policies.modal.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={same || busy}
            onClick={submit}
          >
            {busy ? t('approvals.policies.modal.sending') : t('approvals.policies.modal.submit')}
          </button>
        </>
      }
    >
      <div className="g-field">
        <span className="g-label" id="pol-condition">
          {t('approvals.policies.modal.condition')}
        </span>
        <div className="set-choice" role="group" aria-labelledby="pol-condition">
          {CONDITIONS.map((condition) => {
            // The release says which values a tool reports: the API refuses the others.
            const supported = tool.conditions.includes(condition);
            return (
              <button
                key={condition}
                type="button"
                className={form.condition === condition ? 'is-on' : undefined}
                aria-pressed={form.condition === condition}
                disabled={!supported}
                title={supported ? undefined : t('approvals.policies.modal.conditionUnsupported')}
                onClick={() => {
                  patch({ condition });
                }}
              >
                {t(`approvals.policies.modal.conditions.${condition}`)}
              </button>
            );
          })}
        </div>
        {form.condition === 'always' ? (
          <div className="g-hint">
            {t('approvals.policies.modal.alwaysHint', { count: form.approvers })}
          </div>
        ) : null}
        {form.condition === 'count' ? (
          <>
            <div className="g-hint">{t('approvals.policies.modal.countHint')}</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                className="input w-[90px]"
                aria-label={t('approvals.policies.modal.countLabel')}
                value={form.count}
                onChange={(event) => {
                  patch({ count: event.target.value });
                }}
              />
              <span className="g-hint">{t('approvals.policies.modal.countUnit')}</span>
            </div>
          </>
        ) : null}
        {form.condition === 'environment' ? (
          <>
            <div className="g-hint">{t('approvals.policies.modal.environmentHint')}</div>
            <div className="set-choice">
              {ENVIRONMENTS.map((environment) => (
                <button
                  key={environment}
                  type="button"
                  className={form.environment === environment ? 'is-on' : undefined}
                  aria-pressed={form.environment === environment}
                  onClick={() => {
                    patch({ environment });
                  }}
                >
                  {environment}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {form.condition === 'amount' ? (
        <MoneyInput
          id="pol-amount"
          label={t('approvals.policies.modal.amount')}
          value={form.amount}
          onChange={(amount) => {
            patch({ amount });
          }}
          hint={t('approvals.policies.modal.amountHint', { count: form.approvers })}
        />
      ) : null}
      <div className="g-field">
        <span className="g-label" id="pol-approvers">
          {t('approvals.policies.modal.approvers')}
        </span>
        <div className="set-choice" role="group" aria-labelledby="pol-approvers">
          {APPROVER_COUNTS.map((approvers) => (
            <button
              key={approvers}
              type="button"
              className={form.approvers === approvers ? 'is-on' : undefined}
              aria-pressed={form.approvers === approvers}
              onClick={() => {
                patch({ approvers });
              }}
            >
              {approvers}
            </button>
          ))}
        </div>
        <div className="g-hint">{t('approvals.policies.modal.approversHint')}</div>
      </div>
      <div className="g-field">
        <span className="g-label" id="pol-expires">
          {t('approvals.policies.modal.expires')}
        </span>
        <div className="set-choice" role="group" aria-labelledby="pol-expires">
          {EXPIRY_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              className={form.expiresHours === hours ? 'is-on' : undefined}
              aria-pressed={form.expiresHours === hours}
              onClick={() => {
                patch({ expiresHours: hours });
              }}
            >
              {t('approvals.policies.modal.expiresOption', { hours })}
            </button>
          ))}
        </div>
        <div className="g-hint">{t('approvals.policies.modal.expiresHint')}</div>
      </div>
      <div className="g-field">
        <label htmlFor="pol-why">{t('approvals.policies.modal.reason')}</label>
        <textarea
          id="pol-why"
          className={tried && !reason.trim() ? 'input has-error' : 'input'}
          rows={2}
          maxLength={NOTE_MAX_LENGTH}
          value={reason}
          placeholder={t('approvals.policies.modal.reasonPlaceholder')}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        {error ? (
          <div className="g-err" role="alert">
            {error}
          </div>
        ) : tried && problem ? (
          <div className="g-err" role="alert">
            {problem}
          </div>
        ) : same ? (
          <div className="g-hint">{t('approvals.policies.modal.same')}</div>
        ) : null}
      </div>
    </GovModal>
  );
}

function ChangeItem({
  change,
  me,
  busy,
  onAct,
}: {
  change: PolicyChange;
  me: Me;
  busy: boolean;
  onAct: (action: 'approve' | 'reject' | 'withdraw', reason?: string) => void;
}) {
  const { t } = useTranslation();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const mine = change.proposed_by === me.user_id;
  const who = personOf(change.proposed_by_email, change.proposed_by);
  const decidedBy = personOf(change.decided_by_email, change.decided_by);
  return (
    <article className="chg">
      <div className="chg-h">
        <div className="chg-main">
          <div className="chg-title-row">
            <span className="chg-t">
              {t('approvals.policies.changes.itemTitle', { tool: change.tool })}
            </span>
            <span className={`badge ${CHANGE_BADGE[change.status]}`}>
              {t(`approvals.policies.changes.status.${change.status}`)}
            </span>
          </div>
          <div className="chg-m">
            <span>
              {mine
                ? t('approvals.policies.changes.mine')
                : t('approvals.policies.changes.by', { who })}
            </span>
            <span>{formatRelative(change.created_at)}</span>
            <span className="mono">{change.change_id.slice(0, 8)}</span>
            {decidedBy && change.status === 'approved' ? (
              <span>{t('approvals.policies.changes.approvedBy', { who: decidedBy })}</span>
            ) : null}
            {decidedBy && change.status === 'rejected' ? (
              <span>{t('approvals.policies.changes.rejectedBy', { who: decidedBy })}</span>
            ) : null}
          </div>
        </div>
        {change.status === 'pending' ? (
          <div className="chg-act">
            {mine ? (
              <>
                <Reason>{t('approvals.policies.changes.needsOther')}</Reason>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    onAct('withdraw');
                  }}
                >
                  {t('approvals.policies.changes.withdraw')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setRejecting(true);
                    setNote('');
                  }}
                >
                  {t('approvals.policies.changes.reject')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => {
                    onAct('approve');
                  }}
                >
                  {t('approvals.policies.changes.approve')}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="chg-diff">
        <span className="new">
          {t('approvals.policies.summary.change', {
            from: policySummary(t, change.before),
            to: policySummary(t, change.after),
          })}
        </span>
      </div>
      <div className="chg-why">
        <span className="g-diff-k">{t('approvals.policies.changes.reasonLabel')}</span>{' '}
        {change.reason}
      </div>
      {change.note ? (
        <div className="chg-why">
          <span className="g-diff-k">{t('approvals.policies.changes.rejectReasonLabel')}</span>{' '}
          {change.note}
        </div>
      ) : null}
      {rejecting && change.status === 'pending' ? (
        <div className="g-field chg-reject">
          <textarea
            className="input"
            rows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            placeholder={t('approvals.policies.changes.rejectPlaceholder')}
            aria-label={t('approvals.policies.changes.rejectReasonLabel')}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <div className="chg-reject-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                setRejecting(false);
              }}
            >
              {t('approvals.policies.changes.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!note.trim() || busy}
              onClick={() => {
                onAct('reject', note.trim());
              }}
            >
              {t('approvals.policies.changes.reject')}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Políticas (design policies.jsx): when each write tool asks for other people, how many and for
 * how long. An administrator proposes a change and another one approves it; the API enforces
 * it (`ProposeToolPolicy`, `ApproveToolPolicy`) and `is_admin` here only picks what to render.
 */
export function PoliciesPanel({ api, me, notify }: { api: ApiClient; me: Me; notify: Notify }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [editing, setEditing] = useState<ToolPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.call('getToolPolicies', {}, { signal: controller.signal }).then(
      (data) => {
        setState({ kind: 'ready', data });
      },
      () => {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, reloadToken]);

  const reload = useCallback(() => {
    api.call('getToolPolicies').then(
      (data) => {
        setState({ kind: 'ready', data });
      },
      () => undefined,
    );
  }, [api]);

  const propose = (tool: ToolPolicy, form: PolicyForm, reason: string) => {
    const rule = ruleOf(form);
    if (rule === null) return;
    setBusy(true);
    setModalError(null);
    api
      .call('proposeToolPolicy', {
        path: { tool: tool.tool },
        body: { ...rule, base_version: tool.version, reason },
      })
      .then(
        () => {
          setEditing(null);
          notify(t('approvals.policies.toast.proposed'), 'success');
          reload();
        },
        (error: unknown) => {
          setModalError(errorText(error));
          reload();
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const act = (
    change: PolicyChange,
    action: 'approve' | 'reject' | 'withdraw',
    reason?: string,
  ) => {
    const path = { change_id: change.change_id };
    setBusy(true);
    setListError(null);
    const request =
      action === 'approve'
        ? api.call('approveToolPolicy', { path, body: {} })
        : action === 'reject'
          ? api.call('rejectToolPolicy', { path, body: { reason: reason ?? '' } })
          : api.call('withdrawToolPolicy', { path, body: {} });
    request
      .then(
        (data) => {
          setState({ kind: 'ready', data });
          notify(
            t(
              action === 'approve'
                ? 'approvals.policies.toast.approved'
                : action === 'reject'
                  ? 'approvals.policies.toast.rejected'
                  : 'approvals.policies.toast.withdrawn',
            ),
            action === 'approve' ? 'success' : 'info',
          );
        },
        (error: unknown) => {
          setListError(errorText(error));
          reload();
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  if (state.kind === 'error') {
    return (
      <div className="ap-policies" role="alert">
        <GovErrorState
          title={t('approvals.policies.loadError')}
          body={t('approvals.loadErrorBody')}
          onRetry={() => {
            setState({ kind: 'loading' });
            setReloadToken((value) => value + 1);
          }}
        />
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className="ap-policies" role="status" aria-label={t('approvals.policies.loading')}>
        <Skel h={44} className="mb-4 rounded-xl" />
        <Skel h={120} className="rounded-xl" />
      </div>
    );
  }
  const { tools, changes } = state.data;
  return (
    <div className="ap-policies">
      <div className="ap-note is-inline">
        <InfoIcon size={13} /> <span>{t('approvals.policies.intro')}</span>
      </div>
      <div className="card pol-table">
        <div className="pol-tr mc-th" aria-hidden="true">
          <span>{t('approvals.policies.table.tool')}</span>
          <span>{t('approvals.policies.table.when')}</span>
          <span>{t('approvals.policies.table.approvers')}</span>
          <span>{t('approvals.policies.table.expires')}</span>
          <span />
        </div>
        {tools.length === 0 ? (
          <div className="mk-meta p-4" role="status">
            {t('approvals.policies.empty')}
          </div>
        ) : null}
        {tools.map((tool) => {
          const below = policyBelow(t, tool.policy);
          const pending = tool.pending_change_id !== null;
          return (
            <div key={tool.tool} className="pol-tr">
              <span className="min-w-0">
                <span className="mono pol-tool">{tool.tool}</span>
                {pending ? (
                  <span className="badge badge-amber ml-1.5">
                    {t('approvals.policies.pendingBadge')}
                  </span>
                ) : null}
                <span className="mk-meta block">
                  {tool.server_name}
                  {tool.description ? ` · ${tool.description}` : ''}
                </span>
              </span>
              <span className="text-[13px]">
                {below ? (
                  <span className="mk-meta block">
                    {t('approvals.policies.userConfirms', { when: below })}
                  </span>
                ) : null}
                <span className="block">
                  {t('approvals.policies.needsApproval', { when: policyAbove(t, tool.policy) })}
                </span>
              </span>
              <span className="mk-meta">{tool.policy.approvers}</span>
              <span className="mk-meta">
                {t('approvals.policies.expires', { hours: tool.policy.expires_hours })}
              </span>
              <span className="flex justify-end">
                {me.is_admin ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={pending}
                    title={
                      pending
                        ? t('approvals.policies.editPending')
                        : t('approvals.policies.editTitle')
                    }
                    aria-label={t('approvals.policies.edit', { tool: tool.tool })}
                    onClick={() => {
                      setModalError(null);
                      setEditing(tool);
                    }}
                  >
                    <EditIcon size={12} />
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {changes.length > 0 ? (
        <section className="gr-changes" aria-labelledby="policy-changes">
          <h3 id="policy-changes" className="g-sec-t">
            {t('approvals.policies.changes.title')}
          </h3>
          <div className="g-sec-meta mb-2.5">{t('approvals.policies.changes.meta')}</div>
          {listError ? (
            <div className="g-err mb-2.5" role="alert">
              {listError}
            </div>
          ) : null}
          <div className="chg-list">
            {changes.map((change) => (
              <ChangeItem
                key={change.change_id}
                change={change}
                me={me}
                busy={busy}
                onAct={(action, reason) => {
                  act(change, action, reason);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}
      {editing ? (
        <PolicyModal
          tool={editing}
          busy={busy}
          error={modalError}
          onClose={() => {
            setEditing(null);
          }}
          onSubmit={(form, reason) => {
            propose(editing, form, reason);
          }}
        />
      ) : null}
    </div>
  );
}
