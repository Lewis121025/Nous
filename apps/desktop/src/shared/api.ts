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

/** 提及是入链还是未做成链接的正文出现。 */
export type MentionKind = "linked" | "unlinked";

/** 一条已链接或未链接提及。 */
export type MentionRecord = {
  /** 源文件库内相对路径。 */
  fromPath: string;
  /** 源文件展示标题。 */
  fromTitle: string;
  /** 源文件内容修改时间（自纪元起的纳秒）。 */
  mtime: number;
  /** 命中区间起点（含）。 */
  startByte: number;
  /** 命中区间终点（不含）。 */
  endByte: number;
  /** 命中所在段落。 */
  snippet: string;
  /** 已链接或未链接。 */
  kind: MentionKind;
  /** 已链接时的语法；未链接为 `null`。 */
  linkKind: LinkKind | null;
  /** 已链接为链接原文目标；未链接为命中文本。 */
  toRaw: string;
};

/** 指向一篇笔记的已链接与未链接提及。 */
export type Mentions = {
  /** 索引里的入链。 */
  linked: MentionRecord[];
  /** 正文里尚未做成链接的出现。 */
  unlinked: MentionRecord[];
};

/** 侧栏默认与宽度上下限（像素）。 */
export const SIDEBAR_LAYOUT = {
  leftWidth: 256,
  rightWidth: 288,
  minWidth: 192,
  maxWidth: 480,
};
export type SidebarViewId = "backlinks" | "outline";

/** 右侧栏一个视图槽。 */
export type SidebarSlot = {
  /** 槽里显示的视图。 */
  viewId: SidebarViewId;
  /** 钉住的笔记路径；跟随当前文件为 `null`。 */
  pinnedPath: string | null;
};

/** 左右侧栏布局。 */
export type PaneLayout = {
  /** 左侧文件栏是否收起。 */
  filesCollapsed: boolean;
  /** 左侧栏宽度（像素）。 */
  leftWidth: number;
  /** 右侧栏是否收起。 */
  rightCollapsed: boolean;
  /** 右侧栏宽度（像素）。 */
  rightWidth: number;
  /** 右侧栏是否上下拆成两个槽。 */
  rightSplit: boolean;
  /** 右侧栏视图槽。 */
  rightSlots: SidebarSlot[];
  /** 是否在文档底部再显示入链。 */
  backlinksInDocument: boolean;
};

/**
 * 把 NAPI 传来的 kind 收成提及种类。未知值丢掉，避免坏数据被洗成已链接。
 *
 * @param value 线格式字符串。
 */
export function parseMentionKind(value: string): MentionKind | null {
  return value === "linked" || value === "unlinked" ? value : null;
}

/**
 * 把 NAPI 传来的 kind 收成链接语法。未知值丢掉。
 *
 * @param value 线格式字符串。
 */
export function parseLinkKind(value: string): LinkKind | null {
  return value === "wiki" || value === "md" ? value : null;
}

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

/** 打开文件时同时取回尚未提交的编辑，删除后的文件也能恢复。 */
export type FileSnapshot = {
  /** 当前磁盘内容；不存在为 null。 */
  disk: Uint8Array | null;
  /** 保存失败或冲突时持久化的内容及其编辑基准。 */
  draft: { bytes: Uint8Array; base: Uint8Array | null } | null;
};

/** 文件内容提交与派生索引失败必须分别处理。 */
export type WriteResult =
  { status: "saved"; warning: string | null } | { status: "conflict"; disk: Uint8Array | null };

/** 保留原文件后，新副本的实际位置。 */
export type SavedCopy = { path: string; warning: string | null };

/** 改名已提交，索引或恢复记录的清理可能需要重试。 */
export type RenameOutcome = { warning: string | null };

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
  /** 读取侧栏布局（宽度、收起、拆分、槽位、文档内入链）。 */
  sessionGetPanes: () => Promise<PaneLayout>;
  /** 记住侧栏布局；不能经此改库路径或当前文件。 */
  sessionSetPanes: (panes: PaneLayout) => Promise<void>;
  /** 关闭当前库。 */
  vaultClose: () => Promise<void>;
  /** 列出库内相对路径。 */
  vaultList: () => Promise<string[]>;
  /** 读取原始字节。 */
  fileRead: (rel: string) => Promise<Uint8Array>;
  /** 加载编辑器快照，包括可恢复草稿。 */
  fileSnapshot: (rel: string) => Promise<FileSnapshot>;
  /** 核对 expected 后原子提交；null 仅允许创建新文件。 */
  fileWrite: (rel: string, bytes: Uint8Array, expected: Uint8Array | null) => Promise<WriteResult>;
  /** 独占创建同目录副本，保留原文件和已有副本。 */
  fileWriteCopy: (
    rel: string,
    bytes: Uint8Array,
    expected: Uint8Array | null,
  ) => Promise<SavedCopy>;
  /** 解析内部链接。 */
  linksResolve: (from: string, raw: string, kind: LinkKind) => Promise<string | null>;
  /** 入链。 */
  indexLinksTo: (path: string) => Promise<LinkRecord[]>;
  /** 已链接与未链接提及。 */
  indexMentionsTo: (path: string) => Promise<Mentions>;
  /** 出链。 */
  indexLinksFrom: (path: string) => Promise<LinkRecord[]>;
  /** 改名并更新链接。 */
  entryRename: (from: string, to: string) => Promise<RenameOutcome>;
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
