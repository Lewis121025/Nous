import { app, dialog, ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { LinkKind, PaneLayout } from "../shared/api";
import { onFlushResult, type CloseGate } from "./close-gate";
import type { CoreClient } from "./core-client";
import { parsePaneLayout, type Session } from "./session";

function panesFromSession(session: Session): PaneLayout {
  return {
    filesCollapsed: session.filesCollapsed,
    leftWidth: session.leftWidth,
    rightCollapsed: session.rightCollapsed,
    rightWidth: session.rightWidth,
    rightSplit: session.rightSplit,
    rightSlots: session.rightSlots,
    backlinksInDocument: session.backlinksInDocument,
  };
}

/**
 * 注册主进程 IPC；内核与磁盘操作交给工作线程，主线程只处理窗口交互。
 *
 * @param getWindow 获取目录对话框的父窗口和允许关闭的当前窗口。
 * @param closeGate 关窗口闸门；冲刷成功后放行。
 * @param core 按顺序执行内核操作的客户端。
 * @throws IPC 通道重复注册时抛出 Electron 错误；命令异常通过各自的请求返回。
 */
export function registerIpc(
  getWindow: () => BrowserWindow | null,
  closeGate: CloseGate,
  core: CoreClient,
): void {
  ipcMain.handle("vault.open", async () => {
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    const root = result.filePaths[0];
    if (result.canceled || root === undefined) {
      return null;
    }
    return core.call("vaultOpen", root);
  });

  ipcMain.handle("vault.restore", () => core.call("vaultRestore"));

  ipcMain.handle("session.setCurrent", (_event, path: unknown) => {
    const currentPath = typeof path === "string" && path !== "" ? path : null;
    return core.call("sessionPatch", { currentPath });
  });

  ipcMain.handle("session.getPanes", async (): Promise<PaneLayout> => {
    const session = await core.call("sessionLoad");
    return panesFromSession(session);
  });

  ipcMain.handle("session.setPanes", (_event, panes: unknown) => {
    const parsed = parsePaneLayout(panes);
    if (parsed === null) return;
    return core.call("sessionPatch", parsed);
  });

  ipcMain.handle("vault.close", () => core.call("vaultClose"));
  ipcMain.handle("vault.list", () => core.call("vaultList"));
  ipcMain.handle("file.read", (_event, rel: string) => core.call("fileRead", rel));
  ipcMain.handle("file.snapshot", (_event, rel: string) => core.call("fileSnapshot", rel));
  ipcMain.handle(
    "file.write",
    (_event, rel: string, bytes: Uint8Array, expected: Uint8Array | null) =>
      core.call("fileWrite", rel, bytes, expected),
  );
  ipcMain.handle(
    "file.writeCopy",
    (_event, rel: string, bytes: Uint8Array, expected: Uint8Array | null) =>
      core.call("fileWriteCopy", rel, bytes, expected),
  );
  ipcMain.handle("links.resolve", (_event, from: string, raw: string, kind: LinkKind) =>
    core.call("linksResolve", from, raw, kind),
  );
  ipcMain.handle("index.linksTo", (_event, path: string) => core.call("indexLinksTo", path));
  ipcMain.handle("index.linksFrom", (_event, path: string) => core.call("indexLinksFrom", path));
  ipcMain.handle("index.mentionsTo", (_event, path: string) => core.call("indexMentionsTo", path));
  ipcMain.handle("entry.rename", (_event, from: string, to: string) =>
    core.call("entryRename", from, to),
  );

  ipcMain.handle("app.closeAfterFlush", () => {
    const action = onFlushResult(closeGate, true);
    if (action === "quit") {
      app.quit();
      return;
    }
    if (action === "close") {
      getWindow()?.close();
    }
  });

  ipcMain.handle("app.closeBlocked", () => {
    onFlushResult(closeGate, false);
  });
}
