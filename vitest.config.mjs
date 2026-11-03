import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

/**
 * Tests load n8n-workflow's CommonJS build, the one n8n itself requires. Its ESM build imports its own files without an
 * extension, which Node refuses, so vitest pulls that build through its transformer instead and warns about the source
 * maps of every one of its modules. Exported for the other suites that load the node (the repo root's, the console's).
 */
export const N8N_WORKFLOW = { find: /^n8n-workflow$/, replacement: createRequire(import.meta.url).resolve("n8n-workflow") };

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    // The family ceiling: vitest's 5s default reads a loaded machine as a failed test; the root guard
    // (test/workspace.test.js) holds every package at or above 30s. It bounds a hung test or hook, it waits for neither.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["nodes/**/*.ts", "credentials/**/*.ts", "lib/**/*.ts"]
    }
  },
  resolve: { alias: [N8N_WORKFLOW] }
});
