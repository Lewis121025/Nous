import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { Worker } from "node:worker_threads";
import { CoreClient } from "../../../../apps/desktop/src/main/core-client";
import type { VaultEvent } from "../../../../apps/desktop/src/features/reader/shared/api";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const workerUrl = new URL("../../../../apps/desktop/out/main/core-worker.js", import.meta.url);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null): string => {
  assert.ok(data, "此场景应返回文件内容");
  return new TextDecoder().decode(data);
};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nous-core-worker-"));
  const clients: CoreClient[] = [];
  t.onTestFinished(async () => {
    try {
      await Promise.all(clients.map((client) => client.shutdown()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const roots = [join(dir, "first"), join(dir, "second")] as const;
  await Promise.all(roots.map((root) => mkdir(root)));
  const userData = join(dir, "state");
  return {
    roots,
    userData,
    start() {
      const events: VaultEvent[] = [];
      const core = new CoreClient(new Worker(workerUrl, { workerData: userData }), (event) => {
        events.push(event);
      });
      clients.push(core);
      return { core, changes: () => events.length, events };
    },
  };
}

test.skipIf(process.platform === "win32")(
  "库内反斜杠文件名经线程、索引、监视与副本返回后仍指向同一文件",
  async (t) => {
    const {
      roots: [root],
      start,
    } = await fixture(t);
    const literal = "group\\note.md";
    const nested = "group/note.md";
    await mkdir(join(root, "group"));
    await Promise.all([
      writeFile(join(root, literal), "literal"),
      writeFile(join(root, nested), "nested"),
      writeFile(join(root, "ref.md"), "[literal](./group%5Cnote.md) [nested](./group/note.md)\n"),
    ]);
    const { core, events } = start();
    await core.call("vaultOpen", root);
    assert.deepEqual(await core.call("vaultList"), [nested, literal, "ref.md"]);
    assert.equal(await core.call("linksResolve", "ref.md", "./group%5Cnote.md", "md"), literal);
    assert.equal((await core.call("indexLinksTo", literal)).length, 1);
    assert.equal((await core.call("indexLinksTo", nested)).length, 1);
    await writeFile(join(root, literal), "external");
    for (
      let attempt = 0;
      attempt < 60 && !events.some((event) => event.paths.includes(literal));
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(events.some((event) => event.status === "changed" && event.paths.includes(literal)));
    assert.deepEqual(await core.call("fileWrite", literal, bytes("edited"), bytes("external")), {
      status: "saved",
      warning: null,
    });
    const copy = await core.call("fileWriteCopy", literal, bytes("copy"), bytes("edited"));
    assert.equal(copy.path, "group\\note (副本).md");
    assert.equal(copy.warning, null);
    assert.equal(text(await core.call("fileRead", copy.path)), "copy");
    assert.deepEqual(await core.call("entryRename", literal, "renamed.md"), { warning: null });
    assert.equal(text(await core.call("fileRead", "renamed.md")), "edited");
    assert.equal(text(await core.call("fileRead", nested)), "nested");
    assert.equal(
      text(await core.call("fileRead", "ref.md")),
      "[literal](./renamed.md) [nested](./group/note.md)\n",
    );
  },
);

test("built worker preserves directory entries, current paths and safe file operation boundaries", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  const { core, changes } = start();
  await core.call("vaultOpen", root);
  assert.deepEqual(await core.call("entryCreate", "项目", "directory"), { warning: null });
  assert.deepEqual(await core.call("vaultEntries"), [{ path: "项目", kind: "directory" }]);
  await core.call("entryCreate", "项目/笔记.md", "file");
  await core.call("fileWrite", "项目/笔记.md", bytes("saved note"), bytes(""));
  await core.call("readerSessionPatch", { currentPath: "项目/笔记.md" });
  assert.deepEqual(await core.call("entryRename", "项目", "资料"), { warning: null });
  assert.deepEqual(await core.call("vaultEntries"), [
    { path: "资料", kind: "directory" },
    { path: "资料/笔记.md", kind: "file" },
  ]);
  assert.equal((await core.call("readerSessionLoad")).currentPath, "资料/笔记.md");
  assert.equal(
    await realpath(await core.call("entryPath", "资料/笔记.md")),
    await realpath(join(root, "资料/笔记.md")),
  );
  assert.equal(text(await core.call("fileRead", "资料/笔记.md")), "saved note");
  assert.ok(changes() >= 3);
  await assert.rejects(core.call("entryCreate", "资料/笔记.md", "file"));
  await assert.rejects(core.call("entryCreate", "../outside.md", "file"));
  await assert.rejects(core.call("entryTrash", "."));
  assert.equal(text(await core.call("fileRead", "资料/笔记.md")), "saved note");
});

test("映射失败的编辑恢复数据穿过原生线程，重开仍可读取且不改写原文", async (t) => {
  const { roots: [root], start } = await fixture(t);
  const { core } = start();
  await core.call("vaultOpen", root);
  await core.call("entryCreate", "note.md", "file");
  const source = bytes("原文\r\n");
  await core.call("fileWrite", "note.md", source, bytes(""));
  const editor = JSON.stringify({ format: "nous.prosemirror", version: 1, revision: 3, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "math_inline", attrs: { tex: "" } }] }] } });
  await core.call("filePreserveDraft", "note.md", source, source, editor);
  await core.call("vaultClose");
  await core.call("vaultOpen", root);
  assert.deepEqual(await core.call("fileSnapshot", "note.md"), { disk: source, draft: { bytes: source, base: source, editor } });
  await assert.rejects(core.call("entryRename", "note.md", "new.md"), /未保存草稿/);
  assert.deepEqual(await core.call("fileRead", "note.md"), source);
  await assert.rejects(core.call("filePreserveDraft", "note.md", source, source, "invalid"));
  assert.equal((await core.call("fileSnapshot", "note.md")).draft?.editor, editor);
});

