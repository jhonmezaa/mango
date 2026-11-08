import { defineConfig } from 'vitest/config';

/**
 * The runner of the second origin (D123): `sandbox.html` and its hashed assets. The inner
 * frame's bootstrap and the Python worker are built as classic scripts the runner reads as text
 * (an opaque origin cannot load them otherwise). The mirror (`dist/vendor/`) is built after this
 * by `scripts/build-vendor.mjs`.
 */
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: { input: 'sandbox.html' },
  },
  worker: { format: 'iife' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
