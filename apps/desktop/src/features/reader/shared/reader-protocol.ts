import type {
  HeadingRecord,
  LinkKind,
  LinkRecord,
  LinkTarget,
  MentionRecord,
  Mentions,
  PaneLayout,
  RenameOutcome,
  SavedCopy,
  SearchHit,
  SearchQuery,
  VaultEntry,
  VaultRestore,
  WriteResult,
} from "./api";
import { SIDEBAR_LAYOUT } from "./api";
import { parseSessionHistory } from "./session";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warning(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function path(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function relativePath(value: unknown): value is string {
  return (
    path(value) && !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function byteOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 校验跨进程路径参数的类型；相对路径、符号链接与库根约束仍由内核统一执行。 */
export function parsePathArgument(value: unknown): string {
  if (!path(value)) throw new Error("文件路径必须是非空文本且不含空字符");
  return value;
}

/** 接受完整的字节视图，包括空文件；拒绝数组、字符串及隐式 Buffer 转换。 */
export function parseFileBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("文件内容不是有效字节");
  return value;
}

/** 保存必须携带目标字节和明确的磁盘基准；null 仅表示预期文件不存在。 */
export function parseWriteRequest(rel: unknown, bytes: unknown, expected: unknown) {
  return {
    rel: parsePathArgument(rel),
    bytes: parseFileBytes(bytes),
    expected: expected === null ? null : parseFileBytes(expected),
  };
}

/** 只接受已知的保存分支；无效确认抛错，让文档保留编辑和原磁盘基准。 */
export function parseWriteResult(value: unknown): WriteResult {
  if (record(value)) {
    if (value.status === "saved" && warning(value.warning))
      return { status: "saved", warning: value.warning };
    if (value.status === "conflict" && (value.disk === null || value.disk instanceof Uint8Array))
      return { status: "conflict", disk: value.disk };
  }
  throw new Error("无法确认保存结果，当前编辑仍保留；请检查磁盘内容后重试");
}

/** 副本位置和提交后警告必须完整；失败时不允许切换当前文档或更新保存基准。 */
export function parseSavedCopy(value: unknown): SavedCopy {
  if (record(value) && relativePath(value.path) && warning(value.warning))
    return { path: value.path, warning: value.warning };
  throw new Error("无法确认副本保存结果，当前编辑仍保留；请检查文件栏中的副本后重试");
}

/** 创建、改名、移动和废纸篓操作共享提交后警告；不能把无效返回值当成成功。 */
export function parseEntryOutcome(value: unknown): RenameOutcome {
  if (record(value) && warning(value.warning)) return { warning: value.warning };
  throw new Error("无法确认文件操作结果，请刷新文件栏检查实际条目后重试");
}

/** 无数据命令也必须返回空确认；错误结果不能经 Promise<void> 断言被忽略。 */
export function parseEmptyReply(value: unknown): void {
  if (value !== undefined) throw new Error("未收到有效的操作确认，请检查操作结果后重试");
}

/** 路径只接受明确文本或 null；错误参数不能被解释成关闭文档、取消或未命中。 */
export function parseNullablePath(value: unknown): string | null {
  return value === null ? null : parsePathArgument(value);
}

/** 当前文档和已解析链接必须是规范库内相对路径；拒绝绝对路径与跳出库根的分量。 */
export function parseNullableRelativePath(value: unknown): string | null {
  if (value === null || relativePath(value)) return value;
  throw new Error("当前文档或链接响应包含无效的库内路径");
}

/**
 * 链接解析响应按状态判别：resolved 必须带有效库内路径，ambiguous 必须带
 * 非空候选列表；空锚点归一化为 null，损坏响应整体拒绝而不是退化成死链。
 */
export function parseLinkTarget(value: unknown): LinkTarget {
  if (record(value)) {
    let anchor: string | null = null;
    if (value.anchor !== undefined && value.anchor !== null) {
      if (typeof value.anchor !== "string") throw new Error("链接解析响应无效");
      if (value.anchor !== "") anchor = value.anchor;
    }
    if (value.status === "resolved" && relativePath(value.path))
      return { status: "resolved", path: value.path, anchor };
    if (
      value.status === "ambiguous" &&
      Array.isArray(value.candidates) &&
      value.candidates.length > 0 &&
      value.candidates.every((candidate: unknown) => relativePath(candidate))
    )
      return { status: "ambiguous", candidates: value.candidates, anchor };
    if (value.status === "dead") return { status: "dead" };
  }
  throw new Error("链接解析响应无效");
}

/** 恢复库路径与当前文档必须来自同一个完整响应；无效响应抛错，不伪装成空库。 */
export function parseVaultRestore(value: unknown): VaultRestore | null {
  if (value === null) return null;
  if (
    record(value) &&
    path(value.root) &&
    (value.currentPath === null || relativePath(value.currentPath))
  )
    return {
      root: value.root,
      currentPath: value.currentPath,
      // 阅读栈是恢复性数据：损坏条目按会话解析规则丢弃，不拒绝整个恢复。
      history: parseSessionHistory(value.history),
    };
  throw new Error("笔记库恢复响应无效，请重新打开笔记库");
}

/** 文件列表逐项校验，拒绝半份无效结果，避免文件栏漏项或指向错误条目。 */
export function parseVaultList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("文件列表响应无效");
  return value.map((item: unknown) => {
    if (!relativePath(item)) throw new Error("文件列表包含无效的库内路径");
    return item;
  });
}

/** 文件种类必须明确；未知值不能被内核或调用端猜测为文件夹。 */
export function parseEntryKind(value: unknown): VaultEntry["kind"] {
  if (value !== "file" && value !== "directory") throw new Error("未知的文件条目类型");
  return value;
}

/** 完整目录快照只允许恢复文件使用 recoveryOnly，未知结构拒绝传播。 */
export function parseVaultEntries(value: unknown): VaultEntry[] {
  if (!Array.isArray(value)) throw new Error("目录快照响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.path) ||
      (item.kind !== "file" && item.kind !== "directory") ||
      ("recoveryOnly" in item && (item.recoveryOnly !== true || item.kind !== "file"))
    )
      throw new Error("目录快照包含无效条目");
    return {
      path: item.path,
      kind: item.kind,
      ...("recoveryOnly" in item ? { recoveryOnly: true as const } : {}),
    };
  });
}

