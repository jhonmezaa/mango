import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageClosure } from './vendor-lib.mjs';

const ROOT = join(import.meta.dirname, '..');
const sha = 'a'.repeat(64);

describe('packageClosure', () => {
  it('follows the dependencies of the lock', () => {
    const lock = {
      packages: {
        pandas: { file_name: 'pandas.whl', sha256: sha, depends: ['numpy', 'pytz'] },
        numpy: { file_name: 'numpy.whl', sha256: sha, depends: [] },
        pytz: { file_name: 'pytz.whl', sha256: sha, depends: [] },
        unused: { file_name: 'unused.whl', sha256: sha, depends: [] },
      },
    };
    expect([...packageClosure(lock, ['pandas']).keys()]).toEqual(['numpy', 'pandas', 'pytz']);
  });

  it('refuses a missing package, a file name with a path or no sha256', () => {
    expect(() => packageClosure({ packages: {} }, ['numpy'])).toThrow(/no package/);
    expect(() =>
      packageClosure({ packages: { a: { file_name: '../a.whl', sha256: sha, depends: [] } } }, [
        'a',
      ]),
    ).toThrow(/bad file name/);
    expect(() =>
      packageClosure({ packages: { a: { file_name: 'a.whl', sha256: 'x', depends: [] } } }, ['a']),
    ).toThrow(/no sha256/);
  });
});

describe('the pinned versions', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const vendor = readFileSync(join(ROOT, 'src', 'vendor.ts'), 'utf8');
  const pinned = JSON.parse(readFileSync(join(ROOT, 'vendor.json'), 'utf8'));

  it('are exact in package.json and the same in src/vendor.ts', () => {
    for (const [name, key] of [
      ['react', 'react'],
      ['react-dom', 'react'],
      ['recharts', 'recharts'],
      ['@babel/standalone', 'babel'],
      ['@tailwindcss/browser', 'tailwind'],
      ['pyodide', 'pyodide'],
    ]) {
      expect(pkg.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(vendor).toContain(`  ${key}: '${pkg.dependencies[name]}',`);
    }
    expect(pinned.pyodide.version).toBe(pkg.dependencies.pyodide);
    expect(pinned.pyodide.lockSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pinned.pyodide.baseUrl).toBe(
      `https://cdn.jsdelivr.net/pyodide/v${pinned.pyodide.version}/full/`,
    );
  });
});
