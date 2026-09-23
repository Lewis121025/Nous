/**
 * 公式 NodeView 与最小输入：打开时排版，滚动不再卸预览。
 * 点进去改 TeX，失焦才排这一条。
 */
import { inputRules, InputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PmNode } from "prosemirror-model";
import type { Command, EditorState, Plugin, Transaction } from "prosemirror-state";
import type { EditorView, NodeViewConstructor } from "prosemirror-view";
import { peekRenderedTex, renderTex } from "./mathjax";
import { documentSchema } from "./schema";
import { SourceNodeView } from "./source-node-view";
import { mathPlaceholderText } from "./viewport";

function createMathNodeView(
  node: PmNode,
  view: EditorView,
  getPos: () => number | undefined,
): SourceNodeView {
  return new SourceNodeView(node, view, getPos, {
    kind: "math",
    render(dom, tex, display, signal) {
      const cached = peekRenderedTex(tex, display);
      if (cached !== null) {
        dom.replaceChildren(cached);
        return;
      }
      dom.textContent = mathPlaceholderText(tex, display);
      void renderTex(tex, display, view.dom).then((rendered) => {
        if (!signal.aborted) dom.replaceChildren(rendered);
      });
    },
  });
}

/** 行内与块级公式共用源码编辑生命周期，预览只负责 MathJax 排版。 */
export const mathNodeViews: Record<string, NodeViewConstructor> = {
  math_inline: createMathNodeView,
  math_block: createMathNodeView,
};

function insertInlineMath(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
): Transaction | null {
  const tex = match[1];
  if (tex === undefined || tex === "") {
    return null;
  }
  const node = documentSchema.node("math_inline", { tex });
  return state.tr.replaceWith(start, end, node);
}

const insertMathBlock: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== "paragraph") {
    return false;
  }
  if ($from.parent.textContent !== "$$") {
    return false;
  }
  if (dispatch) {
    const node = documentSchema.node("math_block", { tex: "" });
    dispatch(state.tr.replaceWith($from.before(), $from.after(), node));
  }
  return true;
};

/**
 * 最小输入：行内收尾 `$`；空段落 `$$` 再 Enter 出块级。
 *
 * @returns 应插在 baseKeymap 之前的插件。
 */
export function mathInputPlugins(): Plugin[] {
  return [
    inputRules({
      rules: [new InputRule(/\$([^$\n]+)\$$/, insertInlineMath)],
    }),
    keymap({ Enter: insertMathBlock }),
  ];
}
