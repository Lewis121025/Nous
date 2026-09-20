/**
 * 保存时的字节选择：未改走 identity，已改才序列化。
 */

/**
 * 决定写回磁盘的字节。
 *
 * 未修改时必须返回打开时的原始字节，且不得调用 `serialize`，
 * 这样反复保存不会把未改动的 Markdown 规范化。
 *
 * @param dirty 当前缓冲是否相对打开时有过编辑。
 * @param original 打开（或上次保存）时的原始字节。
 * @param serialize 已修改时用于生成规范化文本。
 * @returns 应交给 `file.write` 的字节。
 */
export function bytesForSave(
  dirty: boolean,
  original: Uint8Array,
  serialize: () => string,
): Uint8Array {
  if (!dirty) {
    return original;
  }
  return new TextEncoder().encode(serialize());
}
