import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onFlushResult, type CloseGate } from "../../../apps/desktop/src/main/close-gate";

const { call, shutdown, register } = vi.hoisted(() => ({
  call: vi.fn(),
  shutdown: vi.fn(),
  register: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({ Worker: class {} }));
vi.mock("../../../apps/desktop/src/main/core-client", () => ({
  CoreClient: class {
    call = call;
    shutdown = shutdown;
  },
}));
vi.mock("../../../apps/desktop/src/main/ipc", () => ({ registerIpc: register }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    static windows: Window[] = [];
    static getAllWindows() {
      return Window.windows;
    }
    webContents = {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      send: vi.fn(),
    };
    constructor() {
      super();
      Window.windows.push(this);
    }
    loadFile = vi.fn();
    loadURL = vi.fn();
    isMaximized = () => false;
    getBounds = () => ({ x: 10, y: 20, width: 900, height: 700 });
  }
  return {
    BrowserWindow: Window,
    app: Object.assign(new EventEmitter(), {
      whenReady: () => Promise.resolve(),
      getPath: () => "/state",
      quit: vi.fn(),
    }),
    dialog: { showErrorBox: vi.fn() },
    screen: {},
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("__dirname", "/desktop/out/main");
  call.mockResolvedValue({ window: null });
});

afterEach(async () => {
  const { app, BrowserWindow } = await import("electron");
  app.removeAllListeners();
  BrowserWindow.getAllWindows().splice(0);
  vi.unstubAllGlobals();
});

async function start() {
  await import("../../../apps/desktop/src/main/index");
  const electron = await import("electron");
  await vi.waitFor(() => expect(electron.BrowserWindow.getAllWindows()).toHaveLength(1));
  return { ...electron, window: electron.BrowserWindow.getAllWindows()[0]! };
}

describe("main process worker lifetime", () => {
  it("flushes the editor before stopping and holds quit until the worker has exited", async () => {
    const stopped = deferred<void>();
    shutdown.mockReturnValue(stopped.promise);
    const { app, window } = await start();
    const before = { preventDefault: vi.fn() };
    app.emit("before-quit", before);
    expect(before.preventDefault).toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith("app.flushBeforeClose");
    expect(shutdown).not.toHaveBeenCalled();

    const gate: CloseGate = register.mock.calls[0]![1];
    onFlushResult(gate, true);
    const closing = { preventDefault: vi.fn() };
    window.emit("close", closing);
    expect(closing.preventDefault).not.toHaveBeenCalled();
    expect(call).toHaveBeenLastCalledWith("sessionPatch", {
      window: { x: 10, y: 20, width: 900, height: 700, maximized: false },
    });
    window.emit("closed");
    const quit = { preventDefault: vi.fn() };
    app.emit("will-quit", quit);
    app.emit("will-quit", quit);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(quit.preventDefault).toHaveBeenCalledTimes(2);
    expect(app.quit).not.toHaveBeenCalled();
    stopped.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    const finalQuit = { preventDefault: vi.fn() };
    app.emit("will-quit", finalQuit);
    expect(finalQuit.preventDefault).not.toHaveBeenCalled();
  });

  it("does not create a window after quitting during asynchronous startup", async () => {
    const loading = deferred<{ window: null }>();
    const stopped = deferred<void>();
    call.mockReturnValue(loading.promise);
    shutdown.mockReturnValue(stopped.promise);
    await import("../../../apps/desktop/src/main/index");
    const { app, BrowserWindow } = await import("electron");
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("sessionLoad"));
    app.emit("will-quit", { preventDefault: vi.fn() });
    loading.resolve({ window: null });
    stopped.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(BrowserWindow.getAllWindows()).toHaveLength(0);
  });

  it("reports a failed worker shutdown and permits quitting the unusable process", async () => {
    const stopped = deferred<void>();
    shutdown.mockReturnValue(stopped.promise);
    const { app, window, dialog } = await start();
    window.emit("closed");
    app.emit("will-quit", { preventDefault: vi.fn() });
    stopped.reject(new Error("线程异常退出"));
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(dialog.showErrorBox).toHaveBeenCalledWith("内核未正常关闭", "线程异常退出");
  });
});
