import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      external: ["@nous/native"],
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [svelte()],
  },
});