/** IPC 布局必须完整且在允许范围；会话文件的旧格式兼容仍由会话解析负责。 */
export function parsePaneLayoutMessage(value: unknown): PaneLayout {
  if (
    !record(value) ||
    typeof value.filesCollapsed !== "boolean" ||
    typeof value.leftWidth !== "number" ||
    !Number.isFinite(value.leftWidth) ||
    value.leftWidth < SIDEBAR_LAYOUT.minWidth ||
    value.leftWidth > SIDEBAR_LAYOUT.maxWidth
  )
    throw new Error("文件栏布局参数无效");
  return { filesCollapsed: value.filesCollapsed, leftWidth: Math.round(value.leftWidth) };
}

/** 链接种类不允许回退；错误种类可能把双链按另一种语法解析到错误文件。 */
export function parseLinkKindArgument(value: unknown): LinkKind {
  if (value !== "wiki" && value !== "md") throw new Error("未知的链接语法");
  return value;
}

/** 索引解析状态不允许回退；缺字段会把死链和歧义混成同一种未解析。 */
function linkResolution(value: unknown): value is "resolved" | "ambiguous" | "dead" | "self" {
  return value === "resolved" || value === "ambiguous" || value === "dead" || value === "self";
}

/** 链接原文允许空字符串，由内核按语法决定是否可解析；其他值必须拒绝。 */
export function parseLinkText(value: unknown): string {
  if (typeof value !== "string") throw new Error("链接目标必须是文本");
  return value;
}

/** 校验原文目标、已解析路径与字节范围，不把错误索引数据强转为导航位置。 */
export function parseLinkRecords(value: unknown): LinkRecord[] {
  if (!Array.isArray(value)) throw new Error("链接索引响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.fromPath) ||
      typeof item.toRaw !== "string" ||
      (item.toPath !== null && !relativePath(item.toPath)) ||
      (item.kind !== "wiki" && item.kind !== "md") ||
      !linkResolution(item.resolution) ||
      !byteOffset(item.startByte) ||
      !byteOffset(item.endByte) ||
      item.endByte < item.startByte
    )
      throw new Error("链接索引包含无效路径、语法或定位范围");
    return {
      fromPath: item.fromPath,
      toRaw: item.toRaw,
      toPath: item.toPath,
      kind: item.kind,
      resolution: item.resolution,
      startByte: item.startByte,
      endByte: item.endByte,
    };
  });
}