test("附件字节穿过原生线程，独占导入并阻止迟到请求写入新库", async (t) => {
  const { roots: [root, second], start } = await fixture(t);
  const { core } = start();
  await core.call("vaultOpen", root);
  await core.call("entryCreate", "资料", "directory");
  await core.call("entryCreate", "资料/笔记.md", "file");
  const binary = new Uint8Array([0, 255, 13, 10]);
  const first = await core.call("attachmentImport", root, "资料/笔记.md", "图片 #1.png", binary);
  assert.deepEqual(first, { path: "资料/attachments/图片 #1.png", warning: null });
  const copy = await core.call("attachmentImport", root, "资料/笔记.md", "图片 #1.png", binary);
  assert.equal(copy.path, "资料/attachments/图片 #1 (1).png");
  assert.deepEqual(await core.call("fileRead", first.path), binary);
  assert.equal(await core.call("linksResolve", "资料/笔记.md", "./attachments/%E5%9B%BE%E7%89%87%20%231.png", "md"), first.path);
  await assert.rejects(core.call("attachmentImport", root, "资料/笔记.md", "../outside.png", binary));
  await core.call("vaultOpen", second);
  await core.call("entryCreate", "资料", "directory");
  await core.call("entryCreate", "资料/笔记.md", "file");
  await assert.rejects(core.call("attachmentImport", root, "资料/笔记.md", "late.png", binary), /笔记库已切换/);
  assert.deepEqual(await core.call("vaultList"), ["资料/笔记.md"]);
});

test("索引故障穿过原生监视通道，正文提交仍返回真实成功与警告", async (t) => {
  const {
    roots: [root],
    userData,
    start,
  } = await fixture(t);
  await writeFile(join(root, "note.md"), "old");
  const { core, events } = start();
  await core.call("vaultOpen", root);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const database = new DatabaseSync(join(userData, "vaults", hash, "index.sqlite"));
  try {
    database.exec("DROP TABLE links");
  } finally {
    database.close();
  }
  await writeFile(join(root, "note.md"), "external");
  for (
    let attempt = 0;
    attempt < 60 && !events.some((event) => event.status === "index-error");
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  const failure = events.find((event) => event.status === "index-error");
  assert.ok(failure);
  assert.ok(failure.paths.includes("note.md"));
  const result = await core.call("fileWrite", "note.md", bytes("saved"), bytes("external"));
  assert.equal(result.status, "saved");
  assert.equal(await readFile(join(root, "note.md"), "utf8"), "saved");
  if (result.status === "saved") assert.ok(result.warning?.includes("索引"));
});

test("built worker preserves native save, conflict, copy, rename and link contracts", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  await writeFile(join(root, "a.md"), "original");
  await writeFile(join(root, "ref.md"), "[[a]]\n");
  const { core } = start();
  assert.equal(await core.call("vaultOpen", root), root);
  assert.equal(await core.call("linksResolve", "ref.md", "a", "wiki"), "a.md");
  assert.equal(await core.call("linksResolve", "ref.md", "missing", "wiki"), null);
  const links = await core.call("indexLinksTo", "a.md");
  assert.ok(links[0]);
  assert.equal(links[0].fromPath, "ref.md");
  assert.equal(links[0].kind, "wiki");
  const mentions = await core.call("indexMentionsTo", "a.md");
  assert.equal(mentions.linked[0]?.fromPath, "ref.md");
  assert.equal(mentions.linked[0]?.linkKind, "wiki");

  const content = bytes("saved");
  const baseline = bytes("original");
  assert.deepEqual(await core.call("fileWrite", "a.md", content, baseline), {
    status: "saved",
    warning: null,
  });
  assert.equal(text(content), "saved");
  assert.equal(text(baseline), "original");
  const conflict = await core.call("fileWrite", "a.md", bytes("draft"), bytes("original"));
  assert.equal(conflict.status, "conflict");
  assert.equal(text(conflict.disk), "saved");
  const snapshot = await core.call("fileSnapshot", "a.md");
  assert.ok(snapshot.draft);
  assert.equal(text(snapshot.disk), "saved");
  assert.equal(text(snapshot.draft.bytes), "draft");
  assert.equal(text(snapshot.draft.base), "original");
  const copy = await core.call("fileWriteCopy", "a.md", bytes("draft"), bytes("original"));
  assert.equal(copy.warning, null);
  assert.equal(text(await core.call("fileRead", copy.path)), "draft");
  assert.deepEqual(await core.call("entryRename", "a.md", "b.md"), { warning: null });
  assert.equal(text(await core.call("fileRead", "ref.md")), "[[b]]\n");
  const renamedMentions = await core.call("indexMentionsTo", "b.md");
  assert.equal(renamedMentions.linked[0]?.toRaw, "b");
  await assert.rejects(core.call("fileRead", "absent.md"));
  assert.equal(text(await core.call("fileRead", "b.md")), "saved");
});

