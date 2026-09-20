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

/** 左右侧栏是否收起。 */
export type PaneLayout = {
  /** 左侧文件栏是否收起。 */
  filesCollapsed: boolean;
  /** 右侧目录栏是否收起。 */
  outlineCollapsed: boolean;
};

/**
 * 经 IPC 暴露给渲染进程的命令。
 *
 * 打开库走系统对话框或主进程会话恢复；渲染进程拿不到任意路径读写。
 */
export type VaultRestore = {
  /** 库根绝对路径。 */
  root: string;
  /** 上次打开的库内相对路径；没有或已删除为 `null`。 */
  currentPath: string | null;
};

export type NousApi = {
  /** 弹出选目录对话框并打开库；取消时返回 `null`。 */
  vaultOpen: () => Promise<string | null>;
  /**
   * 用主进程记下的库路径恢复会话，不弹对话框。
   *
   * 没有可用会话时返回 `null`。
   */
  vaultRestore: () => Promise<VaultRestore | null>;
  /** 把当前打开的相对路径写入会话；`null` 表示没有打开文件。 */
  sessionSetCurrent: (path: string | null) => Promise<void>;
  /** 读取侧栏收起状态。 */
  sessionGetPanes: () => Promise<PaneLayout>;
  /** 记住侧栏收起状态。 */
  sessionSetPanes: (panes: PaneLayout) => Promise<void>;
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
  /**
   * 关窗口前主进程会发冲刷请求；渲染进程应先保存再决定是否放行。
   *
   * @returns 取消订阅。
   */
  subscribeFlushBeforeClose: (callback: () => void) => () => void;
  /** 冲刷成功后允许窗口关闭。 */
  closeAfterFlush: () => Promise<void>;
  /** 冲刷失败，取消这次退出意图，窗口留着。 */
  closeBlocked: () => Promise<void>;
};
