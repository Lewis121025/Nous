/**
 * 源码模式的 `[[` 链接补全：与排版编辑器共用同一候选排序（candidates.ts）。
 *
 * 文件目标同步产出；标题锚点（`[[note#`）需要跨进程解析目标文件，
 * 由注入的 `headings` 加载器异步提供，未注入时 `#` 之后不弹候选。
 * 选中候选后自动补 `]]`（光标后已有闭合时不重复）。
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { rankFileCandidates, rankHeadingCandidates } from "./candidates";

/** 候选的插入行为：替换查询区间，光标后没有 `]]` 时补上闭合。 */
function applyWithClosing(value: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    const after = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length));
    const insert = after === "]]" ? value : `${value}]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
  };
}

/**
 * 创建 Markdown 源码的 wiki 链接补全扩展。
 *
 * @param files 实时读取的库内文件列表；每次触发时过滤 `.md`。
 * @param headings 解析目标并返回其标题文本；失败或无标题时返回空列表。
 */
export function markdownLinkCompletion(
  files: () => readonly string[],
  headings?: (target: string) => Promise<string[]>,
): Extension {
  return autocompletion({
    activateOnTyping: true,
    override: [
      async (context: CompletionContext): Promise<CompletionResult | null> => {
        const line = context.state.doc.lineAt(context.pos);
        const before = line.text.slice(0, context.pos - line.from);
        const trigger = before.lastIndexOf("[[");
        if (trigger < 0) return null;
        const query = before.slice(trigger + 2);
        // 已闭合与别名段不补全；转义的 \[[ 是字面文本。
        if (query.includes("]]") || query.includes("|")) return null;
        let backslashes = 0;
        for (let index = trigger - 1; index >= 0 && before[index] === "\\"; index -= 1)
          backslashes += 1;
        if (backslashes % 2 === 1) return null;
        const from = line.from + trigger + 2;
        const hash = query.lastIndexOf("#");
        if (hash >= 0) {
          const target = query.slice(0, hash);
          if (headings === undefined || target.trim() === "") return null;
          let texts: string[] = [];
          try {
            texts = await headings(target);
          } catch {
            // 加载器约定失败返回空列表；双重防护，避免未处理的拒绝。
          }
          const options = rankHeadingCandidates(query.slice(hash + 1), texts).map(
            (item): Completion => ({
              label: item.label,
              detail: item.detail,
              type: "heading",
              apply: applyWithClosing(item.value),
            }),
          );
          return options.length === 0 ? null : { from: from + hash + 1, options, filter: false };
        }
        const options = rankFileCandidates(
          query,
          files().filter((path) => path.toLowerCase().endsWith(".md")),
        ).map((item): Completion => ({
          label: item.label,
          detail: item.detail,
          type: "file",
          apply: applyWithClosing(item.value),
        }));
        return options.length === 0 ? null : { from, options, filter: false };
      },
    ],
  });
}
