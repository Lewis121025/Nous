import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ compilerOptions: { hmr: false } })],
  resolve: {
    // vitest 默认走 svelte 的 server 入口，mount/$effect 会报 lifecycle_function_unavailable
    conditions: ["browser"],
    alias: {
      // 仓库根部的主进程测试与应用使用同一 Electron 模块，确保 mock 命中。
      electron: fileURLToPath(new URL("./node_modules/electron/index.js", import.meta.url)),
      // PDF 渲染的故障注入必须命中应用实际加载的模块，避免根目录解析到另一个模块 ID。
      "pdfjs-dist": fileURLToPath(new URL("./node_modules/pdfjs-dist", import.meta.url)),
      "@engine": fileURLToPath(new URL("./src/renderer/src/engine", import.meta.url)),
      "@renderer": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
    },
  },
  test: {
    include: ["../../tests/**/*.test.ts"],
    environment: "node",
  },
});
