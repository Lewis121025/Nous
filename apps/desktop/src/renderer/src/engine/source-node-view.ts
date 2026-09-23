/** 公式与 HTML 共用源码编辑和预览生命周期，具体排版与资源由各自的预览实现负责。 */
import type { Node as PmNode, NodeType } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { bindSourceField } from "./source-field";
import { observeViewport } from "./viewport";

/** 两类源码节点的渲染差异；预览只改 DOM，不得提交文档事务。 */
export type SourcePreview = {
  /** 决定现有 schema 属性、样式类与剪贴板数据属性。 */
  kind: "math" | "html";
  /** 屏外占位文本，不执行排版或读盘。 */
  placeholder: (source: string, display: boolean) => string;
  /** signal 失效后不得再更新预览，并须释放已获得及迟到的资源。 */
  render: (dom: HTMLElement, source: string, display: boolean, signal: AbortSignal) => void;
};

/** 源码输入实时进入文档；选择、可见性和销毁统一决定预览的有效期。 */
export class SourceNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly nodeType: NodeType;
  private readonly display: boolean;
  private readonly attribute: "tex" | "html";
  private readonly sourceKey: "mathTex" | "htmlSrc";
  private readonly stopObserve: () => void;
  private source: string;
  private visible = false;
  private sourceEl: HTMLInputElement | HTMLTextAreaElement | null = null;
  private previewController: AbortController | null = null;

  /**
   * @param node 当前公式或 HTML 节点，块级形态取自 schema。
   * @param view 所属编辑器；仅源码输入会触发文档事务。
   * @param getPos 获取节点实时位置，避免前文编辑后写错位置。
   * @param preview 该节点的占位与预览实现，取消时负责释放资源。
   */
  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly preview: SourcePreview,
  ) {
    this.nodeType = node.type;
    this.display = node.isBlock;
    this.attribute = preview.kind === "math" ? "tex" : "html";
    this.sourceKey = preview.kind === "math" ? "mathTex" : "htmlSrc";
    this.source = String(node.attrs[this.attribute] ?? "");
    this.dom = document.createElement(this.display ? "div" : "span");
    this.dom.className = `${preview.kind}-${this.display ? "block" : "inline"}`;
    this.dom.dataset[this.sourceKey] = this.source;
    this.dom.dataset[`${preview.kind}Display`] = String(this.display);
    this.dom.contentEditable = "false";
    this.render();
    this.stopObserve = observeViewport(this.dom, (visible) => {
      if (visible === this.visible) return;
      this.visible = visible;
      if (this.sourceEl === null) this.render();
    });
  }

  selectNode(): void {
    if (this.sourceEl !== null) return;
    this.cancelPreview();
    const field = this.display
      ? document.createElement("textarea")
      : document.createElement("input");
    field.className = `${this.preview.kind}-source`;
    field.value = this.source;
    const label = this.preview.kind === "math" ? "公式" : "HTML";
    field.setAttribute("aria-label", `${this.display ? "块级" : "行内"}${label}源码`);
    bindSourceField(field, this.view, this.getPos, this.attribute);
    this.sourceEl = field;
    this.dom.replaceChildren(field);
    queueMicrotask(() => {
      // 选择可能在同一轮事务中撤销，失效的输入框不应再请求焦点。
      if (this.sourceEl !== field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  deselectNode(): void {
    if (this.sourceEl === null) return;
    this.sourceEl = null;
    this.render();
  }

  update(node: PmNode): boolean {
    if (node.type !== this.nodeType) return false;
    const next = String(node.attrs[this.attribute] ?? "");
    if (next === this.source) return true;
    this.source = next;
    this.dom.dataset[this.sourceKey] = next;
    if (this.sourceEl === null) this.render();
    else if (this.sourceEl.value !== next) this.sourceEl.value = next;
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(): boolean {
    return this.sourceEl !== null;
  }

  destroy(): void {
    this.stopObserve();
    this.cancelPreview();
    this.sourceEl = null;
  }

  private render(): void {
    this.cancelPreview();
    if (!this.visible) {
      this.dom.textContent = this.preview.placeholder(this.source, this.display);
      return;
    }
    this.previewController = new AbortController();
    this.preview.render(this.dom, this.source, this.display, this.previewController.signal);
  }

  private cancelPreview(): void {
    this.previewController?.abort();
    this.previewController = null;
  }
}
