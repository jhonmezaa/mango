// Pure helpers of the mirror's scripts (D123 (3)), tested in `vendor-lib.test.mjs`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** sha256 of a file, hex. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The packages of `lock` (a `pyodide-lock.json`) that `wanted` need, with their dependencies:
 * name → { fileName, sha256 }. A missing package or a file name with a path ends the build.
 */
export function packageClosure(lock, wanted) {
  const packages = lock.packages ?? {};
  const out = new Map();
  const pending = [...wanted];
  while (pending.length > 0) {
    const name = pending.pop();
    if (out.has(name)) continue;
    const entry = packages[name];
    if (!entry) throw new Error(`pyodide-lock.json has no package ${name}`);
    const fileName = entry.file_name;
    if (typeof fileName !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(fileName)) {
      throw new Error(`package ${name} has a bad file name: ${String(fileName)}`);
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`package ${name} has no sha256`);
    }
    out.set(name, { fileName, sha256: entry.sha256 });
    pending.push(...(entry.depends ?? []));
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** Every file under `root`, as sorted POSIX paths relative to it. */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The manifest of the mirror: every file of `root` and of `wasmRoot` (served at the same paths)
 * with its sha256 and size (TM-UI8), sorted.
 */
export function manifest(root, wasmRoot) {
  const files = {};
  for (const base of [root, wasmRoot]) {
    for (const path of listFiles(base)) {
      if (path === 'manifest.json') continue;
      const full = join(base, path);
      files[path] = { sha256: sha256File(full), bytes: statSync(full).size };
    }
  }
  return {
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
}
