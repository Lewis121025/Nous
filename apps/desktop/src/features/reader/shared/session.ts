/** 阅读器会话只记录笔记库、当前文件与文件栏，不包含主题或窗口几何。 */
import { SIDEBAR_LAYOUT, type PaneLayout } from "./api";

/** 文件栏默认宽度（像素）。 */
export const DEFAULT_LEFT_WIDTH = SIDEBAR_LAYOUT.leftWidth;

/** 阅读器独立恢复状态。 */
export type ReaderSession = PaneLayout & {
  /** 当前笔记库的绝对路径。 */
  vaultRoot: string | null;
  /** 当前打开文件的库内相对路径。 */
  currentPath: string | null;
};

/** 缺失或损坏的阅读器状态从空笔记库开始。 */
export const emptyReaderSession: ReaderSession = {
  vaultRoot: null,
  currentPath: null,
  filesCollapsed: false,
  leftWidth: DEFAULT_LEFT_WIDTH,
};

function parseCollapsed(value: unknown): boolean {
  return value === true;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function clampWidth(value: unknown, fallback: number): number {
  if (!(typeof value === "number" && Number.isFinite(value))) {
    return fallback;
  }
  return Math.min(SIDEBAR_LAYOUT.maxWidth, Math.max(SIDEBAR_LAYOUT.minWidth, Math.round(value)));
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
  return {
    filesCollapsed: parseCollapsed(record.filesCollapsed),
    leftWidth: clampWidth(record.leftWidth, DEFAULT_LEFT_WIDTH),
  };
}

/**
 * 归一化阅读器状态，忽略历史分栏与钉住字段。
 * @param value 从应用会话读取的 JSON 值。
 * @returns 独立的阅读器状态；非对象返回默认值，非法宽度回退或限制在允许范围。
 */
export function parseReaderSession(value: unknown): ReaderSession {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ...emptyReaderSession };
  const record = value as Record<string, unknown>;
  return {
    vaultRoot: parseNullableString(record.vaultRoot),
    currentPath: parseNullableString(record.currentPath),
    ...(parsePaneLayout(record) ?? emptyReaderSession),
  };
}

/** 工作线程注入的阅读器会话存储；写入失败必须抛出，供切库事务恢复原状态。 */
export type ReaderSessionStore = {
  load: () => ReaderSession;
  save: (session: ReaderSession) => void;
};
