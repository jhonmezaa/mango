import { defineConfig } from 'vitest/config';

// Unit tests of the helpers (TOTP, masking, configuration). They never reach an installation.
export default defineConfig({ test: { include: ['unit/**/*.test.ts'] } });
