import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminErrorKey, apiErrorCode, isStaleDataError } from '../../api/adminErrors';
import { ApiError } from '../../api/errors';
import type { ApiClient } from '../../api/client';
import type { ToastTone } from '../../components/admin/useToasts';
import {
  isWorking,
  type Registration,
  type RemoteCatalog,
  type RemoteForm,
  type RemoteRequest,
} from './model';

export type RemoteLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; data: RemoteCatalog }
  | { kind: 'error'; forbidden: boolean };

/** While the provisioner creates or removes a registration, the catalog is read again this often. */
const POLL_MS = 5000;

/**
 * GET /api/mcp/remotes, read again while something is being created. Admins and agent creators
 * may read it (`ViewMcpCatalog`); what each one sees is the API's.
 */
export function useRemoteCatalog(api: ApiClient, enabled = true) {
  const [state, setState] = useState<RemoteLoad>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    api.call('getRemoteCatalog', {}, { signal: controller.signal }).then(
      (data) => {
        setState({ kind: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', forbidden: error instanceof ApiError && error.status === 403 });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, enabled, reloadToken]);

  const working = state.kind === 'ready' && isWorking(state.data);
  useEffect(() => {
    if (!working) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      api.call('getRemoteCatalog', {}, { signal: controller.signal }).then(
        (data) => {
          if (!controller.signal.aborted) setState({ kind: 'ready', data });
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [api, working]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setReloadToken((value) => value + 1);
  }, []);

  const replace = useCallback((data: RemoteCatalog) => {
    setState({ kind: 'ready', data });
  }, []);

  return { state, retry, replace };
}

export type RemoteAction =
  | { kind: 'request'; profileId: string; form: RemoteForm }
  | { kind: 'reenable' | 'replace' | 'params'; registration: Registration; form: RemoteForm }
  | { kind: 'approve' | 'withdraw'; registration: Registration; request: RemoteRequest }
  | { kind: 'reject'; registration: Registration; request: RemoteRequest; reason: string }
  | { kind: 'rotate'; registration: Registration; secret: string; expiresOn: string }
  | { kind: 'retry'; registration: Registration }
  | { kind: 'disable'; registration: Registration; reason: string };

/** Codes with a text of their own (`remoteMcp.errors`); the rest use the admin texts. */
const OWN_ERRORS = new Set([
  'remote_exists',
  'same_approver',
  'remote_profile_not_in_release',
  'pending_exists',
  'release_changed',
  'provisioner_unavailable',
  'catalog_unavailable',
  'use_withdraw',
  'not_requester',
  'no_change',
  // `RemoteMcpEnabled=false` in the installation (P-4), when the profile did not say so first.
  'remote_disabled',
  'busy',
]);

const UNWRITTEN = new Set(['identity_unavailable', 'too_many_remotes']);

async function send(api: ApiClient, action: RemoteAction): Promise<RemoteCatalog> {
  switch (action.kind) {
    case 'request': {
      const { form } = action;
      return api.call('requestRemoteRegistration', {
        path: { profile: action.profileId },
        body: {
          organization: form.organization.trim(),
          tenant_id: form.tenantId.trim().toLowerCase(),
          client_id: form.clientId.trim().toLowerCase(),
          client_secret: form.secret,
          secret_expires_on: form.secretExpiresOn,
          toolsets: form.toolsets,
          groups: form.groups,
          reason: null,
        },
      });
    }
    case 'params':
      return api.call('requestRemoteParams', {
        path: { reg: action.registration.id },
        body: {
          version: action.registration.version,
          toolsets: action.form.toolsets,
          groups: action.form.groups,
          reason: null,
        },
      });
    case 'reenable':
    case 'replace': {
      const { form, registration } = action;
      const app = {
        version: registration.version,
        tenant_id: form.tenantId.trim().toLowerCase(),
        client_id: form.clientId.trim().toLowerCase(),
        client_secret: form.secret,
        secret_expires_on: form.secretExpiresOn,
        reason: null,
      };
      return api.call('requestRemoteChange', {
        path: { reg: registration.id },
        body:
          action.kind === 'replace'
            ? { kind: 'replace_app', ...app }
            : { kind: 'enable', ...app, toolsets: form.toolsets, groups: form.groups },
      });
    }
    case 'approve':
      return api.call('approveRemoteRequest', {
        path: { reg: action.registration.id, change_id: action.request.id },
        body: {},
      });
    case 'withdraw':
      return api.call('withdrawRemoteRequest', {
        path: { reg: action.registration.id, change_id: action.request.id },
        body: {},
      });
    case 'reject':
      return api.call('rejectRemoteRequest', {
        path: { reg: action.registration.id, change_id: action.request.id },
        body: { reason: action.reason },
      });
    case 'rotate':
      return api.call('rotateRemoteSecret', {
        path: { reg: action.registration.id },
        body: {
          version: action.registration.version,
          client_secret: action.secret,
          secret_expires_on: action.expiresOn,
        },
      });
    case 'retry':
      return api.call('retryRemote', {
        path: { reg: action.registration.id },
        body: { version: action.registration.version },
      });
    case 'disable':
      return api.call('disableRemote', {
        path: { reg: action.registration.id },
        body: { version: action.registration.version, reason: action.reason },
      });
  }
}

export type Notify = (msg: string, tone?: ToastTone) => void;

/**
 * Sends one action and returns the error to show, or `null`. The secret only travels in the
 * request body: it is never kept here, logged or put in a toast. A stale catalog is read again.
 */
export function useRemoteActions(
  api: ApiClient,
  replace: (data: RemoteCatalog) => void,
  notify: Notify,
) {
  const { t } = useTranslation();
  return useCallback(
    async (
      action: RemoteAction,
      names: { name: string; organization: string },
    ): Promise<string | null> => {
      try {
        replace(await send(api, action));
        const toast = {
          request: 'remoteMcp.toast.requested',
          reenable: 'remoteMcp.toast.requested',
          replace: 'remoteMcp.toast.requested',
          params: 'remoteMcp.toast.requested',
          approve:
            action.kind === 'approve' && action.request.kind === 'params'
              ? 'remoteMcp.toast.approvedParams'
              : 'remoteMcp.toast.approved',
          reject: 'remoteMcp.toast.rejected',
          withdraw: 'remoteMcp.toast.withdrawn',
          rotate: 'remoteMcp.toast.rotated',
          disable: 'remoteMcp.toast.disabled',
          retry: 'remoteMcp.toast.retried',
        } as const;
        notify(t(toast[action.kind], names), 'success');
        return null;
      } catch (error) {
        const code = apiErrorCode(error);
        // Codes the design has no text for yet (plan §1.10): shown as an unknown failure, not as
        // the stale-data text their HTTP status would pick.
        if (code !== null && UNWRITTEN.has(code)) return t('admin.errors.generic');
        if (isStaleDataError(error) || code === 'provisioner_unavailable') {
          try {
            replace(await api.call('getRemoteCatalog'));
          } catch (reloadError) {
            return t(adminErrorKey(reloadError));
          }
        }
        // Design: a retry whose profile changed says so in its own words.
        if (code === 'release_changed' && action.kind === 'retry') {
          return t('remoteMcp.errors.retry_release_changed', names);
        }
        return code !== null && OWN_ERRORS.has(code)
          ? t(`remoteMcp.errors.${code}` as 'remoteMcp.errors.remote_exists', names)
          : t(adminErrorKey(error));
      }
    },
    [api, replace, notify, t],
  );
}
