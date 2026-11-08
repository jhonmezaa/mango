import { defineConfig } from 'vite';

// The host page of the end-to-end tests (dev server: the SPA's utility allows the loopback there).
export default defineConfig({
  root: import.meta.dirname + '/host',
  server: { port: 4602, strictPort: true, host: 'localhost' },
  logLevel: 'warn',
});
