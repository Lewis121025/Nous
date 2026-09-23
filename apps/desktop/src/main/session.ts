/**
 * 桌面会话：上次的库、打开的文件、窗口几何、侧栏布局。
 *
 * 只在内核工作线程读写；渲染进程不能提交任意库路径。损坏或缺失的文件视为空会话。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SIDEBAR_LAYOUT, type PaneLayout, type SidebarSlot as SharedSlot } from "../shared/api";

/** 左侧文件栏默认宽度（像素）。 */
export const DEFAULT_LEFT_WIDTH = SIDEBAR_LAYOUT.leftWidth;
/** 右侧栏默认宽度（像素）。 */
export const DEFAULT_RIGHT_WIDTH = SIDEBAR_LAYOUT.rightWidth;

/** 窗口位置与最大化；最大化时 x/y/宽高是还原后的 normal bounds。 */
export type WindowSession = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
};

/** 右侧栏里的一个视图槽。 */
export type SidebarSlot = SharedSlot;

/** 启动时要恢复的会话。 */
export type Session = {
  vaultRoot: string | null;
  currentPath: string | null;
  window: WindowSession | null;
  /** 左侧文件栏是否收起。 */
  filesCollapsed: boolean;
  /** 左侧栏宽度。 */
  leftWidth: number;
  /** 右侧栏是否收起。 */
  rightCollapsed: boolean;
  /** 右侧栏宽度。 */
  rightWidth: number;
  /** 右侧栏是否上下拆成两个槽。 */
  rightSplit: boolean;
  /** 右侧栏视图槽；未拆分时一项，拆分时两项。 */
  rightSlots: SidebarSlot[];
  /** 是否在文档底部再显示入链。 */
  backlinksInDocument: boolean;
};

const defaultSlots: SidebarSlot[] = [{ viewId: "backlinks", pinnedPath: null }];

/** 没有任何记忆时的空会话。 */
export const emptySession: Session = {
  vaultRoot: null,
  currentPath: null,
  window: null,
  filesCollapsed: false,
  leftWidth: DEFAULT_LEFT_WIDTH,
  rightCollapsed: false,
  rightWidth: DEFAULT_RIGHT_WIDTH,
  rightSplit: false,
  rightSlots: defaultSlots,
  backlinksInDocument: false,
};

/**
 * 会话文件路径。放在 userData 根下，不进笔记库。
 *
 * @param userData Electron `app.getPath("userData")`。
 * @returns 会话文件的绝对路径；本函数不访问磁盘。
 */
export function sessionFile(userData: string): string {
  return join(userData, "session.json");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWindow(value: unknown): WindowSession | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (!("x" in value) || !("y" in value) || !("width" in value) || !("height" in value)) {
    return null;
  }
  if (
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.width) ||
    !isFiniteNumber(value.height)
  ) {
    return null;
  }
  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    maximized: "maximized" in value && value.maximized === true,
  };
}

function parseCollapsed(value: unknown): boolean {
  return value === true;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function clampWidth(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  return Math.min(SIDEBAR_LAYOUT.maxWidth, Math.max(SIDEBAR_LAYOUT.minWidth, Math.round(value)));
}

function parseViewId(value: unknown): SidebarSlot["viewId"] | null {
  return value === "backlinks" || value === "outline" ? value : null;
}

function parseSlot(value: unknown): SidebarSlot | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const viewId = "viewId" in value ? parseViewId(value.viewId) : null;
  if (viewId === null) {
    return null;
  }
  const pinnedPath = "pinnedPath" in value ? parseNullableString(value.pinnedPath) : null;
  return { viewId, pinnedPath };
}

