/**
 * ProseMirror → 确定性 Markdown。
 *
 * 同一棵文档树两次序列化必须得到相同字节；覆盖与解析相同的节点子集。
 */
import type { Mark, Node as PmNode } from "prosemirror-model";

/**
 * 把 ProseMirror 文档序列化为确定性 Markdown。
 *
 * @param doc schema 约束下的文档节点。
 * @returns UTF-8 Markdown 文本，结尾始终带一个换行。
 */
export function serializeMarkdown(doc: PmNode): string {
  const blocks: string[] = [];
  doc.forEach((child) => {
    blocks.push(serializeBlock(child, 0));
  });
  const body = blocks.filter((part) => part !== "").join("\n\n");
  return `${body}\n`;
}

function serializeBlock(node: PmNode, indent: number): string {
  switch (node.type.name) {
    case "heading": {
      const level = Number(node.attrs["level"] ?? 1);
      const hashes = "#".repeat(Number.isFinite(level) ? level : 1);
      return `${hashes} ${serializeInline(node)}`;
    }
    case "paragraph":
      return serializeInline(node);
    case "blockquote": {
      const inner = serializeChildren(node, indent).replace(/^/gm, "> ");
      return inner.replace(/^> $/gm, ">");
    }
    case "bullet_list":
      return serializeList(node, indent, false);
    case "ordered_list":
      return serializeList(node, indent, true);
    case "code_block": {
      const lang = String(node.attrs["params"] ?? "");
      return `\`\`\`${lang}\n${node.textContent}\n\`\`\``;
    }
    case "horizontal_rule":
      return "---";
    case "math_block": {
      const tex = String(node.attrs["tex"] ?? "");
      // TeX 不能走 escapeText，否则 `\` 会被改写，二次解析对不上。
      return `$$\n${tex}\n$$`;
    }
    default:
      return serializeInline(node);
  }
}

function serializeChildren(node: PmNode, indent: number): string {
  const parts: string[] = [];
  node.forEach((child) => {
    parts.push(serializeBlock(child, indent));
  });
  return parts.join("\n\n");
}

function serializeList(node: PmNode, indent: number, ordered: boolean): string {
  const lines: string[] = [];
  let index = ordered ? Number(node.attrs["order"] ?? 1) : 0;
  node.forEach((item) => {
    const marker = ordered ? `${index}. ` : "- ";
    index += 1;
    const itemText = serializeListItem(item, indent, marker);
    lines.push(itemText);
  });
  return lines.join("\n");
}

function serializeListItem(item: PmNode, indent: number, marker: string): string {
  const pad = " ".repeat(indent);
  const nestedPad = " ".repeat(indent + 2);
  const parts: string[] = [];
  item.forEach((child, _offset, index) => {
    if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
      parts.push(serializeList(child, indent + 2, child.type.name === "ordered_list"));
      return;
    }
    const text = serializeBlock(child, indent);
    if (index === 0) {
      parts.push(`${pad}${marker}${text}`);
    } else {
      parts.push(
        text
          .split("\n")
          .map((line) => `${nestedPad}${line}`)
          .join("\n"),
      );
    }
  });
  return parts.join("\n");
}

function serializeInline(node: PmNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.type.name === "wiki_link") {
      const target = String(child.attrs["target"] ?? "");
      const alias = child.attrs["alias"];
      if (typeof alias === "string" && alias !== "") {
        out += `[[${target}|${alias}]]`;
      } else {
        out += `[[${target}]]`;
      }
      return;
    }
    if (child.type.name === "math_inline") {
      out += `$${String(child.attrs["tex"] ?? "")}$`;
      return;
    }
    if (child.type.name === "hard_break") {
      out += "  \n";
      return;
    }
    if (child.isText) {
      out += serializeTextNode(child);
    }
  });
  return out;
}

function serializeTextNode(node: PmNode): string {
  const text = node.text ?? "";
  const marks = [...node.marks].sort((a, b) => a.type.name.localeCompare(b.type.name));
  let wrapped = escapeText(text, marks);
  for (const mark of marks) {
    wrapped = wrapMark(mark, wrapped);
  }
  return wrapped;
}

function wrapMark(mark: Mark, inner: string): string {
  switch (mark.type.name) {
    case "em":
      return `*${inner}*`;
    case "strong":
      return `**${inner}**`;
    case "code":
      return `\`${inner}\``;
    case "link": {
      const href = String(mark.attrs["href"] ?? "");
      const title = mark.attrs["title"];
      if (typeof title === "string" && title !== "") {
        return `[${inner}](${href} "${escapeAttr(title)}")`;
      }
      return `[${inner}](${href})`;
    }
    default:
      return inner;
  }
}

function escapeText(text: string, marks: readonly Mark[]): string {
  if (marks.some((mark) => mark.type.name === "code")) {
    return text;
  }
  return text.replace(/([\\`*_[\]#])/g, "\\$1");
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '\\"');
}
