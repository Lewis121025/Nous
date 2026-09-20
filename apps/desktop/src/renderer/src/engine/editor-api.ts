/**
 * 编辑器挂载后向外暴露的只读操作。
 * 外壳保存时向活动表面取文本，不把 ProseMirror / CodeMirror 实例抬到 App。
 */

/** Markdown 文档表面：把当前 PM 树序列化为确定性 Markdown。 */
export type MarkdownEditorApi = {
  serialize: () => string;
};

/** 代码表面：返回缓冲区内的纯文本。 */
export type CodeEditorApi = {
  getText: () => string;
};
