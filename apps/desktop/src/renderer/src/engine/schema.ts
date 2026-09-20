/**
 * ProseMirror 文档 schema。
 *
 * 这是文档表面的唯一模型；Markdown 适配器只做映射，不再另造 IR。
 */
import { Schema, type MarkSpec, type NodeSpec } from "prosemirror-model";

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
  text: { group: "inline" },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
};

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
