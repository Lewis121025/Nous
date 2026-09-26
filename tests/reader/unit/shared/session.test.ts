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
  it("阅读栈逐条归一化，损坏条目丢弃且不阻止会话恢复", () => {
    const parsed = parseReaderSession({
      history: {
        back: [{ path: "a.md", anchor: "小节" }, { path: "" }, "junk", { path: "b.md", anchor: 5 }],
        forward: [{ path: "c.md" }],
      },
    });
    expect(parsed.documents.panes[0]?.history).toEqual({
      back: [
        { path: "a.md", anchor: "小节" },
        { path: "b.md", anchor: null },
      ],
      forward: [{ path: "c.md", anchor: null }],
    });
    expect(parseReaderSession({}).documents.panes[0]?.history).toEqual({ back: [], forward: [] });
    // 超长历史被截到上限，会话文件不随导航无限增长。
    const long = Array.from({ length: 150 }, (_, index) => ({
      path: `f${index}.md`,
      anchor: null,
    }));
    expect(
      parseReaderSession({ history: { back: long, forward: [] } }).documents.panes[0]?.history.back,
    ).toHaveLength(100);
  });
  it("源码视图记忆去重、丢弃非文本并截到上限", () => {
    expect(parseReaderSession({ sourceViews: ["a.md", 5, "", "a.md"] }).sourceViews).toEqual([
      "a.md",
    ]);
    const many = Array.from({ length: 600 }, (_, index) => `f${index}.md`);
    expect(parseReaderSession({ sourceViews: many }).sourceViews).toHaveLength(500);
    expect(parseReaderSession({}).sourceViews).toEqual([]);
  });
});
