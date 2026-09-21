/**
 * 编辑器挂载后向外暴露的只读操作。
 * 外壳保存时向活动表面取文本，不把 ProseMirror / CodeMirror 实例抬到 App。
 */
import type { MentionRecord } from "../../../shared/api";

/** Markdown 文档表面：序列化当前文档，并按大纲或提及位置跳转。 */
export type MarkdownEditorApi = {
  serialize: () => string;
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
  getText: () => string;
  /**
   * 把光标移到 UTF-8 字节对应的位置。
   *
   * @param byteOffset 源文件 UTF-8 字节下标。
   */
  jumpToByte: (byteOffset: number) => void;
};
