/**
 * 编辑器挂载后向外暴露的只读操作。
 * 外壳保存时向活动表面取文本，不把 ProseMirror / CodeMirror 实例抬到 App。
 */

/** Markdown 文档表面：序列化当前文档，并按大纲位置跳转。 */
export type MarkdownEditorApi = {
  serialize: () => string;
  /** 把选区移到 heading 节点起点并滚入视野。 */
  jumpTo: (pos: number) => void;
};

/** 代码表面：返回缓冲区内的纯文本。 */
export type CodeEditorApi = {
  getText: () => string;
};
