import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@engine": fileURLToPath(new URL("./src/renderer/src/engine", import.meta.url)),
    },
  },
  test: {
    include: ["../../tests/**/*.test.ts"],
    environment: "node",
  },
});
