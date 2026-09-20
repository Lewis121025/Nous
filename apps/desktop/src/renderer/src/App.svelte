<script lang="ts">
  /**
   * 极简外壳：打开库、扁平列表、当前一篇、入链、改名。
   */
  import { onMount } from "svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import DocumentEditor from "./DocumentEditor.svelte";
  import type { CodeEditorApi, MarkdownEditorApi } from "./engine/editor-api";
  import { bytesForSave } from "./engine/save";
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

  let markdownApi: MarkdownEditorApi | null = null;
  let codeApi: CodeEditorApi | null = null;

  const decoder = new TextDecoder();

  onMount(() => {
    return window.nous.subscribeVaultChanged(() => {
      void onVaultChanged();
    });
  });

  /**
   * 是否走文档表面。
   *
   * @param path 库内相对路径。
   */
  function isMarkdown(path: string): boolean {
    return path.toLowerCase().endsWith(".md");
  }

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
    try {
      await refreshList();
    } catch {
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
      }
      return;
    }
    await refreshLinks(current);
    if (dirty) {
      return;
    }
    const bytes = await window.nous.fileRead(current);
    originalBytes = bytes;
    source = decoder.decode(bytes);
  }

  async function openVault(): Promise<void> {
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
    await refreshList();
  }

  async function openFile(path: string): Promise<void> {
    if (path === current) {
      return;
    }
    if (dirty) {
      message = "请先保存再打开其他文件";
      return;
    }
    const bytes = await window.nous.fileRead(path);
    originalBytes = bytes;
    source = decoder.decode(bytes);
    current = path;
    dirty = false;
    renameName = basename(path);
    message = "";
    await refreshLinks(path);
  }

  function markDirty(): void {
    dirty = true;
  }

  function requestSave(): void {
    void save();
  }

  function requestOpenLink(kind: "wiki" | "md", raw: string): void {
    void openLink(kind, raw);
  }

  function registerMarkdown(api: MarkdownEditorApi | null): void {
    markdownApi = api;
  }

  function registerCode(api: CodeEditorApi | null): void {
    codeApi = api;
  }

  async function save(): Promise<void> {
    const path = current;
    const original = originalBytes;
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
      originalBytes = bytes;
      dirty = false;
      message = "";
      await refreshLinks(path);
    } catch (err) {
      message = err instanceof Error ? err.message : "保存失败";
    }
  }

  async function openLink(kind: "wiki" | "md", raw: string): Promise<void> {
    if (current === null) {
      return;
    }
    if (dirty) {
      message = "请先保存再跳转";
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
    if (dirty) {
      message = "有未保存修改，拒绝改名";
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
      await refreshList();
      await refreshLinks(to);
      message = "";
    } catch (err) {
      message = err instanceof Error ? err.message : "改名失败";
    }
  }
</script>

<div class="layout">
  <header class="toolbar">
    <button type="button" onclick={() => void openVault()}>打开库</button>
    <button type="button" onclick={() => void save()} disabled={current === null}>保存</button>
    {#if vaultRoot !== null}
      <span class="root" title={vaultRoot}>{vaultRoot}</span>
    {/if}
    {#if message !== ""}
      <span class="message">{message}</span>
    {/if}
  </header>

  <nav class="list" aria-label="文件列表">
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
  </nav>

  <section class="main">
    {#if current !== null}
      {#if isMarkdown(current)}
        <DocumentEditor
          {source}
          onDirty={markDirty}
          onSave={requestSave}
          onOpenLink={requestOpenLink}
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
        {#each backlinks as link (`${link.fromPath}:${link.startByte}`)}
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
        {#each deadOutbound as link (`dead:${link.toRaw}:${link.startByte}`)}
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
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 16rem 1fr;
    grid-template-rows: auto 1fr;
    height: 100%;
  }

  .toolbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .root {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message {
    margin-left: auto;
  }

  .list {
    overflow: auto;
    border-right: 1px solid var(--border);
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
    overflow: auto;
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
