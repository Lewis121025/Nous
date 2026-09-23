import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { Worker } from "node:worker_threads";
import { CoreClient } from "../../../apps/desktop/src/main/core-client";

const workerUrl = new URL("../../../apps/desktop/out/main/core-worker.js", import.meta.url);
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
      let changes = 0;
      const core = new CoreClient(new Worker(workerUrl, { workerData: userData }), () => {
        changes += 1;
      });
      clients.push(core);
      return { core, changes: () => changes };
    },
  };
}

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
  const remember = core.call("sessionPatch", {
    currentPath: "a.md",
    filesCollapsed: true,
    rightSplit: true,
    rightWidth: 320,
    rightSlots: [
      { viewId: "backlinks", pinnedPath: "a.md" },
      { viewId: "outline", pinnedPath: null },
    ],
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
  assert.equal((await restored.call("sessionLoad")).filesCollapsed, true);
  const panes = await restored.call("sessionLoad");
  assert.equal(panes.rightWidth, 320);
  assert.equal(panes.rightSplit, true);
  assert.deepEqual(panes.rightSlots, [
    { viewId: "backlinks", pinnedPath: "a.md" },
    { viewId: "outline", pinnedPath: null },
  ]);
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
  await core.call("sessionPatch", { currentPath: "a.md" });
  await assert.rejects(core.call("vaultOpen", join(second, "missing")));
  assert.equal(text(await core.call("fileRead", "a.md")), "first");
  const session = await core.call("sessionLoad");
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
