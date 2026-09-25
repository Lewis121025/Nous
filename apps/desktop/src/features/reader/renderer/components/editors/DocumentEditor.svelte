<script lang="ts">
  /**
   * 可编辑 Markdown 表面：ProseMirror 挂载一次，不把文档树放进 Svelte VDOM。
   */
  import { untrack } from "svelte";
  import { baseKeymap } from "prosemirror-commands";
  import { undo, redo, history, undoDepth, redoDepth } from "prosemirror-history";
  import { keymap } from "prosemirror-keymap";
  import { EditorState, TextSelection } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import { search } from "prosemirror-search";
  import "prosemirror-view/style/prosemirror.css";
  import type { MarkdownEditorApi } from "../../engine/editing/editor-api";
  import { createHtmlNodeViews } from "../../engine/rendering/html-view";
  import { createImageNodeViews } from "../../engine/rendering/image-view";
  import { createPdfNodeViews } from "../../engine/rendering/pdf-view";
  import { mathInputPlugins, mathNodeViews } from "../../engine/rendering/math-view";
  import { createMarkdownSession } from "../../engine/markdown/source-session";
  import { findMentionPmPos } from "../../engine/navigation/mention-jump";
  import { type MediaIo, resolveMediaUrl } from "../../engine/media/media";
  import { collectOutline, type OutlineItem } from "../../engine/navigation/outline";
  import { writingPlugins } from "../../engine/editing/writing";
  import { taskItemView } from "../../engine/rendering/task-view";
  import { createSourceEditingPlugin } from "../../engine/editing/source-editing";
  import { linkInteraction } from "../../engine/editing/link-interaction";
  import { createLinkSelectionPlugin } from "../../engine/editing/link-editing";
  import {
    captureMarkdownReload,
    prepareMarkdownReload,
    type MarkdownReloadContext,
  } from "../../engine/editing/markdown-reload";
  import { applyMarkdownHistory, nativeInputOwnsHistory } from "../../engine/editing/history";
  import EditorFormatting from "./EditorFormatting.svelte";
  import SelectionFormatting from "./SelectionFormatting.svelte";
  import EditorLink from "./EditorLink.svelte";
  import EditorSearch from "./EditorSearch.svelte";
  import EditorAttachments from "./EditorAttachments.svelte";
  import {
    createAttachmentEditing,
    type AttachmentProgress,
  } from "../../engine/editing/attachments";
  import type { AttachmentImporter } from "../../../shared/attachments";

  type Props = {
    /** 阅读器注入的资源访问能力，编辑器不依赖宿主应用。 */
    mediaIo: MediaIo;
    /** 已捕获文档身份的附件字节导入能力。 */
    importAttachment: AttachmentImporter;
    /** 导入后警告跨文档显示，告知已经落盘但尚未插入的附件位置。 */
    onAttachmentReport: (message: string) => void;
    /** 附件事务结束后重新检查等待中的外部版本，不改变文档内容。 */
    onAttachmentSettled?: () => void;
    /** 当前笔记的库内相对路径，用来解析相对图片。 */
    path: string;
    /** 打开文件时的 Markdown 文本；变化则重建视图。 */
    source: string;
    /** 无法映射为源码时保存的初始恢复内容；实时内容仍只属于当前编辑会话。 */
    recovery?: string | undefined;
    /** 文档被用户改动时调用。 */
    onDirty: () => void;
    /** 保存快捷键。 */
    onSave: () => void;
    /**
     * 点击内部链接。
     *
     * @param kind wiki 或 Markdown 链接。
     * @param raw 目标原文（wiki 名为 target，md 为 href）。
     */
    onOpenLink: (kind: "wiki" | "md", raw: string) => void;
    /** 文档大纲变化时调用；卸载时传空数组。 */
    onOutline: (items: OutlineItem[]) => void;
    /** 注册/注销序列化入口。 */
    register: (api: MarkdownEditorApi | null) => void;
    /** 库内链接候选；仅用于交互，不参与文档挂载依赖。 */
    linkTargets?: string[];
  };

  let {
    mediaIo,
    importAttachment,
    onAttachmentReport,
    onAttachmentSettled,
    path,
    source,
    recovery,
    onDirty,
    onSave,
    onOpenLink,
    onOutline,
    register,
    linkTargets = [],
  }: Props = $props();
  let host: HTMLDivElement | undefined = $state();
  let editor = $state.raw<EditorView | null>(null);
  let editorState = $state.raw<EditorState | null>(null);
  let showLink = $state(false);
  let showSearch = $state(false);
  let formattingOpen = $state(false);
  let searchPanel: EditorSearch | undefined = $state();
  let formattingPanel: EditorFormatting | undefined = $state();
  let attachmentPanel: EditorAttachments | undefined = $state();
  let attachments = $state.raw<ReturnType<typeof createAttachmentEditing> | null>(null);
  let attachmentProgress = $state<AttachmentProgress>(null);
  let previous: MarkdownReloadContext | null = null;

  function openAttachments(): void {
    formattingPanel?.dismiss();
    attachmentPanel?.pick();
  }

  function openSearch(): void {
    formattingPanel?.dismiss();
    showSearch = true;
    searchPanel?.focusQuery();
  }

  $effect(() => {
    const el = host;
    const src = source;
    const recovered = recovery;
    const notePath = path;
    if (el === undefined) {
      return;
    }
    // 先记下 host/path/source。后面创建视图并调用 onOutline：
    // 回调会读/写外壳的 outline，算进依赖就会「写大纲 → 重跑 effect → 清空 → 再挂载」死循环。
    return untrack(() => {
      const save = onSave;
      const dirty = onDirty;
      const openLink = onOpenLink;
      const pushOutline = onOutline;
      const bindApi = register;
      const loadMd = (raw: string) => resolveMediaUrl(notePath, raw, "md", mediaIo);
      const loadAny = (raw: string, kind: "md" | "wiki") =>
        resolveMediaUrl(notePath, raw, kind, mediaIo);
      const session = createMarkdownSession(src, recovered);
      const doc = session.doc;
      const reload = previous === null ? null : prepareMarkdownReload(previous, doc);
      previous = null;
      const attachmentEditing = createAttachmentEditing({
        // 同路径的会话版本可能因文件操作更新；发起导入时使用当前身份，销毁仍取消迟到请求。
        import: (name, bytes) => importAttachment(name, bytes),
        progress: (progress) => {
          attachmentProgress = progress;
        },
        report: onAttachmentReport,
        settled: () => onAttachmentSettled?.(),
      });
      attachments = attachmentEditing;
      const created = new EditorView(el, {
        state: EditorState.create({
          doc,
          ...(reload === null ? {} : { selection: reload.selection }),
          plugins: [
            history(),
            attachmentEditing.plugin,
            search(),
            createSourceEditingPlugin(reload?.sourceEditing),
            createLinkSelectionPlugin(reload?.bookmark),
            linkInteraction(openLink),
            ...mathInputPlugins(),
            ...writingPlugins({
              link: () => {
                showLink = true;
              },
              search: openSearch,
            }),
            keymap({
              "Mod-s": () => {
                save();
                return true;
              },
              "Mod-z": undo,
              "Mod-y": redo,
              "Mod-Shift-z": redo,
            }),
            keymap(baseKeymap),
          ],
        }),
        nodeViews: {
          list_item: taskItemView,
          ...mathNodeViews,
          ...createHtmlNodeViews(loadMd),
          ...createImageNodeViews(loadAny),
          ...createPdfNodeViews(notePath, openLink, mediaIo),
        },
        dispatchTransaction(tr) {
          const { state: next, transactions } = created.state.applyTransaction(tr);
          for (const transaction of transactions) session.track(transaction);
          created.updateState(next);
          editorState = next;
          if (transactions.some((transaction) => transaction.docChanged)) {
            dirty();
            pushOutline(collectOutline(next.doc));
          }
        },
      });
      const stopRestoring = reload?.restore(created);
      editor = created;
      editorState = created.state;
      pushOutline(collectOutline(created.state.doc));
      bindApi({
        history: (action) => applyMarkdownHistory(created, action),
        historyAvailability: () => {
          if (nativeInputOwnsHistory(created.dom)) return null;
          const state = editorState;
          return {
            undo: state !== null && undoDepth(state) > 0,
            redo: state !== null && redoDepth(state) > 0,
          };
        },
        focus: () => created.focus(),
        openSearch,
        openAttachments,
        settleAttachments: attachmentEditing.settle,
        snapshot: () => session.snapshot(created.state.doc),
        jumpTo: (pos) => {
          jumpEditor(created, pos, "start");
        },
        jumpToMention: (mention, occurrence) => {
          const pos = findMentionPmPos(created.state.doc, mention, occurrence);
          if (pos === null) {
            return;
          }
          jumpEditor(created, pos, "center");
        },
      });
      return () => {
        stopRestoring?.();
        previous = captureMarkdownReload(created);
        pushOutline([]);
        bindApi(null);
        editor = null;
        editorState = null;
        attachments = null;
        attachmentProgress = null;
        created.destroy();
        el.replaceChildren();
      };
    });
  });

  function jumpEditor(view: EditorView, pos: number, block: ScrollLogicalPosition): void {
    const { doc } = view.state;
    if (pos < 0 || pos >= doc.content.size) {
      return;
    }
    const resolved = doc.resolve(Math.min(pos + 1, doc.content.size));
    view.dispatch(view.state.tr.setSelection(TextSelection.near(resolved)).scrollIntoView());
    view.focus();
    const nodeDom = view.nodeDOM(pos);
    if (nodeDom instanceof HTMLElement) {
      // 目录要对齐到阅读区顶部。PM 的 scrollIntoView 只保证「勉强看见」，标题会被贴在底部。
      // 入链命中落在段落里，居中更容易看见。
      nodeDom.scrollIntoView({ block, inline: "nearest" });
      return;
    }
    const scroller = view.dom.closest(".main");
    if (!(scroller instanceof HTMLElement)) {
      return;
    }
    // jsdom 的 Text 没有 getClientRects；真实窗口里极少数位置也会让 coordsAtPos 扔。
    // 上面事务已经 scrollIntoView，这里只是尽量居中。
    let coords: { top: number; bottom: number };
    try {
      coords = view.coordsAtPos(pos);
    } catch {
      return;
    }
    const rect = scroller.getBoundingClientRect();
    if (block === "start") {
      scroller.scrollTop += coords.top - rect.top;
      return;
    }
    const mid = (coords.top + coords.bottom) / 2;
    scroller.scrollTop += mid - (rect.top + rect.height / 2);
  }
