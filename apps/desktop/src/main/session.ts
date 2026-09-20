/**
 * 主进程会话：上次的库、打开的文件、窗口几何。
 *
 * 只给主进程读写；渲染进程不能提交任意库路径。损坏或缺失的文件视为空会话。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 窗口位置与最大化；最大化时 x/y/宽高是还原后的 normal bounds。 */
export type WindowSession = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
};

/** 启动时要恢复的会话。 */
export type Session = {
  vaultRoot: string | null;
  currentPath: string | null;
  window: WindowSession | null;
};

/** 没有任何记忆时的空会话。 */
export const emptySession: Session = {
  vaultRoot: null,
  currentPath: null,
  window: null,
};

/**
 * 会话文件路径。放在 userData 根下，不进笔记库。
 *
 * @param userData Electron `app.getPath("userData")`。
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

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 把 JSON 文本解析为会话；无法识别则返回 `null`。
 *
 * @param raw UTF-8 JSON。
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
  return {
    vaultRoot: "vaultRoot" in data ? parseNullableString(data.vaultRoot) : null,
    currentPath: "currentPath" in data ? parseNullableString(data.currentPath) : null,
    window: "window" in data ? parseWindow(data.window) : null,
  };
}

/**
 * 把会话写成确定性 JSON。
 *
 * @param session 当前会话。
 */
export function serializeSession(session: Session): string {
  return `${JSON.stringify(session, null, 2)}\n`;
}

/**
 * 从磁盘读取会话；文件不存在或损坏时返回空会话。
 *
 * @param file 会话文件绝对路径。
 */
export function loadSession(file: string): Session {
  if (!existsSync(file)) {
    return emptySession;
  }
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
 */
export function patchSession(file: string, patch: Partial<Session>): Session {
  const next = { ...loadSession(file), ...patch };
  saveSession(file, next);
  return next;
}
