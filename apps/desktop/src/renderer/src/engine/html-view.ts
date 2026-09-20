/**
 * HTML NodeView：视口内才消毒预览；点进去改源码，失焦才写回 attr。
 * 预览只改 this.dom，不 dispatch；渲染不得标 dirty。
 */
import type { Node as PmNode } from "prosemirror-model";
import type { EditorView, NodeView, NodeViewConstructor } from "prosemirror-view";
import { sanitizeHtml } from "./html";
import { rewriteMediaSrcs } from "./media";
import { observeViewport } from "./viewport";

/**
 * 预览 / 源码两态。消毒结果只进 DOM；只有用户改了 html 才写回 attr。
 */
class HtmlNodeView implements NodeView {
  readonly dom: HTMLElement;
  private html: string;
  private readonly display: boolean;
  private editing = false;
  private visible = false;
  private sourceEl: HTMLTextAreaElement | HTMLInputElement | null = null;
  private renderGen = 0;
  private blobs: string[] = [];
  private readonly stopObserve: () => void;

  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly loadMedia: (src: string) => Promise<string | null>,
  ) {
    this.display = node.type.name === "html_block";
    this.html = String(node.attrs["html"] ?? "");
    this.dom = document.createElement(this.display ? "div" : "span");
    this.dom.className = this.display ? "html-block" : "html-inline";
    this.dom.dataset.htmlSrc = this.html;
    this.dom.dataset.htmlDisplay = this.display ? "true" : "false";
    this.dom.contentEditable = "false";
    this.showPlaceholder();
    this.stopObserve = observeViewport(this.dom, (visible) => {
      this.visible = visible;
      if (this.editing) {
        return;
      }
      if (visible) {
        this.showPreview();
      } else {
        this.showPlaceholder();
      }
    });
  }

  selectNode(): void {
    this.enterEdit();
  }

  deselectNode(): void {
    this.commitEdit();
  }

  update(node: PmNode): boolean {
    const expected = this.display ? "html_block" : "html_inline";
    if (node.type.name !== expected) {
      return false;
    }
    const next = String(node.attrs["html"] ?? "");
    if (next === this.html) {
      return true;
    }
    this.html = next;
    this.dom.dataset.htmlSrc = next;
    if (!this.editing) {
      if (this.visible) {
        this.showPreview();
      } else {
        this.showPlaceholder();
      }
    }
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(): boolean {
    return this.editing;
  }

  destroy(): void {
    this.renderGen += 1;
    this.stopObserve();
    this.revokeBlobs();
  }

  private enterEdit(): void {
    if (this.editing) {
      return;
    }
    this.editing = true;
    this.renderGen += 1;
    this.revokeBlobs();
    const field = this.display
      ? document.createElement("textarea")
      : document.createElement("input");
    field.className = "html-source";
    field.value = this.html;
    this.sourceEl = field;
    this.dom.replaceChildren(field);
    queueMicrotask(() => {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  private commitEdit(): void {
    if (!this.editing) {
      return;
    }
    const next = this.sourceEl?.value ?? this.html;
    this.editing = false;
    this.sourceEl = null;
    if (next !== this.html) {
      const pos = this.getPos();
      if (typeof pos === "number") {
        const tr = this.view.state.tr.setNodeMarkup(pos, null, { html: next });
        this.view.dispatch(tr);
        return;
      }
      this.html = next;
    }
    if (this.visible) {
      this.showPreview();
    } else {
      this.showPlaceholder();
    }
  }

  private showPlaceholder(): void {
    this.renderGen += 1;
    this.revokeBlobs();
    this.dom.textContent = this.html;
  }

  private showPreview(): void {
    const gen = ++this.renderGen;
    this.revokeBlobs();
    this.dom.replaceChildren(sanitizeHtml(this.html));
    const blobs: string[] = [];
    void rewriteMediaSrcs(this.dom, async (src) => {
      const url = await this.loadMedia(src);
      if (url !== null && url.startsWith("blob:")) {
        blobs.push(url);
      }
      return url;
    }).then(() => {
      if (gen !== this.renderGen || this.editing || !this.visible) {
        for (const url of blobs) {
          URL.revokeObjectURL(url);
        }
        return;
      }
      this.blobs = blobs;
    });
  }

  private revokeBlobs(): void {
    for (const url of this.blobs) {
      URL.revokeObjectURL(url);
    }
    this.blobs = [];
  }
}

/**
 * 行内/块级共用同一套预览与失焦提交，避免两套 NodeView。
 *
 * @param loadMedia 把 HTML 里的相对 img src 变成可加载 URL。
 */
export function createHtmlNodeViews(
  loadMedia: (src: string) => Promise<string | null>,
): Record<string, NodeViewConstructor> {
  return {
    html_inline: (node, view, getPos) => new HtmlNodeView(node, view, getPos, loadMedia),
    html_block: (node, view, getPos) => new HtmlNodeView(node, view, getPos, loadMedia),
  };
}
