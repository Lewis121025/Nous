<script lang="ts">
  /**
   * 极简外壳：打开库、扁平列表、当前一篇、入链、改名。
   */
  import { onMount } from "svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import DocumentEditor from "./DocumentEditor.svelte";
  import OutlineTree from "./OutlineTree.svelte";
  import type { CodeEditorApi, MarkdownEditorApi } from "./engine/editor-api";
  import { createAutosave } from "./engine/autosave";
  import { buildOutlineTree, outlineEquals, type OutlineItem } from "./engine/outline";
  import { shouldApplyReload } from "./engine/reload";
  import { bytesForSave, commitSuccessfulWrite } from "./engine/save";
  import type { LinkRecord } from "../../shared/api";

  let files = $state<string[]>([]);
  let current = $state<string | null>(null);
  let originalBytes = $state<Uint8Array | null>(null);
  let source = $state("");
  let dirty = $state(false);
  let backlinks = $state<LinkRecord[]>([]);
  let deadOutbound = $state<LinkRecord[]>([]);
  let renameName = $state("");
  let message = $state("");
  let vaultRoot = $state<string | null>(null);
  let outline = $state<OutlineItem[]>([]);
  let collapsedByFile = $state<Record<string, string[]>>({});
  let filesCollapsed = $state(false);
  let outlineCollapsed = $state(false);

  let markdownApi: MarkdownEditorApi | null = null;
  let codeApi: CodeEditorApi | null = null;

  const decoder = new TextDecoder();
  let editGen = 0;
  const outlineTree = $derived(buildOutlineTree(outline));
  const collapsedKeys = $derived(current === null ? [] : (collapsedByFile[current] ?? []));

  const autosave = createAutosave({
    isDirty: () => dirty,
    save: persist,
  });

  onMount(() => {
    void (async () => {
      await restorePanes();
      await restoreSession();
    })();
    const unsubscribeVault = window.nous.subscribeVaultChanged(() => {
      void onVaultChanged();
    });
    const unsubscribeClose = window.nous.subscribeFlushBeforeClose(() => {
      void onFlushBeforeClose();
    });
    return () => {
      autosave.dispose();
      unsubscribeVault();
      unsubscribeClose();
    };
  });

  /**
   * 是否走文档表面。
   *
   * @param path 库内相对路径。
   */
  function isMarkdown(path: string): boolean {
    return path.toLowerCase().endsWith(".md");
  }

  const canOutline = $derived(current !== null && isMarkdown(current));

  function basename(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
  }

  function siblingPath(from: string, name: string): string {
    const slash = from.lastIndexOf("/");
    return slash === -1 ? name : `${from.slice(0, slash)}/${name}`;
  }

  async function refreshList(): Promise<void> {
    files = await window.nous.vaultList();
  }

  async function refreshLinks(path: string): Promise<void> {
    backlinks = await window.nous.indexLinksTo(path);
    const outbound = await window.nous.indexLinksFrom(path);
    deadOutbound = outbound.filter((link) => link.toPath === null);
  }

  async function onVaultChanged(): Promise<void> {
    const pathWhenStarted = current;
    try {
      await refreshList();
    } catch {
      return;
    }
    if (current !== pathWhenStarted) {
      return;
    }
    if (current === null) {
      return;
    }
    if (!files.includes(current)) {
      if (!dirty) {
        current = null;
        originalBytes = null;
        source = "";
        backlinks = [];
        deadOutbound = [];
        outline = [];
        void window.nous.sessionSetCurrent(null);
      }
      return;
    }
    await refreshLinks(current);
    if (current !== pathWhenStarted) {
      return;
    }
    const bytes = await window.nous.fileRead(pathWhenStarted);
    if (
      !shouldApplyReload({
        dirty,
        currentPath: current,
        pathWhenStarted,
        original: originalBytes,
        disk: bytes,
      })
    ) {
      return;
    }
    originalBytes = bytes;
    source = decoder.decode(bytes);
  }

  /**
   * 启动时读回侧栏收起状态。
   */
  async function restorePanes(): Promise<void> {
    try {
      const panes = await window.nous.sessionGetPanes();
      filesCollapsed = panes.filesCollapsed;
      outlineCollapsed = panes.outlineCollapsed;
    } catch {
      filesCollapsed = false;
      outlineCollapsed = false;
    }
  }

  function persistPanes(): void {
    void window.nous.sessionSetPanes({ filesCollapsed, outlineCollapsed });
  }

  function toggleFilesPane(): void {
    filesCollapsed = !filesCollapsed;
    persistPanes();
  }

  function toggleOutlinePane(): void {
    outlineCollapsed = !outlineCollapsed;
    persistPanes();
  }

  /**
   * 启动时按主进程会话打开上次的库和文件，不弹选目录框。
   */
  async function restoreSession(): Promise<void> {
    try {
      const restored = await window.nous.vaultRestore();
      if (restored === null) {
        return;
      }
      vaultRoot = restored.root;
      await refreshList();
      if (restored.currentPath !== null && files.includes(restored.currentPath)) {
        await openFile(restored.currentPath);
        return;
      }
      await window.nous.sessionSetCurrent(null);
    } catch (err) {
      message = err instanceof Error ? err.message : "恢复会话失败";
    }
  }

  async function openVault(): Promise<void> {
    await autosave.flush();
    if (dirty) {
      if (message === "") {
        message = "请先保存再打开其他库";
      }
      return;
    }
    try {
      const root = await window.nous.vaultOpen();
      if (root === null) {
        return;
      }
      vaultRoot = root;
      current = null;
      originalBytes = null;
      source = "";
      dirty = false;
      backlinks = [];
      deadOutbound = [];
      message = "";
      outline = [];
      await refreshList();
    } catch (err) {
      message = err instanceof Error ? err.message : "打开库失败";
    }
  }

  async function openFile(path: string): Promise<void> {
    if (path === current) {
      return;
    }
    await autosave.flush();
    if (dirty) {
      if (message === "") {
        message = "请先保存再打开其他文件";
      }
      return;
    }
    const bytes = await window.nous.fileRead(path);
    originalBytes = bytes;
    source = decoder.decode(bytes);
    current = path;
    dirty = false;
    renameName = basename(path);
    message = "";
    await window.nous.sessionSetCurrent(path);
    await refreshLinks(path);
  }

  function markDirty(): void {
    dirty = true;
    editGen += 1;
    autosave.touch();
  }

  function requestSave(): void {
    void autosave.flush();
  }

  function requestOpenLink(kind: "wiki" | "md", raw: string): void {
    void openLink(kind, raw);
  }

  function setOutline(items: OutlineItem[]): void {
    if (outlineEquals(outline, items)) {
      return;
    }
    outline = items;
  }

  function jumpOutline(pos: number): void {
    markdownApi?.jumpTo(pos);
  }

  function toggleOutline(key: string): void {
    const path = current;
    if (path === null) {
      return;
    }
    const currentKeys = collapsedByFile[path] ?? [];
    const next = currentKeys.includes(key)
      ? currentKeys.filter((item) => item !== key)
      : [...currentKeys, key];
    collapsedByFile = { ...collapsedByFile, [path]: next };
  }

  function registerMarkdown(api: MarkdownEditorApi | null): void {
    markdownApi = api;
    if (api === null) {
      outline = [];
    }
  }

  function registerCode(api: CodeEditorApi | null): void {
    codeApi = api;
  }

  async function persist(): Promise<void> {
    const path = current;
    const original = originalBytes;
    const gen = editGen;
    if (path === null || original === null) {
      return;
    }
    const serialize = (): string => {
      if (isMarkdown(path)) {
        if (markdownApi === null) {
          throw new Error("文档编辑器尚未就绪");
        }
        return markdownApi.serialize();
      }
      if (codeApi === null) {
        throw new Error("代码编辑器尚未就绪");
      }
      return codeApi.getText();
    };
    try {
      const bytes = bytesForSave(dirty, original, serialize);
      await window.nous.fileWrite(path, bytes);
      if (current !== path) {
        return;
      }
      const commit = commitSuccessfulWrite(bytes, gen, editGen);
      originalBytes = commit.originalBytes;
      dirty = commit.dirty;
      message = "";
      if (current === path) {
        await refreshLinks(path);
      }
    } catch (err) {
      message = err instanceof Error ? err.message : "保存失败";
    }
  }

  async function onFlushBeforeClose(): Promise<void> {
    await autosave.flush();
    if (dirty) {
      if (message === "") {
        message = "保存失败，请先手动保存再关闭";
      }
      await window.nous.closeBlocked();
      return;
    }
    await window.nous.closeAfterFlush();
  }

  async function openLink(kind: "wiki" | "md", raw: string): Promise<void> {
    if (current === null) {
      return;
    }
    await autosave.flush();
    if (dirty) {
      if (message === "") {
        message = "请先保存再跳转";
      }
      return;
    }
    const to = await window.nous.linksResolve(current, raw, kind);
    if (to === null) {
      message = "死链，无法跳转";
      return;
    }
    await openFile(to);
  }

  async function rename(): Promise<void> {
    if (current === null) {
      return;
    }
    await autosave.flush();
    if (dirty) {
      if (message === "") {
        message = "有未保存修改，拒绝改名";
      }
      return;
    }
    const name = renameName.trim();
    if (name === "") {
      message = "文件名不能为空";
      return;
    }
    const to = siblingPath(current, name);
    if (to === current) {
      return;
    }
    try {
      await window.nous.entryRename(current, to);
      current = to;
      renameName = basename(to);
      const bytes = await window.nous.fileRead(to);
      originalBytes = bytes;
      source = decoder.decode(bytes);
      dirty = false;
      await window.nous.sessionSetCurrent(to);
      await refreshList();
      await refreshLinks(to);
      message = "";
    } catch (err) {
      message = err instanceof Error ? err.message : "改名失败";
    }
  }
