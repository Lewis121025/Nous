import type {
  HistoryAction,
  HistoryAvailability,
  MentionRecord,
  Mentions,
  ReaderApi,
} from "../../shared/api";
import type { CodeEditorApi, MarkdownEditorApi } from "../engine/editing/editor-api";
import { mentionOccurrenceIndex } from "../engine/navigation/backlinks";
import { buildOutlineTree, outlineEquals, type OutlineItem } from "../engine/navigation/outline";
import type { ReaderDocument } from "./document.svelte";
import type { EditorSnapshot } from "../engine/markdown/source-session";

/** 阅读上下文：目录折叠、引用查询及等待编辑器挂载后的定位，不参与文件写入。 */
export class ReaderNavigation {
  private headings = $state<OutlineItem[]>([]);
  private tree = $derived(buildOutlineTree(this.headings));
  private collapsed = $state<Record<string, string[]>>({});
  private references = $state<Mentions>({ linked: [], unlinked: [] });
  private mentionGeneration = 0;
  private pending: { mention: MentionRecord; all: MentionRecord[] } | null = null;
  private markdown = $state.raw<MarkdownEditorApi | null>(null);
  private code = $state.raw<CodeEditorApi | null>(null);

  /** @param document 用于判断查询、定位与编辑器所属文档的唯一状态。 */
  constructor(private readonly document: ReaderDocument) {}

  /** 当前编辑器接管历史动作；没有编辑器或焦点属于普通输入框时交还外壳。 */
  applyHistory(action: HistoryAction): boolean {
    return this.markdown?.history(action) ?? this.code?.history(action) ?? false;
  }

  /** 当前已挂载输入表面的历史投影；null 表示交由外壳查询原生控件。 */
  get historyAvailability(): HistoryAvailability | null {
    return this.markdown?.historyAvailability() ?? this.code?.historyAvailability() ?? null;
  }

  /** 打开活动 Markdown 文档的附件选择器；其他预览表面没有此动作。 */
  openAttachments(): void {
    this.markdown?.openAttachments();
  }

  /** 离开编辑器前等待附件引用进入文档，供保存门禁获取最终快照。 */
  settleAttachments(): Promise<boolean> {
    return this.markdown?.settleAttachments() ?? Promise.resolve(true);
  }

  /** 当前目录树，仅标题或层级变化时由编辑器更新。 */
  get outlineTree() {
    return this.tree;
  }
  /** 当前文档是否有目录。 */
  get hasOutline() {
    return this.document.content?.kind === "markdown" && this.headings.length > 0;
  }
  /** 每篇文件独立的目录折叠键。 */
  get collapsedKeys() {
    return this.document.path === null ? [] : (this.collapsed[this.document.path] ?? []);
  }
  /** 当前文档的已链接与未链接提及。 */
  get mentions() {
    return this.references;
  }

  /** 清除上一文档的引用并使其查询失效，等待中的跨文件定位仍保留。 */
  resetReferences(): void {
    this.mentionGeneration += 1;
    this.references = { linked: [], unlinked: [] };
  }

  /** 清空工作区时同时丢弃目录与等待定位，不保留上一文档的界面状态。 */
  clear(): void {
    this.resetReferences();
    this.headings = [];
    this.pending = null;
  }

  /**
   * 查询当前文档引用；切换文档或后续查询开始后丢弃旧结果。
   * @param api 阅读器索引查询能力。
   * @returns 当前查询的错误文本或 null，旧查询的错误同样丢弃。
   */
  async refreshMentions(api: Pick<ReaderApi, "indexMentionsTo">): Promise<string | null> {
    const { epoch, path } = this.document;
    const generation = ++this.mentionGeneration;
    if (path === null) return null;
    const isCurrent = () =>
      generation === this.mentionGeneration &&
      epoch === this.document.epoch &&
      path === this.document.path;
    try {
      const mentions = await api.indexMentionsTo(path);
      if (isCurrent()) this.references = mentions;
      return null;
    } catch (error) {
      return isCurrent()
        ? `引用暂不可用：${error instanceof Error ? error.message : String(error)}`
        : null;
    }
  }

  /** @param items 编辑器解析出的标题；相同目录不触发重复更新。 */
  setOutline = (items: OutlineItem[]): void => {
    if (!outlineEquals(this.headings, items)) this.headings = items;
  };

  /** @param key 当前文件中需要切换展开状态的标题键。 */
  toggleOutline = (key: string): void => {
    const path = this.document.path;
    if (path === null) return;
    const keys = this.collapsed[path] ?? [];
    this.collapsed = {
      ...this.collapsed,
      [path]: keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key],
    };
  };

  /** @param pos 当前 Markdown 文档中的标题位置。 */
  jumpOutline(pos: number): void {
    this.markdown?.jumpTo(pos);
  }

  /** 打开当前文档的查找入口；附件预览与编辑器尚未挂载时不执行操作。 */
  openSearch = (): void => {
    if (this.document.content?.kind === "markdown") this.markdown?.openSearch();
    else if (this.document.content?.kind === "text") this.code?.openSearch();
  };

  /** 文件操作完成后恢复写作焦点；只操作当前已挂载的编辑器，不改变选区或滚动位置。 */
  focusEditor = (): void => {
    if (this.document.content?.kind === "markdown") this.markdown?.focus();
    else if (this.document.content?.kind === "text") this.code?.focus();
  };

  /** 注册与注销时不清目录，目录清理由编辑器 onOutline 负责，避免挂载时状态竞争。 */
  registerMarkdown = (api: MarkdownEditorApi | null): void => {
    this.markdown = api;
    if (api !== null) this.applyPendingJump();
  };

  /** @param api 当前文本编辑器；挂载完成后兑现等待定位，卸载时传 null。 */
  registerCode = (api: CodeEditorApi | null): void => {
    this.code = api;
    if (api !== null) this.applyPendingJump();
  };

  /** @returns 当前编辑器的内容快照；编辑器未就绪或附件不支持编辑时抛出错误。 */
  snapshot = (): EditorSnapshot => {
    if (this.document.content?.kind === "markdown") {
      if (this.markdown === null) throw new Error("文档编辑器尚未就绪");
      return this.markdown.snapshot();
    }
    if (this.document.content?.kind !== "text" || this.code === null)
      throw new Error("文本编辑器尚未就绪");
    return this.code.snapshot();
  };

  /**
   * 打开引用来源并等待其编辑器挂载；切换被保存门禁阻止时取消定位。
   * @param mention 目标引用。
   * @param openFile 工作区提供的受保存门禁保护的文件切换。
   */
  async openMention(
    mention: MentionRecord,
    openFile: (path: string) => Promise<void>,
  ): Promise<void> {
    this.pending = { mention, all: [...this.references.linked, ...this.references.unlinked] };
    try {
      if (mention.fromPath === this.document.path) this.applyPendingJump();
      else await openFile(mention.fromPath);
    } finally {
      if (this.document.path !== mention.fromPath) this.pending = null;
    }
  }

  private applyPendingJump(): void {
    const pending = this.pending;
    if (pending === null || pending.mention.fromPath !== this.document.path) return;
    if (this.document.content?.kind === "markdown") {
      if (this.markdown === null) return;
      this.markdown.jumpToMention(
        pending.mention,
        mentionOccurrenceIndex(pending.all, pending.mention),
      );
    } else if (this.document.content?.kind === "text") {
      if (this.code === null) return;
      this.code.jumpToByte(pending.mention.startByte);
    }
    this.pending = null;
  }
}
