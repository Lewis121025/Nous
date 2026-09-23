/**
 * ProseMirror 文档 schema。
 *
 * 这是文档表面的唯一模型；Markdown 适配器只做映射，不再另造 IR。
 */
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from "prosemirror-model";

const mediaAttrs = {
  src: { default: "" },
  alt: { default: "" },
  title: { default: null },
  kind: { default: "md" },
  reference: { default: null },
};

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
    attrs: { spread: { default: false } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    attrs: { order: { default: 1 }, spread: { default: false } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ol" }],
    toDOM: (node) => ["ol", { start: node.attrs["order"] as number }, 0],
  },
  list_item: {
    content: "paragraph block*",
    attrs: { checked: { default: null }, spread: { default: false } },
    parseDOM: [
      {
        tag: "li",
        getAttrs: (dom) => {
          if (typeof dom === "string") {
            return false;
          }
          const raw = dom.getAttribute("data-checked");
          if (raw === "true") {
            return { checked: true };
          }
          if (raw === "false") {
            return { checked: false };
          }
          return { checked: null };
        },
      },
    ],
    toDOM: (node) => {
      const checked = node.attrs["checked"];
      if (checked === true || checked === false) {
        return ["li", { "data-checked": String(checked) }, 0];
      }
      return ["li", 0];
    },
  },
  code_block: {
    attrs: { params: { default: "" }, meta: { default: null } },
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
  markdown_block: {
    content: "text*",
    group: "block",
    code: true,
    defining: true,
    marks: "",
    parseDOM: [
      { tag: 'pre[data-markdown-source="block"]', priority: 60, preserveWhitespace: "full" },
    ],
    toDOM: () => ["pre", { "data-markdown-source": "block" }, ["code", 0]],
  },
  markdown_inline: {
    inline: true,
    atom: true,
    group: "inline",
    attrs: { source: { default: "" } },
    parseDOM: [
      {
        tag: "span[data-markdown-source]",
        getAttrs: (dom) => ({ source: dom.getAttribute("data-markdown-source") ?? "" }),
      },
    ],
    toDOM: (node) => {
      const source = String(node.attrs["source"] ?? "");
      return ["span", { "data-markdown-source": source }, source];
    },
  },
  image: {
    inline: true,
    atom: true,
    group: "inline",
    attrs: mediaAttrs,
    parseDOM: [{ tag: "img[data-image-src]", getAttrs: imageDomAttrs }],
    toDOM: (node) => {
      const src = String(node.attrs["src"] ?? "");
      const alt = String(node.attrs["alt"] ?? "");
      const title = node.attrs["title"];
      const kind = String(node.attrs["kind"] ?? "md");
      const attrs: Record<string, string> = {
        "data-image-src": src,
        "data-image-kind": kind,
        alt,
        class: "note-image",
      };
      if (typeof title === "string" && title !== "") {
        attrs["title"] = title;
      }
      return ["img", attrs];
    },
  },
  pdf: {
    inline: true,
    atom: true,
    group: "inline",
    attrs: mediaAttrs,
    parseDOM: [
      {
        tag: "span[data-pdf-src]",
        getAttrs: (dom) => ({
          src: dom.getAttribute("data-pdf-src"),
          alt: dom.getAttribute("data-pdf-alt") ?? "",
          title: dom.getAttribute("data-pdf-title"),
          kind: dom.getAttribute("data-pdf-kind") ?? "md",
          reference: dom.getAttribute("data-pdf-reference"),
        }),
      },
    ],
    toDOM: (node) => [
      "span",
      {
        "data-pdf-src": node.attrs["src"],
        "data-pdf-alt": node.attrs["alt"],
        "data-pdf-title": node.attrs["title"],
        "data-pdf-kind": node.attrs["kind"],
        "data-pdf-reference": node.attrs["reference"],
      },
      String(node.attrs["alt"] || node.attrs["src"]),
    ],
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
  html_inline: {
    inline: true,
    atom: true,
    group: "inline",
    attrs: { html: { default: "" } },
    // 剪贴板和无 NodeView 时靠 data-* 保住源码；真正画进页面只走 NodeView + 消毒。
    parseDOM: [
      {
        tag: "span[data-html-src]",
        getAttrs: (dom) => htmlDomAttrs(dom, false),
      },
    ],
    toDOM: (node) => htmlToDom(node, false),
  },
  html_block: {
    atom: true,
    group: "block",
    attrs: { html: { default: "" } },
    parseDOM: [
      {
        tag: "div[data-html-src]",
        getAttrs: (dom) => htmlDomAttrs(dom, true),
      },
    ],
    toDOM: (node) => htmlToDom(node, true),
  },
  table: {
    content: "table_row+",
    group: "block",
    isolating: true,
    parseDOM: [{ tag: "table" }],
    toDOM: () => ["table", ["tbody", 0]],
  },
  table_row: {
    content: "(table_header | table_cell)+",
    parseDOM: [{ tag: "tr" }],
    toDOM: () => ["tr", 0],
  },
  table_header: {
    content: "inline*",
    attrs: { align: { default: null } },
    parseDOM: [{ tag: "th", getAttrs: cellAlignAttrs }],
    toDOM: (node) => ["th", cellAlignDom(node), 0],
  },
  table_cell: {
    content: "inline*",
    attrs: { align: { default: null } },
    parseDOM: [{ tag: "td", getAttrs: cellAlignAttrs }],
    toDOM: (node) => ["td", cellAlignDom(node), 0],
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

/** 从降级 DOM 读回 HTML 源；display 必须与节点种类一致。 */
function htmlDomAttrs(dom: string | HTMLElement, display: boolean) {
  if (typeof dom === "string") {
    return false;
  }
  const isDisplay = dom.getAttribute("data-html-display") === "true";
  if (isDisplay !== display) {
    return false;
  }
  return { html: dom.getAttribute("data-html-src") ?? "" };
}

/** 降级 DOM 只带源码，不把未消毒 HTML 当作子树。 */
function htmlToDom(node: { attrs: Record<string, unknown> }, display: boolean): DOMOutputSpec {
  const html = String(node.attrs["html"] ?? "");
  const tag = display ? "div" : "span";
  const className = display ? "html-block" : "html-inline";
  return [
    tag,
    {
      "data-html-src": html,
      "data-html-display": display ? "true" : "false",
      class: className,
    },
    html,
  ];
}

/** 从降级 img 读回源地址；真正加载走 NodeView。 */
function imageDomAttrs(dom: string | HTMLElement) {
  if (typeof dom === "string") {
    return false;
  }
  const title = dom.getAttribute("title");
  return {
    src: dom.getAttribute("data-image-src") ?? "",
    alt: dom.getAttribute("alt") ?? "",
    title: title === null || title === "" ? null : title,
    kind: dom.getAttribute("data-image-kind") ?? "md",
  };
}

function cellAlignAttrs(dom: string | HTMLElement) {
  if (typeof dom === "string") {
    return false;
  }
  const align = dom.getAttribute("data-align");
  if (align === "left" || align === "right" || align === "center") {
    return { align };
  }
  return { align: null };
}

function cellAlignDom(node: { attrs: Record<string, unknown> }): Record<string, string> {
  const align = node.attrs["align"];
  if (align === "left" || align === "right" || align === "center") {
    return { "data-align": align, style: `text-align: ${align}` };
  }
  return {};
}

const marks: Record<string, MarkSpec> = {
  em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
  strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
  strike: {
    parseDOM: [{ tag: "del" }, { tag: "s" }, { tag: "strike" }],
    toDOM: () => ["del", 0],
  },
  code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
  link: {
    attrs: { href: { default: "" }, title: { default: null }, reference: { default: null } },
    inclusive: false,
    parseDOM: [{ tag: "a[href]" }],
    toDOM: (node) => ["a", { href: node.attrs["href"] as string }, 0],
  },
};

/** 文档表面使用的 schema。 */
export const documentSchema = new Schema({ nodes, marks });
