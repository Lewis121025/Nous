/**
 * Markdown → ProseMirror。
 *
 * 使用 remark/micromark 解析，再映射到文档 schema；wiki 在文本节点上二次识别，
 * 并还原 remark 把 `[[target]]` 拆成 linkReference 的情况。
 * `$`/`$$` 由 remark-math 识别；math 节点必须显式映射，否则会落入 default 被丢掉。
 * 行内 HTML 由 micromark 拆成相邻 html 词元，必须拼回一条 html_inline。
 * GFM 表格 / 任务列表 / 删除线 / 图片必须显式映射，否则会落入 default 被丢掉。
 */
import type {
  Heading,
  Link,
  LinkReference,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
} from "mdast";
import type { Node as PmNode } from "prosemirror-model";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { isImageFileName } from "./media";
import { documentSchema } from "./schema";

const wikiPattern = /\[\[([^[\]]+)\]\]/g;

/**
 * 把 Markdown 源解析为 ProseMirror 文档。
 *
 * @param source UTF-8 Markdown 文本。
 * @returns schema 约束下的文档节点。
 */
export function parseMarkdown(source: string): PmNode {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source);
  const blocks = tree.children.flatMap((child) => mapBlock(child));
  const content = blocks.length === 0 ? documentSchema.node("paragraph", null, []) : blocks;
  return documentSchema.node("doc", null, content);
}

function mapBlock(node: RootContent | ListItem["children"][number]): PmNode[] {
  switch (node.type) {
    case "heading":
      return [mapHeading(node)];
    case "paragraph":
      return [documentSchema.node("paragraph", null, mapPhrasing(node.children))];
    case "blockquote":
      return [
        documentSchema.node(
          "blockquote",
          null,
          node.children.flatMap((child) => mapBlock(child)),
        ),
      ];
    case "list":
      return [mapList(node)];
    case "code":
      return [
        documentSchema.node(
          "code_block",
          { params: node.lang ?? "" },
          node.value === "" ? [] : [documentSchema.text(node.value)],
        ),
      ];
    case "thematicBreak":
      return [documentSchema.node("horizontal_rule")];
    default:
      if (node.type === "html" && hasStringValue(node)) {
        return [documentSchema.node("html_block", { html: node.value })];
      }
      if (node.type === "table" && isTable(node)) {
        return [mapTable(node)];
      }
      // remark-math 的块级节点不在 mdast 默认联合里，只能在这里接住。
      if (node.type === "math" && hasStringValue(node)) {
        return [documentSchema.node("math_block", { tex: node.value.trim() })];
      }
      return [];
  }
}

function mapHeading(node: Heading): PmNode {
  const level = Math.min(6, Math.max(1, node.depth));
  return documentSchema.node("heading", { level }, mapPhrasing(node.children));
}

function mapList(node: List): PmNode {
  const items = node.children.map((item) => mapListItem(item));
  if (node.ordered === true) {
    return documentSchema.node("ordered_list", { order: node.start ?? 1 }, items);
  }
  return documentSchema.node("bullet_list", null, items);
}

function mapListItem(node: ListItem): PmNode {
  const mapped = node.children.flatMap((child) => mapBlock(child));
  const content = mapped.length === 0 ? [documentSchema.node("paragraph", null, [])] : mapped;
  const checked = node.checked === true || node.checked === false ? node.checked : null;
  return documentSchema.node("list_item", { checked }, content);
}

function mapPhrasing(nodes: PhrasingContent[], markTypes: string[] = []): PmNode[] {
  const out: PmNode[] = [];
  let index = 0;
  while (index < nodes.length) {
    const wiki = tryWikiSequence(nodes, index);
    if (wiki !== null) {
      out.push(...wiki.nodes);
      index = wiki.nextIndex;
      continue;
    }
    const html = tryHtmlRun(nodes, index);
    if (html !== null) {
      out.push(html.node);
      index = html.nextIndex;
      continue;
    }
    const node = nodes[index];
    if (node === undefined) {
      break;
    }
    out.push(...mapPhrase(node, markTypes));
    index += 1;
  }
  return out;
}

