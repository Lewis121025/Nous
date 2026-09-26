/** @vitest-environment jsdom */
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/state/workspace.svelte";
import type { LinkTarget, ReaderApi } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function createApi(resolveResult: LinkTarget): ReaderApi {
  return createReaderApiMock({
    vaultEntries: vi.fn(async () => [
      { path: "a/foo.md", kind: "file" as const },
      { path: "b/foo.md", kind: "file" as const },
      { path: "ref.md", kind: "file" as const },
    ]),
    fileSnapshot: vi.fn(async () => ({
      disk: encode("# 笔记\n\n## 小节\n\n正文。\n"),
      draft: null,
    })),
    linksResolve: vi.fn(async () => resolveResult),
  });
}

async function startWorkspace(api: ReaderApi): Promise<ReaderWorkspaceController> {
  const workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  await workspace.openFile("ref.md");
  flushSync();
  return workspace;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("链接跳转的解析分支", () => {
  it("可创建的死链等待确认，纯锚点只提示无法跳转", async () => {
    const workspace = await startWorkspace(createApi({ status: "dead" }));
    await workspace.openLink("wiki", "missing#小节");
    expect(workspace.deadLinkOffer).toEqual({ path: "missing.md", anchor: "小节" });
    expect(workspace.document.path).toBe("ref.md");
    workspace.dismissDeadLink();
    expect(workspace.deadLinkOffer).toBeNull();

    await workspace.openLink("wiki", "#");
    expect(workspace.message).toContain("死链");
    expect(workspace.deadLinkOffer).toBeNull();
  });

  it("确认死链后创建笔记并打开", async () => {
    const api = createApi({ status: "dead" });
    const workspace = await startWorkspace(api);
    await workspace.openLink("wiki", "missing");
    await workspace.confirmDeadLink();
    await settle();
    expect(api.entryCreate).toHaveBeenCalledWith("missing.md", "file");
    expect(workspace.document.path).toBe("missing.md");
    expect(workspace.deadLinkOffer).toBeNull();
  });

  it("歧义候选等待用户选择，选中后打开并清空候选", async () => {
    const workspace = await startWorkspace(
      createApi({
        status: "ambiguous",
        candidates: ["a/foo.md", "b/foo.md"],
        anchor: null,
      }),
    );
    await workspace.openLink("wiki", "foo");
    expect(workspace.document.path).toBe("ref.md");
    expect(workspace.linkCandidates).toEqual({
      paths: ["a/foo.md", "b/foo.md"],
      anchor: null,
    });

    await workspace.chooseLinkCandidate("b/foo.md");
    await settle();
    expect(workspace.document.path).toBe("b/foo.md");
    expect(workspace.linkCandidates).toBeNull();
  });

  it("放弃候选选择不打开任何目标", async () => {
    const workspace = await startWorkspace(
      createApi({ status: "ambiguous", candidates: ["a/foo.md", "b/foo.md"], anchor: null }),
    );
    await workspace.openLink("wiki", "foo");
    workspace.dismissLinkCandidates();
    expect(workspace.linkCandidates).toBeNull();
    expect(workspace.document.path).toBe("ref.md");
  });

  it("跨文件锚点打开目标文件；编辑器缺席时定位留待挂载兑现", async () => {
    const workspace = await startWorkspace(
      createApi({ status: "resolved", path: "a/foo.md", anchor: "小节" }),
    );
    await workspace.openLink("wiki", "a/foo#小节");
    await settle();
    expect(workspace.document.path).toBe("a/foo.md");
    // 无编辑器可定位时不得崩溃，也不误报锚点失效（失效提示属于编辑器验证）。
    expect(workspace.message).not.toContain("未找到标题");
  });

  it("同文档锚点没有编辑器可验证时给出可见的失效提示", async () => {
    const workspace = await startWorkspace(
      createApi({ status: "resolved", path: "ref.md", anchor: "小节" }),
    );
    await workspace.openLink("wiki", "#小节");
    expect(workspace.document.path).toBe("ref.md");
    expect(workspace.message).toContain("未找到标题");
  });

  it("无锚点的唯一解析直接打开文件", async () => {
    const workspace = await startWorkspace(
      createApi({ status: "resolved", path: "a/foo.md", anchor: null }),
    );
    await workspace.openLink("wiki", "a/foo");
    await settle();
    expect(workspace.document.path).toBe("a/foo.md");
    expect(workspace.message).not.toContain("未找到标题");
  });
});
