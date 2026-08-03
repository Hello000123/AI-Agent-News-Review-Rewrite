import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/live-writing-only-review.mts"],
    restoreMocks: true,
  },
});
