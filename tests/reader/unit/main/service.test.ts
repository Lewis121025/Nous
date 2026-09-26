import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultEvent } from "@reader/shared/api";
import { createReaderService } from "@reader/main/service";

const { native, session } = vi.hoisted(() => ({
  native: {
    vaultOpen: vi.fn(),
    vaultClose: vi.fn(),
    fileRead: vi.fn(),
    fileSnapshot: vi.fn(),
    fileWrite: vi.fn(),
    indexMentionsTo: vi.fn(),
    searchQuery: vi.fn(),
    indexHeadings: vi.fn(),
    entryRename: vi.fn(),
    entryTrash: vi.fn(),
    entryCreate: vi.fn(),
    attachmentImport: vi.fn(),
  },
  session: {
    saveSession: vi.fn(),
    loadSession: vi.fn(),
  },
}));

vi.mock("node:module", () => ({ createRequire: () => () => native }));

function documents(
  currentPath: string | null,
  history: {
    back: { path: string; anchor: string | null }[];
    forward: { path: string; anchor: string | null }[];
  } = {
    back: [],
    forward: [],
  },
) {
  return { panes: [{ currentPath, history }], active: 0, split: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.loadSession.mockReturnValue({
    vaultRoot: "/first",
    documents: documents("a.md"),
    filesCollapsed: false,
    leftWidth: 232,
    sourceViews: [],
  });
});

