/** 编辑器映射回 Markdown 语法树，转义、围栏与嵌套缩进交给共用处理器。 */
import type { AlignType, BlockContent, Heading, PhrasingContent, Root } from "mdast";
import type { Mark, Node as PmNode } from "prosemirror-model";
import { markdownProcessor } from "./markdown-processor";

/**
 * 序列化完整文档；所有节点与格式都必须有显式映射，禁止静默省略。
 *
 * @param doc 当前编辑器文档。
 * @returns 结尾带换行的 Markdown。
 * @throws 遇到未映射的编辑器节点或格式时失败，以免不完整内容覆盖文件。
 */
export function serializeMarkdown(doc: PmNode): string {
  const root: Root = { type: "root", children: blocks(doc) };
  return markdownProcessor.stringify(root);
}

function blocks(node: PmNode): BlockContent[] {
  return node.content.content.map(block);
}

function block(node: PmNode): BlockContent {
  switch (node.type.name) {
    case "paragraph":
      return { type: "paragraph", children: inline(node) };
    case "heading":
      return { type: "heading", depth: headingDepth(node), children: inline(node) };
    case "blockquote":
      return { type: "blockquote", children: blocks(node) };
    case "bullet_list":
    case "ordered_list":
      return {
        type: "list",
        ordered: node.type.name === "ordered_list",
        start: node.type.name === "ordered_list" ? Number(node.attrs["order"]) : null,
        spread: node.attrs["spread"] === true,
        children: node.content.content.map((item) => ({
          type: "listItem",
          checked: typeof item.attrs["checked"] === "boolean" ? item.attrs["checked"] : null,
          spread: item.attrs["spread"] === true,
          children: blocks(item),
        })),
      };
    case "code_block":
      return {
        type: "code",
        lang: optionalString(node, "params"),
        meta: optionalString(node, "meta"),
        value: node.textContent,
      };
    case "horizontal_rule":
      return { type: "thematicBreak" };
    case "math_block":
      return { type: "math", value: String(node.attrs["tex"] ?? "") };
    case "html_block":
      return { type: "html", value: String(node.attrs["html"] ?? "") };
    case "markdown_block":
      return { type: "rawMarkdown", value: node.textContent };
    case "table":
      return {
        type: "table",
        align: node.firstChild?.content.content.map(cellAlign) ?? [],
        children: node.content.content.map((row) => ({
          type: "tableRow",
          children: row.content.content.map((cell) => ({
            type: "tableCell",
            children: inline(cell),
          })),
        })),
      };
    default:
      throw new Error(`无法保存未识别的文档节点：${node.type.name}`);
  }
}

type MarkedNode = { node: PmNode; marks: readonly Mark[] };
const markOrder: Record<string, number> = { link: 0, strong: 1, em: 2, strike: 3, code: 4 };

function inline(node: PmNode): PhrasingContent[] {
  return markedContent(
    node.content.content.map((child) => ({
      node: child,
      marks: [...child.marks].sort(
        (left, right) => (markOrder[left.type.name] ?? 5) - (markOrder[right.type.name] ?? 5),
      ),
    })),
    0,
  );
}

function markedContent(nodes: readonly MarkedNode[], depth: number): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let index = 0;
  while (index < nodes.length) {
    const current = nodes[index];
    if (current === undefined) break;
    const mark = current.marks[depth];
    if (mark === undefined) {
      out.push(inlineNode(current.node));
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < nodes.length) {
      const next = nodes[end]?.marks[depth];
      if (next === undefined || !mark.eq(next)) break;
      end += 1;
    }
    // 共享格式的相邻片段必须合并，避免嵌套格式被拆成相邻的 Markdown 分隔符。
    out.push(wrapMark(mark, markedContent(nodes.slice(index, end), depth + 1)));
    index = end;
  }
  return out;
}

function wrapMark(mark: Mark, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type.name) {
    case "strong":
      return { type: "strong", children };
    case "em":
      return { type: "emphasis", children };
    case "strike":
      return { type: "delete", children };
    case "code": {
      const value = children
        .map((child) =>
          child.type === "text"
            ? child.value
            : markdownProcessor
                .stringify({ type: "root", children: [{ type: "paragraph", children: [child] }] })
                .trimEnd(),
        )
        .join("");
      return { type: "inlineCode", value };
    }
    case "link": {
      const reference = optionalString(mark, "reference");
      return reference === null
        ? {
            type: "link",
            url: String(mark.attrs["href"] ?? ""),
            title: optionalString(mark, "title"),
            children,
          }
        : {
            type: "linkReference",
            identifier: reference,
            label: reference,
            referenceType: "full",
            children,
          };
    }
    default:
      throw new Error(`无法保存未识别的文本格式：${mark.type.name}`);
  }
}

function inlineNode(node: PmNode): PhrasingContent {
  switch (node.type.name) {
    case "text":
      return { type: "text", value: node.text ?? "" };
    case "wiki_link":
      return wiki(String(node.attrs["target"] ?? ""), optionalString(node, "alias"), false);
    case "math_inline":
      return { type: "inlineMath", value: String(node.attrs["tex"] ?? "") };
    case "html_inline":
      return { type: "html", value: String(node.attrs["html"] ?? "") };
    case "markdown_inline":
      return { type: "rawMarkdown", value: String(node.attrs["source"] ?? "") };
    case "pdf":
    case "image": {
      const src = String(node.attrs["src"] ?? "");
      const alt = String(node.attrs["alt"] ?? "");
      if (node.attrs["kind"] === "wiki") return wiki(src, alt === "" ? null : alt, true);
      const reference = optionalString(node, "reference");
      return reference === null
        ? { type: "image", url: src, alt, title: optionalString(node, "title") }
        : {
            type: "imageReference",
            identifier: reference,
            label: reference,
            referenceType: "full",
            alt,
          };
    }
    case "hard_break":
      return { type: "break" };
    default:
      throw new Error(`无法保存未识别的行内节点：${node.type.name}`);
  }
}

function wiki(target: string, alias: string | null, embed: boolean): PhrasingContent {
  // 目标和别名是已解码的文本；再次写入语法前必须保护实体与结束分隔符。
  const encode = (value: string): string =>
    value.replace(/[\\&[\]]/g, (char) => `&#${char.charCodeAt(0)};`);
  return {
    type: "wikiLink",
    value: `${embed ? "!" : ""}[[${encode(target)}${alias === null ? "" : `|${encode(alias)}`}]]`,
  };
}

function optionalString(node: PmNode | Mark, key: string): string | null {
  const value: unknown = node.attrs[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function headingDepth(node: PmNode): Heading["depth"] {
  const level: unknown = node.attrs["level"];
  if (level === 1 || level === 2 || level === 3 || level === 4 || level === 5 || level === 6)
    return level;
  throw new Error("标题级别必须在 1 到 6 之间");
}

function cellAlign(node: PmNode): AlignType {
  const align: unknown = node.attrs["align"];
  return align === "left" || align === "right" || align === "center" ? align : null;
}
