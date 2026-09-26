/**
 * 把顶层「只有一条笔记嵌入」的段落提升为 `note_embed`。
 *
 * 图片和 PDF 的 `![[ ]]` 已在行内映射成媒体节点，不会走到这里。
 * 和正文写在同一段里的嵌入保持 `!` + 链接，避免拆开句子。
 */

import type { Node as PmNode } from "prosemirror-model";
import { splitLinkResource } from "../../../shared/link-target";
import { documentSchema } from "./schema";

/**
 * 段落若只含 `!` 和一条 wiki 链接，返回嵌入块；否则返回 `null`。
 *
 * @param block 已映射的段落。
 * @returns 嵌入节点；目标为空或不是单独嵌入时为 `null`。
 */
export function noteEmbedFromParagraph(block: PmNode): PmNode | null {
  if (block.childCount !== 2) return null;
  const bang = block.child(0);
  const link = block.child(1);
  if (!bang.isText || bang.text !== "!" || link.type.name !== "wiki_link") return null;
  const { path, anchor } = splitLinkResource(String(link.attrs["target"] ?? ""));
  if (path === "") return null;
  const alias = link.attrs["alias"];
  return documentSchema.node("note_embed", {
    target: path,
    anchor,
    alias: typeof alias === "string" && alias !== "" ? alias : null,
  });
}