describe("文件操作与会话提交", () => {
  it("附件导入核对笔记库归属，返回实际路径并传播提交后的索引警告", () => {
    const changed = vi.fn();
    const service = createReaderService("/state", changed, {
      load: session.loadSession,
      save: session.saveSession,
    });
    service.vaultOpen("/first");
    native.attachmentImport.mockReturnValue({ path: "attachments/a (1).png", warning: "索引失败" });
    const bytes = new Uint8Array([0, 255]);
    expect(service.attachmentImport("/first", "a.md", "a.png", bytes)).toEqual({
      path: "attachments/a (1).png",
      warning: "索引失败",
    });
    expect(native.attachmentImport).toHaveBeenCalledWith("a.md", "a.png", Buffer.from(bytes));
    expect(changed).toHaveBeenCalledWith({
      status: "changed",
      paths: ["attachments/a (1).png"],
      healthy: false,
    });
    expect(() => service.attachmentImport("/second", "a.md", "a.png", bytes)).toThrow(
      "笔记库已切换",
    );
    service.vaultClose();
    expect(() => service.attachmentImport("/first", "a.md", "a.png", bytes)).toThrow(
      "笔记库已切换",
    );
    expect(native.attachmentImport).toHaveBeenCalledTimes(1);
  });

  it("移动父文件夹后会话跟随子文件，阅读栈与源码视图记忆同口径迁移，成功通知只触发一次", () => {
    session.loadSession.mockReturnValue({
      vaultRoot: "/notes",
      documents: documents("old/sub/note.md", {
        back: [
          { path: "old/a.md", anchor: null },
          { path: "keep.md", anchor: "小节" },
        ],
        forward: [{ path: "old/sub/note.md", anchor: null }],
      }),
      sourceViews: ["old/sub/view.md"],
    });
    native.entryRename.mockReturnValue({});
    const changed = vi.fn();
    const service = createReaderService("/state", changed, {
      load: session.loadSession,
      save: session.saveSession,
    });
    expect(service.entryRename("old", "new")).toEqual({ warning: null });
    expect(session.saveSession).toHaveBeenCalledWith({
      vaultRoot: "/notes",
      documents: documents("new/sub/note.md", {
        back: [
          { path: "new/a.md", anchor: null },
          { path: "keep.md", anchor: "小节" },
        ],
        forward: [{ path: "new/sub/note.md", anchor: null }],
      }),
      sourceViews: ["new/sub/view.md"],
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("删除当前目录清空会话，前缀相似的兄弟目录不受影响", () => {
    native.entryTrash.mockReturnValue({});
    const service = createReaderService("/state", vi.fn(), {
      load: session.loadSession,
      save: session.saveSession,
    });
    session.loadSession.mockReturnValue({
      documents: documents("old-archive/note.md"),
      sourceViews: [],
    });
    service.entryTrash("old");
    expect(session.saveSession).not.toHaveBeenCalled();
    session.loadSession.mockReturnValue({
      documents: documents("old/sub/note.md", {
        back: [{ path: "old/sub/other.md", anchor: null }],
        forward: [],
      }),
      sourceViews: ["old/sub/view.md"],
    });
    service.entryTrash("old");
    expect(session.saveSession).toHaveBeenCalledWith({
      documents: documents(null),
      sourceViews: [],
    });
  });

  it("会话写入失败作为提交后警告，不把已经移动的文件报告成失败", () => {
    session.loadSession.mockReturnValue({
      documents: documents("old/note.md"),
      sourceViews: [],
    });
    session.saveSession.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    native.entryRename.mockReturnValue({ warning: "索引刷新待重试" });
    const changed = vi.fn();
    const service = createReaderService("/state", changed, {
      load: session.loadSession,
      save: session.saveSession,
    });
    const outcome = service.entryRename("old", "new");
    expect(outcome.warning).toContain("索引刷新待重试");
    expect(outcome.warning).toContain("会话更新失败");
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

it("工作线程返回已链接与未链接提及，未知种类作为索引错误传播", () => {
  const mention = {
    fromPath: "source.md",
    fromTitle: "来源",
    mtime: 1,
    startByte: 0,
    endByte: 8,
    snippet: "目标",
    toRaw: "target",
  };
  native.indexMentionsTo.mockReturnValue({
    linked: [{ ...mention, kind: "linked", linkKind: "wiki" }],
    unlinked: [{ ...mention, kind: "unlinked" }],
  });
  const service = createReaderService("/state", vi.fn(), {
    load: session.loadSession,
    save: session.saveSession,
  });
  expect(service.indexMentionsTo("target.md")).toEqual({
    linked: [{ ...mention, kind: "linked", linkKind: "wiki" }],
    unlinked: [{ ...mention, kind: "unlinked", linkKind: null }],
  });
  expect(native.indexMentionsTo).toHaveBeenCalledWith("target.md");
  native.indexMentionsTo.mockReturnValue({
    linked: [{ ...mention, kind: "unknown", linkKind: "wiki" }],
    unlinked: [],
  });
  expect(() => service.indexMentionsTo("target.md")).toThrow("提及索引包含无效");
});

it("检索条件与结果在工作线程边界结构化校验，损坏行不冒充空结果", () => {
  const service = createReaderService("/state", vi.fn(), {
    load: session.loadSession,
    save: session.saveSession,
  });
  const query = {
    terms: ["全文"],
    tags: ["标签"],
    attributes: [{ key: "status", value: "draft" }],
    pathContains: null,
    limit: 10,
  };
  native.searchQuery.mockReturnValue([
    { path: "notes/a.md", title: "A", snippet: "命中\u{1}全文\u{2}词" },
  ]);
  expect(service.searchQuery(query)).toEqual([
    { path: "notes/a.md", title: "A", snippet: "命中\u{1}全文\u{2}词" },
  ]);
  // null 路径过滤转换成原生层的 undefined；条件原样透传。
  expect(native.searchQuery).toHaveBeenCalledWith({ ...query, pathContains: undefined });
  native.searchQuery.mockReturnValue([{ path: "../逃逸.md", title: "A", snippet: "" }]);
  expect(() => service.searchQuery(query)).toThrow("检索命中");
  expect(() => service.searchQuery({ ...query, terms: "全文" } as never)).toThrow("全文词");
  native.indexHeadings.mockReturnValue([
    { path: "a.md", level: 2, text: "标题", startByte: 0, endByte: 9 },
  ]);
  expect(service.indexHeadings("a.md")).toEqual([
    { path: "a.md", level: 2, text: "标题", startByte: 0, endByte: 9 },
  ]);
  native.indexHeadings.mockReturnValue([
    { path: "a.md", level: 0, text: "标题", startByte: 0, endByte: 9 },
  ]);
  expect(() => service.indexHeadings("a.md")).toThrow("标题索引");
});

it("原生层的错误字节不能被 Uint8Array 转换成空文档", () => {
  const service = createReaderService("/state", vi.fn(), {
    load: session.loadSession,
    save: session.saveSession,
  });
  for (const invalid of [undefined, [], 0, "正文"]) {
    native.fileRead.mockReturnValue(invalid);
    expect(() => service.fileRead("a.md")).toThrow("不是有效字节");
    native.fileSnapshot.mockReturnValue({ disk: Buffer.from("原文"), draft: { bytes: invalid } });
    expect(() => service.fileSnapshot("a.md")).toThrow("不是有效字节");
  }
  native.fileWrite.mockReturnValue({ status: "unknown" });
  expect(() => service.fileWrite("a.md", new Uint8Array(), null)).toThrow("无法确认保存结果");
});

it("返回的字节独立于原生 Buffer，可转移而不影响其他结果或原生内存", () => {
  const original = Buffer.from([1, 2, 3]);
  native.fileRead.mockReturnValue(original);
  native.fileSnapshot.mockReturnValue({
    disk: original,
    draft: { bytes: original, base: original },
  });
  native.fileWrite.mockReturnValue({ status: "conflict", disk: original });
  const service = createReaderService("/state", vi.fn(), {
    load: session.loadSession,
    save: session.saveSession,
  });
  const read = service.fileRead("a.md");
  const snapshot = service.fileSnapshot("a.md");
  const conflict = service.fileWrite("a.md", new Uint8Array([4]), null);
  expect(conflict.status).toBe("conflict");
  if (conflict.status !== "conflict") throw new Error("预期保存冲突");
  for (const bytes of [
    read,
    snapshot.disk,
    snapshot.draft?.bytes,
    snapshot.draft?.base,
    conflict.disk,
  ]) {
    expect(bytes?.buffer).not.toBe(original.buffer);
    expect(bytes?.byteOffset).toBe(0);
    expect(bytes?.buffer.byteLength).toBe(3);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    if (!bytes || !(bytes.buffer instanceof ArrayBuffer)) throw new Error("预期独占缓冲区");
    expect(structuredClone(bytes, { transfer: [bytes.buffer] })).toEqual(new Uint8Array([1, 2, 3]));
    expect(original).toEqual(Buffer.from([1, 2, 3]));
  }
});

describe("vault watcher ownership", () => {
  it("ignores queued callbacks from the old vault and from a closed vault", () => {
    const changed = vi.fn();
    const callbacks: ((event: VaultEvent) => void)[] = [];
    native.vaultOpen.mockImplementation(
      (_root: string, _index: string, callback: (event: VaultEvent) => void) => {
        callbacks.push(callback);
      },
    );
    const service = createReaderService("/state", changed, {
      load: session.loadSession,
      save: session.saveSession,
    });
    service.vaultOpen("/first");
    callbacks[0]?.({ status: "changed", paths: [], healthy: true });
    expect(changed).toHaveBeenCalledTimes(1);
    service.vaultOpen("/second");
    callbacks[0]?.({ status: "changed", paths: [], healthy: true });
    expect(changed).toHaveBeenCalledTimes(1);
    callbacks[1]?.({ status: "changed", paths: [], healthy: true });
    expect(changed).toHaveBeenCalledTimes(2);
    service.vaultClose();
    callbacks[1]?.({ status: "changed", paths: [], healthy: true });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("retains the previous watcher when opening the replacement fails", () => {
    const changed = vi.fn();
    let originalCallback: (event: VaultEvent) => void = () => {};
    native.vaultOpen.mockImplementation(
      (_root: string, _index: string, callback: (event: VaultEvent) => void) => {
        originalCallback = callback;
      },
    );
    const service = createReaderService("/state", changed, {
      load: session.loadSession,
      save: session.saveSession,
    });
    service.vaultOpen("/first");
    native.vaultOpen.mockImplementationOnce(() => {
      throw new Error("恢复事务被外部修改阻止");
    });
    expect(() => service.vaultOpen("/second")).toThrow("恢复事务被外部修改阻止");
    originalCallback({ status: "changed", paths: [], healthy: true });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(session.saveSession).toHaveBeenLastCalledWith(session.loadSession());
  });

  it("keeps the active vault when persisting the new session fails", () => {
    const service = createReaderService("/state", vi.fn(), {
      load: session.loadSession,
      save: session.saveSession,
    });
    session.saveSession.mockImplementationOnce(() => {
      throw new Error("会话目录不可写");
    });
    expect(() => service.vaultOpen("/second")).toThrow("会话目录不可写");
    expect(native.vaultOpen).not.toHaveBeenCalled();
  });
});
