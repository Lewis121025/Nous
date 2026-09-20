<script lang="ts">
  /**
   * 可编辑 Markdown 表面：ProseMirror 挂载一次，不把文档树放进 Svelte VDOM。
   */
  import { untrack } from "svelte";
  import { baseKeymap } from "prosemirror-commands";
  import { undo, redo, history } from "prosemirror-history";
  import { keymap } from "prosemirror-keymap";
  import { EditorState, TextSelection } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import "prosemirror-view/style/prosemirror.css";
  import type { MarkdownEditorApi } from "./engine/editor-api";
  import { createHtmlNodeViews } from "./engine/html-view";
  import { createImageNodeViews } from "./engine/image-view";
  import { mathInputPlugins, mathNodeViews } from "./engine/math-view";
  import { parseMarkdown, serializeMarkdown } from "./engine/markdown";
  import { browserMediaIo, resolveMediaUrl } from "./engine/media";
  import { collectOutline, type OutlineItem } from "./engine/outline";

  type Props = {
    /** 当前笔记的库内相对路径，用来解析相对图片。 */
    path: string;
    /** 打开文件时的 Markdown 文本；变化则重建视图。 */
    source: string;
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
  };

  let { path, source, onDirty, onSave, onOpenLink, onOutline, register }: Props = $props();
  let host: HTMLDivElement | undefined = $state();

  $effect(() => {
    const el = host;
    const src = source;
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
      let view: EditorView | undefined;
      const loadMd = (raw: string) => resolveMediaUrl(notePath, raw, "md", browserMediaIo);
      const loadAny = (raw: string, kind: "md" | "wiki") =>
        resolveMediaUrl(notePath, raw, kind, browserMediaIo);
      const doc = parseMarkdown(src);
      const created = new EditorView(el, {
        state: EditorState.create({
          doc,
          plugins: [
            history(),
            ...mathInputPlugins(),
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
          ...mathNodeViews,
          ...createHtmlNodeViews(loadMd),
          ...createImageNodeViews(loadAny),
        },
        handleClickOn(_view, _pos, node) {
          if (node.type.name !== "wiki_link") {
            return false;
          }
          const target = String(node.attrs["target"] ?? "");
          if (target !== "") {
            openLink("wiki", target);
          }
          return true;
        },
        handleClick(_view, _pos, event) {
          const target = event.target;
          if (!(target instanceof Element)) {
            return false;
          }
          const anchor = target.closest("a[href]");
          if (!(anchor instanceof HTMLAnchorElement)) {
            return false;
          }
          event.preventDefault();
          const href = anchor.getAttribute("href") ?? "";
          if (href === "" || isExternalHref(href)) {
            return true;
          }
          openLink("md", href);
          return true;
        },
        dispatchTransaction(tr) {
          const next = created.state.apply(tr);
          created.updateState(next);
          if (tr.docChanged) {
            dirty();
            pushOutline(collectOutline(next.doc));
          }
        },
      });
      view = created;
      pushOutline(collectOutline(created.state.doc));
      bindApi({
        serialize: () => serializeMarkdown(created.state.doc),
        jumpTo: (pos) => {
          const { doc } = created.state;
          if (pos < 0 || pos >= doc.content.size) {
            return;
          }
          const resolved = doc.resolve(Math.min(pos + 1, doc.content.size));
          created.dispatch(created.state.tr.setSelection(TextSelection.near(resolved)));
          created.focus();
          const dom = created.nodeDOM(pos);
          if (dom instanceof HTMLElement) {
            // 目录要对齐到阅读区顶部。PM 的 scrollIntoView 只保证「勉强看见」，标题会被贴在底部。
            dom.scrollIntoView({ block: "start", inline: "nearest" });
          }
        },
      });
      return () => {
        pushOutline([]);
        bindApi(null);
        view?.destroy();
        el.replaceChildren();
      };
    });
  });

  function isExternalHref(href: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(href);
  }
</script>

<div class="surface" bind:this={host}></div>

<style>
  .surface {
    min-height: 16rem;
  }

  .surface :global(.ProseMirror) {
    outline: none;
    min-height: 16rem;
    padding: 0.5rem;
  }

  .surface :global(.wiki-link) {
    text-decoration: underline;
    cursor: pointer;
  }

  .surface :global(.ProseMirror a) {
    color: inherit;
    cursor: pointer;
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
  }

  .surface :global(th),
  .surface :global(td) {
    border: 1px solid var(--border);
    padding: 0.2rem 0.5rem;
  }

  .surface :global(li[data-checked]) {
    list-style: none;
  }

  .surface :global(li[data-checked="false"])::before {
    content: "☐ ";
  }

  .surface :global(li[data-checked="true"])::before {
    content: "☑ ";
  }

  .surface :global(.math-source),
  .surface :global(.html-source) {
    display: block;
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.95em;
  }

  .surface :global(.math-error) {
    color: #b00020;
  }
</style>
