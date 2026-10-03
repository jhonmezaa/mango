import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Synthesis ignores dist/packs unless a test passes its own `packsDir`: the release
    // catalog on a developer's machine must not change what the tests check (CI has none).
    // One temp root for the whole run, removed at the end (see the file).
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    // Most tests synthesize whole stacks; with every file running at once a busy machine
    // passes the 5 s default (it happened to several agents and to CI before).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
