import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ compilerOptions: { hmr: false } })],
  resolve: {
    // vitest 默认走 svelte 的 server 入口，mount/$effect 会报 lifecycle_function_unavailable
    conditions: ["browser"],
    alias: {
      "@engine": fileURLToPath(new URL("./src/renderer/src/engine", import.meta.url)),
      "@renderer": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
    },
  },
  test: {
    include: ["../../tests/**/*.test.ts"],
    environment: "node",
  },
});
