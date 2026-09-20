/**
 * 公式 NodeView 与最小输入：视口内才排版；点进去改 TeX，失焦才排这一条。
 */
import { inputRules, InputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PmNode } from "prosemirror-model";
import type { Command, EditorState, Plugin, Transaction } from "prosemirror-state";
import type { EditorView, NodeView, NodeViewConstructor } from "prosemirror-view";
import { peekRenderedTex, renderTex } from "./mathjax";
import { documentSchema } from "./schema";
import { mathPlaceholderText, observeViewport } from "./viewport";

/**
 * 预览 / 源码两态。排版只改 this.dom，不 dispatch；只有用户改了 tex 才写回 attr。
 */
class MathNodeView implements NodeView {
  readonly dom: HTMLElement;
  private tex: string;
  private readonly display: boolean;
  private editing = false;
  private visible = false;
  private renderGen = 0;
  private sourceEl: HTMLTextAreaElement | HTMLInputElement | null = null;
  private readonly stopObserve: () => void;

  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.display = node.type.name === "math_block";
    this.tex = String(node.attrs["tex"] ?? "");
    this.dom = document.createElement(this.display ? "div" : "span");
    this.dom.className = this.display ? "math-block" : "math-inline";
    this.dom.dataset.mathTex = this.tex;
    this.dom.dataset.mathDisplay = this.display ? "true" : "false";
    this.dom.contentEditable = "false";
    this.showPlaceholder();
    this.stopObserve = observeViewport(this.dom, (visible) => {
      this.visible = visible;
      if (this.editing) {
        return;
      }
      if (visible) {
        this.showPreview();
      } else {
        this.showPlaceholder();
      }
    });
  }

  selectNode(): void {
    this.enterEdit();
  }

  deselectNode(): void {
    this.commitEdit();
  }

  update(node: PmNode): boolean {
    const expected = this.display ? "math_block" : "math_inline";
    if (node.type.name !== expected) {
      return false;
    }
    const next = String(node.attrs["tex"] ?? "");
    if (next === this.tex) {
      return true;
    }
    this.tex = next;
    this.dom.dataset.mathTex = next;
    if (!this.editing) {
      if (this.visible) {
        this.showPreview();
      } else {
        this.showPlaceholder();
      }
    }
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(): boolean {
    return this.editing;
  }

  destroy(): void {
    this.renderGen += 1;
    this.stopObserve();
  }

  private enterEdit(): void {
    if (this.editing) {
      return;
    }
    this.editing = true;
    this.renderGen += 1;
    const field = this.display
      ? document.createElement("textarea")
      : document.createElement("input");
    field.className = "math-source";
    field.value = this.tex;
    this.sourceEl = field;
    this.dom.replaceChildren(field);
    queueMicrotask(() => {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  private commitEdit(): void {
    if (!this.editing) {
      return;
    }
    const next = this.sourceEl?.value ?? this.tex;
    this.editing = false;
    this.sourceEl = null;
    if (next !== this.tex) {
      const pos = this.getPos();
      if (typeof pos === "number") {
        const tr = this.view.state.tr.setNodeMarkup(pos, null, { tex: next });
        this.view.dispatch(tr);
        return;
      }
      this.tex = next;
    }
    if (this.visible) {
      this.showPreview();
    } else {
      this.showPlaceholder();
    }
  }

  private showPlaceholder(): void {
    this.renderGen += 1;
    this.dom.textContent = mathPlaceholderText(this.tex, this.display);
  }

  private showPreview(): void {
    const gen = ++this.renderGen;
    const cached = peekRenderedTex(this.tex, this.display);
    if (cached !== null) {
      this.dom.replaceChildren(cached);
      return;
    }
    this.dom.textContent = mathPlaceholderText(this.tex, this.display);
    void renderTex(this.tex, this.display, this.view.dom).then((node) => {
      if (gen !== this.renderGen || this.editing || !this.visible) {
        return;
      }
      this.dom.replaceChildren(node);
    });
  }
}

/** 行内/块级共用同一套预览与失焦提交，避免两套 NodeView。 */
export const mathNodeViews: Record<string, NodeViewConstructor> = {
  math_inline: (node, view, getPos) => new MathNodeView(node, view, getPos),
  math_block: (node, view, getPos) => new MathNodeView(node, view, getPos),
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
