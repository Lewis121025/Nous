/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@renderer/App.svelte";
import type {
  FileSnapshot,
  NousApi,
  SavedCopy,
  WriteResult,
} from "../../../apps/desktop/src/shared/api";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let app: ReturnType<typeof mount>;
let target: HTMLDivElement;
let onClose: () => void;
let onChanged: () => void;
let disk: Map<string, Uint8Array>;
let api: NousApi;

beforeEach(() => {
  disk = new Map([
    ["note.md", encode("base\n")],
    ["other.md", encode("other\n")],
  ]);
  api = {
    vaultRestore: vi.fn(async () => ({ root: "/notes", currentPath: "note.md" })),
    vaultOpen: vi.fn(async () => null),
    vaultClose: vi.fn(async () => {}),
    vaultList: vi.fn(async () => [...disk.keys()]),
    fileRead: vi.fn(async (path) => disk.get(path)!),
    fileSnapshot: vi.fn(async (path) => ({ disk: disk.get(path) ?? null, draft: null })),
    fileWrite: vi.fn(async (path, bytes) => {
      disk.set(path, bytes);
      return { status: "saved" as const, warning: null };
    }),
    fileWriteCopy: vi.fn(async (_path, bytes) => {
      disk.set("note (副本).md", bytes);
      return { path: "note (副本).md", warning: null };
    }),
    sessionSetCurrent: vi.fn(async () => {}),
    sessionGetPanes: vi.fn(async () => ({ filesCollapsed: false, outlineCollapsed: false })),
    sessionSetPanes: vi.fn(async () => {}),
    linksResolve: vi.fn(async () => null),
    indexLinksTo: vi.fn(async () => []),
    indexLinksFrom: vi.fn(async () => []),
    entryRename: vi.fn(async () => ({ warning: null })),
    subscribeVaultChanged: (callback) => {
      onChanged = callback;
      return () => {};
    },
    subscribeFlushBeforeClose: (callback) => {
      onClose = callback;
      return () => {};
    },
    closeAfterFlush: vi.fn(async () => {}),
    closeBlocked: vi.fn(async () => {}),
  };
  window.nous = api;
});

afterEach(async () => {
  await unmount(app);
  target.remove();
});

async function start(): Promise<void> {
  target = document.createElement("div");
  document.body.append(target);
  app = mount(App, { target });
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".ProseMirror")).not.toBeNull();
    expect(target.querySelector(".panes")?.hasAttribute("inert")).toBe(false);
  });
}