/**
 * micromark 把 `<a id="x"></a>` 拆成开标签和闭标签两个 html 节点。
 * 相邻 html 词元必须拼回一条，否则 NodeView 无法画出完整元素。
 */
function tryHtmlRun(
  nodes: PhrasingContent[],
  index: number,
): { node: PmNode; nextIndex: number } | null {
  const first = nodes[index];
  if (first === undefined || first.type !== "html" || !hasStringValue(first)) {
    return null;
  }
  let html = first.value;
  let nextIndex = index + 1;
  while (nextIndex < nodes.length) {
    const next = nodes[nextIndex];
    if (next === undefined || next.type !== "html" || !hasStringValue(next)) {
      break;
    }
    html += next.value;
    nextIndex += 1;
  }
  return { node: documentSchema.node("html_inline", { html }), nextIndex };
}

function tryWikiSequence(
  nodes: PhrasingContent[],
  index: number,
): { nodes: PmNode[]; nextIndex: number } | null {
  const lead = nodes[index];
  const ref = nodes[index + 1];
  const trail = nodes[index + 2];
  if (lead === undefined || ref === undefined || trail === undefined) {
    return null;
  }
  if (lead.type !== "text" || ref.type !== "linkReference" || trail.type !== "text") {
    return null;
  }
  if (!lead.value.endsWith("[") || !trail.value.startsWith("]")) {
    return null;
  }
  const inner = linkReferenceInner(ref);
  const target = wikiTarget(inner);
  let prefix = lead.value.slice(0, -1);
  const embed = prefix.endsWith("!") && isImageFileName(target);
  if (embed) {
    prefix = prefix.slice(0, -1);
  }
  const suffix = trail.value.slice(1);
  const pieces: PmNode[] = [];
  if (prefix !== "") {
    pieces.push(...splitWikiText(prefix, []));
  }
  const wiki = wikiOrImageFromInner(inner, embed);
  if (wiki !== null) {
    pieces.push(wiki);
  }
  if (suffix !== "") {
    pieces.push(...splitWikiText(suffix, []));
  }
  return { nodes: pieces, nextIndex: index + 3 };
}

function linkReferenceInner(node: LinkReference): string {
  if (node.children.length > 0) {
    return node.children.map((child) => (child.type === "text" ? child.value : "")).join("");
  }
  return node.label ?? node.identifier;
}

function wikiTarget(inner: string): string {
  const [targetRaw] = inner.split("|", 2);
  return (targetRaw ?? "").trim();
}

function wikiOrImageFromInner(inner: string, embed: boolean): PmNode | null {
  const [targetRaw, aliasRaw] = inner.split("|", 2);
  const target = (targetRaw ?? "").trim();
  if (target === "") {
    return null;
  }
  const alias = aliasRaw === undefined ? null : aliasRaw;
  if (embed && isImageFileName(target)) {
    return documentSchema.node("image", {
      src: target,
      alt: alias ?? "",
      title: null,
      kind: "wiki",
    });
  }
  return documentSchema.node("wiki_link", { target, alias });
}

function mapPhrase(node: PhrasingContent, markTypes: string[]): PmNode[] {
  switch (node.type) {
    case "text":
      return splitWikiText(node.value, markTypes);
    case "strong":
      return mapPhrasing(node.children, [...markTypes, "strong"]);
    case "emphasis":
      return mapPhrasing(node.children, [...markTypes, "em"]);
    case "inlineCode":
      return wrapText(node.value, [...markTypes, "code"]);
    case "break":
      return [documentSchema.node("hard_break")];
    case "link":
      return mapLink(node, markTypes);
    case "delete":
      return mapPhrasing(node.children, [...markTypes, "strike"]);
    case "image":
      return [
        markAtom(
          documentSchema.node("image", {
            src: node.url,
            alt: node.alt ?? "",
            title: node.title ?? null,
            kind: "md",
          }),
          markTypes,
        ),
      ];
    case "linkReference":
      return node.children.flatMap((child) => mapPhrase(child, markTypes));
    default:
      if (node.type === "html" && hasStringValue(node)) {
        return [documentSchema.node("html_inline", { html: node.value })];
      }
      // 行内 math 同样不在默认 PhrasingContent 联合里。
      if (node.type === "inlineMath" && hasStringValue(node)) {
        return [documentSchema.node("math_inline", { tex: node.value.trim() })];
      }
      return phrasingFallback(node, markTypes);
  }
}

