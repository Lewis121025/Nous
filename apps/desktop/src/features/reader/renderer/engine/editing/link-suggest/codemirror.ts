/**
 * 源码模式的 `[[` 链接补全：与排版编辑器共用同一候选排序（candidates.ts）。
 *
 * 范围说明：只补全文件目标。标题锚点（`[[note#`）依赖跨进程解析目标文件，
 * 源码模式按字面文本编辑语法，v1 不提供锚点候选；`#` 之后不再弹出。
 * 选中候选后自动补 `]]`（光标后已有闭合时不重复）。
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { rankFileCandidates } from "./candidates";

/**
 * 创建 Markdown 源码的 wiki 链接补全扩展。
 *
 * @param files 实时读取的库内文件列表；每次触发时过滤 `.md`。
 */
export function markdownLinkCompletion(files: () => readonly string[]): Extension {
  return autocompletion({
    activateOnTyping: true,
    override: [
      (context: CompletionContext): CompletionResult | null => {
        const line = context.state.doc.lineAt(context.pos);
        const before = line.text.slice(0, context.pos - line.from);
        const trigger = before.lastIndexOf("[[");
        if (trigger < 0) return null;
        const query = before.slice(trigger + 2);
        // 已闭合、别名段与锚点段不补全；转义的 \[[ 是字面文本。
        if (query.includes("]]") || query.includes("|") || query.includes("#")) return null;
        const escaped = before.slice(0, trigger).split("").reverse();
        let backslashes = 0;
        for (const ch of escaped) {
          if (ch !== "\\") break;
          backslashes += 1;
        }
        if (backslashes % 2 === 1) return null;
        const options = rankFileCandidates(
          query,
          files().filter((path) => path.toLowerCase().endsWith(".md")),
        ).map((item): Completion => ({
          label: item.label,
          detail: item.detail,
          type: "file",
          apply: (view, _completion, from, to) => {
            const after = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length));
            const insert = after === "]]" ? item.value : `${item.value}]]`;
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length },
            });
          },
        }));
        if (options.length === 0) return null;
        return { from: line.from + trigger + 2, options, filter: false };
      },
    ],
  });
}
