// Build the npm part of the mirror (D123 (3)) into dist/vendor/<package>/<version>/: ES module
// bundles of React and Recharts for the import map of a React run, and the files of Babel,
// Tailwind (browser build) and the Pyodide core as published. Versions come from the lockfile
// (pnpm checks their integrity) and must be the ones the runner names (src/vendor.ts). The
// Pyodide packages are added by fetch-pyodide-packages.mjs, in the release build only.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { listFiles, manifest } from './vendor-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const VENDOR = join(ROOT, 'dist', 'vendor');
// The .wasm files, at the same paths: the release uploads them apart, as application/wasm.
const VENDOR_WASM = join(ROOT, 'dist', 'vendor-wasm');
const WORK = join(ROOT, '.vendor-build');

const versions = Object.fromEntries(
  [
    ...readFileSync(join(ROOT, 'src', 'vendor.ts'), 'utf8').matchAll(/^ {2}(\w+): '([0-9.]+)',$/gm),
  ].map((m) => [m[1], m[2]]),
);
const installed = (name) =>
  JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
const expect = {
  react: 'react',
  recharts: 'recharts',
  babel: '@babel/standalone',
  tailwind: '@tailwindcss/browser',
  pyodide: 'pyodide',
};
for (const [key, name] of Object.entries(expect)) {
  if (installed(name) !== versions[key])
    throw new Error(`${name} ${installed(name)} is not ${versions[key]} (src/vendor.ts)`);
}
if (installed('react-dom') !== versions.react) throw new Error('react-dom and react differ');

rmSync(VENDOR, { recursive: true, force: true });
rmSync(VENDOR_WASM, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** An ES module entry for a CommonJS module: its default and each of its named exports. */
function esEntry(specifier) {
  const names = Object.keys(require(specifier)).filter(
    (n) => IDENTIFIER.test(n) && n !== 'default',
  );
  return [
    `import m from ${JSON.stringify(specifier)};`,
    'export default m;',
    ...names.map((n) => `export const ${n} = m.${n};`),
  ].join('\n');
}

const quiet = {
  configFile: false,
  logLevel: 'warn',
  root: ROOT,
  define: { 'process.env.NODE_ENV': '"production"' },
};
const REACT_SPECIFIERS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'];

// React, with one shared chunk: every entry uses the same copy of React.
const reactEntries = {
  react: 'react',
  'jsx-runtime': 'react/jsx-runtime',
  'react-dom': 'react-dom',
  'react-dom-client': 'react-dom/client',
};
const reactInput = {};
for (const [name, specifier] of Object.entries(reactEntries)) {
  const file = join(WORK, `${name}.mjs`);
  writeFileSync(file, esEntry(specifier));
  reactInput[name] = file;
}
await build({
  ...quiet,
  build: {
    outDir: join(VENDOR, 'react', versions.react),
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    rollupOptions: {
      input: reactInput,
      preserveEntrySignatures: 'strict',
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'shared-[hash].mjs' },
    },
  },
});

/**
 * React left to the import map, also for the CommonJS dependencies of Recharts (`require` cannot
 * reach an external ES module): each React specifier is an internal module that re-exports the
 * external one.
 */
const reactFromImportMap = {
  name: 'mango-react-from-import-map',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!REACT_SPECIFIERS.includes(source)) return null;
    if (importer?.startsWith('\0react:')) return { id: source, external: true };
    return `\0react:${source}`;
  },
  load(id) {
    if (!id.startsWith('\0react:')) return null;
    const specifier = JSON.stringify(id.slice('\0react:'.length));
    return `import * as m from ${specifier};\nexport * from ${specifier};\nexport default m.default ?? m;\n`;
  },
};

// Recharts, with React left to the import map.
const rechartsEntry = join(WORK, 'recharts.mjs');
writeFileSync(rechartsEntry, "export * from 'recharts';\n");
await build({
  ...quiet,
  plugins: [reactFromImportMap],
  build: {
    outDir: join(VENDOR, 'recharts', versions.recharts),
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    rollupOptions: {
      input: { recharts: rechartsEntry },
      preserveEntrySignatures: 'strict',
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'recharts-[hash].mjs' },
    },
  },
});

/** Copy files of an installed package, with its license, under vendor/<folder>/<version>/. */
function copy(name, folder, version, files) {
  const from = dirname(require.resolve(`${name}/package.json`));
  const to = join(VENDOR, folder, version);
  mkdirSync(to, { recursive: true });
  for (const file of files) cpSync(join(from, file), join(to, file.split('/').pop()));
  // Pyodide publishes its license (MPL-2.0) in its repository, not in the npm package.
  if (existsSync(join(from, 'LICENSE'))) cpSync(join(from, 'LICENSE'), join(to, 'LICENSE'));
}
copy('@babel/standalone', 'babel-standalone', versions.babel, ['babel.min.js']);
copy('@tailwindcss/browser', 'tailwindcss-browser', versions.tailwind, ['dist/index.global.js']);
copy('pyodide', 'pyodide', versions.pyodide, [
  'pyodide.js',
  'pyodide.mjs',
  'pyodide.asm.js',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]);
for (const [name, folder] of [
  ['react', 'react'],
  ['recharts', 'recharts'],
]) {
  cpSync(
    join(dirname(require.resolve(`${name}/package.json`)), 'LICENSE'),
    join(VENDOR, folder, versions[name], 'LICENSE'),
  );
}

for (const path of listFiles(VENDOR).filter((p) => p.endsWith('.wasm'))) {
  mkdirSync(dirname(join(VENDOR_WASM, path)), { recursive: true });
  renameSync(join(VENDOR, path), join(VENDOR_WASM, path));
}

rmSync(WORK, { recursive: true, force: true });
writeFileSync(
  join(VENDOR, 'manifest.json'),
  `${JSON.stringify(manifest(VENDOR, VENDOR_WASM), null, 2)}\n`,
);
console.log('Mirror built in dist/vendor (without the Pyodide packages: vendor:pyodide adds them)');
