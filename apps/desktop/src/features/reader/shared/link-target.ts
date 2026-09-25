/** 判断目标是否声明 URL 协议；内部相对路径不交给操作系统。 */
export function hasUrlScheme(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target.trim());
}

/**
 * 校验由用户点击的外链，主进程必须再次校验，不信任渲染进程输入。
 * @param value 原始目标。
 * @returns 浏览器或邮件客户端可打开的规范 URL。
 * @throws 非字符串、无效 URL 或非 HTTP/HTTPS/mailto 协议时拒绝。
 */
export function externalUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    throw new Error("外部链接地址无效");
  const url = new URL(value);
  if (!["http:", "https:", "mailto:"].includes(url.protocol))
    throw new Error("仅支持网页和邮件链接");
  return url.href;
}
