import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as NativeModule from "@nous/native";
import type {
  FileSnapshot,
  LinkKind,
  LinkRecord,
  MentionRecord,
  Mentions,
  RenameOutcome,
  SavedCopy,
  VaultRestore,
  WriteResult,
} from "../shared/api";
import { parseLinkKind, parseMentionKind } from "../shared/api";
import { loadSession, patchSession, saveSession, sessionFile, type Session } from "./session";

const require = createRequire(import.meta.url);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mapLink(link: NativeModule.JsLinkRecord): LinkRecord {
  return {
    fromPath: link.fromPath,
    toRaw: link.toRaw,
    toPath: link.toPath ?? null,
    kind: link.kind === "wiki" ? "wiki" : "md",
    startByte: link.startByte,
    endByte: link.endByte,
  };
}

function mapMention(mention: NativeModule.JsMentionRecord): MentionRecord | null {
  const kind = parseMentionKind(mention.kind);
  if (kind === null) {
    return null;
  }
  return {
    fromPath: mention.fromPath,
    fromTitle: mention.fromTitle,
    mtime: mention.mtime,
    startByte: mention.startByte,
    endByte: mention.endByte,
    snippet: mention.snippet,
    kind,
    linkKind: kind === "linked" ? parseLinkKind(mention.linkKind ?? "") : null,
    toRaw: mention.toRaw,
  };
}

function mapMentions(value: NativeModule.JsMentions): Mentions {
  return {
    linked: value.linked.flatMap((item) => {
      const mapped = mapMention(item);
      return mapped === null ? [] : [mapped];
    }),
    unlinked: value.unlinked.flatMap((item) => {
      const mapped = mapMention(item);
      return mapped === null ? [] : [mapped];
    }),
  };
}

/**
 * 创建仅由工作线程使用的同步内核服务，所有命令共用同一库与会话。
 *
 * @param userData 应用数据目录，不能由渲染进程指定。
 * @param onChanged 当前库的索引刷新通知；关闭或切库后丢弃旧回调。
 * @returns 按消息顺序调用的命令集合；磁盘与内核错误由调用方转发。
 * 返回的字节均为独占副本，供工作线程转移；不得返回原生 Buffer 或复用缓冲区。
 * @throws 原生模块无法加载时抛出加载错误；不创建部分可用的服务。
 */
export function createCoreService(userData: string, onChanged: () => void) {
  const native = require("@nous/native") as typeof NativeModule;
  const sessionPath = sessionFile(userData);
  let activeVault: object | null = null;

  function openVault(root: string): void {
    const vault = {};
    const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
    native.vaultOpen(root, join(userData, "vaults", hash), () => {
      if (activeVault === vault) onChanged();
    });
    // 打开失败时保留原库及其回调归属。
    activeVault = vault;
  }

  return {
    vaultOpen(root: string): string {
      const previous = loadSession(sessionPath);
      // 先确认会话可写，避免内核已切库、界面却因会话写入失败而留在原库。
      saveSession(sessionPath, { ...previous, vaultRoot: root, currentPath: null });
      try {
        openVault(root);
      } catch (error) {
        try {
          saveSession(sessionPath, previous);
        } catch (restoreError) {
          throw new Error(`${String(error)}；恢复上次会话失败：${String(restoreError)}`);
        }
        throw error;
      }
      return root;
    },
    vaultRestore(): VaultRestore | null {
      const stored = loadSession(sessionPath);
      const root = stored.vaultRoot;
      if (root === null || !isDirectory(root)) return null;
      openVault(root);
      return { root, currentPath: stored.currentPath };
    },
    vaultClose(): void {
      native.vaultClose();
      activeVault = null;
    },
    vaultList(): string[] {
      return native.vaultList();
    },
    sessionLoad(): Session {
      return loadSession(sessionPath);
    },
    sessionPatch(patch: Partial<Session>): void {
      patchSession(sessionPath, patch);
    },
    fileRead(rel: string): Uint8Array {
      return new Uint8Array(native.fileRead(rel));
    },
    fileSnapshot(rel: string): FileSnapshot {
      const snapshot = native.fileSnapshot(rel);
      return {
        disk: snapshot.disk == null ? null : new Uint8Array(snapshot.disk),
        draft:
          snapshot.draft == null
            ? null
            : {
                bytes: new Uint8Array(snapshot.draft.bytes),
                base: snapshot.draft.base == null ? null : new Uint8Array(snapshot.draft.base),
              },
      };
    },
    fileWrite(rel: string, bytes: Uint8Array, expected: Uint8Array | null): WriteResult {
      const result = native.fileWrite(
        rel,
        Buffer.from(bytes),
        expected === null ? null : Buffer.from(expected),
      );
      if (result.status === "conflict") {
        return {
          status: "conflict",
          disk: result.disk == null ? null : new Uint8Array(result.disk),
        };
      }
      if (result.status !== "saved") throw new Error("未知的保存结果");
      return { status: "saved", warning: result.warning ?? null };
    },
    fileWriteCopy(rel: string, bytes: Uint8Array, expected: Uint8Array | null): SavedCopy {
      const copy = native.fileWriteCopy(
        rel,
        Buffer.from(bytes),
        expected === null ? null : Buffer.from(expected),
      );
      return { path: copy.path, warning: copy.warning ?? null };
    },
    linksResolve(from: string, raw: string, kind: LinkKind): string | null {
      return native.linksResolve(from, raw, kind) ?? null;
    },
    indexLinksTo(path: string): LinkRecord[] {
      return native.indexLinksTo(path).map(mapLink);
    },
    indexLinksFrom(path: string): LinkRecord[] {
      return native.indexLinksFrom(path).map(mapLink);
    },
    indexMentionsTo(path: string): Mentions {
      return mapMentions(native.indexMentionsTo(path));
    },
    entryRename(from: string, to: string): RenameOutcome {
      const result = native.entryRename(from, to);
      return { warning: result.warning ?? null };
    },
  };
}

/** 工作线程协议直接使用服务签名，避免参数与返回值各维护一份。 */
export type CoreService = ReturnType<typeof createCoreService>;
