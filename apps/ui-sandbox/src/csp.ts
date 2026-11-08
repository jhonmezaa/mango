/**
 * The CSP of an inner frame (D123 (4), (8); TM-UI4). The frame is created with `srcdoc`, so it
 * inherits the runner's header policy (the ceiling the CloudFront Function sets) and this one is
 * added with `<meta>`: a second policy can only restrict. Its network is the mirror of the
 * release and nothing else; a domain an MCP App declares can only be one the ceiling already
 * names, and a runner never loosens the policy of what it runs: that takes a new runner.
 */

/**
 * Origins the ceiling lets an inner frame connect to besides its own origin. Empty until A1
 * brings the curated domains of MCP Apps, which the release will add here and to the ceiling
 * (`UI_SANDBOX_CSP` in `infra/lib/constructs/ui-sandbox-origin.ts`) at once.
 */
export const CEILING_CONNECT_DOMAINS: readonly string[] = [];

/** The paths of the second origin an inner frame may load from. */
export const VENDOR_PATH = '/vendor/';

export interface InnerPolicy {
  /** Normalized origins (`https://host[:port]`), sorted, without duplicates. */
  readonly connectDomains: readonly string[];
}

/**
 * Normalize the domains a run asks for, as the observed sandbox does: trim, `https://` when there
 * is no scheme, a parseable URL with `https:` or `wss:` and no credentials, reduced to its
 * origin. Anything with a character that could end a directive is refused, never dropped
 * quietly: the caller learns its policy is not what it asked for.
 */
export function normalizeDomains(domains: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    const value = raw.trim();
    if (!/^[^\s;,"']+$/.test(value)) throw new Error(`not a domain: ${JSON.stringify(raw)}`);
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw new Error(`not a domain: ${JSON.stringify(raw)}`);
    }
    if (!['https:', 'wss:'].includes(url.protocol)) throw new Error(`not https: ${raw}`);
    if (url.username || url.password) throw new Error(`a domain with credentials: ${raw}`);
    if (url.hostname.includes('*')) throw new Error(`a wildcard: ${raw}`);
    out.add(`${url.protocol}//${url.host}`);
  }
  return [...out].sort();
}

/** The policy of a run: its domains normalized and within the ceiling. */
export function innerPolicy(
  connectDomains: readonly string[] = [],
  ceiling: readonly string[] = CEILING_CONNECT_DOMAINS,
): InnerPolicy {
  const domains = normalizeDomains(connectDomains);
  const allowed = new Set(normalizeDomains(ceiling));
  const outside = domains.filter((domain) => !allowed.has(domain));
  if (outside.length > 0) {
    throw new Error(`outside the ceiling of the sandbox: ${outside.join(' ')}`);
  }
  return { connectDomains: domains };
}

/**
 * How `next` compares with `previous`: `equal`, `stricter` (a subset) or `looser` (anything
 * else). The runner refuses a looser policy (`CSP is being loosened`).
 */
export function comparePolicies(
  previous: InnerPolicy,
  next: InnerPolicy,
): 'equal' | 'stricter' | 'looser' {
  const before = new Set(previous.connectDomains);
  if (next.connectDomains.some((domain) => !before.has(domain))) return 'looser';
  return next.connectDomains.length === before.size ? 'equal' : 'stricter';
}

/** The `<meta>` policy of an inner frame of the runner at `origin`. */
export function innerCsp(origin: string, policy: InnerPolicy): string {
  const vendor = `${origin}${VENDOR_PATH}`;
  const connect = [vendor, ...policy.connectDomains].join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${vendor}`,
    'worker-src blob:',
    `connect-src ${connect}`,
    'img-src data: blob:',
    `style-src 'unsafe-inline' ${vendor}`,
    `font-src ${vendor}`,
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
