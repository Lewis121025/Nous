import { describe, expect, it } from "vitest";
import { deadLinkCreatePath } from "@reader/renderer/engine/navigation/dead-link";

describe("deadLinkCreatePath", () => {
  it("裸名落在当前笔记目录并补上 md", () => {
    expect(deadLinkCreatePath("notes/ref.md", "missing", "wiki")).toEqual({
      path: "notes/missing.md",
      anchor: null,
    });
    expect(deadLinkCreatePath("ref.md", "missing#小节", "wiki")).toEqual({
      path: "missing.md",
      anchor: "小节",
    });
  });

  it("路径形式按库根解释，已有扩展名不再追加", () => {
    expect(deadLinkCreatePath("ref.md", "dir/foo", "wiki")).toEqual({
      path: "dir/foo.md",
      anchor: null,
    });
    expect(deadLinkCreatePath("ref.md", "shot.png", "wiki")).toEqual({
      path: "shot.png",
      anchor: null,
    });
  });

  it("Markdown 相对路径解码并拒绝越界和纯锚点", () => {
    expect(deadLinkCreatePath("a/ref.md", "./my%20note.md#sec", "md")).toEqual({
      path: "a/my note.md",
      anchor: "sec",
    });
    expect(deadLinkCreatePath("ref.md", "../secret.md", "md")).toBeNull();
    expect(deadLinkCreatePath("ref.md", "#小节", "wiki")).toBeNull();
    expect(deadLinkCreatePath("ref.md", ".hidden", "wiki")).toBeNull();
  });
});
