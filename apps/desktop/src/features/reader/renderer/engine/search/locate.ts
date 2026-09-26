/**
 * 把搜索命中词定位到 ProseMirror 文档位置。
 *
 * 与未链接提及的定位不同：全文索引覆盖代码块与源码保留节点，
 * 定位器同样不跳过它们，否则命中在围栏代码里的结果无法跳转。
 * HTML 与数学节点不进全文索引，这里同步跳过，保持两侧范围一致。
 */

import type { Node as PmNode } from "prosemirror-model";

/** 全文索引不覆盖的节点；与内核 `scan.rs` 的正文提取范围对应。 */
const SKIP_NODES = new Set(["html_inline", "html_block", "math_inline", "math_block"]);

/**
 * 在文档里找命中词的第一次出现（大小写不敏感）。
 *
 * @param doc 当前 ProseMirror 文档。
 * @param needle 摘要高亮片段或全文词；空串不定位。
 * @returns 文本起点位置；找不到为 `null`（跨行内节点的命中不定位，只打开文件）。
 */
export function findSearchMatchPmPos(doc: PmNode, needle: string): number | null {
  const target = needle.toLowerCase();
  if (target === "") {
    return null;
  }
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) {
      return false;
    }
    if (SKIP_NODES.has(node.type.name)) {
      return false;
    }
    if (node.isText && node.text !== undefined) {
      const at = node.text.toLowerCase().indexOf(target);
      if (at >= 0) {
        found = pos + at;
        return false;
      }
    }
    return true;
  });
  if (found === null) found = findInAttrs(doc, target);
  return found;
}

/**
 * 命中词只存在于节点属性时的第二遍定位：wiki 目标/别名与行内源码保留节点
 * 没有文本子节点，但全文索引里有它们的原文。
 */
function findInAttrs(doc: PmNode, target: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) {
      return false;
    }
    if (SKIP_NODES.has(node.type.name)) {
      return false;
    }
    const values: unknown[] =
      node.type.name === "wiki_link"
        ? [node.attrs["target"], node.attrs["alias"]]
        : node.type.name === "markdown_inline"
          ? [node.attrs["source"]]
          : [];
    if (values.some((value) => typeof value === "string" && value.toLowerCase().includes(target))) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}
