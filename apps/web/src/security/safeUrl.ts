const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https everywhere; plain http is only accepted for loopback hosts (local development). */
export function isAllowedOrigin(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

/**
 * Parses a URL coming from untrusted content (LLM markdown) and returns it only if it is an
 * absolute http(s) URL. Everything else (javascript:, data:, vbscript:, relative paths, …) is
 * rejected (REACT-URL-001, TM-012).
 */
export function parseExternalHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url;
}

/**
 * Installation-provided link (e.g. `aiPolicyUrl`) about to be rendered in an `href`. Even though
 * `config.json` is validated with zod, it is checked again right before use: only absolute
 * `https:` URLs without credentials pass, so `javascript:`, `data:` or `http:` never reach the DOM
 * (REACT-URL-001). Returns the normalized href or null.
 */
export function safeHttpsHref(value: string | undefined): string | null {
  if (!value) return null;
  const url = parseExternalHttpUrl(value);
  return url?.protocol === 'https:' ? url.href : null;
}

/** react-markdown urlTransform: keeps only absolute http(s) URLs, everything else becomes ''. */
export function markdownUrlTransform(url: string): string {
  return parseExternalHttpUrl(url) ? url : '';
}

/**
 * Validates an in-app return path (post-login redirect). Only same-origin relative paths are
 * allowed; protocol-relative (`//host`) and backslash tricks fall back to `/` (REACT-REDIRECT-001).
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  try {
    const url = new URL(value, 'https://app.invalid');
    if (url.origin !== 'https://app.invalid') return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
