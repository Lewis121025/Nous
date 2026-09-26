/**
 * ProseMirror 文档 schema。
 *
 * 这是文档表面的唯一模型；Markdown 适配器只做映射，不再另造 IR。
 */
import { Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from "prosemirror-model";

const mediaAttrs = {
  src: { default: "", validate: "string" },
  alt: { default: "", validate: "string" },
  title: { default: null, validate: "string|null" },
  kind: { default: "md", validate: linkKind },
  reference: { default: null, validate: "string|null" },
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
    attrs: { level: { default: 1, validate: headingLevel } },
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
    attrs: { spread: { default: false, validate: "boolean" } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    attrs: {
      order: { default: 1, validate: listOrder },
      spread: { default: false, validate: "boolean" },
    },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ol" }],
    toDOM: (node) => ["ol", { start: node.attrs["order"] as number }, 0],
  },
  list_item: {
    content: "paragraph block*",
    attrs: {
      checked: { default: null, validate: "boolean|null" },
      spread: { default: false, validate: "boolean" },
    },
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
    attrs: {
      params: { default: "", validate: "string" },
      meta: { default: null, validate: "string|null" },
    },
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
    attrs: { source: { default: "", validate: "string" } },
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
  note_embed: {
    atom: true,
    group: "block",
    attrs: {
      target: { default: "", validate: "string" },
      alias: { default: null, validate: "string|null" },
      anchor: { default: null, validate: "string|null" },
    },
    parseDOM: [
      {
        tag: "div[data-note-embed]",
        getAttrs: (dom) => ({
          target: dom.getAttribute("data-note-target") ?? "",
          alias: dom.getAttribute("data-note-alias"),
          anchor: dom.getAttribute("data-note-anchor"),
        }),
      },
    ],
    toDOM: (node) => [
      "div",
      {
        "data-note-embed": "",
        "data-note-target": node.attrs["target"] as string,
        "data-note-alias": node.attrs["alias"] as string | null,
        "data-note-anchor": node.attrs["anchor"] as string | null,
        class: "note-embed",
      },
      embedLabel(node),
    ],
  },
  wiki_link: {
    inline: true,
    atom: true,
    group: "inline",
    attrs: {
      target: { default: "", validate: "string" },
      alias: { default: null, validate: "string|null" },
    },
    parseDOM: [
      {
        tag: "span[data-wiki-target]",
        getAttrs: (dom) => ({
          target: dom.getAttribute("data-wiki-target") ?? "",
          alias: dom.getAttribute("data-wiki-alias"),
        }),
      },
    ],
    toDOM: (node) => [
      "span",
      {
        "data-wiki-target": node.attrs["target"] as string,
        "data-wiki-alias": node.attrs["alias"] as string | null,
        class: "wiki-link",
      },
      (node.attrs["alias"] as string | null) ?? (node.attrs["target"] as string),
    ],
  },
  math_inline: {
    inline: true,
    atom: true,
    group: "inline",
    attrs: { tex: { default: "", validate: "string" } },
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
    attrs: { tex: { default: "", validate: "string" } },
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
    attrs: { html: { default: "", validate: "string" } },
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
    attrs: { html: { default: "", validate: "string" } },
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
    attrs: { align: { default: null, validate: tableAlign } },
    parseDOM: [{ tag: "th", getAttrs: cellAlignAttrs }],
    toDOM: (node) => ["th", cellAlignDom(node), 0],
  },
  table_cell: {
    content: "inline*",
    attrs: { align: { default: null, validate: tableAlign } },
    parseDOM: [{ tag: "td", getAttrs: cellAlignAttrs }],
    toDOM: (node) => ["td", cellAlignDom(node), 0],
  },
  text: { group: "inline" },
  hard_break: {
    // 正文和代码块互换时，由文档变换统一映射显式换行与换行符。
    linebreakReplacement: true,
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
    attrs: {
      href: { default: "", validate: "string" },
      title: { default: null, validate: "string|null" },
      reference: { default: null, validate: "string|null" },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => ({
          href: dom.getAttribute("href") ?? "",
          title: dom.getAttribute("title"),
          reference: dom.getAttribute("data-link-reference"),
        }),
      },
    ],
    toDOM: (node) => [
      "a",
      {
        href: node.attrs["href"] as string,
        title: node.attrs["title"] as string | null,
        "data-link-reference": node.attrs["reference"] as string | null,
      },
      0,
    ],
  },
};

// 恢复和外部 JSON 进入文档时按同一 schema 验证，不能依靠渲染时的 String 转换掩盖坏数据。
function headingLevel(value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 6)
    throw new RangeError("标题级别必须在 1 到 6 之间");
}

function listOrder(value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 999999999)
    throw new RangeError("有序列表起始编号必须是最多九位的非负整数");
}

function linkKind(value: unknown): void {
  if (value !== "md" && value !== "wiki") throw new RangeError("未知链接语法");
}

function tableAlign(value: unknown): void {
  if (value !== null && value !== "left" && value !== "right" && value !== "center")
    throw new RangeError("未知表格对齐方式");
}

/** 嵌入降级文本：没有 NodeView 时仍能看出目标。 */
function embedLabel(node: { attrs: Record<string, unknown> }): string {
  const alias = node.attrs["alias"];
  const target = String(node.attrs["target"] ?? "");
  const anchor = node.attrs["anchor"];
  const name = typeof alias === "string" && alias !== "" ? alias : target;
  return typeof anchor === "string" && anchor !== "" ? `${name}#${anchor}` : name;
}

/** 文档表面使用的 schema。 */
export const documentSchema = new Schema({ nodes, marks });
