/**
 * ProseMirror 文档 schema。
 *
 * 这是文档表面的唯一模型；Markdown 适配器只做映射，不再另造 IR。
 */
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from "prosemirror-model";

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },
  heading: {
    attrs: { level: { default: 1 } },
    content: "inline*",
    group: "block",
    defining: true,
    parseDOM: [
      { tag: "h1", attrs: { level: 1 } },
      { tag: "h2", attrs: { level: 2 } },
      { tag: "h3", attrs: { level: 3 } },
      { tag: "h4", attrs: { level: 4 } },
      { tag: "h5", attrs: { level: 5 } },
      { tag: "h6", attrs: { level: 6 } },
    ],
    toDOM: (node) => [`h${String(node.attrs["level"] as number)}`, 0],
  },
  blockquote: {
    content: "block+",
    group: "block",
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },
  bullet_list: {
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    attrs: { order: { default: 1 } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ol" }],
    toDOM: (node) => ["ol", { start: node.attrs["order"] as number }, 0],
  },
  list_item: {
    content: "paragraph block*",
    parseDOM: [{ tag: "li" }],
    toDOM: () => ["li", 0],
  },
  code_block: {
    attrs: { params: { default: "" } },
    content: "text*",
    group: "block",
    code: true,
    defining: true,
    marks: "",
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: () => ["pre", ["code", 0]],
  },
  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },
  wiki_link: {
    inline: true,
    atom: true,
    group: "inline",
    attrs: { target: { default: "" }, alias: { default: null } },
    parseDOM: [{ tag: "span[data-wiki-target]" }],
    toDOM: (node) => [
      "span",
      {
        "data-wiki-target": node.attrs["target"] as string,
        class: "wiki-link",
      },
      (node.attrs["alias"] as string | null) ?? (node.attrs["target"] as string),
    ],
  },
  math_inline: {
    inline: true,
    atom: true,
    group: "inline",
    attrs: { tex: { default: "" } },
    // 剪贴板和无 NodeView 时靠 data-* 降级，不把排版 HTML 写回文档。
    parseDOM: [
      {
        tag: "span[data-math-tex]",
        getAttrs: (dom) => mathDomAttrs(dom, false),
      },
    ],
    toDOM: (node) => mathToDom(node, false),
  },
  math_block: {
    atom: true,
    group: "block",
    attrs: { tex: { default: "" } },
    parseDOM: [
      {
        tag: "div[data-math-tex]",
        getAttrs: (dom) => mathDomAttrs(dom, true),
      },
    ],
    toDOM: (node) => mathToDom(node, true),
  },
  text: { group: "inline" },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
};

/** 从降级 DOM 读回 tex；display 必须与节点种类一致，避免行内/块级互吃。 */
function mathDomAttrs(dom: string | HTMLElement, display: boolean) {
  if (typeof dom === "string") {
    return false;
  }
  const isDisplay = dom.getAttribute("data-math-display") === "true";
  if (isDisplay !== display) {
    return false;
  }
  return { tex: dom.getAttribute("data-math-tex") ?? "" };
}

/** 序列化到 DOM 时只带 TeX 源，供无 NodeView 时仍能看见 `$`/`$$`。 */
function mathToDom(node: { attrs: Record<string, unknown> }, display: boolean): DOMOutputSpec {
  const tex = String(node.attrs["tex"] ?? "");
  const tag = display ? "div" : "span";
  const className = display ? "math-block" : "math-inline";
  const fallback = display ? `$$${tex}$$` : `$${tex}$`;
  return [
    tag,
    {
      "data-math-tex": tex,
      "data-math-display": display ? "true" : "false",
      class: className,
    },
    fallback,
  ];
}

const marks: Record<string, MarkSpec> = {
  em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
  strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
  code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
  link: {
    attrs: { href: { default: "" }, title: { default: null } },
    inclusive: false,
    parseDOM: [{ tag: "a[href]" }],
    toDOM: (node) => ["a", { href: node.attrs["href"] as string }, 0],
  },
};

/** 文档表面使用的 schema。 */
export const documentSchema = new Schema({ nodes, marks });
