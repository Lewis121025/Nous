import { defineConfig } from "vitest/config";

// 基准使用实际内核线程；运行前须构建，不将波动的耗时作为单元测试断言。
export default defineConfig({
  test: {
    environment: "node",
    include: ["../../tests/desktop/performance/*.test.mts"],
    testTimeout: 30000,
  },
});
