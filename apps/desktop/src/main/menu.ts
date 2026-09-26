import { Menu, type MenuItemConstructorOptions } from "electron";
import type { AppCommand } from "../shared/api";
import type { HistoryAvailability } from "../features/reader/shared/api";

/** 应用当前输入表面的历史投影；未就绪、重载或关闭窗口时禁用，菜单尚未安装则忽略。 */
export function updateHistoryMenu(
  availability: HistoryAvailability = { undo: false, redo: false },
): void {
  const menu = Menu.getApplicationMenu();
  for (const action of ["undo", "redo"] as const) {
    const item = menu?.getMenuItemById(action);
    if (item) item.enabled = availability[action];
  }
}

/**
 * 安装桌面原生菜单；历史与文档动作交给当前输入表面，剪贴板与窗口动作使用 Electron role。
 * @param dispatch 将命令交给活动窗口，保存与切换仍由阅读器协调。
 */
export function installApplicationMenu(dispatch: (command: AppCommand) => void): void {
  const command = (
    label: string,
    accelerator: string,
    action: AppCommand,
  ): MenuItemConstructorOptions => ({
    id: action,
    label,
    accelerator,
    enabled: action !== "undo" && action !== "redo",
    click: () => dispatch(action),
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        command("新建笔记", "CmdOrCtrl+N", "new-note"),
        command("新建文件夹", "CmdOrCtrl+Shift+N", "new-folder"),
        command("打开笔记库…", "CmdOrCtrl+O", "open-vault"),
        { type: "separator" },
        command("保存", "CmdOrCtrl+S", "save"),
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        command("撤销", "CmdOrCtrl+Z", "undo"),
        command("重做", process.platform === "darwin" ? "Cmd+Shift+Z" : "Ctrl+Y", "redo"),
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
        command("插入附件…", "CmdOrCtrl+Shift+I", "insert-attachment"),
        { type: "separator" },
        command("文内查找", "CmdOrCtrl+F", "find"),
        command("查找文件", "CmdOrCtrl+Shift+F", "find-files"),
      ],
    },
    {
      label: "导航",
      submenu: [
        command("后退", "CmdOrCtrl+[", "go-back"),
        command("前进", "CmdOrCtrl+]", "go-forward"),
        { type: "separator" },
        command("切换排版/源码视图", "CmdOrCtrl+E", "toggle-source"),
      ],
    },
    {
      label: "显示",
      submenu: [
        command("显示或隐藏文件栏", "CmdOrCtrl+\\", "toggle-files"),
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "togglefullscreen", label: "进入全屏幕" },
      ],
    },
    { role: "windowMenu", label: "窗口" },
  ];
  if (process.platform === "darwin")
    template.unshift({
      label: "Nous",
      submenu: [
        { role: "about", label: "关于 Nous" },
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: "隐藏 Nous" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出 Nous" },
      ],
    });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
