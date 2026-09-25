import { decodeString } from "micromark-util-decode-string";

/**
 * 取得节点首行之前的语法前缀，供嵌套结构生成续行。
 * @param source 包含 BOM 的完整源码。
 * @param at 已由解析器确认的节点起点，采用 UTF-16。
 * @returns 行首到节点前的原始内容；文件 BOM 不属于缩进，不能复制到续行。
 */
export function sourceLinePrefix(source: string, at: number): string {
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  const start = lineStart === 0 && source.startsWith("\uFEFF") ? 1 : lineStart;
  return source.slice(start, at);
}

/**
 * 将解析后的文本边界映射回原始文本片段，保留实体、转义和引用续行前缀。
 * @param raw 解析节点覆盖的原始源码。
 * @param value 解析器确认的文本值，位置按 UTF-16 计。
 * @returns 每个文本边界对应的源码偏移；实体内部为 null，无法逐字验证时整体返回 null。
 */
export function sourceTextOffsets(raw: string, value: string): Array<number | null> | null {
  const offsets: Array<number | null> = [0];
  let input = 0;
  let output = 0;
  let lineStart = false;
  while (input < raw.length) {
    if (lineStart && raw[input] !== value[output]) {
      // 只接受 Markdown 的续行空白与引用前缀，且随后仍逐字核对解析值。
      const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(raw.slice(input))?.[0] ?? "";
      input += prefix.length;
      offsets[output] = input;
    }
    const remaining = raw.slice(input);
    const encoded =
      /^(?:\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#[xX][\da-fA-F]+|#\d+|[\da-zA-Z]+);|\r\n|\r)/.exec(
        remaining,
      )?.[0];
    const token = encoded ?? raw[input];
    if (token === undefined) return null;
    const decoded =
      token.startsWith("\r") && !value.startsWith(token, output) ? "\n" : decodeString(token);
    if (!value.startsWith(decoded, output)) return null;
    for (let index = 1; index < decoded.length; index++)
      offsets[output + index] = decoded === token ? input + index : null;
    input += token.length;
    output += decoded.length;
    offsets[output] = input;
    lineStart = /[\r\n]$/.test(decoded);
  }
  return output === value.length ? offsets : null;
}
