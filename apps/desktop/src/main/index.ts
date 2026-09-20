import { join } from "node:path";
import { BrowserWindow, app } from "electron";
import { registerIpc } from "./ipc";

let mainWindow: BrowserWindow | null = null;

/**
 * 创建主窗口。
 *
 * 渲染进程无 Node、无直接磁盘访问；仅通过 preload 暴露的 IPC 与内核通信。
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

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
