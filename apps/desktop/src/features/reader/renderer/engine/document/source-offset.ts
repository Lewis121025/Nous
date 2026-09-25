/**
 * 将内核 UTF-8 字节位置转换为编辑器 UTF-16 下标。
 * @param source 包含 BOM 的原文。
 * @param byteOffset 字节位置；越界夹到文本边界，落在字符内部时向前对齐。
 * @returns 不会切断代理对的 UTF-16 位置。
 * @throws 非有限数或非整数时抛出 RangeError。
 */
export function utf8ByteToJsIndex(source: string, byteOffset: number): number {
  if (!Number.isSafeInteger(byteOffset)) throw new RangeError("源码字节位置必须是安全整数");
  let bytes = 0;
  let position = 0;
  for (const character of source) {
    const point = character.codePointAt(0);
    if (point === undefined) throw new Error("源码字符缺少码点");
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > byteOffset) break;
    bytes += size;
    position += character.length;
  }
  return position;
}

/**
 * 将源码字节位置转换为 CodeMirror 的位置；CRLF 在其文档模型中只占一位。
 * @param source 包含磁盘换行的完整文本。
 * @param byteOffset 内核返回的 UTF-8 字节位置。
 * @returns CodeMirror 文档下标；位置校验沿用 utf8ByteToJsIndex。
 */
export function utf8ByteToCodeIndex(source: string, byteOffset: number): number {
  const end = utf8ByteToJsIndex(source, byteOffset);
  return source.slice(0, end).replace(/\r\n?/g, "\n").length;
}
