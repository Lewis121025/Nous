/**
 * 入链刷新的提交闸门：只接受仍是最新世代的结果，避免慢请求盖掉当前笔记。
 */

import type { Mentions } from "../../../shared/api";

/** 没有打开笔记、或这次查询不含当前路径时的空列表。 */
export const EMPTY_MENTIONS: Mentions = { linked: [], unlinked: [] };

/**
 * 把一次入链查询写进缓存。世代落后则丢弃，不改状态。
 *
 * @param input.startedGen 发起这次查询时的世代。
 * @param input.latestGen 当前外壳上的最新世代。
 * @param input.current 提交时打开的笔记；用来填跟随列表。
 * @param input.fetched 这次查询拿到的路径 → 提及。
 * @returns 可写入的缓存；过期为 `null`。
 */
export function commitMentionsRefresh(input: {
  startedGen: number;
  latestGen: number;
  current: string | null;
  fetched: Record<string, Mentions>;
}): { mentionCache: Record<string, Mentions>; followMentions: Mentions } | null {
  if (input.startedGen !== input.latestGen) {
    return null;
  }
  return {
    mentionCache: input.fetched,
    followMentions:
      input.current === null ? EMPTY_MENTIONS : (input.fetched[input.current] ?? EMPTY_MENTIONS),
  };
}
