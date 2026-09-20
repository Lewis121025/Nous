/**
 * 公式尚未排好时的可读 TeX 源，不跑 MathJax。
 *
 * @param tex TeX 源。
 * @param display 是否块级。
 * @returns `$...$` 或 `$$...$$`。
 */
export function mathPlaceholderText(tex: string, display: boolean): string {
  return display ? `$$${tex}$$` : `$${tex}$`;
}
