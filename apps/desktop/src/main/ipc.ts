import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { app, dialog, ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { LinkKind, LinkRecord, PaneLayout, VaultRestore } from "../shared/api";
import { onFlushResult, type CloseGate } from "./close-gate";
import { loadSession, patchSession, sessionFile } from "./session";

const require = createRequire(import.meta.url);

type NativeAddon = {
  vaultOpen: (root: string, indexDir: string, onChanged: () => void) => void;
  vaultClose: () => void;
  vaultList: () => string[];
  fileRead: (rel: string) => Buffer;
  fileWrite: (rel: string, bytes: Buffer) => void;
  linksResolve: (from: string, raw: string, kind: string) => string | null;
  indexLinksTo: (path: string) => NativeLink[];
  indexLinksFrom: (path: string) => NativeLink[];
  entryRename: (from: string, to: string) => void;
};

type NativeLink = {
  fromPath: string;
  toRaw: string;
  toPath?: string;
  kind: string;
  startByte: number;
  endByte: number;
};

const native = require("@nous/native") as NativeAddon;

function indexDirFor(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(app.getPath("userData"), "vaults", hash);
}

function sessionPath(): string {
  return sessionFile(app.getPath("userData"));
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mapLink(link: NativeLink): LinkRecord {
  const kind: LinkKind = link.kind === "wiki" ? "wiki" : "md";
  return {
    fromPath: link.fromPath,
    toRaw: link.toRaw,
    toPath: link.toPath ?? null,
    kind,
    startByte: link.startByte,
    endByte: link.endByte,
  };
}

function openNativeVault(root: string, getWindow: () => BrowserWindow | null): void {
  native.vaultOpen(root, indexDirFor(root), () => {
    getWindow()?.webContents.send("vault.changed");
  });
}

/**
 * 注册主进程 IPC。只转发 `nous-core` 经 napi 暴露的命令，以及关窗口冲刷。
 *
 * @param getWindow 用于把监视事件推到当前窗口。
 * @param closeGate 关窗口闸门；冲刷成功后放行。
 */
export function registerIpc(getWindow: () => BrowserWindow | null, closeGate: CloseGate): void {
  ipcMain.handle("vault.open", async () => {
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    const root = result.filePaths[0];
    if (result.canceled || root === undefined) {
      return null;
    }
    openNativeVault(root, getWindow);
    patchSession(sessionPath(), { vaultRoot: root, currentPath: null });
    return root;
  });

  ipcMain.handle("vault.restore", (): VaultRestore | null => {
    const session = loadSession(sessionPath());
    const root = session.vaultRoot;
    if (root === null || !isDirectory(root)) {
      return null;
    }
    try {
      openNativeVault(root, getWindow);
    } catch {
      return null;
    }
    return { root, currentPath: session.currentPath };
  });

  ipcMain.handle("session.setCurrent", (_event, path: unknown) => {
    const currentPath = typeof path === "string" && path !== "" ? path : null;
    patchSession(sessionPath(), { currentPath });
  });

  ipcMain.handle("session.getPanes", (): PaneLayout => {
    const session = loadSession(sessionPath());
    return {
      filesCollapsed: session.filesCollapsed,
      outlineCollapsed: session.outlineCollapsed,
    };
  });

  ipcMain.handle("session.setPanes", (_event, panes: unknown) => {
    if (typeof panes !== "object" || panes === null) {
      return;
    }
    const filesCollapsed = "filesCollapsed" in panes && panes.filesCollapsed === true;
    const outlineCollapsed = "outlineCollapsed" in panes && panes.outlineCollapsed === true;
    patchSession(sessionPath(), { filesCollapsed, outlineCollapsed });
  });

  ipcMain.handle("vault.close", () => {
    native.vaultClose();
  });

  ipcMain.handle("vault.list", () => native.vaultList());

  ipcMain.handle("file.read", (_event, rel: string) => {
    const buffer = native.fileRead(rel);
    return new Uint8Array(buffer);
  });

  ipcMain.handle("file.write", (_event, rel: string, bytes: Uint8Array) => {
    native.fileWrite(rel, Buffer.from(bytes));
  });

  ipcMain.handle("links.resolve", (_event, from: string, raw: string, kind: LinkKind) => {
    return native.linksResolve(from, raw, kind);
  });

  ipcMain.handle("index.linksTo", (_event, path: string) => {
    return native.indexLinksTo(path).map(mapLink);
  });

  ipcMain.handle("index.linksFrom", (_event, path: string) => {
    return native.indexLinksFrom(path).map(mapLink);
  });

  ipcMain.handle("entry.rename", (_event, from: string, to: string) => {
    native.entryRename(from, to);
  });

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
