<script lang="ts">
  /**
   * 可编辑 Markdown 表面：ProseMirror 挂载一次，不把文档树放进 Svelte VDOM。
   */
  import { baseKeymap } from "prosemirror-commands";
  import { undo, redo, history } from "prosemirror-history";
  import { keymap } from "prosemirror-keymap";
  import { EditorState } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import "prosemirror-view/style/prosemirror.css";
  import type { MarkdownEditorApi } from "./engine/editor-api";
  import { parseMarkdown, serializeMarkdown } from "./engine/markdown";

  type Props = {
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
    /** 注册/注销序列化入口。 */
    register: (api: MarkdownEditorApi | null) => void;
  };

  let { source, onDirty, onSave, onOpenLink, register }: Props = $props();
  let host: HTMLDivElement | undefined = $state();

  $effect(() => {
    const el = host;
    if (el === undefined) {
      return;
    }
    const doc = parseMarkdown(source);
    let view: EditorView;
    view = new EditorView(el, {
      state: EditorState.create({
        doc,
        plugins: [
          history(),
          keymap({
            "Mod-s": () => {
              onSave();
              return true;
            },
            "Mod-z": undo,
            "Mod-y": redo,
            "Mod-Shift-z": redo,
          }),
          keymap(baseKeymap),
        ],
      }),
      handleClickOn(_view, _pos, node) {
        if (node.type.name !== "wiki_link") {
          return false;
        }
        const target = String(node.attrs["target"] ?? "");
        if (target !== "") {
          onOpenLink("wiki", target);
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
        onOpenLink("md", href);
        return true;
      },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) {
          onDirty();
        }
      },
    });
    register({
      serialize: () => serializeMarkdown(view.state.doc),
    });
    return () => {
      register(null);
      view.destroy();
    };
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
</style>
