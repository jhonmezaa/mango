import type { RunKind } from './protocol';
import { importMap, VENDOR_PATHS } from './vendor';

/**
 * The document of an inner frame (`srcdoc`). Its first element is the `<meta>` policy, so
 * nothing in it runs before the policy applies; then the bootstrap, which takes the port the
 * runner hands over. The code of a React or Python run is not in the document: it travels on
 * that port. HTML is the document itself, after the bootstrap.
 */

/** `text` safe inside an attribute value in double quotes. */
export function escapeAttribute(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** `code` safe inside `<script>`: it cannot close the element nor open a comment state. */
export function escapeScript(code: string): string {
  return code.replace(/<(\/script|!--)/gi, '<\\$1');
}

export interface SrcdocParts {
  readonly kind: RunKind;
  /** The HTML of an `html` run; unused for the others. */
  readonly source: string;
  readonly csp: string;
  /** The text of the bootstrap script (the runner's own asset). */
  readonly bootstrap: string;
  /** The runner's origin, where the mirror is. */
  readonly origin: string;
}

const PYTHON_STYLE = [
  'body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}',
  '#console{margin:0;padding:8px;white-space:pre-wrap;word-break:break-word}',
  '#console .stderr{color:#b42318}',
  '#figures img{display:block;max-width:100%;height:auto}',
].join('');

export function buildSrcdoc(parts: SrcdocParts): string {
  const head = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(parts.csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<script>${escapeScript(parts.bootstrap)}</script>`,
  ].join('');
  switch (parts.kind) {
    case 'html':
      return `${head}</head><body>${parts.source}`;
    case 'react':
      return [
        head,
        `<script type="importmap">${escapeScript(JSON.stringify(importMap(parts.origin)))}</script>`,
        `<script src="${escapeAttribute(parts.origin + VENDOR_PATHS.babel)}"></script>`,
        `<script src="${escapeAttribute(parts.origin + VENDOR_PATHS.tailwind)}"></script>`,
        '</head><body><div id="root"></div></body></html>',
      ].join('');
    case 'python':
      return [
        head,
        `<style>${PYTHON_STYLE}</style>`,
        '</head><body><pre id="console"></pre><div id="figures"></div></body></html>',
      ].join('');
  }
}

export interface AppSrcdocParts {
  /** The app's HTML, as its signed profile carries it (checked against its hash by the host). */
  readonly html: string;
  readonly csp: string;
  /** The text of the app bridge (the runner's own asset). */
  readonly bridge: string;
}

/**
 * The document of an MCP App (D125 (3)): the `<meta>` policy first, then the bridge, then the
 * app's own HTML. A second `<html>` or `<head>` in the app is merged by the HTML parser into
 * this document, after the policy and the bridge; a policy of its own can only restrict.
 */
export function buildAppSrcdoc(parts: AppSrcdocParts): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(parts.csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<script>${escapeScript(parts.bridge)}</script>`,
    parts.html.replace(/^\s*<!doctype[^>]*>/i, ''),
  ].join('');
}
