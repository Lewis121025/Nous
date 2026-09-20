/**
 * 入链展示：索引里一条链接一行，界面按源文件去重。
 */

/**
 * 按出现顺序留下每个源文件的第一条入链，供点进去。
 *
 * @param links `indexLinksTo` 的原始记录，同一文件可能出现多次。
 * @returns 去重后的记录；仍保留第一次出现的字节位置。
 */
export function uniqueBacklinks<T extends { fromPath: string }>(links: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const link of links) {
    if (seen.has(link.fromPath)) {
      continue;
    }
    seen.add(link.fromPath);
    out.push(link);
  }
  return out;
}
