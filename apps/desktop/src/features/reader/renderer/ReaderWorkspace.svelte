<script lang="ts">
  import { flushSync, onMount, tick, untrack, type Snippet } from "svelte";
  import ReaderToolbar from "./components/workspace/ReaderToolbar.svelte";
  import FileList from "./components/files/FileList.svelte";
  import DocumentSurface from "./components/workspace/DocumentSurface.svelte";
  import FileEntryDialog from "./components/files/FileEntryDialog.svelte";
  import LinkCandidatesDialog from "./components/workspace/LinkCandidatesDialog.svelte";
  import DeadLinkDialog from "./components/workspace/DeadLinkDialog.svelte";
  import { parentDirectory, type FileEntryChange } from "./engine/navigation/file-tree";
  import { ReaderWorkspaceController } from "./state/workspace.svelte";
  import { createBrowserMediaIo } from "./engine/media/media";
  import { SIDEBAR_LAYOUT, type ReaderApi } from "../shared/api";
  import "./styles/controls.css";
  import type { HistoryAction, HistoryAvailability, ReaderCommand } from "../shared/api";
  import { isCompositionKey } from "./engine/editing/composition";

  /** 每次挂载对应一个阅读器实例，api 在该实例存活期间保持不变。 */
  let { api, applicationMenu }: { api: ReaderApi; applicationMenu: Snippet } = $props();
  // 控制器和资源访问接口共用同一组能力，替换能力时由外壳重新挂载实例。
  const readerApi = untrack(() => api);
  const workspace = new ReaderWorkspaceController(readerApi);
  const mediaIo = createBrowserMediaIo(readerApi);
  const doc = workspace.document;
  let filesCollapsed = $state(false);
  let narrow = $state(false);
  let leftWidth = $state(SIDEBAR_LAYOUT.leftWidth);
  let entryDialog: FileEntryDialog | undefined = $state();
  let fileList: FileList | undefined = $state();
  let toolbar: ReaderToolbar | undefined = $state();
  let mainPane: HTMLElement | undefined = $state();

  /** 组词与切换期间消费但不执行命令；模态输入框保留自身历史，不修改背后的正文。 */
  export function executeHistory(action: HistoryAction): boolean {
    if (workspace.isComposing || workspace.switching) return true;
    if (document.querySelector("dialog[open]")) return false;
    return workspace.navigation.applyHistory(action);
  }

  /** 与执行门禁一致的响应式历史投影；null 交由外壳查询当前原生输入控件。 */
  export function historyAvailability(): HistoryAvailability | null {
    if (workspace.isComposing || workspace.switching) return { undo: false, redo: false };
    if (document.querySelector("dialog[open]")) return null;
    return workspace.navigation.historyAvailability;
  }

  /** 原生菜单和工作区快捷键共享动作；组词及模态操作期间不能跳转或提交。 */
  export function executeCommand(command: ReaderCommand): void {
    if (
      workspace.isComposing ||
      workspace.switching ||
      workspace.copying ||
      document.querySelector("dialog[open]")
    )
      return;
    switch (command) {
      case "open-vault":
        void workspace.openVault();
        break;
      case "new-note":
        if (workspace.vaultRoot !== null) fileList?.beginCreate("file");
        break;
      case "new-folder":
        if (workspace.vaultRoot !== null) fileList?.beginCreate("directory");
        break;
      case "save":
        if (doc.canEdit) workspace.requestSave();
        break;
      case "find":
        prepareDocumentAction();
        workspace.navigation.openSearch();
        break;
      case "find-files":
        void searchFiles();
        break;
      case "insert-attachment":
        prepareDocumentAction();
        workspace.navigation.openAttachments();
        break;
      case "toggle-files":
        toggleFilesPane();
        break;
      case "go-back":
        void workspace.navigateBack();
        break;
      case "go-forward":
        void workspace.navigateForward();
        break;
      case "toggle-source":
        void workspace.toggleViewMode();
        break;
    }
  }

  onMount(() => {
    updateViewport();
    // 阅读栈的滚动捕获/恢复绑定到主滚动区；恢复等待新文档渲染完成，
    // 避免滚动值先被旧内容高度钳制。
    workspace.history.attachScroll({
      capture: () => mainPane?.scrollTop ?? null,
      apply: (top) => {
        void tick().then(() => {
          if (mainPane) mainPane.scrollTop = top;
        });
      },
    });
    const dispose = workspace.start();
    void (async () => {
      await restorePanes();
      await workspace.restore();
    })();
    return dispose;
  });

  async function restorePanes(): Promise<void> {
    try {
      const panes = await readerApi.sessionGetPanes();
      filesCollapsed = panes.filesCollapsed;
      leftWidth = panes.leftWidth;
    } catch (error) {
      workspace.report(
        "文件栏布局未能恢复，已使用默认布局。可重新调整布局；若问题持续，请查看详细原因。",
        error,
      );
    }
  }

  function persistPanes(): void {
    void readerApi.sessionSetPanes({ filesCollapsed, leftWidth }).catch((error: unknown) => {
      workspace.report(
        "文件栏布局未能保存，下次打开可能恢复为原布局。请检查磁盘空间及应用数据目录是否可写，再重新调整布局。",
        error,
      );
    });
  }

  function updateViewport(): void {
    narrow = window.innerWidth <= 640;
  }

  function closeFilesPane(): void {
    filesCollapsed = true;
    persistPanes();
    void tick().then(() => toolbar?.focusFilesToggle());
  }

  function toggleFilesPane(): void {
    if (!filesCollapsed) closeFilesPane();
    else {
      filesCollapsed = false;
      persistPanes();
    }
  }

  function prepareDocumentAction(): boolean {
    if (filesCollapsed || !narrow) return false;
    // 原生弹层会在点击事件结束时分配焦点，需要先解除正文的 inert。
    flushSync(() => {
      filesCollapsed = true;
    });
    persistPanes();
    return true;
  }

  function beginRename(): void {
    if (doc.path !== null && !workspace.switching && !workspace.copying)
      void entryDialog?.open("rename", { path: doc.path, kind: "file" }, parentDirectory(doc.path));
  }

  async function searchFiles(): Promise<void> {
    if (filesCollapsed) {
      filesCollapsed = false;
      persistPanes();
      await tick();
    }
    fileList?.focusSearch();
  }

  function finishFileNavigation(focusEditor = false): void {
    const revealed = prepareDocumentAction();
    if (focusEditor || revealed) void tick().then(() => workspace.navigation.focusEditor());
  }

  async function finishEntryOperation(change: FileEntryChange): Promise<void> {
    const writing =
      change.action === "create" && change.entry.kind === "file" && doc.path === change.entry.path;
    await fileList?.reflectChange(change, !filesCollapsed && !writing);
    if (writing) finishFileNavigation(true);
  }

  function onWorkspaceShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || isCompositionKey(event) || workspace.isComposing) return;
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
    if (
      event.key === "Escape" &&
      narrow &&
      !filesCollapsed &&
      !(event.target instanceof Element && event.target.closest("[popover]"))
    ) {
      event.preventDefault();
      closeFilesPane();
      return;
    }
    if (event.altKey || !(event.metaKey || event.ctrlKey)) return;
    if (workspace.switching || workspace.copying) return;
    const key = event.key.toLowerCase();
    const command: ReaderCommand | null =
      key === "n"
        ? event.shiftKey
          ? "new-folder"
          : "new-note"
        : key === "f"
          ? event.shiftKey
            ? "find-files"
            : "find"
          : key === "s" && !event.shiftKey
            ? "save"
            : key === "o"
              ? "open-vault"
              : key === "\\"
                ? "toggle-files"
                : // 菜单加速键被系统消费时（含合成按键）由工作区兜底，与 Cmd+N 等同一路径。
                  key === "[" && !event.shiftKey
                  ? "go-back"
                  : key === "]" && !event.shiftKey
                    ? "go-forward"
                    : key === "e" && !event.shiftKey
                      ? "toggle-source"
                      : null;
    if (command !== null) {
      event.preventDefault();
      executeCommand(command);
    }
  }

  /** @returns 当前编辑已安全保存时允许关闭；冲突或写入失败时由应用外壳保留窗口。 */
  export function flushBeforeClose(): Promise<boolean> {
    return workspace.flushBeforeClose();
  }