</script>

{#if editor !== null && editorState !== null}
  <EditorFormatting
    bind:this={formattingPanel}
    view={editor}
    state={editorState}
    onLink={() => (showLink = true)}
    onAttachment={openAttachments}
    onOpenChange={(open) => (formattingOpen = open)}
  />
  {#if attachments}<EditorAttachments
      bind:this={attachmentPanel}
      view={editor}
      editing={attachments}
      progress={attachmentProgress}
    />{/if}
  <SelectionFormatting
    view={editor}
    state={editorState}
    blocked={showSearch || showLink || formattingOpen}
    onLink={() => (showLink = true)}
  />
  {#if showSearch}<EditorSearch
      bind:this={searchPanel}
      view={editor}
      state={editorState}
      onClose={() => (showSearch = false)}
    />{/if}
  {#if showLink}<EditorLink
      view={editor}
      targets={linkTargets}
      onClose={() => (showLink = false)}
    />{/if}
{/if}
<div class="surface" bind:this={host}></div>

<style>
  .surface {
    min-height: 16rem;
  }

  .surface :global(.ProseMirror) {
    outline: none;
    min-height: 16rem;
    padding: 0.5rem;
    font-size: var(--font-reading);
    line-height: var(--line-reading);
  }

  .surface :global(.ProseMirror :is(h1, h2, h3, h4, h5, h6)) {
    line-height: 1.35;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 1.8em 0 0.65em;
  }

  .surface :global(.ProseMirror h1) {
    font-size: 30px;
  }
  .surface :global(.ProseMirror h2) {
    font-size: 24px;
  }
  .surface :global(.ProseMirror h3) {
    font-size: 20px;
  }
  .surface :global(.ProseMirror :is(h4, h5, h6)) {
    font-size: 17px;
  }
  .surface :global(.ProseMirror > :first-child) {
    margin-top: 0.5rem;
  }
  .surface :global(.ProseMirror p) {
    margin: 0.85em 0;
  }
  .surface :global(.ProseMirror :is(ul, ol)) {
    padding-left: 1.6em;
    margin: 1em 0;
  }
  .surface :global(.ProseMirror li + li) {
    margin-top: 0.3em;
  }
  .surface :global(.ProseMirror :is(ul, ol) :is(ul, ol)) {
    margin: 0.3em 0;
  }

  .surface :global(.ProseMirror blockquote) {
    margin: 1.2em 0;
    padding-left: 1rem;
    border-left: 2px solid var(--border);
    color: var(--muted);
  }

  .surface :global(.ProseMirror code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--sidebar);
    border-radius: 0.25rem;
    padding: 0.1em 0.3em;
  }

  .surface :global(.ProseMirror pre) {
    padding: 1rem;
    background: var(--sidebar);
    border-radius: 0.6rem;
    line-height: 1.6;
    overflow-x: auto;
  }

  .surface :global(.ProseMirror pre code) {
    padding: 0;
    background: transparent;
  }

  .surface :global(.wiki-link) {
    text-decoration: underline;
    cursor: text;
  }

  .surface :global(.ProseMirror a) {
    color: inherit;
    cursor: text;
  }

  .surface :global(.math-inline) {
    display: inline-block;
    vertical-align: middle;
    cursor: text;
  }

  .surface :global(.math-block) {
    display: block;
    margin: 0.5rem 0;
    overflow-x: auto;
    cursor: text;
  }

  .surface :global(.html-inline) {
    display: inline;
    cursor: text;
  }

  .surface :global(.html-block) {
    display: block;
    margin: 0.5rem 0;
    cursor: text;
  }

  .surface :global(.note-image) {
    max-width: 100%;
    height: auto;
    vertical-align: middle;
  }

  .surface :global(table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
    max-width: 100%;
    margin: 1.25em 0;
  }

  .surface :global(th),
  .surface :global(td) {
    border: 1px solid var(--border);
    padding: 0.45rem 0.75rem;
    min-width: 7em;
    max-width: 24em;
    vertical-align: top;
  }

  .surface :global(li[data-checked]) {
    list-style: none;
    position: relative;
  }
  .surface :global(.task-checkbox) {
    position: absolute;
    right: calc(100% + 0.15rem);
    top: -1px;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 0.25em;
    padding: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .surface :global(.task-checkbox::before) {
    content: "";
    position: absolute;
    inset: 7px;
    border: 1.5px solid var(--muted);
    border-radius: 4px;
  }
  .surface :global(.task-checkbox[aria-checked="true"]::before) {
    background: var(--accent-fill);
    border-color: var(--accent-fill);
  }
  .surface :global(.task-checkbox[aria-checked="true"]::after) {
    content: "";
    position: absolute;
    left: 13px;
    top: 10px;
    width: 4px;
    height: 8px;
    border: solid var(--accent-text);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }
  .surface :global(.list-item-content > p:first-child) {
    margin-top: 0;
  }
  .surface :global(.ProseMirror-search-match) {
    background: light-dark(#fff0a8, #625018);
  }
  .surface :global(.ProseMirror-active-search-match) {
    outline: 2px solid var(--accent);
  }

  .surface :global(.math-source),
  .surface :global(.html-source) {
    display: block;
    max-width: 100%;
    padding: 0.4rem 0.6rem;
    color: var(--fg);
    background: var(--sidebar);
    border: 1px solid var(--accent);
    border-radius: 0.4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    line-height: 1.5;
    outline: none;
  }

  .surface :global(textarea.math-source),
  .surface :global(textarea.html-source) {
    width: 100%;
    resize: vertical;
  }

  .surface :global(.ProseMirror-selectednode) {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: 0.2rem;
  }

  .surface :global(.source-editing) {
    outline: none;
  }

  .surface :global(.source-editing:is(.math-inline, .html-inline)) {
    display: inline-block;
    max-width: 100%;
    vertical-align: middle;
  }

  .surface :global(.math-error) {
    color: #b00020;
  }
</style>
