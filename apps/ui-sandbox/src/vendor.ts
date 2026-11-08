/**
 * The mirror of browser dependencies (D123 (3)): fixed versions, built or copied into
 * `dist/vendor/<package>/<version>/` by `scripts/build-vendor.mjs` (npm packages, verified by the
 * pnpm lockfile) and `scripts/fetch-pyodide-packages.mjs` (the Pyodide wheels, verified against
 * `pyodide-lock.json`, whose own sha256 is pinned in `vendor.json`). The release publishes it
 * with the runner; nothing is fetched at run time (D25).
 */
export const VENDOR_VERSIONS = {
  react: '18.3.1',
  recharts: '3.8.1',
  babel: '8.1.1',
  tailwind: '4.3.5',
  pyodide: '0.26.4',
} as const;

/** Paths under the second origin, from its root. */
export const VENDOR_PATHS = {
  react: `/vendor/react/${VENDOR_VERSIONS.react}/react.mjs`,
  jsxRuntime: `/vendor/react/${VENDOR_VERSIONS.react}/jsx-runtime.mjs`,
  reactDom: `/vendor/react/${VENDOR_VERSIONS.react}/react-dom.mjs`,
  reactDomClient: `/vendor/react/${VENDOR_VERSIONS.react}/react-dom-client.mjs`,
  recharts: `/vendor/recharts/${VENDOR_VERSIONS.recharts}/recharts.mjs`,
  babel: `/vendor/babel-standalone/${VENDOR_VERSIONS.babel}/babel.min.js`,
  tailwind: `/vendor/tailwindcss-browser/${VENDOR_VERSIONS.tailwind}/index.global.js`,
  pyodide: `/vendor/pyodide/${VENDOR_VERSIONS.pyodide}/`,
} as const;

/** The import map of a React run: the only modules its code may import. */
export function importMap(origin: string): { imports: Record<string, string> } {
  return {
    imports: {
      react: origin + VENDOR_PATHS.react,
      'react/jsx-runtime': origin + VENDOR_PATHS.jsxRuntime,
      'react-dom': origin + VENDOR_PATHS.reactDom,
      'react-dom/client': origin + VENDOR_PATHS.reactDomClient,
      recharts: origin + VENDOR_PATHS.recharts,
    },
  };
}
