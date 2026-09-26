import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { _electron as electron } from "playwright-core";

const desktop = new URL("../../../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));

test("侧栏全文搜索：长词、中文短词、标签谓词与命中定位", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nous-search-test-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const userData = join(root, "state");
  await Promise.all([mkdir(join(vault, "notes"), { recursive: true }), mkdir(userData)]);
  await Promise.all([
    writeFile(
      join(vault, "设计笔记.md"),
      [
        "---",
        "status: draft",
        "tags: [project]",
        "---",
        "",
        "# 设计笔记",
        "",
        "这是关于量子检索的正文。",
        "",
        "## 小节",
        "",
        "```ts",
        "const quantumToken = 1;",
        "```",
        "",
      ].join("\n"),
    ),
    writeFile(join(vault, "其它笔记.md"), "# 其它\n\n无关内容。\n"),
    writeFile(join(vault, "notes/量子.md"), "# 量子\n\n量子力学笔记 #project\n"),
    writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        reader: {
          vaultRoot: vault,
          currentPath: "其它笔记.md",
          filesCollapsed: false,
          leftWidth: 260,
        },
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
    const files = page.getByRole("navigation", { name: "文件列表" });
    const search = files.getByRole("searchbox");
    const status = files.getByRole("status");
    const hitPaths = async () =>
      files.locator(".hit .path").evaluateAll((nodes) => nodes.map((node) => node.textContent));

    // 等待启动恢复完成：当前文档就绪且切换门禁释放。
    await page.waitForFunction(
      () =>
        document.querySelector(".document-name")?.textContent === "其它笔记.md" &&
        !document.querySelector(".panes")?.hasAttribute("inert"),
    );

    // 长词走 trigram 索引；结果替换文件树，摘要圈出命中词。
    await search.fill("量子检索");
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    expect(await status.textContent()).toContain("共 1 条结果");
    expect(await hitPaths()).toEqual(["设计笔记.md"]);
    expect(await files.locator(".hit mark").textContent()).toBe("量子检索");
    expect(await files.getByRole("treeitem").count()).toBe(0);

    // 点击命中：打开文件并把光标定位到命中词所在文本。
    await files.locator(".hit").first().click();
    await page.waitForFunction(() => {
      const selection = document.getSelection();
      const text = selection?.anchorNode?.parentElement?.textContent ?? "";
      return (
        document.querySelector(".document-name")?.textContent === "设计笔记.md" &&
        text.includes("量子检索")
      );
    });

    // 围栏代码里的命中同样可定位（全文索引覆盖代码块）。
    await search.fill("quantumToken");
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    await files.locator(".hit").first().click();
    await page.waitForFunction(() => {
      const selection = document.getSelection();
      return (selection?.anchorNode?.parentElement?.textContent ?? "").includes("quantumToken");
    });

    // 中文两字短词走 LIKE 回落：结果仍然完整。
    await search.fill("量子");
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    expect((await hitPaths()).sort()).toEqual(["notes/量子.md", "设计笔记.md"]);

    // 标签谓词：frontmatter 与行内标签同表可查。
    await search.fill("tag:project");
    await search.press("Enter");
    await files.locator(".hit").first().waitFor();
    expect((await hitPaths()).sort()).toEqual(["notes/量子.md", "设计笔记.md"]);

    // 无结果与退出：第一次 Escape 回到文件树并保留查询词（树仍按其过滤），
    // 第二次 Escape 清空过滤词，恢复完整文件树。
    await search.fill("绝对不存在的词");
    await search.press("Enter");
    await expect
      .poll(async () => files.locator(".empty").textContent())
      .toContain("没有匹配的笔记");
    await search.press("Escape");
    expect(await search.inputValue()).toBe("绝对不存在的词");
    expect(await files.getByRole("treeitem").count()).toBe(0);
    await search.press("Escape");
    expect(await search.inputValue()).toBe("");
    expect(await files.getByRole("treeitem").first().isVisible()).toBe(true);

    // 标签面板：组树展示计数（frontmatter 与行内标签同表汇总），点击进入 tag: 检索。
    await files.getByRole("button", { name: "浏览标签" }).click();
    await expect.poll(async () => files.locator(".tag .name").allTextContents()).toEqual([
      "#project",
    ]);
    await expect.poll(async () => files.locator(".tag .count").allTextContents()).toEqual(["2"]);
    await files.locator(".tag", { hasText: "project" }).click();
    await files.locator(".hit").first().waitFor();
    expect((await hitPaths()).sort()).toEqual(["notes/量子.md", "设计笔记.md"]);
    expect(await search.inputValue()).toBe("tag:project");

    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
