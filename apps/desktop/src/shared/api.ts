/**
 * 渲染进程可调用的内核 API。
 *
 * 与 preload `contextBridge` 暴露的对象保持同一类型；禁止在此加入任意文件系统能力。
 */
export type NousApi = Record<string, never>;
