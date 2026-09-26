/**
 * 笔记嵌入：只读渲染目标笔记或其中一节，不把对方正文写进当前文档。
 *
 * 嵌套内容关闭再次嵌入，避免两篇笔记互相 `![[ ]]` 时无限展开。
 * 编辑器视图在确认节点仍挂载后才创建，卸载发生在读取期间就不会留下游离视图。
 */

import type { Node as PmNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView, type NodeViewConstructor } from "prosemirror-view";
import type { MediaIo } from "../media/media";
import { parseMarkdown } from "../markdown/parse";
import { sliceEmbed } from "../navigation/block-anchor";

/** 读取结果：取消为 `null`，失败带给界面的短句，成功是待渲染文档。 */
type LoadedEmbed = { doc: PmNode } | { message: string };

/**
 * 创建笔记嵌入的节点视图。
 *
 * @param from 当前笔记路径，用于解析相对目标。
 * @param openLink 点击标题时按普通 wiki 链接打开，死链和歧义沿用工作区的处理。
 * @param io 解析与读取目标文件；失败只显示在嵌入块内。
 * @returns 不修改宿主文档的节点视图。
 */
export function createNoteEmbedViews(
  from: string,
  openLink: (kind: "wiki" | "md", raw: string) => void,
  io: Pick<MediaIo, "resolveLink" | "readFile">,
): Record<string, NodeViewConstructor> {
  return {
    note_embed(node) {
      const target = String(node.attrs["target"] ?? "");
      const anchor = typeof node.attrs["anchor"] === "string" ? node.attrs["anchor"] : null;
      const alias = typeof node.attrs["alias"] === "string" ? node.attrs["alias"] : "";
      const raw = anchor === null || anchor === "" ? target : `${target}#${anchor}`;
      const dom = document.createElement("div");
      dom.contentEditable = "false";
      dom.style.margin = "0.75rem 0";
      dom.style.padding = "0.5rem 0.75rem";
      dom.style.border = "1px solid var(--border)";
      dom.style.borderRadius = "0.75rem";
      const header = document.createElement("button");
      header.type = "button";
      header.className = "reader-button";
      header.textContent = alias !== "" ? alias : raw;
      header.addEventListener("click", () => openLink("wiki", raw));
      const body = document.createElement("div");
      body.style.marginTop = "0.35rem";
      body.textContent = "正在嵌入…";
      dom.append(header, body);
      const nested: { view: EditorView | null } = { view: null };
      let cancelled = false;
      void loadEmbed(io, from, target, anchor, () => cancelled).then((loaded) => {
        if (loaded === null || cancelled) return;
        if ("message" in loaded) {
          body.textContent = loaded.message;
          return;
        }
        body.textContent = "";
        nested.view = new EditorView(body, {
          state: EditorState.create({ doc: loaded.doc }),
          editable: () => false,
        });
      });
      return {
        dom,
        destroy() {
          cancelled = true;
          nested.view?.destroy();
          nested.view = null;
        },
        ignoreMutation: () => true,
        stopEvent: () => true,
      };
    },
  };
}

async function loadEmbed(
  io: Pick<MediaIo, "resolveLink" | "readFile">,
  from: string,
  target: string,
  anchor: string | null,
  cancelled: () => boolean,
): Promise<LoadedEmbed | null> {
  try {
    const path = await io.resolveLink(from, target, "wiki");
    if (cancelled()) return null;
    if (path === null) return { message: "无法嵌入：目标不存在或同名歧义" };
    const bytes = await io.readFile(path);
    if (cancelled()) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const doc = sliceEmbed(parseMarkdown(text, { embeds: false }), anchor);
    if (cancelled()) return null;
    if (doc === null) return { message: anchor?.startsWith("^") ? "未找到块" : "未找到标题" };
    return { doc };
  } catch {
    return cancelled() ? null : { message: "无法嵌入此笔记" };
  }
}
