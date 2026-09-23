import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreService } from "../../../apps/desktop/src/main/core-service";

const { native, session } = vi.hoisted(() => ({
  native: {
    vaultOpen: vi.fn(),
    vaultClose: vi.fn(),
    fileRead: vi.fn(),
    fileSnapshot: vi.fn(),
    fileWrite: vi.fn(),
    indexMentionsTo: vi.fn(),
  },
  session: {
    patchSession: vi.fn(),
    saveSession: vi.fn(),
    loadSession: vi.fn(),
    sessionFile: vi.fn(() => "/state/session.json"),
  },
}));

vi.mock("node:module", () => ({ createRequire: () => () => native }));
vi.mock("../../../apps/desktop/src/main/session", () => session);

beforeEach(() => {
  vi.clearAllMocks();
  session.loadSession.mockReturnValue({
    vaultRoot: "/first",
    currentPath: "a.md",
    window: null,
    filesCollapsed: false,
    outlineCollapsed: false,
  });
});

it("工作线程返回已链接与未链接提及，并过滤未知种类", () => {
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
    linked: [
      { ...mention, kind: "linked", linkKind: "wiki" },
      { ...mention, kind: "unknown" },
    ],
    unlinked: [{ ...mention, kind: "unlinked" }],
  });
  const service = createCoreService("/state", vi.fn());
  expect(service.indexMentionsTo("target.md")).toEqual({
    linked: [{ ...mention, kind: "linked", linkKind: "wiki" }],
    unlinked: [{ ...mention, kind: "unlinked", linkKind: null }],
  });
  expect(native.indexMentionsTo).toHaveBeenCalledWith("target.md");
});

it("返回的字节独立于原生 Buffer，可转移而不影响其他结果或原生内存", () => {
  const original = Buffer.from([1, 2, 3]);
  native.fileRead.mockReturnValue(original);
  native.fileSnapshot.mockReturnValue({
    disk: original,
    draft: { bytes: original, base: original },
  });
  native.fileWrite.mockReturnValue({ status: "conflict", disk: original });
  const service = createCoreService("/state", vi.fn());
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
    const callbacks: (() => void)[] = [];
    native.vaultOpen.mockImplementation((_root: string, _index: string, callback: () => void) => {
      callbacks.push(callback);
    });
    const service = createCoreService("/state", changed);
    service.vaultOpen("/first");
    callbacks[0]?.();
    expect(changed).toHaveBeenCalledTimes(1);
    service.vaultOpen("/second");
    callbacks[0]?.();
    expect(changed).toHaveBeenCalledTimes(1);
    callbacks[1]?.();
    expect(changed).toHaveBeenCalledTimes(2);
    service.vaultClose();
    callbacks[1]?.();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("retains the previous watcher when opening the replacement fails", () => {
    const changed = vi.fn();
    let originalCallback = () => {};
    native.vaultOpen.mockImplementation((_root: string, _index: string, callback: () => void) => {
      originalCallback = callback;
    });
    const service = createCoreService("/state", changed);
    service.vaultOpen("/first");
    native.vaultOpen.mockImplementationOnce(() => {
      throw new Error("恢复事务被外部修改阻止");
    });
    expect(() => service.vaultOpen("/second")).toThrow("恢复事务被外部修改阻止");
    originalCallback();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(session.saveSession).toHaveBeenLastCalledWith(
      "/state/session.json",
      session.loadSession(),
    );
  });

  it("keeps the active vault when persisting the new session fails", () => {
    const service = createCoreService("/state", vi.fn());
    session.saveSession.mockImplementationOnce(() => {
      throw new Error("会话目录不可写");
    });
    expect(() => service.vaultOpen("/second")).toThrow("会话目录不可写");
    expect(native.vaultOpen).not.toHaveBeenCalled();
  });
});