function parseSlots(value: unknown, split: boolean): SidebarSlot[] {
  if (!Array.isArray(value)) {
    return split
      ? [
          { viewId: "backlinks", pinnedPath: null },
          { viewId: "outline", pinnedPath: null },
        ]
      : [{ viewId: "backlinks", pinnedPath: null }];
  }
  const slots = value
    .map(parseSlot)
    .filter((slot): slot is SidebarSlot => slot !== null)
    .slice(0, 2);
  if (slots.length === 0) {
    return parseSlots(undefined, split);
  }
  if (split && slots.length === 1) {
    const second: SidebarSlot =
      slots[0]?.viewId === "outline"
        ? { viewId: "backlinks", pinnedPath: null }
        : { viewId: "outline", pinnedPath: null };
    return [slots[0] ?? { viewId: "backlinks", pinnedPath: null }, second];
  }
  if (!split) {
    return [slots[0] ?? { viewId: "backlinks", pinnedPath: null }];
  }
  return slots;
}

function parseRightCollapsed(data: Record<string, unknown>): boolean {
  if ("rightCollapsed" in data) {
    return parseCollapsed(data.rightCollapsed);
  }
  if ("outlineCollapsed" in data) {
    return parseCollapsed(data.outlineCollapsed);
  }
  return false;
}

/**
 * 只认侧栏布局字段。忽略 `vaultRoot` / `currentPath`，避免渲染进程经 setPanes 改库路径。
 *
 * @param value IPC 传入的未知对象。
 * @returns 合法布局；非对象为 `null`。
 */
export function parsePaneLayout(value: unknown): PaneLayout | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const rightSplit = parseCollapsed(record.rightSplit);
  return {
    filesCollapsed: parseCollapsed(record.filesCollapsed),
    leftWidth: clampWidth(record.leftWidth, DEFAULT_LEFT_WIDTH),
    rightCollapsed: parseCollapsed(record.rightCollapsed),
    rightWidth: clampWidth(record.rightWidth, DEFAULT_RIGHT_WIDTH),
    rightSplit,
    rightSlots: parseSlots(record.rightSlots, rightSplit),
    backlinksInDocument: parseCollapsed(record.backlinksInDocument),
  };
}

/**
 * 把 JSON 文本解析为会话；无法识别则返回 `null`。
 *
 * @param raw UTF-8 JSON。
 * @returns 归一化后的会话；语法无效或根值不是对象时返回 null。
 */
export function parseSession(raw: string): Session | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const panes = parsePaneLayout(record);
  if (panes === null) {
    return null;
  }
  return {
    vaultRoot: "vaultRoot" in record ? parseNullableString(record.vaultRoot) : null,
    currentPath: "currentPath" in record ? parseNullableString(record.currentPath) : null,
    window: "window" in record ? parseWindow(record.window) : null,
    ...panes,
    rightCollapsed: parseRightCollapsed(record),
  };
}

/**
 * 把会话写成确定性 JSON。
 *
 * @param session 当前会话。
 * @returns 带末尾换行的 JSON 文本。
 */
export function serializeSession(session: Session): string {
  return `${JSON.stringify(session, null, 2)}\n`;
}

/**
 * 从磁盘读取会话；文件不存在或损坏时返回空会话。
 *
 * @param file 会话文件绝对路径。
 * @returns 可用会话；文件缺失、不可读或损坏时返回空会话。
 */
export function loadSession(file: string): Session {
  try {
    return parseSession(readFileSync(file, "utf8")) ?? emptySession;
  } catch {
    return emptySession;
  }
}

/**
 * 覆盖写入会话。
 *
 * @param file 会话文件绝对路径。
 * @param session 要保存的完整会话。
 * @throws 创建目录或写入文件失败时，保留底层文件系统错误。
 */
export function saveSession(file: string, session: Session): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeSession(session));
}

/**
 * 合并补丁后写回。
 *
 * @param file 会话文件绝对路径。
 * @param patch 要覆盖的字段。
 * @returns 写盘后的完整会话。
 * @throws 合并后的会话无法写入时，保留底层文件系统错误。
 */
export function patchSession(file: string, patch: Partial<Session>): Session {
  const next = { ...loadSession(file), ...patch };
  saveSession(file, next);
  return next;
}
