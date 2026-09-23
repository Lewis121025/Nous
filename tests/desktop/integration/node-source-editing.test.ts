/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, NodeSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { createHtmlNodeViews } from "@engine/html-view";
import { mathNodeViews } from "@engine/math-view";
import { parseMarkdown, serializeMarkdown } from "@engine/markdown";

vi.mock("@engine/viewport", () => ({
  observeViewport: () => () => {},
  mathPlaceholderText: (tex: string) => tex,
}));

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("源码节点编辑与保存", () => {
  it.each([
    ["行内公式", "$x$\n", ".math-source", "math_inline", "x + y", "$x + y$"],
    ["块级公式", "$$\nx\n$$\n", ".math-source", "math_block", "x + y", "x + y"],
    [
      "行内 HTML",
      'Text <a id="old"></a>.\n',
      ".html-source",
      "html_inline",
      '<a id="new"></a>',
      '<a id="new"></a>',
    ],
    [
      "块级 HTML",
      "<div>old</div>\n",
      ".html-source",
      "html_block",
      "<div>new</div>",
      "<div>new</div>",
    ],
  ])("%s 未退出编辑时也保存最新输入", async (_name, source, selector, type, edited, expected) => {
    const target = document.createElement("div");
    document.body.append(target);
    const saved: string[] = [];
    const view = new EditorView(target, {
      state: EditorState.create({ doc: parseMarkdown(`# Title\n\n${source}`) }),
      nodeViews: { ...mathNodeViews, ...createHtmlNodeViews(async () => null) },
      handleKeyDown: (current, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "s") {
          saved.push(serializeMarkdown(current.state.doc));
          return true;
        }
        return false;
      },
    });
    views.push(view);
    let pos = -1;
    view.state.doc.descendants((node, offset) => {
      if (node.type.name === type) pos = offset;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    await Promise.resolve();
    const field = target.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    field.value = edited;
    field.setSelectionRange(1, 1);
    field.dispatchEvent(new Event("input", { bubbles: true }));

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(1);
    expect(serializeMarkdown(view.state.doc)).toContain(expected);
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain(expected);
    expect(target.querySelector(selector)).toBe(field);
  });
});
