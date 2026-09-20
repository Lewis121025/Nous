/**
 * Markdown → ProseMirror。
 *
 * 使用 remark/micromark 解析，再映射到文档 schema；wiki 在文本节点上二次识别，
 * 并还原 remark 把 `[[target]]` 拆成 linkReference 的情况。
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
import remarkParse from "remark-parse";
import { unified } from "unified";
import { documentSchema } from "./schema";

const wikiPattern = /\[\[([^[\]]+)\]\]/g;

/**
 * 把 Markdown 源解析为 ProseMirror 文档。
 *
 * @param source UTF-8 Markdown 文本。
 * @returns schema 约束下的文档节点。
 */
export function parseMarkdown(source: string): PmNode {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
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
  return documentSchema.node("list_item", null, content);
}

function mapPhrasing(nodes: PhrasingContent[]): PmNode[] {
  const out: PmNode[] = [];
  let index = 0;
  while (index < nodes.length) {
    const wiki = tryWikiSequence(nodes, index);
    if (wiki !== null) {
      out.push(...wiki.nodes);
      index = wiki.nextIndex;
      continue;
    }
    const node = nodes[index];
    if (node === undefined) {
      break;
    }
    out.push(...mapPhrase(node, []));
    index += 1;
  }
  return out;
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
  const prefix = lead.value.slice(0, -1);
  const suffix = trail.value.slice(1);
  const pieces: PmNode[] = [];
  if (prefix !== "") {
    pieces.push(...splitWikiText(prefix, []));
  }
  const wiki = wikiNodeFromInner(linkReferenceInner(ref));
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

function wikiNodeFromInner(inner: string): PmNode | null {
  const [targetRaw, aliasRaw] = inner.split("|", 2);
  const target = (targetRaw ?? "").trim();
  if (target === "") {
    return null;
  }
  const alias = aliasRaw === undefined ? null : aliasRaw;
  return documentSchema.node("wiki_link", { target, alias });
}

function mapPhrase(node: PhrasingContent, markTypes: string[]): PmNode[] {
  switch (node.type) {
    case "text":
      return splitWikiText(node.value, markTypes);
    case "strong":
      return node.children.flatMap((child) => mapPhrase(child, [...markTypes, "strong"]));
    case "emphasis":
      return node.children.flatMap((child) => mapPhrase(child, [...markTypes, "em"]));
    case "inlineCode":
      return wrapText(node.value, [...markTypes, "code"]);
    case "break":
      return [documentSchema.node("hard_break")];
    case "link":
      return mapLink(node, markTypes);
    case "delete":
      return node.children.flatMap((child) => mapPhrase(child, markTypes));
    case "linkReference":
      return node.children.flatMap((child) => mapPhrase(child, markTypes));
    default:
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

function hasStringValue(node: PhrasingContent): node is PhrasingContent & { value: string } {
  return "value" in node && typeof node.value === "string";
}

function mapLink(node: Link, markTypes: string[]): PmNode[] {
  const href = node.url;
  const mark = documentSchema.mark("link", { href, title: node.title ?? null });
  const inner = node.children.flatMap((child) => mapPhrase(child, markTypes));
  return inner.map((child) => child.mark(child.marks.concat(mark)));
}

function splitWikiText(text: string, markTypes: string[]): PmNode[] {
  const out: PmNode[] = [];
  wikiPattern.lastIndex = 0;
  let last = 0;
  let match = wikiPattern.exec(text);
  while (match !== null) {
    if (match.index > last) {
      out.push(...wrapText(text.slice(last, match.index), markTypes));
    }
    const wiki = wikiNodeFromInner(match[1] ?? "");
    if (wiki !== null) {
      out.push(wiki);
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