</script>

<svelte:window
  onkeydown={onWorkspaceShortcut}
  onresize={updateViewport}
  oncompositionstart={() => workspace.setComposing(true)}
  oncompositionend={() => workspace.setComposing(false)}
/>
<div class="app">
  <ReaderToolbar
    bind:this={toolbar}
    {workspace}
    {filesCollapsed}
    onToggleFiles={toggleFilesPane}
    onRename={beginRename}
    onDocumentAction={prepareDocumentAction}
    {applicationMenu}
  />
  <div class="panes" inert={workspace.switching}>
    {#if !filesCollapsed}
      <button class="files-scrim" type="button" aria-label="收起文件栏" onclick={closeFilesPane}
      ></button>
    {/if}
    <FileList
      bind:this={fileList}
      onOpen={finishFileNavigation}
      {workspace}
      hidden={filesCollapsed}
      width={leftWidth}
      onEdit={(action, entry, parent) => void entryDialog?.open(action, entry, parent)}
      onWidth={(width) => {
        leftWidth = width;
        persistPanes();
      }}
    />
    <section class="main" bind:this={mainPane} inert={narrow && !filesCollapsed}>
      <div class:document-body={doc.content?.kind === "markdown"}>
        {#if doc.path !== null}
          <DocumentSurface {workspace} {mediaIo} />
        {:else}
          <div class="welcome">
            <h1>
              {workspace.vaultRoot === null
                ? "你的笔记，安静地在这里。"
                : workspace.files.length === 0
                  ? "从第一篇笔记开始"
                  : "留一点空间，给新的想法。"}
            </h1>
            <p>
              {workspace.vaultRoot === null
                ? "打开一个本地文件夹，开始阅读和写作。"
                : workspace.files.length === 0
                  ? "创建笔记后，就可以直接开始写作。"
                  : "打开已有笔记，或写下此刻的想法。"}
            </p>
            {#if workspace.vaultRoot === null}
              <button
                type="button"
                class="reader-button primary"
                onclick={() => void workspace.openVault()}
                disabled={workspace.switching}>打开笔记库…</button
              >
            {:else}
              <div class="welcome-actions">
                <button
                  class="reader-button primary"
                  type="button"
                  onclick={() => fileList?.beginCreate("file")}
                  disabled={workspace.switching}>新建笔记</button
                >
                {#if filesCollapsed}
                  <button class="reader-button" type="button" onclick={toggleFilesPane}
                    >显示文件栏</button
                  >
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </section>
  </div>
  {#if workspace.deadLinkOffer !== null}
    <DeadLinkDialog
      path={workspace.deadLinkOffer.path}
      anchor={workspace.deadLinkOffer.anchor}
      onConfirm={() => void workspace.confirmDeadLink()}
      onDismiss={workspace.dismissDeadLink}
    />
  {/if}
  <FileEntryDialog
    bind:this={entryDialog}
    {workspace}
    onComplete={(change) => void finishEntryOperation(change)}
  />
  {#if workspace.linkCandidates !== null}
    <LinkCandidatesDialog
      paths={workspace.linkCandidates.paths}
      anchor={workspace.linkCandidates.anchor}
      onChoose={(path) => void workspace.chooseLinkCandidate(path)}
      onDismiss={workspace.dismissLinkCandidates}
    />
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .panes {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .files-scrim {
    display: none;
  }
  .main {
    /* 查找栏复用滚动区内边距，吸顶时对齐真实视口边缘。 */
    --reader-inset: 1.5rem;
    flex: 1 1 auto;
    overflow: auto;
    min-width: 0;
    min-height: 0;
    padding: var(--reader-inset);
  }
  .document-body {
    max-width: var(--reading-width);
    margin: 0 auto;
    padding: 0.5rem 0 1.5rem;
  }
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    padding: 3rem 1.5rem;
    text-align: center;
  }
  .welcome h1 {
    font-size: 1.5rem;
    font-weight: 500;
  }
  .welcome p {
    color: var(--muted);
    margin: 0 0 1.5rem;
  }
  .welcome-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.65rem;
  }
  @media (max-width: 640px) {
    .main {
      --reader-inset: 1rem;
    }
    .panes {
      position: relative;
    }
    .files-scrim {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 1;
      background: var(--scrim);
      border: 0;
      padding: 0;
    }
  }
</style>
