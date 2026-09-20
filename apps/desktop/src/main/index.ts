import { join } from "node:path";
import { BrowserWindow, app, screen } from "electron";
import { registerIpc } from "./ipc";
import { loadSession, patchSession, sessionFile, type WindowSession } from "./session";

let mainWindow: BrowserWindow | null = null;

function sessionPath(): string {
  return sessionFile(app.getPath("userData"));
}

/**
 * 把记下的窗口放到当前仍存在的显示器上，避免外接屏拔掉后开到屏外。
 *
 * @param stored 上次关闭时的几何。
 */
function clampWindow(stored: WindowSession): Electron.Rectangle {
  const display = screen.getDisplayMatching({
    x: stored.x,
    y: stored.y,
    width: stored.width,
    height: stored.height,
  });
  const area = display.workArea;
  const width = Math.min(Math.max(Math.round(stored.width), 400), area.width);
  const height = Math.min(Math.max(Math.round(stored.height), 300), area.height);
  let x = Math.round(stored.x);
  let y = Math.round(stored.y);
  if (x + width < area.x || x > area.x + area.width) {
    x = area.x + Math.floor((area.width - width) / 2);
  }
  if (y + height < area.y || y > area.y + area.height) {
    y = area.y + Math.floor((area.height - height) / 2);
  }
  return { x, y, width, height };
}

function persistWindow(win: BrowserWindow): void {
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  patchSession(sessionPath(), {
    window: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    },
  });
}

/**
 * 创建主窗口。
 *
 * 渲染进程无 Node、无直接磁盘访问；仅通过 preload 暴露的 IPC 与内核通信。
 */
function createWindow(): void {
  const stored = loadSession(sessionPath()).window;
  const bounds = stored === null ? null : clampWindow(stored);
  mainWindow = new BrowserWindow({
    ...(bounds ?? { width: 1100, height: 720 }),
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      // 沙箱 preload 必须是 CJS；electron-vite 在 format: "cjs" 时产出 index.cjs。
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (stored !== null && stored.maximized) {
    mainWindow.maximize();
  }

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", () => {
    if (mainWindow !== null) {
      persistWindow(mainWindow);
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc(() => mainWindow);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
