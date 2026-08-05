import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@vps-mcp/core": resolve(root, "packages/core/src/index.ts"),
      "@vps-mcp/db": resolve(root, "packages/db/src/index.ts"),
      "@vps-mcp/workspace": resolve(root, "packages/workspace/src/index.ts"),
      "@vps-mcp/attachments": resolve(root, "packages/attachments/src/index.ts"),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**", "tests/smoke/**"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
