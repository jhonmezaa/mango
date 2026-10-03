import { useCallback, useState } from 'react';

import type { ApiClient } from '../../api/client';
import { approvalErrorKey, isStale, type Approval, type ApprovalErrorKey } from './model';

export type Decision =
  | { kind: 'approve'; note: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'cancel' }
  | { kind: 'confirm' }
  | { kind: 'execute' };

function send(api: ApiClient, approval: Approval, decision: Decision): Promise<Approval> {
  const path = { approval_id: approval.approval_id };
  switch (decision.kind) {
    case 'approve':
      return api.call('approveApproval', { path, body: { note: decision.note || null } });
    case 'reject':
      return api.call('rejectApproval', { path, body: { reason: decision.reason } });
    case 'cancel':
      return api.call('cancelApproval', { path, body: {} });
    case 'confirm':
      return api.call('confirmApproval', { path, body: {} });
    case 'execute':
      return api.call('executeApproval', { path, body: {} });
  }
}

/**
 * Sends one decision on a request and hands back its new state. The API decides who may do
 * what; a refusal is shown with a message of this app (never the server's text), and a request
 * that changed under the user is read again.
 */
export function useDecision(api: ApiClient, onUpdated: (approval: Approval) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApprovalErrorKey | null>(null);

  const decide = useCallback(
    async (approval: Approval, decision: Decision): Promise<Approval | null> => {
      setBusy(true);
      setError(null);
      try {
        const next = await send(api, approval, decision);
        onUpdated(next);
        return next;
      } catch (failure) {
        setError(approvalErrorKey(failure));
        if (isStale(failure)) {
          // Someone else decided it, or it expired: show what it is now.
          api
            .call('getApproval', { path: { approval_id: approval.approval_id } })
            .then(onUpdated, () => undefined);
        }
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, onUpdated],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { busy, error, decide, clearError };
}
