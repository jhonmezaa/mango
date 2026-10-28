import type { TFunction } from 'i18next';

import { ApiError } from '../../api/errors';
import type { OperationOutput } from '../../api/operations';
import type { RemoteLinkSource } from '../../security/remoteLinks';
import { REGISTRATION_ID } from '../remoteMcp/model';

export type Connection = OperationOutput<'listMyConnections'>['connections'][number];

/** Route of the return from AgentCore Identity (D98 (9), P-1): `defaultReturnUrl` of the SPA. */
export const RETURN_PATH = '/conexiones/vuelta';

/** The pending consent lives 10 minutes (the interceptor's `MCP_CONSENT#<sub>`, D94). */
export const CONSENT_TTL_MS = 10 * 60_000;

/** `sessionUri` of `CompleteResourceTokenAuth`: the pattern mango-api checks too. */
export const SESSION_URI = /^urn:ietf:params:oauth:request_uri:[A-Za-z0-9._~-]{1,990}$/;

const MAX_CONSENT_URL = 2048;

export function isRegistrationId(value: string): boolean {
  return REGISTRATION_ID.test(value);
}

/**
 * The consent URL mango-api handed over, checked again before the page leaves for it (D94 (2)):
 * https, the AgentCore host of the installation's region, no credentials, at most 2048 characters.
 * Anything else is never opened.
 */
export function consentUrl(value: string | null | undefined, region: string): string | null {
  if (!value || value.length > MAX_CONSENT_URL) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url.hostname === `bedrock-agentcore.${region}.amazonaws.com` ? url.href : null;
}

/** Design `MyConnections` row: what the line under the service says. */
export type RowState = 'off' | 'opening' | 'on' | 'blocked' | 'none';

export function rowStateOf(connection: Connection, opening: boolean): RowState {
  if (connection.status === 'disabled') return 'off';
  if (opening) return 'opening';
  if (connection.status === 'connected') return 'on';
  if (connection.status === 'secret_expired') return 'blocked';
  return 'none';
}

/** The provider the person signs in with («Microsoft»); the service when the API names none. */
export function idpOf(connection: Pick<Connection, 'provider' | 'service'>): string {
  return connection.provider ?? connection.service;
}

/** Unique names, in order: «Al conectar vas a iniciar sesión en Microsoft o …». */
export function idpsOf(list: readonly Connection[]): string[] {
  return [...new Set(list.map(idpOf))];
}

/** Text of a failed «Conectar» (design texts; the rest, the app's generic error). */
export function connectErrorText(t: TFunction, error: unknown, service: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'remote_disabled':
        return t('connections.errors.remote_disabled', { service });
      case 'secret_expired':
        return t('connections.row.blocked', { service });
      case 'remote_not_usable':
        return t('connections.errors.remote_not_usable', { service });
      case 'gateway_unavailable':
        return t('connections.errors.gateway_unavailable');
    }
  }
  return t('errors.generic');
}

/** The registrations a turn read, as link sources (A1): their hosts and their organizations. */
export function linkSourcesOf(
  registrations: readonly string[],
  list: readonly Connection[],
): RemoteLinkSource[] {
  const byId = new Map(list.map((item) => [item.registration_id, item]));
  const sources: RemoteLinkSource[] = [];
  const seen = new Set<string>();
  for (const id of registrations) {
    const read = byId.get(id);
    if (!read || seen.has(read.profile_id)) continue;
    seen.add(read.profile_id);
    sources.push({
      service: read.service,
      linkHosts: read.link_hosts,
      // Every organization of that profile the person may use counts as the company's.
      organizations: list
        .filter((item) => item.profile_id === read.profile_id)
        .map((item) => item.organization),
    });
  }
  return sources;
}

// --- The return (design `RemoteReturn`) -------------------------------------------------------

export type ReturnResult =
  'ok' | 'expired' | 'nosession' | 'notyours' | 'denied' | 'conditional' | 'error';

/** Result of `POST /api/oauth/callback` when it fails (docs/specs/poc-api-contract.md). */
export function returnResultOf(error: unknown): ReturnResult {
  if (!(error instanceof ApiError)) return 'error';
  switch (error.code) {
    case 'consent_expired':
      return 'expired';
    case 'consent_not_yours':
      return 'notyours';
    case 'consent_denied':
      return 'denied';
    case 'conditional_access':
      return 'conditional';
    // Several pending consents and a session that names none (security review F-1): the
    // design has no text for it yet, so it is the generic error.
    case 'consent_ambiguous':
      return 'error';
    default:
      return 'error';
  }
}

/**
 * What the provider put in the return URL when there is no `session_id` (V-5 still open: what
 * Identity sends after a cancel is not known). An OAuth `access_denied` is the person or the
 * provider saying no; anything else is an error. The free text of the provider is never read.
 */
export function returnResultOfQuery(error: string | null): ReturnResult {
  return error === 'access_denied' ? 'denied' : 'error';
}