function parseMention(value: unknown, kind: "linked" | "unlinked"): MentionRecord {
  if (
    !record(value) ||
    !relativePath(value.fromPath) ||
    typeof value.fromTitle !== "string" ||
    typeof value.snippet !== "string" ||
    typeof value.toRaw !== "string" ||
    value.kind !== kind ||
    typeof value.mtime !== "number" ||
    !Number.isFinite(value.mtime) ||
    !byteOffset(value.startByte) ||
    !byteOffset(value.endByte) ||
    value.endByte < value.startByte ||
    (kind === "linked"
      ? value.linkKind !== "wiki" && value.linkKind !== "md"
      : value.linkKind !== null)
  )
    throw new Error("提及索引包含无效来源、语法或定位范围");
  return {
    fromPath: value.fromPath,
    fromTitle: value.fromTitle,
    snippet: value.snippet,
    toRaw: value.toRaw,
    kind,
    mtime: value.mtime,
    startByte: value.startByte,
    endByte: value.endByte,
    linkKind: parseNullableLinkKind(value.linkKind),
  };
}

function parseNullableLinkKind(value: unknown): LinkKind | null {
  return value === null ? null : parseLinkKindArgument(value);
}

/** 两组提及的种类与字段必须一致；损坏数据整体拒绝，由引用面板显示可恢复错误。 */
export function parseMentions(value: unknown): Mentions {
  if (!record(value) || !Array.isArray(value.linked) || !Array.isArray(value.unlinked))
    throw new Error("提及索引响应无效");
  return {
    linked: value.linked.map((item: unknown) => parseMention(item, "linked")),
    unlinked: value.unlinked.map((item: unknown) => parseMention(item, "unlinked")),
  };
}

function parseStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是文本列表`);
  return value.map((item: unknown) => {
    if (typeof item !== "string") throw new Error(`${label}必须是文本列表`);
    return item;
  });
}

/**
 * 校验结构化检索条件；查询文本的谓词解析发生在渲染层，主进程不接受原始查询串。
 *
 * `limit` 截断为整数并压到 0–500：0 由内核解释为默认上限，超出内核对 `i32`
 * 的表示范围会在原生边界报错，必须提前收敛。
 */
export function parseSearchQueryArgument(value: unknown): SearchQuery {
  if (!record(value)) throw new Error("检索条件无效");
  const attributes = Array.isArray(value.attributes)
    ? value.attributes.map((item: unknown) => {
        if (!record(item) || typeof item.key !== "string" || typeof item.value !== "string")
          throw new Error("属性谓词必须是键值文本对");
        return { key: item.key, value: item.value };
      })
    : null;
  if (attributes === null) throw new Error("属性谓词必须是键值文本对");
  let pathContains: string | null = null;
  if (value.pathContains !== null && value.pathContains !== undefined) {
    if (typeof value.pathContains !== "string") throw new Error("检索条件的路径过滤必须是文本");
    pathContains = value.pathContains;
  }
  if (typeof value.limit !== "number" || !Number.isFinite(value.limit))
    throw new Error("检索条件的结果上限无效");
  return {
    terms: parseStringList(value.terms, "全文词"),
    tags: parseStringList(value.tags, "标签谓词"),
    attributes,
    pathContains,
    limit: Math.min(Math.trunc(value.limit), 500),
  };
}

/** 检索命中逐项校验；摘要里的控制字符是合法的命中标记，不做过滤。 */
export function parseSearchHits(value: unknown): SearchHit[] {
  if (!Array.isArray(value)) throw new Error("检索响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.path) ||
      typeof item.title !== "string" ||
      typeof item.snippet !== "string"
    )
      throw new Error("检索命中包含无效路径、标题或摘要");
    return { path: item.path, title: item.title, snippet: item.snippet };
  });
}

/** 标题记录逐项校验；字节区间将被映射为编辑器位置，损坏数据必须整体拒绝。 */
export function parseHeadingRecords(value: unknown): HeadingRecord[] {
  if (!Array.isArray(value)) throw new Error("标题索引响应无效");
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      !relativePath(item.path) ||
      typeof item.level !== "number" ||
      !Number.isInteger(item.level) ||
      item.level < 1 ||
      item.level > 6 ||
      typeof item.text !== "string" ||
      !byteOffset(item.startByte) ||
      !byteOffset(item.endByte) ||
      item.endByte < item.startByte
    )
      throw new Error("标题索引包含无效等级或定位范围");
    return {
      path: item.path,
      level: item.level,
      text: item.text,
      startByte: item.startByte,
      endByte: item.endByte,
    };
  });
}
