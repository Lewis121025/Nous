<script lang="ts">
  /**
   * 可编辑代码表面：CodeMirror 6 挂载一次，文本即文件。
   */
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import {
    bracketMatching,
    defaultHighlightStyle,
    indentOnInput,
    syntaxHighlighting,
  } from "@codemirror/language";
  import { EditorState, Compartment } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import type { CodeEditorApi } from "./engine/editor-api";
  import { languageExtensions } from "./engine/language";

  type Props = {
    /** 打开时的文本。 */
    source: string;
    /** 用于选择高亮语言的库内路径。 */
    path: string;
    /** 缓冲被改动时调用。 */
    onDirty: () => void;
    /** 保存快捷键。 */
    onSave: () => void;
    /** 注册/注销取文本入口。 */
    register: (api: CodeEditorApi | null) => void;
  };

  let { source, path, onDirty, onSave, register }: Props = $props();
  let host: HTMLDivElement | undefined = $state();

  $effect(() => {
    const el = host;
    if (el === undefined) {
      return;
    }
    const currentPath = path;
    const currentSource = source;
    let cancelled = false;
    const langConf = new Compartment();
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: currentSource,
        extensions: [
          history(),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSave();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          lineNumbers(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onDirty();
            }
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "var(--bg)",
              color: "var(--fg)",
            },
            ".cm-content": {
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            },
          }),
          langConf.of([]),
        ],
      }),
    });
    register({
      getText: () => view.state.doc.toString(),
    });
    void languageExtensions(currentPath).then((lang) => {
      if (cancelled) {
        return;
      }
      view.dispatch({ effects: langConf.reconfigure(lang) });
    });
    return () => {
      cancelled = true;
      register(null);
      view.destroy();
    };
  });
</script>

<div class="surface" bind:this={host}></div>

<style>
  .surface {
    min-height: 16rem;
  }
</style>
