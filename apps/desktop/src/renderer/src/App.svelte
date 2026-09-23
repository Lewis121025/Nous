<script lang="ts">
  /**
   * 极简外壳：打开库、扁平列表、当前一篇、入链、改名。
   */
  import { onMount } from "svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import DocumentEditor from "./DocumentEditor.svelte";
  import ImagePreview from "./ImagePreview.svelte";
  import PdfPreview from "./PdfPreview.svelte";
  import OutlineTree from "./OutlineTree.svelte";
  import type { CodeEditorApi, MarkdownEditorApi } from "./engine/editor-api";
  import { createAutosave } from "./engine/autosave";
  import { buildOutlineTree, outlineEquals, type OutlineItem } from "./engine/outline";
  import { bytesEqual } from "./engine/reload";
  import { bytesForSave, commitSuccessfulWrite } from "./engine/save";
  import { uniqueBacklinks } from "./engine/backlinks";
  import { readFileContent, type FileContent } from "./engine/file-content";
  import type { LinkRecord } from "../../shared/api";

  let files = $state<string[]>([]);
  let current = $state<string | null>(null);
  let originalBytes = $state<Uint8Array | null>(null);
  let content = $state.raw<FileContent | null>(null);
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
  let conflict = $state<{ disk: Uint8Array | null } | null>(null);
  let saveError = $state<string | null>(null);
  let saving = $state(false);
  let copying = $state(false);
  let switching = $state(true);

  let markdownApi: MarkdownEditorApi | null = null;
  let codeApi: CodeEditorApi | null = null;

  const decoder = new TextDecoder();
  let editGen = 0;
  // 路径相同也可能已换库或重载，异步结果必须属于同一次文档加载。
  let documentEpoch = $state(0);
  let refreshEpoch = 0;
  let pendingRefresh = false;
  const outlineTree = $derived(buildOutlineTree(outline));
  const collapsedKeys = $derived(current === null ? [] : (collapsedByFile[current] ?? []));
  const backlinkSources = $derived(uniqueBacklinks(backlinks));
  const saveStatus = $derived(
    copying
      ? "正在保存副本…"
      : saving
        ? "正在保存…"
        : conflict !== null
          ? "存在保存冲突"
          : saveError !== null
            ? "保存失败"
            : dirty
              ? "未保存"
              : "已保存",
  );

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

  const canEdit = $derived(content?.kind === "markdown" || content?.kind === "text");
  const canOutline = $derived(content?.kind === "markdown");

  function basename(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
  }

  function siblingPath(from: string, name: string): string {
    const slash = from.lastIndexOf("/");
    return slash === -1 ? name : `${from.slice(0, slash)}/${name}`;
  }

  async function refreshList(): Promise<void> {
    const root = vaultRoot;
    const epoch = documentEpoch;
    const listed = await window.nous.vaultList();
    if (root === vaultRoot && epoch === documentEpoch) {
      files = listed;
    }
  }

  async function refreshLinks(path: string): Promise<void> {
    const epoch = documentEpoch;
    try {
      const [incoming, outbound] = await Promise.all([
        window.nous.indexLinksTo(path),
        window.nous.indexLinksFrom(path),
      ]);
      if (epoch !== documentEpoch || current !== path) return;
      backlinks = incoming;
      deadOutbound = outbound.filter((link) => link.toPath === null);
    } catch (err) {
      if (epoch === documentEpoch && current === path && message === "") {
        message = `链接信息暂不可用：${errorText(err)}`;
      }
    }
  }

  async function onVaultChanged(): Promise<void> {
    if (switching || copying || saving) {
      pendingRefresh = true;
      return;
    }
    const path = current;
    const epoch = documentEpoch;
    const request = ++refreshEpoch;
    const baseline = originalBytes;
    try {
      await refreshList();
      if (epoch !== documentEpoch || path === null || switching) return;
      const snapshot = await window.nous.fileSnapshot(path);
      if (epoch !== documentEpoch || request !== refreshEpoch) return;
      if (switching || copying || saving || baseline !== originalBytes) {
        pendingRefresh = true;
        resumeVaultRefresh();
        return;
      }
      if (dirty) {
        conflict = bytesEqual(snapshot.disk, originalBytes) ? null : { disk: snapshot.disk };
      } else if (snapshot.disk === null) {
        clearDocument();
        await window.nous.sessionSetCurrent(null);
      } else if (!bytesEqual(snapshot.disk, originalBytes)) {
        documentEpoch += 1;
        originalBytes = snapshot.disk;
        content = readFileContent(path, snapshot.disk);
      }
      if (current === path) await refreshLinks(path);
    } catch (err) {
      if (epoch === documentEpoch && !switching) {
        message = `读取外部变更失败：${errorText(err)}`;
      }
    }
  }

  function resumeVaultRefresh(): void {
    if (!pendingRefresh || switching || copying || saving) return;
    pendingRefresh = false;
    void onVaultChanged();
  }

  function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function clearDocument(): void {
    documentEpoch += 1;
    current = null;
    originalBytes = null;
    content = null;
    dirty = false;
    conflict = null;
    saveError = null;
    backlinks = [];
    deadOutbound = [];
    outline = [];
  }

  async function loadFile(path: string): Promise<void> {
    const snapshot = await window.nous.fileSnapshot(path);
    let bytes = snapshot.draft?.bytes ?? snapshot.disk;
    if (bytes === null) throw new Error("文件已不存在");
    const baseBytes = snapshot.draft?.base ?? bytes;
    const baseContent = readFileContent(path, baseBytes);
    const editable = baseContent.kind === "markdown" || baseContent.kind === "text";
    // 旧版本可能为二进制误建文本草稿；预览只读取原文件，保留草稿但不写回附件。
    // 草稿原本是文本时，以编辑基准判断，磁盘变为二进制也不能隐藏用户的有效编辑。
    if (!editable) bytes = snapshot.disk ?? baseBytes;
    documentEpoch += 1;
    originalBytes = editable && snapshot.draft !== null ? snapshot.draft.base : snapshot.disk;
    content = bytes === baseBytes ? baseContent : readFileContent(path, bytes);
    current = path;
    dirty =
      (content.kind === "markdown" || content.kind === "text") &&
      editable &&
      snapshot.draft !== null;
    conflict = dirty && !bytesEqual(snapshot.disk, originalBytes) ? { disk: snapshot.disk } : null;
    saveError = null;
    renameName = basename(path);
    message = dirty ? "已恢复上次未保存的编辑，请检查后保存。" : "";
    await window.nous.sessionSetCurrent(path);
    await refreshLinks(path);
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
        await loadFile(restored.currentPath);
        return;
      }
      await window.nous.sessionSetCurrent(null);
    } catch (err) {
      message = err instanceof Error ? err.message : "恢复会话失败";
    } finally {
      switching = false;
      resumeVaultRefresh();
    }
  }

  async function openVault(): Promise<void> {
    if (switching || copying) return;
    switching = true;
    try {
      await autosave.flush();
      if (dirty) return;
      const root = await window.nous.vaultOpen();
      if (root === null) return;
      vaultRoot = root;
      clearDocument();
      message = "";
      await refreshList();
    } catch (err) {
      message = `打开库失败：${errorText(err)}`;
    } finally {
      switching = false;
      resumeVaultRefresh();
    }
  }

  async function openFile(path: string): Promise<void> {
    if (path === current || switching || copying) return;
    switching = true;
    try {
      await autosave.flush();
      if (dirty) return;
      await loadFile(path);
    } catch (err) {
      message = `打开文件失败：${errorText(err)}`;
    } finally {
      switching = false;
      resumeVaultRefresh();
    }
  }

  function markDirty(): void {
    if (!canEdit) return;
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

  /**
   * 注册/注销序列化入口。卸载时不要在这里清大纲：onOutline([]) 已经做了。
   * 若此处再写 outline = []，会和编辑器挂载抢状态。
   */
  function registerMarkdown(api: MarkdownEditorApi | null): void {
    markdownApi = api;
  }

  function registerCode(api: CodeEditorApi | null): void {
    codeApi = api;
  }

  function serializeCurrent(): string {
    if (content?.kind === "markdown") {
      if (markdownApi === null) throw new Error("文档编辑器尚未就绪");
      return markdownApi.serialize();
    }
    if (content?.kind !== "text" || codeApi === null) throw new Error("文本编辑器尚未就绪");
    return codeApi.getText();
  }

  async function persist(): Promise<void> {
    const path = current;
    const original = originalBytes;
    const gen = editGen;
    const epoch = documentEpoch;
    if (path === null || copying || !canEdit) return;
    saving = true;
    try {
      const bytes = bytesForSave(dirty, original ?? new Uint8Array(), serializeCurrent);
      const result = await window.nous.fileWrite(path, bytes, original);
      if (epoch !== documentEpoch) return;
      saveError = null;
      if (result.status === "conflict") {
        conflict = { disk: result.disk };
        return;
      }
      const commit = commitSuccessfulWrite(bytes, gen, editGen);
      originalBytes = commit.originalBytes;
      dirty = commit.dirty;
      conflict = null;
      message = result.warning === null ? "" : `内容已保存。${result.warning}`;
      await refreshLinks(path);
    } catch (err) {
      if (epoch === documentEpoch) saveError = errorText(err);
    } finally {
      saving = false;
      resumeVaultRefresh();
    }
  }

  async function saveCopy(): Promise<void> {
    if (current === null || switching || copying || saving || !canEdit) return;
    copying = true;
    autosave.dispose();
    const path = current;
    const gen = editGen;
    let savedPath: string | null = null;
    try {
      const bytes = new TextEncoder().encode(serializeCurrent());
      const copy = await window.nous.fileWriteCopy(path, bytes, originalBytes);
      savedPath = copy.path;
      // 等待写盘期间仍可输入；换到副本时必须带上这段更新。
      const latest = editGen === gen ? bytes : new TextEncoder().encode(serializeCurrent());
      documentEpoch += 1;
      current = copy.path;
      content = readFileContent(copy.path, latest);
      originalBytes = bytes;
      dirty = editGen !== gen;
      conflict = null;
      saveError = null;
      renameName = basename(copy.path);
      message = `副本已保存为 ${copy.path}。${copy.warning ?? "原文件已保留。"}`;
      await window.nous.sessionSetCurrent(copy.path);
      await refreshList();
      await refreshLinks(copy.path);
    } catch (err) {
      if (savedPath === null) saveError = errorText(err);
      else message = `副本已保存为 ${savedPath}，但界面更新失败：${errorText(err)}`;
    } finally {
      copying = false;
      resumeVaultRefresh();
      if (dirty) autosave.touch();
    }
  }

  async function onFlushBeforeClose(): Promise<void> {
    if (switching || copying) {
      message = "请等待当前操作完成后再关闭。";
      await window.nous.closeBlocked();
      return;
    }
    switching = true;
    try {
      await autosave.flush();
      if (dirty) {
        if (message === "") message = "当前编辑尚未保存，请处理后再关闭。";
        await window.nous.closeBlocked();
        return;
      }
      await window.nous.closeAfterFlush();
    } finally {
      switching = false;
      resumeVaultRefresh();
    }
  }

  async function openLink(kind: "wiki" | "md", raw: string): Promise<void> {
    if (current === null || switching || copying) return;
    const path = current;
    const epoch = documentEpoch;
    try {
      const to = await window.nous.linksResolve(path, raw, kind);
      if (epoch !== documentEpoch || switching || copying) return;
      if (to === null) {
        message = "死链，无法跳转";
        return;
      }
      await openFile(to);
    } catch (err) {
      if (epoch === documentEpoch) message = `打开链接失败：${errorText(err)}`;
    }
  }

  async function rename(): Promise<void> {
    if (current === null || switching || copying) return;
    switching = true;
    let renamedPath: string | null = null;
    try {
      await autosave.flush();
      if (dirty) return;
      const name = renameName.trim();
      if (name === "") {
        message = "文件名不能为空";
        return;
      }
      const to = siblingPath(current, name);
      if (to === current) return;
      const result = await window.nous.entryRename(current, to);
      renamedPath = to;
      await loadFile(to);
      await refreshList();
      if (result.warning !== null) message = `文件已重命名。${result.warning}`;
    } catch (err) {
      if (renamedPath === null) message = `改名失败：${errorText(err)}`;
      else {
        clearDocument();
        message = `文件已重命名为 ${renamedPath}，但界面更新失败，请重新打开：${errorText(err)}`;
        await refreshList().catch(() => undefined);
      }
    } finally {
      switching = false;
      resumeVaultRefresh();
    }
  }
</script>

<div class="app">
  <header class="toolbar">
    <button type="button" onclick={() => void openVault()} disabled={switching || copying}
      >打开库</button
    >
    <button
      type="button"
      onclick={requestSave}
      disabled={!canEdit || switching || copying || saving}>保存</button
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
    {#if current !== null}
      <span class="save-status" role="status">{canEdit ? saveStatus : "只读预览"}</span>
    {/if}
    {#if message !== ""}
      <span class="message">{message}</span>
    {/if}
  </header>

  <div class="panes" inert={switching}>
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
        {#if conflict !== null || saveError !== null}
          <section class="save-notice" aria-label="保存需要处理">
            <p role="alert">
              {#if conflict !== null}
                {conflict.disk === null ? "原文件已在其他地方删除。" : "原文件已在其他地方修改。"}
                当前编辑仍保留，可另存副本以保留两份内容。
              {:else}
                保存失败。当前编辑仍保留，请重试或另存副本。
              {/if}
            </p>
            {#if saveError !== null}<p class="save-error">{saveError}</p>{/if}
            <div class="save-actions">
              <button type="button" onclick={() => void saveCopy()} disabled={saving || copying}
                >另存为副本</button
              >
              <button type="button" onclick={requestSave} disabled={saving || copying}
                >重试保存</button
              >
            </div>
            {#if conflict?.disk != null}
              <details>
                <summary>查看磁盘版本</summary>
                <pre>{decoder.decode(conflict.disk)}</pre>
              </details>
            {/if}
          </section>
        {/if}
        {#key documentEpoch}
          {#if content?.kind === "markdown"}
            <DocumentEditor
              path={current}
              source={content.source}
              onDirty={markDirty}
              onSave={requestSave}
              onOpenLink={requestOpenLink}
              onOutline={setOutline}
              register={registerMarkdown}
            />
          {:else if content?.kind === "text"}
            <CodeEditor
              source={content.source}
              path={current}
              onDirty={markDirty}
              onSave={requestSave}
              register={registerCode}
            />
          {:else if content?.kind === "image"}
            <ImagePreview path={current} bytes={content.bytes} />
          {:else if content?.kind === "pdf"}
            <PdfPreview bytes={content.bytes} />
          {:else}
            <section class="unsupported" aria-label="附件预览">
              <h2>暂不支持预览此文件</h2>
              <p>{current}</p>
              <p>可预览图片、PDF 和 UTF-8 文本文件。</p>
            </section>
          {/if}
        {/key}

        <h2>入链</h2>
        <ul class="backlinks">
          {#each backlinkSources as link (link.fromPath)}
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

  .save-status {
    white-space: nowrap;
    font-size: 0.875rem;
  }

  .save-notice {
    border: 1px solid var(--border);
    border-left: 3px solid var(--fg);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }

  .save-notice p {
    margin: 0 0 0.75rem;
  }

  .save-actions {
    display: flex;
    gap: 0.5rem;
  }

  .save-notice details {
    margin-top: 0.75rem;
  }

  .save-notice pre {
    max-height: 14rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .save-error {
    font-size: 0.875rem;
    overflow-wrap: anywhere;
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
    content-visibility: auto;
    contain-intrinsic-size: auto 2.2rem;
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

  .unsupported {
    padding: 3rem 1rem;
    text-align: center;
    overflow-wrap: anywhere;
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