function click(label: string): void {
  const button = [...target.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  button!.click();
  flushSync();
}

async function edit(text: string): Promise<void> {
  const paragraph = target.querySelector(".ProseMirror p")!;
  paragraph.textContent = text;
  // 通过真实 ProseMirror 的 DOM 观察器提交编辑，避免只测试模拟的 dirty 标记。
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  flushSync();
}

function status(): string | null {
  flushSync();
  return target.querySelector('[role="status"]')?.textContent ?? null;
}

function renameTo(name: string): void {
  const input = target.querySelector<HTMLInputElement>('input[name="rename"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  target
    .querySelector("form.rename")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flushSync();
}

describe("保存、冲突与恢复的完整界面流程", () => {
  it("二进制附件不能进入文本编辑器，切换和关闭也不会写回附件", async () => {
    const binary = new Uint8Array([80, 75, 3, 4, 0, 255]);
    disk.set("archive.zip", binary);
    await start();
    click("archive.zip");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".file.active")?.textContent?.trim()).toBe("archive.zip");
    });
    expect(target.querySelector(".cm-editor")).toBeNull();
    expect(target.textContent).toContain("暂不支持预览此文件");
    click("保存");
    onClose();
    await vi.waitFor(() => expect(api.closeAfterFlush).toHaveBeenCalled());
    expect(api.fileWrite).not.toHaveBeenCalled();
    expect(disk.get("archive.zip")).toEqual(binary);
  });

  it("旧版本误建的附件文本草稿不能覆盖原二进制文件", async () => {
    const binary = new Uint8Array([80, 75, 3, 4, 0, 255]);
    disk.set("archive.zip", binary);
    await start();
    vi.mocked(api.fileSnapshot).mockResolvedValueOnce({
      disk: binary,
      draft: { bytes: encode("mistaken text edit"), base: binary },
    });
    click("archive.zip");
    await vi.waitFor(() => expect(status()).toBe("只读预览"));
    expect(target.querySelector(".cm-editor")).toBeNull();
    click("other.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("other");
    });
    expect(api.fileWrite).not.toHaveBeenCalled();
    expect(disk.get("archive.zip")).toEqual(binary);
  });

  it("外部将文本替换为二进制后，刷新会退出编辑器并禁用保存", async () => {
    await start();
    disk.set("note.md", new Uint8Array([0, 255]));
    onChanged();
    await vi.waitFor(() => expect(status()).toBe("只读预览"));
    expect(target.querySelector(".ProseMirror")).toBeNull();
    expect(target.textContent).toContain("暂不支持预览此文件");
    expect(api.fileWrite).not.toHaveBeenCalled();
  });

  it("外部文件变为二进制时，仍恢复原本有效的文本草稿并保留冲突", async () => {
    const binary = new Uint8Array([0, 255]);
    vi.mocked(api.fileSnapshot).mockResolvedValue({
      disk: binary,
      draft: { bytes: encode("recovered text\n"), base: encode("base\n") },
    });
    await start();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("recovered text");
    expect(status()).toBe("存在保存冲突");
    expect(api.fileWrite).not.toHaveBeenCalled();
  });

  it("重命名提交后的索引警告保留新路径，并明确说明文件已经改名", async () => {
    await start();
    vi.mocked(api.entryRename).mockImplementation(async (from, to) => {
      disk.set(to, disk.get(from)!);
      disk.delete(from);
      return { warning: "链接索引更新失败" };
    });
    renameTo("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".file.active")?.textContent?.trim()).toBe("renamed.md");
      expect(target.textContent).toContain("文件已重命名。链接索引更新失败");
    });
    expect(api.sessionSetCurrent).toHaveBeenLastCalledWith("renamed.md");
    expect(status()).toBe("已保存");
  });

  it("重命名失败后保持原文件可编辑", async () => {
    await start();
    vi.mocked(api.entryRename).mockRejectedValue(new Error("写入失败，已恢复原文件"));
    renameTo("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain("改名失败：写入失败，已恢复原文件");
    });
    expect(target.querySelector(".file.active")?.textContent?.trim()).toBe("note.md");
    await edit("after failure");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(decode(disk.get("note.md")!)).toBe("after failure\n");
  });

  it("改名已提交但读回失败时，提示真实结果并允许从新路径重新打开", async () => {
    await start();
    vi.mocked(api.entryRename).mockImplementation(async (from, to) => {
      disk.set(to, disk.get(from)!);
      disk.delete(from);
      return { warning: null };
    });
    vi.mocked(api.fileSnapshot).mockRejectedValueOnce(new Error("读取失败"));
    renameTo("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain("文件已重命名为 renamed.md，但界面更新失败");
      expect(target.querySelector(".ProseMirror")).toBeNull();
    });
    click("renamed.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("base");
    });
    expect(api.sessionSetCurrent).toHaveBeenLastCalledWith("renamed.md");
  });

  it("外部恢复成最初内容时，编辑器也必须重载，不能只更新保存基准", async () => {
    await start();
    await edit("saved edit");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    disk.set("note.md", encode("base\n"));
    onChanged();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("base");
    });
  });

  it("保存期间到达的监视事件会在提交后重新读取", async () => {
    await start();
    await edit("saved edit");
    const pending = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(pending.promise);
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("正在保存…"));
    disk.set("note.md", encode("external after save\n"));
    onChanged();
    pending.resolve({ status: "saved", warning: null });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("external after save");
    });
  });

  it("携带原始版本保存，冲突后保留编辑并阻止切换和关闭", async () => {
    await start();
    await edit("my edits");
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "conflict", disk: encode("external\n") });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    expect(api.fileWrite).toHaveBeenCalledWith("note.md", encode("my edits\n"), encode("base\n"));
    expect(target.querySelector(".save-notice pre")?.textContent).toBe("external\n");
    click("other.md");
    onClose();
    await vi.waitFor(() => expect(api.closeBlocked).toHaveBeenCalled());
    expect(api.closeAfterFlush).not.toHaveBeenCalled();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("my edits");
    expect(api.fileSnapshot).not.toHaveBeenCalledWith("other.md");
  });

  it("写入失败仍可继续输入，重试使用最新内容", async () => {
    await start();
    await edit("first");
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new Error("磁盘空间不足"));
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("保存失败"));
    await edit("latest");
    click("重试保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(decode(disk.get("note.md")!)).toBe("latest\n");
  });

  it("在保存期间输入的内容保持未保存，后续写入使用已提交的基准", async () => {
    await start();
    await edit("first");
    const pending = deferred<WriteResult>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(pending.promise);
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("正在保存…"));
    await edit("second");
    pending.resolve({ status: "saved", warning: null });
    await vi.waitFor(() => expect(status()).toBe("未保存"));
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("second");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(api.fileWrite).toHaveBeenLastCalledWith(
      "note.md",
      encode("second\n"),
      encode("first\n"),
    );
  });

  it("已提交内容的索引警告不会把文件标成未保存或阻止关闭", async () => {
    await start();
    await edit("saved content");
    vi.mocked(api.fileWrite).mockResolvedValue({ status: "saved", warning: "链接索引更新失败" });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(target.textContent).toContain("内容已保存。链接索引更新失败");
    onClose();
    await vi.waitFor(() => expect(api.closeAfterFlush).toHaveBeenCalled());
    expect(api.closeBlocked).not.toHaveBeenCalled();
  });

  it("另存副本期间继续输入，切换到副本时仍保留最新内容", async () => {
    await start();
    await edit("my edits");
    vi.mocked(api.fileWrite).mockResolvedValueOnce({
      status: "conflict",
      disk: encode("external\n"),
    });
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("存在保存冲突"));
    const pending = deferred<SavedCopy>();
    vi.mocked(api.fileWriteCopy).mockReturnValueOnce(pending.promise);
    click("另存为副本");
    await edit("newer edits");
    pending.resolve({ path: "note (副本).md", warning: null });
    await vi.waitFor(() => expect(status()).toBe("未保存"));
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("newer edits");
    expect(api.sessionSetCurrent).toHaveBeenLastCalledWith("note (副本).md");
    click("保存");
    await vi.waitFor(() => expect(status()).toBe("已保存"));
    expect(api.fileWrite).toHaveBeenLastCalledWith(
      "note (副本).md",
      encode("newer edits\n"),
      encode("my edits\n"),
    );
  });

  it("重新启动可打开已删除文件的恢复草稿，并提示删除冲突", async () => {
    disk.delete("note.md");
    vi.mocked(api.vaultList).mockResolvedValue(["note.md", "other.md"]);
    vi.mocked(api.fileSnapshot).mockResolvedValue({
      disk: null,
      draft: { bytes: encode("recovered\n"), base: encode("base\n") },
    });
    await start();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("recovered");
    expect(status()).toBe("存在保存冲突");
    expect(target.textContent).toContain("原文件已在其他地方删除");
    expect(target.textContent).toContain("已恢复上次未保存的编辑");
    expect(api.fileWrite).not.toHaveBeenCalled();
  });

  it("晚到的文件监视结果不能覆盖新打开的文件", async () => {
    await start();
    const pending = deferred<FileSnapshot>();
    vi.mocked(api.fileSnapshot).mockReturnValueOnce(pending.promise);
    onChanged();
    await vi.waitFor(() => expect(api.fileSnapshot).toHaveBeenCalledTimes(2));
    click("other.md");
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".ProseMirror")?.textContent).toBe("other");
    });
    pending.resolve({ disk: encode("stale content\n"), draft: null });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.querySelector(".ProseMirror")?.textContent).toBe("other");
  });
});
