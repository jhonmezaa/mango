import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

import { mockBackend } from './mock/mockBackend.ts';

/**
 * Defense-in-depth CSP injected only into the production build. The authoritative policy is the
 * CloudFront response header (see README); a meta policy cannot carry frame-ancestors or
 * report-uri, and connect-src is left to the header because the Cognito domain is runtime config.
 */
const BUILD_CSP = [
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "img-src 'self' data:",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

function buildCspMeta(): Plugin {
  return {
    name: 'mango-build-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: BUILD_CSP },
          injectTo: 'head-prepend',
        },
      ],
    },
  };
}

/** Serves /config.json from config.local.json when developing against a real backend. */
function localRuntimeConfig(): Plugin {
  const file = resolve(import.meta.dirname, 'config.local.json');
  return {
    name: 'mango-local-runtime-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end('config.local.json not found (see apps/web/README.md)');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const isMock = mode === 'mock';
  return {
    plugins: [
      react(),
      tailwindcss(),
      buildCspMeta(),
      isMock ? mockBackend() : localRuntimeConfig(),
    ],
    server: {
      port: 5173,
      strictPort: true,
      proxy: isMock ? {} : { '/api': process.env.MANGO_API_URL ?? 'http://localhost:8000' },
    },
    preview: { port: 4173, strictPort: true },
    build: {
      // Source maps reveal code structure and internal URLs; they are not published.
      sourcemap: false,
      target: 'es2023',
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'react',
                test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
              },
              {
                name: 'markdown',
                test: /node_modules[\\/](react-markdown|remark-|mdast-|micromark|unified|hast-|unist-|vfile|property-information|decode-named|character-|trim-lines|ccount|markdown-table|devlop|bail|is-plain-obj|trough|zwitch|longest-streak|space-separated|comma-separated|html-url-attributes|estree-|style-to-|inline-style-parser|escape-string-regexp)/,
              },
              // Login-only libraries loaded on demand (D20): the SSO redirect and the TOTP
              // enrollment QR stay out of the eager vendor chunk.
              { name: 'oidc', test: /node_modules[\\/](oidc-client-ts|jwt-decode)[\\/]/ },
              { name: 'qrcode', test: /node_modules[\\/]qrcode-generator[\\/]/ },
              { name: 'vendor', test: /node_modules/ },
            ],
          },
        },
      },
    },
    test: {
      restoreMocks: true,
      projects: [
        {
          extends: true,
          test: {
            name: 'web',
            environment: 'jsdom',
            setupFiles: ['./src/test/setup.ts'],
            include: ['src/**/*.test.{ts,tsx}'],
          },
        },
        // The mock backend is Node code (a dev-server plugin): its tests run without a DOM.
        {
          extends: true,
          test: { name: 'mock', environment: 'node', include: ['mock/**/*.test.ts'] },
        },
      ],
    },
  };
});
