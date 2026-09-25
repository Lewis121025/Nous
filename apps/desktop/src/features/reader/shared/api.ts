/**
 * 渲染进程可调用的内核 API。
 *
 * 与 preload `contextBridge` 暴露的对象保持同一类型；禁止在此加入任意文件系统能力。
 */

import type { ImportedAttachment } from "./attachments";

/** 历史动作由当前输入表面执行，不建立独立于编辑器的撤销记录。 */
export type HistoryAction = "undo" | "redo";

/** 当前输入表面的历史可用性；只从编辑器或原生控件派生，不存储撤销记录。 */
export type HistoryAvailability = Readonly<{ undo: boolean; redo: boolean }>;

/** 阅读器提供的用户动作；外壳可以通过菜单调用，不直接接触编辑状态。 */
export type ReaderCommand =
  | "open-vault"
  | "new-note"
  | "new-folder"
  | "save"
  | "find"
  | "find-files"
  | "toggle-files"
  | "insert-attachment";

/** 链接语法。 */
export type LinkKind = "wiki" | "md";

/** 后台能力的故障独立于文档保存状态；路径始终是当前库的相对路径。 */
export type VaultEvent =
  | { status: "changed"; paths: string[]; healthy: boolean }
  | { status: "watch-error" | "index-error" | "worker-error"; paths: string[]; message: string };

/** 校验原生层或线程事件；未知状态和缺失原因会抛错，禁止悄悄当作成功。 */
export function parseVaultEvent(value: unknown): VaultEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    !("paths" in value) ||
    !Array.isArray(value.paths) ||
    !value.paths.every((path: unknown) => typeof path === "string")
  )
    throw new Error("库事件缺少有效状态或路径");
  const paths: string[] = value.paths;
  if (value.status === "changed" && "healthy" in value && typeof value.healthy === "boolean")
    return { status: "changed", paths, healthy: value.healthy };
  if (
    (value.status === "watch-error" ||
      value.status === "index-error" ||
      value.status === "worker-error") &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message !== ""
  )
    return { status: value.status, paths, message: value.message };
  throw new Error("库事件状态无效或缺少错误原因");
}

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

/** 文件栏默认宽度与拖拽范围（像素）。 */
export const SIDEBAR_LAYOUT = {
  leftWidth: 232,
  minWidth: 192,
  maxWidth: 480,
};

/** 文件栏布局；目录和引用是临时展开内容，不写入会话。 */
export type PaneLayout = {
  /** 文件栏是否收起。 */
  filesCollapsed: boolean;
  /** 文件栏宽度（像素）。 */
  leftWidth: number;
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

/** 打开文件时同时取回尚未提交的编辑，删除后的文件也能恢复。 */
export type FileSnapshot = {
  /** 当前磁盘内容；不存在或读取失败为 null，失败时附带 diskError。 */
  disk: Uint8Array | null;
  /** 仅在原路径不可读、但恢复草稿仍可返回时提供具体原因。 */
  diskError?: string;
  /** 保存失败或冲突时的草稿与基准；存在 editor 时，bytes 为源码映射基准，最新编辑由 editor 保存。 */
  draft: { bytes: Uint8Array; base: Uint8Array | null; editor?: string } | null;
};

/** 文件内容提交与派生索引失败必须分别处理。 */
export type WriteResult =
  { status: "saved"; warning: string | null } | { status: "conflict"; disk: Uint8Array | null };

/** 保留原文件后，新副本的实际位置。 */
export type SavedCopy = { path: string; warning: string | null };

/** 改名已提交，索引或恢复记录的清理可能需要重试。 */
export type RenameOutcome = { warning: string | null };

/** 文件管理条目使用库内相对路径，空文件夹也占有独立条目。 */
export type VaultEntry = {
  path: string;
  kind: "file" | "directory";
  /** 仅用于被目录变化阻挡的文件草稿，须与真实磁盘目录分开呈现。 */
  recoveryOnly?: true;
};

/**
 * 阅读器公开能力，由应用外壳注入；文件参数均为库内相对路径，不能访问任意文件。
 * 异步命令返回业务结果，IPC、磁盘及内核错误通过 Promise 拒绝传播给调用方。
 * 订阅返回取消函数，阅读器卸载时必须调用，避免继续接收旧实例事件。
 */
export type ReaderApi = {
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
  /** 读取文件栏布局（宽度、收起）。 */
  sessionGetPanes: () => Promise<PaneLayout>;
  /** 记住文件栏布局；不能经此改库路径或当前文件。 */
  sessionSetPanes: (panes: PaneLayout) => Promise<void>;
  /** 关闭当前库。 */
  vaultClose: () => Promise<void>;
  /** 列出库内相对路径。 */
  vaultList: () => Promise<string[]>;
  /** 完整目录快照，包含空文件夹和恢复草稿。 */
  vaultEntries: () => Promise<VaultEntry[]>;
  /** 独占创建空笔记或文件夹；同名时拒绝覆盖。 */
  entryCreate: (path: string, kind: VaultEntry["kind"]) => Promise<RenameOutcome>;
  /** 导入用户选择的字节到笔记旁；root 必须仍是活动库，同名文件自动避让。 */
  attachmentImport: (
    root: string,
    from: string,
    name: string,
    bytes: Uint8Array,
  ) => Promise<ImportedAttachment>;
  /** 移入系统废纸篓；有未处理草稿时拒绝，绝不永久删除。 */
  entryTrash: (path: string) => Promise<RenameOutcome>;
  /** 在系统文件管理器中定位已校验的库内条目。 */
  entryReveal: (path: string) => Promise<void>;
  /** 读取原始字节。 */
  fileRead: (rel: string) => Promise<Uint8Array>;
  /** 加载编辑器快照，包括可恢复草稿。 */
  fileSnapshot: (rel: string) => Promise<FileSnapshot>;
  /** 只写恢复记录；source 是会话原始源码，editor 是带版本的最新编辑，不能写入 Markdown。 */
  filePreserveDraft: (
    rel: string,
    source: Uint8Array,
    expected: Uint8Array | null,
    editor: string,
  ) => Promise<void>;
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
  /** 用户点击后用系统应用打开网页或邮件链接；无效地址和非允许协议拒绝。 */
  openExternal: (url: string) => Promise<void>;
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
  subscribeVaultChanged: (callback: (event: VaultEvent) => void) => () => void;
};
