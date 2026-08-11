import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    setupFiles: ["./src/test/setup.ts"],
    // Each DB-backed suite boots its own WASM Postgres, which is memory-hungry.
    // Running files in parallel exhausts the heap once a few suites exist, so
    // trade a little wall-clock for headroom.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": src,
      "server-only": `${src}/test/server-only-stub.ts`,
    },
  },
});