function phrasingFallback(node: PhrasingContent, markTypes: string[]): PmNode[] {
  if (hasPhrasingChildren(node)) {
    return node.children.flatMap((child) => mapPhrase(child, markTypes));
  }
  if (hasStringValue(node) && node.value !== "") {
    return wrapText(node.value, markTypes);
  }
  return [];
}

function hasPhrasingChildren(
  node: PhrasingContent,
): node is PhrasingContent & { children: PhrasingContent[] } {
  return "children" in node && Array.isArray(node.children);
}

function hasStringValue(node: object): node is { value: string } {
  return "value" in node && typeof node.value === "string";
}

function mapLink(node: Link, markTypes: string[]): PmNode[] {
  const href = node.url;
  const mark = documentSchema.mark("link", { href, title: node.title ?? null });
  const inner = mapPhrasing(node.children, markTypes);
  return inner.map((child) => child.mark(child.marks.concat(mark)));
}

function splitWikiText(text: string, markTypes: string[]): PmNode[] {
  const out: PmNode[] = [];
  wikiPattern.lastIndex = 0;
  let last = 0;
  let match = wikiPattern.exec(text);
  while (match !== null) {
    const inner = match[1] ?? "";
    const target = wikiTarget(inner);
    let from = match.index;
    const embed = from > last && text[from - 1] === "!" && isImageFileName(target);
    if (embed) {
      from -= 1;
    }
    if (from > last) {
      out.push(...wrapText(text.slice(last, from), markTypes));
    }
    const wiki = wikiOrImageFromInner(inner, embed);
    if (wiki !== null) {
      out.push(markAtom(wiki, markTypes));
    }
    last = match.index + match[0].length;
    match = wikiPattern.exec(text);
  }
  if (last < text.length) {
    out.push(...wrapText(text.slice(last), markTypes));
  }
  return out;
}

function wrapText(value: string, markTypes: string[]): PmNode[] {
  if (value === "") {
    return [];
  }
  const marks = markTypes.map((name) => documentSchema.mark(name));
  return [documentSchema.text(value, marks)];
}

function markAtom(node: PmNode, markTypes: string[]): PmNode {
  if (markTypes.length === 0) {
    return node;
  }
  return node.mark(markTypes.map((name) => documentSchema.mark(name)));
}

type TableCellLike = { children: PhrasingContent[] };
type TableRowLike = { children: TableCellLike[] };
type TableLike = {
  align?: (string | null)[] | null;
  children: TableRowLike[];
};

function isTable(node: object): node is TableLike {
  return "children" in node && Array.isArray((node as TableLike).children);
}

function mapTable(node: TableLike): PmNode {
  const align = node.align ?? [];
  const rows = node.children.map((row, rowIndex) => {
    const type = rowIndex === 0 ? "table_header" : "table_cell";
    const cells = row.children.map((cell, colIndex) => {
      const cellAlign = align[colIndex] ?? null;
      return documentSchema.node(type, { align: cellAlign }, mapPhrasing(cell.children));
    });
    const content = cells.length === 0 ? [documentSchema.node(type, { align: null }, [])] : cells;
    return documentSchema.node("table_row", null, content);
  });
  const content =
    rows.length === 0
      ? [
          documentSchema.node("table_row", null, [
            documentSchema.node("table_header", { align: null }, []),
          ]),
        ]
      : rows;
  return documentSchema.node("table", null, content);
}