</script>

<div class="app">
  <header class="toolbar">
    <button type="button" onclick={() => void openVault()}>打开库</button>
    <button type="button" onclick={() => void autosave.flush()} disabled={current === null}
      >保存</button
    >
    <button type="button" aria-pressed={!filesCollapsed} onclick={toggleFilesPane}>文件</button>
    <button
      type="button"
      aria-pressed={canOutline && !outlineCollapsed}
      disabled={!canOutline}
      onclick={toggleOutlinePane}>目录</button
    >
    {#if vaultRoot !== null}
      <span class="root" title={vaultRoot}>{vaultRoot}</span>
    {/if}
    {#if message !== ""}
      <span class="message">{message}</span>
    {/if}
  </header>

  <div class="panes">
    {#if !filesCollapsed}
      <nav class="list" aria-label="文件列表">
        <div class="pane-head">文件</div>
        <div class="list-body">
          {#each files as path (path)}
            <button
              type="button"
              class="file"
              class:active={path === current}
              onclick={() => void openFile(path)}
            >
              {path}
            </button>
          {/each}
        </div>
      </nav>
    {/if}

    <section class="main">
      {#if current !== null}
        {#if isMarkdown(current)}
          <DocumentEditor
            path={current}
            {source}
            onDirty={markDirty}
            onSave={requestSave}
            onOpenLink={requestOpenLink}
            onOutline={setOutline}
            register={registerMarkdown}
          />
        {:else}
          <CodeEditor
            {source}
            path={current}
            onDirty={markDirty}
            onSave={requestSave}
            register={registerCode}
          />
        {/if}

        <h2>入链</h2>
        <ul class="backlinks">
          {#each backlinks as link, index (`${link.fromPath}:${link.startByte}:${index}`)}
            <li>
              {#if link.toPath !== null}
                <button type="button" class="link" onclick={() => void openFile(link.fromPath)}>
                  {link.fromPath}
                </button>
              {:else}
                {link.fromPath}
              {/if}
            </li>
          {/each}
          {#each deadOutbound as link, index (`dead:${link.toRaw}:${link.startByte}:${index}`)}
            <li>{link.toRaw}</li>
          {/each}
        </ul>

        <form
          class="rename"
          onsubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <label>
            重命名
            <input bind:value={renameName} name="rename" />
          </label>
          <button type="submit">提交</button>
        </form>
      {/if}
    </section>

    {#if canOutline && !outlineCollapsed}
      <aside class="outline-pane">
        <div class="pane-head">目录</div>
        <nav class="outline" aria-label="文档目录">
          <OutlineTree
            nodes={outlineTree}
            collapsed={collapsedKeys}
            onToggle={toggleOutline}
            onJump={jumpOutline}
          />
        </nav>
      </aside>
    {/if}
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .toolbar button[aria-pressed="true"] {
    font-weight: 600;
  }

  .root {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message {
    margin-left: auto;
  }

  /* 文件 | 编辑 | 目录。未挂载的侧栏不占列；开关在顶栏，不随列宽移动。 */
  .panes {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .list {
    grid-column: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    width: 16rem;
    border-right: 1px solid var(--border);
  }

  .list-body {
    overflow: auto;
    flex: 1 1 auto;
    min-height: 0;
  }

  .pane-head {
    padding: 0.35rem 0.6rem;
    border-bottom: 1px solid var(--border);
    font-size: 1rem;
    font-weight: 600;
  }

  .file {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0.6rem;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
  }

  .file.active {
    font-weight: 600;
  }

  .main {
    grid-column: 2;
    overflow: auto;
    min-height: 0;
    padding: 0.75rem;
  }

  h2 {
    font-size: 1rem;
    font-weight: 600;
    margin: 1rem 0 0.35rem;
  }

  .backlinks {
    margin: 0;
    padding-left: 1.2rem;
  }

  .outline-pane {
    grid-column: 3;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    width: 14rem;
    border-left: 1px solid var(--border);
  }

  .outline {
    overflow: auto;
    flex: 1 1 auto;
    min-height: 0;
    padding: 0.35rem 0.45rem;
  }

  .link {
    border: none;
    background: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
    font: inherit;
  }

  .rename {
    display: flex;
    gap: 0.5rem;
    align-items: end;
    margin-top: 1rem;
  }

  button,
  input {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
  }

  input {
    padding: 0.25rem 0.4rem;
  }

  button {
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }

  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
</style>
