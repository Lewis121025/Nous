import { defineConfig } from "vitest/config";

// 使用生产构建验证浏览器 API、工作线程与离线资源；Linux 运行时需要显示服务器。
export default defineConfig({
  test: {
    include: [
      "../../tests/reader/e2e/attachments.test.mts",
      "../../tests/reader/e2e/attachment-import.test.mts",
      "../../tests/reader/e2e/workspace.test.mts",
      "../../tests/reader/e2e/writing.test.mts",
      "../../tests/reader/e2e/composition.test.mts",
      "../../tests/reader/e2e/history.test.mts",
      "../../tests/reader/e2e/protocol-failure.test.mts",
      "../../tests/reader/e2e/table.test.mts",
      "../../tests/reader/e2e/continuous-editing.test.mts",
      "../../tests/reader/e2e/external-reload.test.mts",
      "../../tests/reader/e2e/files.test.mts",
      "../../tests/reader/e2e/vault-search.test.mts",
      "../../tests/reader/e2e/links-navigation.test.mts",
      "../../tests/reader/e2e/source-mode.test.mts",
      "../../tests/reader/e2e/recovery.test.mts",
      "../../tests/reader/e2e/source-recovery.test.mts",
      "../../tests/reader/e2e/visual-scenes.test.mts",
    ],
    environment: "node",
    // 原生窗口共享系统焦点和菜单，键盘旅程必须串行，避免多个应用争抢组合键。
    fileParallelism: false,
    testTimeout: 45000,
  },
});
