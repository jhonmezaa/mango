import { memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import type { ChatApproval, Me } from '../../api/schemas';
import { ApprovalDecision } from '../../pages/approvals/ApprovalDecision';
import { argumentEntries, personOf, ruleText, shortId } from '../../pages/approvals/model';
import { useDecision } from '../../pages/approvals/useDecision';
import { Badge } from '../Badge';
import { CheckIcon, LockIcon, WarnIcon } from '../icons';

interface Props {
  api: ApiClient;
  me: Me;
  approval: ChatApproval;
  onUpdated: (approval: ChatApproval) => void;
  notify: (message: string, tone?: 'success' | 'info' | 'error') => void;
}

/** While other people decide, or the action runs, the card reads its request again. */
const POLL_MS = 15_000;

function useRefresh({ api, approval, onUpdated }: Pick<Props, 'api' | 'approval' | 'onUpdated'>) {
  const { approval_id: id, status, tier } = approval;
  // Also while it is approved: it can expire before who asked runs it.
  const open =
    status === 'executing' ||
    (tier === 'approvers' && (status === 'pending' || status === 'approved'));
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      api
        .call('getApproval', { path: { approval_id: id } }, { signal: controller.signal })
        .then(onUpdated, () => undefined);
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [api, id, open, onUpdated]);
}

/** Tool and arguments exactly as the API stored them, as text (design: `tool · k=v, …`). */
function CallLine({ approval, rule }: { approval: ChatApproval; rule?: string }) {
  const { t } = useTranslation();
  const args = argumentEntries(approval)
    .map(([key, value]) => t('approvals.card.param', { key, value }))
    .join(', ');
  return (
    <div className="mono ap-card-call">
      {approval.tool}
      {args ? ` · ${args}` : ''}
      {rule ? ` · ${rule}` : ''}
    </div>
  );
}

/**
 * Design `SelfConfirmCard`: a write action below the policy's threshold, which the person who
 * asked confirms. «Ejecutar» sends the confirmation; the API runs exactly the stored call.
 */
function SelfConfirm({ api, approval, onUpdated, notify }: Props) {
  const { t } = useTranslation();
  const { busy, error, decide } = useDecision(api, onUpdated);
  const { status } = approval;
  const id = t('approvals.id', { id: shortId(approval) });
  const who = personOf(approval.decided_by_email, approval.decided_by);
  const pending = status === 'pending';
  // Confirmed but the call did not start: it can be run again.
  const retry = status === 'approved';
  const act = (kind: 'confirm' | 'execute' | 'cancel') => {
    void decide(approval, { kind }).then((next) => {
      if (!next) return;
      if (next.status === 'executed') notify(t('approvals.toast.executed', { id }), 'success');
      else if (next.status === 'failed') notify(t('approvals.toast.notExecuted', { id }), 'error');
      else if (next.status === 'cancelled') notify(t('approvals.toast.cancelled', { id }), 'info');
    });
  };
  return (
    <div
      className={pending || retry ? 'card ap-card is-self' : 'card ap-card is-self is-done'}
      role="group"
      aria-label={t('approvals.card.selfLabel')}
    >
      <div className="ap-card-h">
        <WarnIcon size={13} className={pending ? 'text-accent-ink' : 'text-muted'} />
        <span>{t('approvals.card.selfTitle')}</span>
        <Badge>{t('approvals.card.write')}</Badge>
      </div>
      <div className="ap-card-t">{approval.description || approval.tool}</div>
      <CallLine approval={approval} />
      <div className="ap-card-rule">
        {t('approvals.card.selfRule', { rule: ruleText(t, approval) })}
      </div>
      {error ? (
        <div className="g-err mb-2" role="alert">
          {t(error)}
        </div>
      ) : null}
      {pending || retry ? (
        <>
          {retry ? (
            <div className="ap-reason mb-2" role="status">
              <WarnIcon size={12} /> {t('approvals.decision.retryRun')}
            </div>
          ) : null}
          <div className="ap-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => {
                act(retry ? 'execute' : 'confirm');
              }}
            >
              <CheckIcon size={12} />{' '}
              {busy ? t('approvals.decision.running') : t('approvals.card.execute')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => {
                act('cancel');
              }}
            >
              {t('approvals.card.cancel')}
            </button>
          </div>
        </>
      ) : (
        <div className="ap-closed">
          {status === 'cancelled' ? (
            <Badge>{t('approvals.card.cancelled')}</Badge>
          ) : status === 'expired' ? (
            <Badge>{t('approvals.status.expired')}</Badge>
          ) : (
            <Badge tone="green">{t('approvals.card.confirmed')}</Badge>
          )}
          {who ? t('approvals.card.confirmedBy', { who }) : null}
          {status === 'executing' ? ` · ${t('approvals.decision.running')}` : null}
          {status === 'executed' ? ` · ${t('approvals.decision.executed')}` : null}
          {status === 'failed'
            ? ` · ${t('approvals.decision.failed', { code: approval.error ?? 'error' })}`
            : null}
        </div>
      )}
    </div>
  );
}

/** Design `ApprovalCard`: the border follows the state of the request. */
const CARD_TONE: Record<ChatApproval['status'], string> = {
  pending: 'is-pending',
  approved: 'is-run',
  executing: 'is-run',
  executed: 'is-ok',
  failed: 'is-bad',
  rejected: 'is-bad',
  cancelled: 'is-closed',
  expired: 'is-closed',
};

/** Design `ApprovalCard`: a write action that needs other people, with its state. */
function NeedsApprovers({ api, me, approval, onUpdated, notify }: Props) {
  const { t } = useTranslation();
  const { status } = approval;
  const tone = CARD_TONE[status];
  const id = t('approvals.id', { id: shortId(approval) });
  return (
    <div
      className={`card ap-card ${tone}`}
      role="group"
      aria-label={t('approvals.card.approvalLabel', { id })}
    >
      <div className="ap-card-h">
        <LockIcon size={13} />
        <span>
          {status === 'pending'
            ? t('approvals.card.approvalTitle')
            : t(`approvals.status.${status}`)}
        </span>
        <span className="mono ap-card-id">{id}</span>
      </div>
      <div className="ap-card-t">{approval.description || approval.tool}</div>
      <CallLine approval={approval} rule={ruleText(t, approval)} />
      <div className="mt-2">
        <ApprovalDecision
          api={api}
          me={me}
          approval={approval}
          // In the chat the card belongs to who asked: nothing is signed from here.
          canDecide={false}
          compact
          onUpdated={onUpdated}
          notify={notify}
        />
      </div>
    </div>
  );
}

/**
 * A write tool call of the agent, waiting for a person (D27). Tool, arguments and rule are the
 * ones the API stored for the request: the card never shows the model's own description of the
 * action (R3), and every value is rendered as React text.
 */
export const ChatApprovalCard = memo(function ChatApprovalCard(props: Props) {
  useRefresh(props);
  return props.approval.tier === 'self' ? (
    <SelfConfirm {...props} />
  ) : (
    <NeedsApprovers {...props} />
  );
});
