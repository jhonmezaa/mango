/**
 * Where a link of a turn that read a remote MCP really goes (design remote-core.jsx
 * `classifyLink`, A1). The content of a remote service was written outside Mango and may carry
 * links to look-alike sites (indirect prompt injection, TM-001): the dialog says whether the host
 * belongs to the service and whether the organization is one the company registered.
 *
 * Only the registrations the person may use are known here (`GET /api/me/connections`), never the
 * organizations of the whole installation (plan §7.7).
 */

/** A remote service the turn read: its link hosts and the organizations the person may use. */
export interface RemoteLinkSource {
  service: string;
  /** Hosts of the signed profile, lowercase (`dev.azure.com`, `visualstudio.com`). */
  linkHosts: readonly string[];
  /** Organizations registered for that profile that the person may use. */
  organizations: readonly string[];
}

export type RemoteLinkKind = 'own' | 'other-org' | 'other';

export interface RemoteLinkClass {
  kind: RemoteLinkKind;
  host: string;
  /** What the dialog shows as the destination: the host, with the organization if any. */
  label: string;
  org: string | null;
  /** The service whose host the link uses; the first source when it uses none. */
  service: string;
}

const ORG = /^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?$/;

function orgOf(segment: string | undefined): string | null {
  const value = (segment ?? '').toLowerCase();
  return ORG.test(value) ? value : null;
}

/**
 * Classifies an http(s) URL already parsed by `parseExternalHttpUrl`.
 * - On the host itself (`dev.azure.com/<org>/…`) the organization is the first path segment.
 * - On a subdomain (`<org>.visualstudio.com`) it is the first label.
 * - `own` only when the organization is one of the registered ones; a host of the service with
 *   any other organization (or none) is `other-org`; any other host is `other`.
 */
export function classifyRemoteLink(
  url: URL,
  sources: readonly RemoteLinkSource[],
): RemoteLinkClass {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const fallback = sources[0]?.service ?? '';
  for (const source of sources) {
    for (const raw of source.linkHosts) {
      const linkHost = raw.toLowerCase();
      let org: string | null = null;
      let label = host;
      if (host === linkHost) {
        org = orgOf(url.pathname.split('/')[1]);
        if (org) label = `${host}/${org}`;
      } else if (host.endsWith(`.${linkHost}`)) {
        org = orgOf(host.slice(0, -(linkHost.length + 1)).split('.')[0]);
      } else {
        continue;
      }
      const own = org !== null && source.organizations.some((value) => value.toLowerCase() === org);
      return { kind: own ? 'own' : 'other-org', host, label, org, service: source.service };
    }
  }
  return { kind: 'other', host, label: host, org: null, service: fallback };
}
