/**
 * 笔记里的图片地址：远程原样用，库内文件读字节再变成 blob URL。
 * 解析层只复用文件名判断，不碰 DOM。
 */

export type MediaKind = "md" | "wiki";

/** 注入点，便于测试；渲染进程用 window.nous + URL.createObjectURL。 */
export type MediaIo = {
  resolveLink: (from: string, raw: string, kind: MediaKind) => Promise<string | null>;
  readFile: (rel: string) => Promise<Uint8Array>;
  createUrl: (bytes: Uint8Array, mime: string) => string;
};

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i;

/**
 * 判断 wiki 目标是否按图片嵌入，而不是普通链接。
 *
 * @param src wiki target 或路径，可带 query/hash。
 */
export function isImageFileName(src: string): boolean {
  const path = src.split(/[?#]/, 1)[0] ?? src;
  return IMAGE_EXT.test(path);
}

/**
 * 浏览器能直接当 img.src 的地址，不必读库。
 *
 * @param src Markdown url 或 HTML img src。
 */
export function isRemoteMediaSrc(src: string): boolean {
  return /^(?:https?:|data:|blob:)/i.test(src);
}

/**
 * 由库内路径猜 MIME，给 blob 用。
 *
 * @param path 库内相对路径。
 */
export function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

/**
 * 把笔记里的图片地址变成 `<img>` 能加载的 URL。
 *
 * @param from 当前笔记的库内相对路径。
 * @param src 节点或标签上的原文地址。
 * @param kind wiki 按文件名解析，md 按相对路径拼接。
 * @param io 解析与读文件。
 * @returns 可赋给 img.src 的地址；找不到文件时为 `null`。
 */
export async function resolveMediaUrl(
  from: string,
  src: string,
  kind: MediaKind,
  io: MediaIo,
): Promise<string | null> {
  const trimmed = src.trim();
  if (trimmed === "") {
    return null;
  }
  if (isRemoteMediaSrc(trimmed)) {
    return trimmed;
  }
  try {
    const rel = await io.resolveLink(from, trimmed, kind);
    if (rel === null) {
      return null;
    }
    const bytes = await io.readFile(rel);
    return io.createUrl(bytes, mimeFromPath(rel));
  } catch {
    return null;
  }
}

/**
 * 渲染进程使用的 IO：走 IPC，blob 只活在当前页。
 */
export const browserMediaIo: MediaIo = {
  resolveLink: (from, raw, kind) => window.nous.linksResolve(from, raw, kind),
  readFile: (rel) => window.nous.fileRead(rel),
  createUrl: (bytes, mime) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
  },
};

/**
 * 把消毒后的 HTML 里相对路径 img 换成可加载 URL。
 * 远程地址不动；失败的 src 清空，避免打到 vite 开发服务器。
 *
 * @param root 已挂到页面的消毒 DOM。
 * @param load 相对 src → 可加载 URL。
 */
export async function rewriteMediaSrcs(
  root: ParentNode,
  load: (src: string) => Promise<string | null>,
): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  for (const img of images) {
    const src = img.getAttribute("src") ?? "";
    if (src === "" || isRemoteMediaSrc(src)) {
      continue;
    }
    const url = await load(src);
    if (url === null) {
      img.removeAttribute("src");
      continue;
    }
    img.setAttribute("src", url);
  }
}
