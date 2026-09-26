/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/state/workspace.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

// 与内核恢复流程同构的最小合法编辑器恢复记录。
const editorRecovery = JSON.stringify({
  format: "nous.prosemirror",
  version: 1,
  revision: 1,
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "math_inline", attrs: { tex: "" } }] }],
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("源码视图记忆", () => {
  it("恢复会话时按记忆直接以源码视图打开，未记住的文件回排版", async () => {
    const sessionSetSourceViews = vi.fn(async () => {});
    const workspace = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: vi.fn(async () => ({
          root: "/notes",
          documents: {
            panes: [{ currentPath: "b.md", history: { back: [], forward: [] } }],
            active: 0,
            split: false,
          },
          sourceViews: ["b.md"],
        })),
        vaultEntries: vi.fn(async () => [
          { path: "a.md", kind: "file" as const },
          { path: "b.md", kind: "file" as const },
        ]),
        fileSnapshot: vi.fn(async () => ({ disk: encode("# 笔记\n"), draft: null })),
        sessionSetSourceViews,
      }),
    );
    await workspace.restore();
    expect(workspace.document.path).toBe("b.md");
    expect(workspace.viewMode).toBe("source");

    await workspace.openFile("a.md");
    expect(workspace.viewMode).toBe("wysiwyg");
  });

  it("带恢复记录的文件强制排版视图，即使被记忆为源码", async () => {
    const workspace = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: vi.fn(async () => ({
          root: "/notes",
          documents: {
            panes: [{ currentPath: "b.md", history: { back: [], forward: [] } }],
            active: 0,
            split: false,
          },
          sourceViews: ["b.md"],
        })),
        vaultEntries: vi.fn(async () => [{ path: "b.md", kind: "file" as const }]),
        fileSnapshot: vi.fn(async () => ({
          disk: encode("# 笔记\n"),
          draft: {
            bytes: encode("# 笔记\n"),
            base: encode("# 笔记\n"),
            editor: editorRecovery,
          },
        })),
      }),
    );
    await workspace.restore();
    expect(workspace.document.needsSourceRepair).toBe(true);
    expect(workspace.viewMode).toBe("wysiwyg");
  });

  it("改名后视图记忆跟随新路径", async () => {
    const workspace = new ReaderWorkspaceController(
      createReaderApiMock({
        vaultRestore: vi.fn(async () => ({
          root: "/notes",
          documents: {
            panes: [{ currentPath: null, history: { back: [], forward: [] } }],
            active: 0,
            split: false,
          },
          sourceViews: ["a.md"],
        })),
        vaultEntries: vi.fn(async () => [
          { path: "a.md", kind: "file" as const },
          { path: "renamed.md", kind: "file" as const },
        ]),
        fileSnapshot: vi.fn(async () => ({ disk: encode("# 笔记\n"), draft: null })),
      }),
    );
    await workspace.restore();
    await workspace.renameEntry("a.md", "renamed.md");
    await workspace.openFile("renamed.md");
    expect(workspace.viewMode).toBe("source");
  });
});
