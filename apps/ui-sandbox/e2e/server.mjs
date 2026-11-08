// The second origin as CloudFront serves it (infra/lib/constructs/ui-sandbox-origin.ts), for the
// end-to-end tests without AWS: the runner of the end-to-end build and the mirror, with the
// ceiling CSP plus frame-ancestors of the host, CORS only under /vendor/, application/wasm, and
// runner-config.json with the host's origin. A different site from the host (127.0.0.1 and
// localhost), as the two distributions are.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const HOST_ORIGIN = 'http://localhost:4602';
const infra = readFileSync(
  join(ROOT, '..', '..', 'infra', 'lib', 'constructs', 'ui-sandbox-origin.ts'),
  'utf8',
);
const block = /export const UI_SANDBOX_CSP = \[([\s\S]*?)\]\.join/.exec(infra)?.[1];
if (!block) throw new Error('UI_SANDBOX_CSP not found');
const CEILING = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join('; ');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.whl': 'application/octet-stream',
};

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  const headers = {
    'content-security-policy': `${CEILING}; frame-ancestors ${HOST_ORIGIN}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'origin-agent-cluster': '?1',
  };
  if (path.startsWith('/vendor/')) headers['access-control-allow-origin'] = '*';
  if (path === '/runner-config.json') {
    response.writeHead(200, { ...headers, 'content-type': 'application/json' });
    response.end(JSON.stringify({ spaOrigin: HOST_ORIGIN }));
    return;
  }
  // The mirror is two trees (dist/vendor and, for .wasm, dist/vendor-wasm) at the same paths.
  const base = path.startsWith('/vendor/') ? join(ROOT, 'dist') : join(ROOT, 'dist-e2e');
  const relative = path.endsWith('.wasm') ? path.replace(/^\/vendor\//, '/vendor-wasm/') : path;
  const file = normalize(join(base, relative === '/' ? 'sandbox.html' : relative));
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, headers);
    response.end();
    return;
  }
  response.writeHead(200, {
    ...headers,
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
}).listen(4601, '127.0.0.1');
