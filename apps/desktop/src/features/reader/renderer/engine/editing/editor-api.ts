/**
 * 编辑器挂载后向外暴露的文本读取与交互入口。
 * 外壳保存时向活动表面取文本，不把 ProseMirror / CodeMirror 实例抬到 App。
 */
import type { HistoryAction, HistoryAvailability, MentionRecord } from "../../../shared/api";
import type { EditorSnapshot } from "../markdown/source-session";

/** Markdown 文档表面：读取带内容版本的保真快照，并按大纲或提及位置跳转。 */
export type MarkdownEditorApi = {
  /** 正文和就地源码共用文档历史；焦点属于外部普通输入框时返回 false。 */
  history: (action: HistoryAction) => boolean;
  /** 响应式读取文档历史；焦点属于外部原生输入框时返回 null。 */
  historyAvailability: () => HistoryAvailability | null;
  /** 从当前文档选区打开附件选择器，取消不改动正文。 */
  openAttachments: () => void;
  /** 等待附件导入与引用插入；失败返回 false，必须先重试或关闭失败提示。 */
  settleAttachments: () => Promise<boolean>;
  /** 将键盘焦点交给正文，保留已有文档选区。 */
  focus: () => void;
  /** 打开文内查找；已打开时选中查询词，不重置查询或文档选区。 */
  openSearch: () => void;
  /** 获取保留原始格式的字节快照；无法安全映射时抛出错误。 */
  snapshot: () => EditorSnapshot;
  /** 把选区移到标题内，并把该标题滚到阅读区顶部。 */
  jumpTo: (pos: number) => void;
  /**
   * 跳到入链/未链接命中。
   *
   * @param mention 提及记录。
   * @param occurrence 同一文件里同类命中的次序（从 1 计）。
   */
  jumpToMention: (mention: MentionRecord, occurrence: number) => void;
};

/** 代码表面：返回缓冲区内的纯文本，并按字节跳转。 */
export type CodeEditorApi = {
  /** 操作代码历史；查找框等普通输入控件保留自身历史并返回 false。 */
  history: (action: HistoryAction) => boolean;
  /** 响应式读取代码历史；焦点属于外部原生输入框时返回 null。 */
  historyAvailability: () => HistoryAvailability | null;
  /** 将键盘焦点交给文本编辑器，保留已有选区。 */
  focus: () => void;
  /** 打开文内查找；焦点交由 CodeMirror 的搜索面板管理。 */
  openSearch: () => void;
  /** 获取当前内容字节及编辑版本，保留打开时的换行方式。 */
  snapshot: () => EditorSnapshot;
  /**
   * 把光标移到 UTF-8 字节对应的位置。
   *
   * @param byteOffset 源文件 UTF-8 字节下标。
   */
  jumpToByte: (byteOffset: number) => void;
};
