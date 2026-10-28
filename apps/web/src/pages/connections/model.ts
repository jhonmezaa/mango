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
export type RowState =
  'off' | 'opening' | 'waiting' | 'finishing' | 'on' | 'onBlocked' | 'blocked' | 'none';

export function rowStateOf(
  connection: Connection,
  phase: 'opening' | 'waiting' | 'finishing' | null,
): RowState {
  if (connection.status === 'disabled') return 'off';
  if (phase) return phase;
  if (connection.status === 'connected') return 'on';
  // With the app's secret expired, `connected_at` says the person had connected (round 24).
  if (connection.status === 'secret_expired')
    return connection.connected_at ? 'onBlocked' : 'blocked';
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

/** Design `CONNECT_ERR`: the title and the body of a failed «Conectar», as the card says them. */
export interface ConnectError {
  title: string;
  body: string;
}

/**
 * Text of a failed «Conectar» (design `CONNECT_ERR`, round 24). The Gateway or AgentCore Identity
 * not giving a consent URL is the design's `identity_unavailable`; a 429 is `rate_limited`. Codes
 * that say why this service cannot be connected keep their own text under the generic title.
 */
export function connectErrorOf(
  t: TFunction,
  error: unknown,
  connection: Pick<Connection, 'service' | 'provider'>,
): ConnectError {
  const generic = {
    title: t('connections.connectErrors.error.title'),
    body: t('connections.connectErrors.error.body'),
  };
  if (!(error instanceof ApiError)) return generic;
  if (error.status === 429) {
    return {
      title: t('connections.connectErrors.rate_limited.title'),
      body: t('connections.connectErrors.rate_limited.body'),
    };
  }
  const service = connection.service;
  switch (error.code) {
    case 'gateway_unavailable':
    case 'identity_unavailable':
      return {
        title: t('connections.connectErrors.identity_unavailable.title'),
        body: t('connections.connectErrors.identity_unavailable.body', {
          idp: idpOf(connection),
        }),
      };
    case 'remote_disabled':
      return { ...generic, body: t('connections.errors.remote_disabled', { service }) };
    case 'secret_expired':
      return { ...generic, body: t('connections.row.blocked', { service }) };
    case 'remote_not_usable':
      return { ...generic, body: t('connections.errors.remote_not_usable', { service }) };
  }
  return generic;
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

// --- The return (design `RemoteReturn`, D100) ------------------------------------------------

/**
 * What the return page says (design `RET`, round 24). It never closes the consent: the tab that
 * pressed «Conectar» does, and tells it how it went. `orphan`: no tab took it (it was closed, or
 * its session changed, or the page was reloaded).
 */
export const RETURN_RESULTS = [
  'ok',
  'orphan',
  'expired',
  'denied',
  'conditional',
  'ambiguous',
  'notyours',
  'error',
] as const;

export type ReturnResult = (typeof RETURN_RESULTS)[number];

/**
 * Why the tab that pressed «Conectar» could not finish (design `FINISH_ERR`, shown in the chat and
 * Playground card and in the row of «Mis conexiones»). `expired` is the card's «El enlace venció».
 */
export type FinishError = 'session_changed' | 'denied' | 'conditional' | 'error' | 'expired';

/**
 * Result of `POST /api/oauth/callback` when it fails, for the waiting tab and for the return page.
 * `consent_not_yours` leaves the tab silent (`tab: null`): with several tabs waiting, it is the
 * answer to the one that did not ask (D100 (2)).
 */
export function finishOutcomeOf(error: unknown): { tab: FinishError | null; ret: ReturnResult } {
  if (!(error instanceof ApiError)) return { tab: 'error', ret: 'error' };
  switch (error.code) {
    case 'consent_expired':
      return { tab: 'expired', ret: 'expired' };
    case 'consent_not_yours':
      return { tab: null, ret: 'notyours' };
    case 'consent_denied':
      return { tab: 'denied', ret: 'denied' };
    case 'conditional_access':
      return { tab: 'conditional', ret: 'conditional' };
    // Several pending consents and a session that names none (security review F-1).
    case 'consent_ambiguous':
      return { tab: 'error', ret: 'ambiguous' };
    default:
      return { tab: 'error', ret: 'error' };
  }
}

/** Text of a finish error (design `FINISH_ERR`); `expired` has the card's own text. */
export function finishErrorOf(
  t: TFunction,
  error: Exclude<FinishError, 'expired'>,
  connection: Pick<Connection, 'service' | 'provider'>,
): ConnectError {
  const idp = idpOf(connection);
  return {
    title: t(`connections.finishErrors.${error}.title`, { idp }),
    body: t(`connections.finishErrors.${error}.body`, { idp }),
  };
}

/**
 * What the provider put in the return URL when there is no `session_id` (V-5 still open: what
 * Identity sends after a cancel is not known). An OAuth `access_denied` is the person or the
 * provider saying no; anything else is an error. The free text of the provider is never read.
 */
export function returnResultOfQuery(error: string | null): 'denied' | 'error' {
  return error === 'access_denied' ? 'denied' : 'error';
}
