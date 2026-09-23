import { defineConfig } from "vitest/config";

// 使用生产构建验证浏览器 API、工作线程与离线资源；Linux 运行时需要显示服务器。
export default defineConfig({
  test: {
    include: ["../../tests/desktop/e2e/attachments.test.mts"],
    environment: "node",
    testTimeout: 45000,
  },
});
