/** 阅读器会话只记录笔记库、当前文件、文件栏与阅读栈，不包含主题或窗口几何。 */
import { SIDEBAR_LAYOUT, type PaneLayout } from "./api";

/** 文件栏默认宽度（像素）。 */
export const DEFAULT_LEFT_WIDTH = SIDEBAR_LAYOUT.leftWidth;

/** 阅读栈持久化上限；超长历史没有恢复价值，防止会话文件无限增长。 */
export const HISTORY_LIMIT = 100;

/** 源码视图记忆条数上限；只防会话文件病态增长，正常库远达不到。 */
export const SOURCE_VIEW_LIMIT = 500;

/** 阅读栈条目：一次导航落点。滚动位置只在会话内恢复，不持久化。 */
export type HistoryEntry = {
  /** 库内相对路径。 */
  path: string;
  /** 落点标题锚点；无锚点为 `null`。 */
  anchor: string | null;
};

/** 阅读栈的双向持久化形态。 */
export type SessionHistory = {
  /** 后退栈，栈顶是上一个位置。 */
  back: HistoryEntry[];
  /** 前进栈，栈顶是下一个位置。 */
  forward: HistoryEntry[];
};

/** 单个分栏的持久化形态。 */
export type PaneSession = {
  /** 该栏打开文件的库内相对路径；空栏为 `null`。 */
  currentPath: string | null;
  /** 该栏的阅读栈。 */
  history: SessionHistory;
};

/** 文档会话：分栏集合、活动栏与分栏开关。 */
export type SessionDocuments = {
  /** 1–2 个分栏；下标即栏位。 */
  panes: PaneSession[];
  /** 活动栏下标。 */
  active: number;
  /** 是否分栏显示。 */
  split: boolean;
};

/** 单栏空文档会话。 */
export function emptyPaneSession(): PaneSession {
  return { currentPath: null, history: { back: [], forward: [] } };
}

/** 单栏空文档会话集合。 */
export function emptySessionDocuments(): SessionDocuments {
  return { panes: [emptyPaneSession()], active: 0, split: false };
}

/** 阅读器独立恢复状态。 */
export type ReaderSession = PaneLayout & {
  /** 当前笔记库的绝对路径。 */
  vaultRoot: string | null;
  /** 各分栏的文档与阅读栈；切库时重置为单栏。 */
  documents: SessionDocuments;
  /** 记住源码视图的文件路径；切库时清空。 */
  sourceViews: string[];
};

/** 缺失或损坏的阅读器状态从空笔记库开始。 */
export const emptyReaderSession: ReaderSession = {
  vaultRoot: null,
  documents: emptySessionDocuments(),
  filesCollapsed: false,
  leftWidth: DEFAULT_LEFT_WIDTH,
  sourceViews: [],
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

function parseHistoryEntries(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryEntry[] = [];
  for (const item of value.slice(0, HISTORY_LIMIT)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path === "") continue;
    const anchor = typeof record.anchor === "string" && record.anchor !== "" ? record.anchor : null;
    out.push({ path: record.path, anchor });
  }
  return out;
}

/**
 * 归一化阅读栈：无效条目静默丢弃，长度压到上限。
 *
 * 会话文件是恢复性数据，损坏条目不该阻止整个会话恢复。
 */
export function parseSessionHistory(value: unknown): SessionHistory {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { back: [], forward: [] };
  const record = value as Record<string, unknown>;
  return {
    back: parseHistoryEntries(record.back),
    forward: parseHistoryEntries(record.forward),
  };
}

/**
 * 归一化源码视图记忆：只留非空文本，去重并截到上限。
 *
 * 会话是恢复性数据，损坏条目静默丢弃而不是拒绝整个会话。
 */
export function parseSourceViews(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "" || out.includes(item)) continue;
    out.push(item);
    if (out.length >= SOURCE_VIEW_LIMIT) break;
  }
  return out;
}

/** 分栏数量上限；界面只提供双栏，多余条目丢弃。 */
export const PANE_LIMIT = 2;

function parsePaneSession(value: unknown): PaneSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyPaneSession();
  const record = value as Record<string, unknown>;
  return {
    currentPath: parseNullableString(record.currentPath),
    history: parseSessionHistory(record.history),
  };
}

/**
 * 归一化文档会话；旧版单文档字段（currentPath/history）迁移为单栏。
 *
 * 会话是恢复性数据：损坏条目丢弃而不是拒绝整个会话。
 */
export function parseSessionDocuments(value: unknown, legacy?: Record<string, unknown>): SessionDocuments {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.panes)) {
      const panes = record.panes.slice(0, PANE_LIMIT).map(parsePaneSession);
      if (panes.length === 0) panes.push(emptyPaneSession());
      const active =
        typeof record.active === "number" &&
        Number.isInteger(record.active) &&
        record.active >= 0 &&
        record.active < panes.length
          ? record.active
          : 0;
      const split = record.split === true && panes.length === PANE_LIMIT;
      return { panes, active, split };
    }
  }
  if (legacy !== undefined) {
    return {
      panes: [
        {
          currentPath: parseNullableString(legacy.currentPath),
          history: parseSessionHistory(legacy.history),
        },
      ],
      active: 0,
      split: false,
    };
  }
  return emptySessionDocuments();
}

/**
 * 归一化阅读器状态，忽略历史分栏与钉住字段。
 * @param value 从应用会话读取的 JSON 值。
 * @returns 独立的阅读器状态；非对象返回默认值，非法宽度回退或限制在允许范围。
 */
export function parseReaderSession(value: unknown): ReaderSession {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ...emptyReaderSession, documents: emptySessionDocuments(), sourceViews: [] };
  const record = value as Record<string, unknown>;
  return {
    vaultRoot: parseNullableString(record.vaultRoot),
    documents: parseSessionDocuments(record.documents, record),
    sourceViews: parseSourceViews(record.sourceViews),
    ...(parsePaneLayout(record) ?? emptyReaderSession),
  };
}

/** 工作线程注入的阅读器会话存储；写入失败必须抛出，供切库事务恢复原状态。 */
export type ReaderSessionStore = {
  load: () => ReaderSession;
  save: (session: ReaderSession) => void;
};
