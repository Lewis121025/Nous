<script lang="ts">
  /**
   * 工作台：左侧文件栏、中间编辑器、右侧入链/目录视图宿主。
   */
  import { onMount } from "svelte";
  import BacklinksPane from "./BacklinksPane.svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import DocumentEditor from "./DocumentEditor.svelte";
  import OutlineTree from "./OutlineTree.svelte";
  import RightSidebar from "./RightSidebar.svelte";
  import Sidebar from "./Sidebar.svelte";
  import type { CodeEditorApi, MarkdownEditorApi } from "./engine/editor-api";
  import { createAutosave } from "./engine/autosave";
  import { mentionOccurrenceIndex } from "./engine/backlinks";
  import { buildOutlineTree, outlineEquals, type OutlineItem } from "./engine/outline";
  import { shouldApplyReload } from "./engine/reload";
  import { bytesForSave, commitSuccessfulWrite } from "./engine/save";
  import type { MentionRecord, Mentions, SidebarSlot, SidebarViewId } from "../../shared/api";
  import { SIDEBAR_LAYOUT } from "../../shared/api";
  import { EMPTY_MENTIONS, commitMentionsRefresh } from "./engine/mentions-refresh";

  let files = $state<string[]>([]);
  let current = $state<string | null>(null);
  let originalBytes = $state<Uint8Array | null>(null);
  let source = $state("");
  let dirty = $state(false);
  let followMentions = $state<Mentions>(EMPTY_MENTIONS);
  let mentionCache = $state<Record<string, Mentions>>({});
  let mentionGen = 0;
  let renameName = $state("");
  let message = $state("");
  let vaultRoot = $state<string | null>(null);
  let outline = $state<OutlineItem[]>([]);
  let collapsedByFile = $state<Record<string, string[]>>({});
  let filesCollapsed = $state(false);
  let leftWidth = $state(SIDEBAR_LAYOUT.leftWidth);
  let rightCollapsed = $state(false);
  let rightWidth = $state(SIDEBAR_LAYOUT.rightWidth);
  let rightSplit = $state(false);
  let rightSlots = $state<SidebarSlot[]>([{ viewId: "backlinks", pinnedPath: null }]);
  let backlinksInDocument = $state(false);
  let pendingJump = $state<MentionRecord | null>(null);
  let pendingJumpAll = $state<MentionRecord[]>([]);

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

  async function refreshMentions(): Promise<void> {
    const gen = mentionGen + 1;
    mentionGen = gen;
    const paths: string[] = [];
    if (current !== null) {
      paths.push(current);
    }
    for (const slot of rightSlots) {
      if (slot.pinnedPath !== null && !paths.includes(slot.pinnedPath)) {
        paths.push(slot.pinnedPath);
      }
    }
    const next: Record<string, Mentions> = {};
    try {
      for (const path of paths) {
        next[path] = await window.nous.indexMentionsTo(path);
      }
    } catch (err) {
      if (gen !== mentionGen) {
        return;
      }
      message = err instanceof Error ? err.message : "入链刷新失败";
      return;
    }
    const committed = commitMentionsRefresh({
      startedGen: gen,
      latestGen: mentionGen,
      current,
      fetched: next,
    });
    if (committed === null) {
      return;
    }
    mentionCache = committed.mentionCache;
    followMentions = committed.followMentions;
  }

  function mentionsFor(slot: SidebarSlot): Mentions {
    const path = slot.pinnedPath ?? current;
    if (path === null) {
      return EMPTY_MENTIONS;
    }
    return mentionCache[path] ?? EMPTY_MENTIONS;
  }

  function notePathFor(slot: SidebarSlot): string | null {
    return slot.pinnedPath ?? current;
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
        followMentions = EMPTY_MENTIONS;
        mentionCache = {};
        outline = [];
        void window.nous.sessionSetCurrent(null);
      }
      return;
    }
    await refreshMentions();
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
   * 启动时读回侧栏布局。
   */
  async function restorePanes(): Promise<void> {
    try {
      const panes = await window.nous.sessionGetPanes();
      filesCollapsed = panes.filesCollapsed;
      leftWidth = panes.leftWidth;
      rightCollapsed = panes.rightCollapsed;
      rightWidth = panes.rightWidth;
      rightSplit = panes.rightSplit;
      rightSlots = panes.rightSlots;
      backlinksInDocument = panes.backlinksInDocument;
    } catch {
      filesCollapsed = false;
      rightCollapsed = false;
    }
  }

  function persistPanes(): void {
    void window.nous.sessionSetPanes({
      filesCollapsed,
      leftWidth,
      rightCollapsed,
      rightWidth,
      rightSplit,
      rightSlots,
      backlinksInDocument,
    });
  }

  function toggleFilesPane(): void {
    filesCollapsed = !filesCollapsed;
    persistPanes();
  }

  function toggleRightPane(): void {
    rightCollapsed = !rightCollapsed;
    persistPanes();
  }

  function showOutlineView(): void {
    rightCollapsed = false;
    if (rightSplit) {
      const has = rightSlots.some((slot) => slot.viewId === "outline");
      if (!has && rightSlots[1] !== undefined) {
        rightSlots = [rightSlots[0] ?? rightSlots[1], { ...rightSlots[1], viewId: "outline" }];
      }
    } else {
      const first = rightSlots[0] ?? { viewId: "outline" as const, pinnedPath: null };
      rightSlots = [{ ...first, viewId: "outline" }];
    }
    persistPanes();
  }

  function selectSlotView(index: number, viewId: SidebarViewId): void {
    rightSlots = rightSlots.map((slot, slotIndex) =>
      slotIndex === index ? { ...slot, viewId } : slot,
    );
    persistPanes();
  }

  function toggleSplit(): void {
    if (rightSplit) {
      rightSplit = false;
      rightSlots = [rightSlots[0] ?? { viewId: "backlinks", pinnedPath: null }];
    } else {
      rightSplit = true;
      const first = rightSlots[0] ?? { viewId: "backlinks", pinnedPath: null };
      const secondView: SidebarViewId = first.viewId === "outline" ? "backlinks" : "outline";
      rightSlots = [first, { viewId: secondView, pinnedPath: null }];
    }
    persistPanes();
  }

  function togglePin(index: number): void {
    const slot = rightSlots[index];
    if (slot === undefined || slot.viewId !== "backlinks") {
      return;
    }
    const pinnedPath = slot.pinnedPath === null ? current : null;
    rightSlots = rightSlots.map((item, slotIndex) =>
      slotIndex === index ? { ...item, pinnedPath } : item,
    );
    persistPanes();
    void refreshMentions();
  }

  function toggleInDocument(): void {
    backlinksInDocument = !backlinksInDocument;
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
      followMentions = EMPTY_MENTIONS;
      mentionCache = {};
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
    await refreshMentions();
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

  /**
   * 注册/注销序列化入口。卸载时不要在这里清大纲：onOutline([]) 已经做了。
   * 若此处再写 outline = []，会和编辑器挂载抢状态。
   */
  function registerMarkdown(api: MarkdownEditorApi | null): void {
    markdownApi = api;
    if (api !== null) {
      applyPendingJump();
    }
  }

  function registerCode(api: CodeEditorApi | null): void {
    codeApi = api;
    if (api !== null) {
      applyPendingJump();
    }
  }

  function applyPendingJump(): void {
    const mention = pendingJump;
    const path = current;
    if (mention === null || path === null || mention.fromPath !== path) {
      return;
    }
    const occurrence = mentionOccurrenceIndex(pendingJumpAll, mention);
    if (isMarkdown(path)) {
      markdownApi?.jumpToMention(mention, occurrence);
    } else {
      codeApi?.jumpToByte(mention.startByte);
    }
    pendingJump = null;
    pendingJumpAll = [];
  }

  async function openMention(mention: MentionRecord, all: MentionRecord[]): Promise<void> {
    pendingJump = mention;
    pendingJumpAll = all;
    try {
      if (mention.fromPath === current) {
        applyPendingJump();
        return;
      }
      await openFile(mention.fromPath);
    } finally {
      if (current !== mention.fromPath) {
        pendingJump = null;
        pendingJumpAll = [];
      }
    }
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
        await refreshMentions();
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
      rightSlots = rightSlots.map((slot) =>
        slot.pinnedPath === current ? { ...slot, pinnedPath: to } : slot,
      );
      current = to;
      renameName = basename(to);
      const bytes = await window.nous.fileRead(to);
      originalBytes = bytes;
      source = decoder.decode(bytes);
      dirty = false;
      await window.nous.sessionSetCurrent(to);
      persistPanes();
      await refreshList();
      await refreshMentions();
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
    <button type="button" aria-pressed={!rightCollapsed} onclick={toggleRightPane}>入链</button>
    <button type="button" aria-pressed={canOutline && !rightCollapsed} onclick={showOutlineView}
      >目录</button
    >
    <button type="button" aria-pressed={backlinksInDocument} onclick={toggleInDocument}
      >文档内入链</button
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
      <Sidebar
        side="left"
        width={leftWidth}
        onWidth={(width) => {
          leftWidth = width;
          persistPanes();
        }}
      >
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
      </Sidebar>
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

        {#if backlinksInDocument}
          <div class="in-doc">
            <BacklinksPane
              notePath={current}
              mentions={followMentions}
              pinned={false}
              embedded
              onTogglePin={() => {}}
              onOpen={(mention) =>
                void openMention(mention, [...followMentions.linked, ...followMentions.unlinked])}
            />
          </div>
        {/if}

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

    {#if !rightCollapsed}
      <Sidebar
        side="right"
        width={rightWidth}
        onWidth={(width) => {
          rightWidth = width;
          persistPanes();
        }}
      >
        <RightSidebar
          split={rightSplit}
          slots={rightSlots}
          onSelect={selectSlotView}
          onToggleSplit={toggleSplit}
        >
          {#snippet children(index: number, slot: SidebarSlot)}
            {#if slot.viewId === "backlinks"}
              <BacklinksPane
                notePath={notePathFor(slot)}
                mentions={mentionsFor(slot)}
                pinned={slot.pinnedPath !== null}
                onTogglePin={() => togglePin(index)}
                onOpen={(mention) =>
                  void openMention(mention, [
                    ...mentionsFor(slot).linked,
                    ...mentionsFor(slot).unlinked,
                  ])}
              />
            {:else if canOutline}
              <div class="outline-slot">
                <div class="pane-head">目录</div>
                <nav class="outline" aria-label="文档目录">
                  <OutlineTree
                    nodes={outlineTree}
                    collapsed={collapsedKeys}
                    onToggle={toggleOutline}
                    onJump={jumpOutline}
                  />
                </nav>
              </div>
            {:else}
              <p class="empty-outline">打开 Markdown 以查看目录。</p>
            {/if}
          {/snippet}
        </RightSidebar>
      </Sidebar>
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

  .panes {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }

  .list {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    height: 100%;
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
    flex: 1 1 auto;
    overflow: auto;
    min-width: 0;
    min-height: 0;
    padding: 0.75rem;
  }

  .in-doc {
    margin-top: 1rem;
    border-top: 1px solid var(--border);
    min-height: 12rem;
  }

  .outline-slot {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .outline {
    overflow: auto;
    flex: 1 1 auto;
    min-height: 0;
    padding: 0.35rem 0.45rem;
  }

  .empty-outline {
    margin: 0.6rem;
    opacity: 0.7;
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
