// Download the Pyodide packages of the mirror (D123 (3)) into dist/vendor/pyodide/<version>/,
// checking each against pyodide-lock.json, whose own sha256 is pinned in vendor.json. Run by the
// release build (deployment/dist.py) after `build`, never in a customer account (D25).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { manifest, packageClosure, sha256File } from './vendor-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'vendor.json'), 'utf8')).pyodide;
const target = join(ROOT, 'dist', 'vendor', 'pyodide', config.version);
const lockPath = join(target, 'pyodide-lock.json');
if (!existsSync(lockPath)) throw new Error(`${lockPath} is missing: run the build first`);
if (sha256File(lockPath) !== config.lockSha256)
  throw new Error('pyodide-lock.json is not the pinned one');
if (
  !config.baseUrl.startsWith('https://') ||
  !config.baseUrl.endsWith(`/v${config.version}/full/`)
) {
  throw new Error(`unexpected base URL ${config.baseUrl}`);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
let bytes = 0;
for (const [name, { fileName, sha256 }] of packageClosure(lock, config.packages)) {
  const path = join(target, fileName);
  if (existsSync(path) && sha256File(path) === sha256) continue;
  const response = await fetch(new URL(fileName, config.baseUrl), { redirect: 'error' });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== sha256) {
    rmSync(path, { force: true });
    throw new Error(`${name}: sha256 ${digest} is not the lock's ${sha256}`);
  }
  writeFileSync(path, body);
  bytes += body.length;
  console.log(`· ${fileName} (${(body.length / 1e6).toFixed(1)} MB)`);
}
// The synthesis of a release refuses a mirror without these packages (infra, UiSandboxContent).
const listed = {
  ...manifest(join(ROOT, 'dist', 'vendor'), join(ROOT, 'dist', 'vendor-wasm')),
  pyodidePackages: [...config.packages].sort(),
};
writeFileSync(
  join(ROOT, 'dist', 'vendor', 'manifest.json'),
  `${JSON.stringify(listed, null, 2)}\n`,
);
console.log(`Pyodide packages ready (${(bytes / 1e6).toFixed(1)} MB downloaded)`);