test("queued writes stay in their original vault and shutdown drains the final save", async (t) => {
  const {
    roots: [first, second],
    start,
  } = await fixture(t);
  await Promise.all([first, second].map((root) => writeFile(join(root, "a.md"), "original")));
  const { core } = start();
  await core.call("vaultOpen", first);
  const saveFirst = core.call("fileWrite", "a.md", bytes("first saved"), bytes("original"));
  const openSecond = core.call("vaultOpen", second);
  const readSecond = core.call("fileRead", "a.md");
  const saveSecond = core.call("fileWrite", "a.md", bytes("second saved"), bytes("original"));
  const remember = core.call("readerSessionPatch", {
    currentPath: "a.md",
    filesCollapsed: true,
    leftWidth: 240,
  });
  const stopped = core.shutdown();
  const [firstResult, , secondBytes, secondResult] = await Promise.all([
    saveFirst,
    openSecond,
    readSecond,
    saveSecond,
    remember,
    stopped,
  ]);
  assert.equal(firstResult.status, "saved");
  assert.equal(text(secondBytes), "original");
  assert.equal(secondResult.status, "saved");
  assert.equal(await readFile(join(first, "a.md"), "utf8"), "first saved");
  assert.equal(await readFile(join(second, "a.md"), "utf8"), "second saved");

  const { core: restored } = start();
  assert.deepEqual(await restored.call("vaultRestore"), { root: second, currentPath: "a.md" });
  assert.equal((await restored.call("readerSessionLoad")).filesCollapsed, true);
  const panes = await restored.call("readerSessionLoad");
  assert.equal(panes.leftWidth, 240);
  assert.equal(text(await restored.call("fileRead", "a.md")), "second saved");
});

test("failed vault switches retain the active vault and previous session", async (t) => {
  const {
    roots: [first, second],
    userData,
    start,
  } = await fixture(t);
  await writeFile(join(first, "a.md"), "first");
  await writeFile(join(second, "a.md"), "second");
  const { core } = start();
  await core.call("vaultOpen", first);
  await core.call("readerSessionPatch", { currentPath: "a.md" });
  await assert.rejects(core.call("vaultOpen", join(second, "missing")));
  assert.equal(text(await core.call("fileRead", "a.md")), "first");
  const session = await core.call("readerSessionLoad");
  assert.equal(session.vaultRoot, first);
  assert.equal(session.currentPath, "a.md");

  const sessionPath = join(userData, "session.json");
  await rm(sessionPath);
  await mkdir(sessionPath);
  await assert.rejects(core.call("vaultOpen", second));
  assert.equal(text(await core.call("fileRead", "a.md")), "first");
});

test("native watcher refreshes the active vault and releases it on close", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  const { core, changes } = start();
  await core.call("vaultOpen", root);
  await writeFile(join(root, "new.md"), "[[other]]\n");
  for (let attempt = 0; attempt < 60 && changes() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(changes() > 0, "原生监视回调应穿过工作线程");
  assert.deepEqual(await core.call("vaultList"), ["new.md"]);
  const links = await core.call("indexLinksFrom", "new.md");
  assert.ok(links[0]);
  assert.equal(links[0].toRaw, "other");
  assert.equal(links[0].toPath, null);
  await core.call("vaultClose");
  const changesAtClose = changes();
  await writeFile(join(root, "late.md"), "late");
  await core.shutdown();
  assert.equal(changes(), changesAtClose);
});
