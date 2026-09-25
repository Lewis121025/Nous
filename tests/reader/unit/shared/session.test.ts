import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEFT_WIDTH,
  emptyReaderSession,
  parsePaneLayout,
  parseReaderSession,
} from "@reader/shared/session";

describe("阅读器会话边界", () => {
  it("宽度限制在安全范围，缺失和非法值使用默认值", () => {
    expect(parsePaneLayout({ leftWidth: 12 })?.leftWidth).toBe(192);
    expect(parsePaneLayout({ leftWidth: 999 })?.leftWidth).toBe(480);
    expect(parsePaneLayout({ leftWidth: Infinity })?.leftWidth).toBe(DEFAULT_LEFT_WIDTH);
    expect(parsePaneLayout({})?.leftWidth).toBe(DEFAULT_LEFT_WIDTH);
  });
  it("布局更新不能注入应用设置或笔记库路径", () => {
    expect(
      parsePaneLayout({
        vaultRoot: "/evil",
        currentPath: "stolen.md",
        appearance: "dark",
        window: {},
        filesCollapsed: true,
        leftWidth: 200,
        rightSplit: true,
      }),
    ).toEqual({ filesCollapsed: true, leftWidth: 200 });
    expect(parsePaneLayout(null)).toBeNull();
    expect(parsePaneLayout([])).toBeNull();
  });
  it("旧目录状态不影响文件栏，状态解析只返回阅读器字段", () => {
    expect(parseReaderSession({ outlineCollapsed: false, appearance: "dark", window: {} })).toEqual(
      emptyReaderSession,
    );
    expect(parseReaderSession(null)).toEqual(emptyReaderSession);
    expect(parseReaderSession({ currentPath: "", vaultRoot: 1 })).toEqual(emptyReaderSession);
  });
});
