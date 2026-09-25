import { Worker } from "node:worker_threads";
import { beforeEach, expect, it, vi } from "vitest";
import { CoreClient } from "../../../../apps/desktop/src/main/core-client";
import { registerReaderIpc } from "@reader/main/ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const { handlers, call } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  call: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({ Worker: class {} }));
vi.mock("../../../../apps/desktop/src/main/core-client", () => ({
  CoreClient: class {
    call = call;
  },
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  dialog: {},
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}));

beforeEach(() => {
  handlers.clear();
  call.mockReset();
  call.mockResolvedValue(undefined);
  registerReaderIpc(() => null, new CoreClient(new Worker("unused"), vi.fn()));
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`未注册通道：${channel}`);
  return handler(undefined, ...args);
}

it("错误字节和缺失基准在 IPC 入口被拒绝，不进入保存或副本执行队列", async () => {
  const bytes = new Uint8Array([0, 255]);
  for (const channel of ["reader.file.write", "reader.file.writeCopy"]) {
    for (const invalid of [[], "内容", 100, undefined, null]) {
      await expect(invoke(channel, "笔记.md", invalid, bytes)).rejects.toThrow("字节");
      if (invalid !== null)
        await expect(invoke(channel, "笔记.md", bytes, invalid)).rejects.toThrow("字节");
    }
  }
  expect(call).not.toHaveBeenCalled();
  await invoke("reader.file.write", "空笔记.md", new Uint8Array(), null);
  expect(call).toHaveBeenLastCalledWith("fileWrite", "空笔记.md", new Uint8Array(), null);
  await invoke("reader.file.writeCopy", "笔记.md", bytes, bytes);
  expect(call).toHaveBeenLastCalledWith("fileWriteCopy", "笔记.md", bytes, bytes);
});

it("错误会话参数不能清空当前路径或重置布局，额外字段不能修改库路径", async () => {
  await expect(invoke("reader.session.setCurrent", {})).rejects.toThrow("路径");
  await expect(invoke("reader.session.setCurrent", undefined)).rejects.toThrow("路径");
  await expect(invoke("reader.session.setPanes", {})).rejects.toThrow("布局");
  expect(call).not.toHaveBeenCalled();
  await invoke("reader.session.setCurrent", null);
  expect(call).toHaveBeenLastCalledWith("readerSessionPatch", { currentPath: null });
  await invoke("reader.session.setPanes", {
    filesCollapsed: true,
    leftWidth: 240,
    vaultRoot: "/不允许注入",
  });
  expect(call).toHaveBeenLastCalledWith("readerSessionPatch", {
    filesCollapsed: true,
    leftWidth: 240,
  });
});

it("读取、预览、索引和文件操作统一拒绝错误路径与未知种类", async () => {
  for (const channel of [
    "reader.file.read",
    "reader.file.snapshot",
    "reader.index.linksTo",
    "reader.index.linksFrom",
    "reader.index.mentionsTo",
    "reader.entry.trash",
    "reader.entry.reveal",
  ])
    await expect(invoke(channel, {})).rejects.toThrow("路径");
  await expect(invoke("reader.entry.create", "目录", "unknown")).rejects.toThrow("类型");
  await expect(invoke("reader.entry.rename", "原名.md", null)).rejects.toThrow("路径");
  await expect(invoke("reader.links.resolve", "原名.md", "目标", "unknown")).rejects.toThrow(
    "语法",
  );
  await expect(invoke("reader.links.resolve", "原名.md", {}, "wiki")).rejects.toThrow("目标");
  expect(call).not.toHaveBeenCalled();
  await invoke("reader.links.resolve", "原名.md", "标题#定位", "wiki");
  expect(call).toHaveBeenLastCalledWith("linksResolve", "原名.md", "标题#定位", "wiki");
});
