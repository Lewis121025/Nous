/**
 * 渲染进程可调用的内核 API。
 *
 * 与 preload `contextBridge` 暴露的对象保持同一类型；禁止在此加入任意文件系统能力。
 */

/** 链接语法。 */
export type LinkKind = "wiki" | "md";

/** 索引中的一条链接。 */
export type LinkRecord = {
  /** 源文件库内相对路径。 */
  fromPath: string;
  /** 链接原文中的目标。 */
  toRaw: string;
  /** 解析到的路径；死链为 `null`。 */
  toPath: string | null;
  /** 语法种类。 */
  kind: LinkKind;
  /** 字节区间起点（含）。 */
  startByte: number;
  /** 字节区间终点（不含）。 */
  endByte: number;
};

/**
 * 经 IPC 暴露给渲染进程的命令。
 *
 * 打开库走系统对话框，渲染进程拿不到任意路径读写。
 */
export type NousApi = {
  /** 弹出选目录对话框并打开库；取消时返回 `null`。 */
  vaultOpen: () => Promise<string | null>;
  /** 关闭当前库。 */
  vaultClose: () => Promise<void>;
  /** 列出库内相对路径。 */
  vaultList: () => Promise<string[]>;
  /** 读取原始字节。 */
  fileRead: (rel: string) => Promise<Uint8Array>;
  /** 原子写入。 */
  fileWrite: (rel: string, bytes: Uint8Array) => Promise<void>;
  /** 解析内部链接。 */
  linksResolve: (from: string, raw: string, kind: LinkKind) => Promise<string | null>;
  /** 入链。 */
  indexLinksTo: (path: string) => Promise<LinkRecord[]>;
  /** 出链。 */
  indexLinksFrom: (path: string) => Promise<LinkRecord[]>;
  /** 改名并更新链接。 */
  entryRename: (from: string, to: string) => Promise<void>;
  /**
   * 订阅库文件变更（监视防抖后）。
   *
   * @returns 取消订阅。
   */
  subscribeVaultChanged: (callback: () => void) => () => void;
};
