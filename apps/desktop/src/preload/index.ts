import { contextBridge, ipcRenderer } from "electron";
import type { LinkKind, LinkRecord, NousApi, VaultRestore } from "../shared/api";

const api: NousApi = {
  vaultOpen: () => ipcRenderer.invoke("vault.open") as Promise<string | null>,
  vaultRestore: () => ipcRenderer.invoke("vault.restore") as Promise<VaultRestore | null>,
  sessionSetCurrent: (path) => ipcRenderer.invoke("session.setCurrent", path) as Promise<void>,
  vaultClose: () => ipcRenderer.invoke("vault.close") as Promise<void>,
  vaultList: () => ipcRenderer.invoke("vault.list") as Promise<string[]>,
  fileRead: (rel: string) => ipcRenderer.invoke("file.read", rel) as Promise<Uint8Array>,
  fileWrite: (rel: string, bytes: Uint8Array) =>
    ipcRenderer.invoke("file.write", rel, bytes) as Promise<void>,
  linksResolve: (from: string, raw: string, kind: LinkKind) =>
    ipcRenderer.invoke("links.resolve", from, raw, kind) as Promise<string | null>,
  indexLinksTo: (path: string) =>
    ipcRenderer.invoke("index.linksTo", path) as Promise<LinkRecord[]>,
  indexLinksFrom: (path: string) =>
    ipcRenderer.invoke("index.linksFrom", path) as Promise<LinkRecord[]>,
  entryRename: (from: string, to: string) =>
    ipcRenderer.invoke("entry.rename", from, to) as Promise<void>,
  subscribeVaultChanged: (callback: () => void) => {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on("vault.changed", listener);
    return () => {
      ipcRenderer.removeListener("vault.changed", listener);
    };
  },
};

contextBridge.exposeInMainWorld("nous", api);
