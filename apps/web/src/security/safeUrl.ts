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

// --- Links to the files of an answer (C4, D116; rea-gaps §2.3) ------------------------------

const FILE_LINK_MAX = 4096;
const DECODE_ROUNDS = 4;
/** What the code connector tells the model a file is (`sandbox:/mnt/data/<name>`). */
const SANDBOX_PREFIX = 'sandbox:/mnt/data/';
/** A file of the answer by its id (`mango-file:<id>`). */
const FILE_PREFIX = 'mango-file:';
const STRAY_PERCENT = /%(?![0-9A-Fa-f]{2})/g;

/** One round is unsafe: a trailing `/`, a `.` or `..` segment, or a control character. */
function unsafeRound(value: string): boolean {
  if (value.endsWith('/')) return true;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return value.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * The link, decoded until it no longer changes (at most 4 rounds; a stray `%` is escaped
 * first), or null when any round is unsafe or it keeps changing (rea-gaps §2.3).
 */
function decodedFileLink(href: string): string | null {
  if (href.length > FILE_LINK_MAX) return null;
  let value = href;
  for (let round = 0; round <= DECODE_ROUNDS; round++) {
    if (unsafeRound(value)) return null;
    let next: string;
    try {
      next = decodeURIComponent(value.replace(STRAY_PERCENT, '%25'));
    } catch {
      return null;
    }
    if (next === value) return value;
    value = next;
  }
  return null;
}

/** Whether a Markdown link may name a file of the answer (it is resolved when rendered). */
export function isFileLink(href: string): boolean {
  const value = decodedFileLink(href);
  return value !== null && (value.startsWith(SANDBOX_PREFIX) || value.startsWith(FILE_PREFIX));
}

/**
 * The id of the file a Markdown link of an answer names, only when it is one of the files the
 * server announced in that same answer (`files`); null otherwise. `mango-file:<id>` names it by
 * id; `sandbox:/mnt/data/<name>`, by the name of exactly one of them. The model writes these
 * links: nothing else is reached through them, and the download is asked of the API by id.
 */
export function fileLinkTarget(
  href: string,
  files: readonly { file_id: string; name: string }[],
): string | null {
  const value = decodedFileLink(href);
  if (value === null) return null;
  if (value.startsWith(FILE_PREFIX)) {
    const id = value.slice(FILE_PREFIX.length);
    return files.some((file) => file.file_id === id) ? id : null;
  }
  if (!value.startsWith(SANDBOX_PREFIX)) return null;
  const name = value.slice(SANDBOX_PREFIX.length);
  if (!name || name.includes('/')) return null;
  const named = files.filter((file) => file.name === name);
  return named.length === 1 && named[0] ? named[0].file_id : null;
}

/**
 * react-markdown urlTransform: keeps absolute http(s) URLs and the links to the files of the
 * answer (checked again, against its announced files, when rendered); everything else is ''.
 */
export function markdownUrlTransform(url: string): string {
  return parseExternalHttpUrl(url) || isFileLink(url) ? url : '';
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
