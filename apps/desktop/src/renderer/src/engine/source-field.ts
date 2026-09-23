/** 公式与 HTML 源码输入共享同一条文档提交路径，保存无需等待失焦。 */
import type { EditorView } from "prosemirror-view";

/**
 * 将输入实时写入文档，同时把保存快捷键交回编辑器。
 *
 * @param field 当前节点的源码输入框；移除后监听器随元素一起释放。
 * @param view 所属编辑器，事务触发既有脏标记与自动保存。
 * @param getPos 节点当前位置，不能缓存初始位置。
 * @param attribute 要更新的源码属性。
 * @returns 无返回值；输入值留在同一 DOM 节点内，避免打断输入法与光标。
 */
export function bindSourceField(
  field: HTMLInputElement | HTMLTextAreaElement,
  view: EditorView,
  getPos: () => number | undefined,
  attribute: "tex" | "html",
): void {
  field.addEventListener("input", () => {
    const pos = getPos();
    if (pos === undefined) return;
    const node = view.state.doc.nodeAt(pos);
    if (node === null || node.attrs[attribute] === field.value) return;
    // 只更新属性；替换整个行内节点会映射掉 NodeSelection，导致输入框失焦。
    view.dispatch(view.state.tr.setNodeAttribute(pos, attribute, field.value));
  });
  field.onkeydown = (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      view.someProp("handleKeyDown", (handle) => handle(view, event));
    }
  };
}
