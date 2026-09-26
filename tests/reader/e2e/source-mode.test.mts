import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("源码视图：排版表达不了的语法逐字节保真，[[ 补全与排版视图往返", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-source-mode-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(userData, { recursive: true })]);
  // 排版文档模型会重写这些写法：下划线强调、波浪围栏、HTML 注释里的伪语法。
  const original = [
    "---",
    "title: 保真验收",
    "---",
    "",
    "# 标题",
    "",
    "段落 __强调__ 保持下划线写法。",
    "",
    "~~~text",
    "代码 #原样",
    "~~~",
    "",
    "结尾段落。",
    "",
  ].join("\r\n");
  const target = "目标笔记.md";
  await Promise.all([
    writeFile(join(vault, "笔记.md"), original),
    writeFile(join(vault, target), "# 目标\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: { vaultRoot: vault, currentPath: "笔记.md", filesCollapsed: false, leftWidth: 260 },
        appearance: "light",
        window: null,
      }),
    ),
  ]);
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("缺少 Electron 可执行文件");
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "ELECTRON_RENDERER_URL") environment[name] = value;
  }
  const app = await electron.launch({
    executablePath: executable,
    colorScheme: null,
    args: [
      fileURLToPath(new URL("out/main/index.js", desktop)),
      `--user-data-dir=${userData}`,
      "--no-sandbox",
    ],
    env: environment,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "笔记.md" &&
        document.querySelector(".ProseMirror") !== null &&
        !document.querySelector(".panes")?.hasAttribute("inert"),
    );

    // 切到源码视图：工具栏按钮 + 原始字节完整呈现。
    await page.getByRole("button", { name: "切换源码视图", exact: true }).click();
    const code = page.locator(".cm-content");
    await code.waitFor();
    await expect.poll(() => code.textContent()).toContain("__强调__");
    await expect.poll(() => code.textContent()).toContain("~~~text");
    expect(await page.locator(".ProseMirror").count()).toBe(0);

    // 源码里的 [[ 补全：候选弹出，回车插入去扩展名目标并自动闭合。
    await page.keyboard.press("ControlOrMeta+ArrowDown");
    await page.keyboard.type("[[目标");
    const option = page.locator(".cm-tooltip-autocomplete li").first();
    await option.waitFor();
    expect(await option.textContent()).toContain("目标笔记");
    await page.keyboard.press("Enter");
    await expect.poll(() => code.textContent()).toContain("[[目标笔记]]");

    // 保存：除补全插入外，磁盘字节与原文完全一致——特殊语法零重写。
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(vault, "笔记.md"), "utf8"))
      .toBe(original + "[[目标笔记]]");
    const saved = await readFile(join(vault, "笔记.md"), "utf8");
    expect(saved).toContain("__强调__");
    expect(saved).toContain("~~~text");
    expect(saved).toContain("title: 保真验收");
    expect(saved).not.toContain("**强调**");

    // 切回排版视图：文档模型重新挂载，强调按 strong 渲染。
    await page.getByRole("button", { name: "切换排版视图", exact: true }).click();
    const editor = page.locator(".ProseMirror");
    await editor.waitFor();
    await expect.poll(() => editor.locator("strong").textContent()).toBe("强调");
    expect(await editor.locator(".wiki-link").count()).toBe(1);

    // Cmd/Ctrl+E 快捷键往返切换，未保存编辑不丢失。
    await page.keyboard.press("ControlOrMeta+e");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.press("ControlOrMeta+e");
    await page.locator(".ProseMirror").waitFor();
    await expect.poll(() => page.locator(".ProseMirror").textContent()).toContain("结尾段落。");

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
