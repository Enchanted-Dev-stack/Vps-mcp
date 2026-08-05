import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@vps-mcp/core": resolve(root, "packages/core/src/index.ts"),
      "@vps-mcp/db": resolve(root, "packages/db/src/index.ts"),
    },
  },
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
