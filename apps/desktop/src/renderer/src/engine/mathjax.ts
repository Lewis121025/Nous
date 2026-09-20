/**
 * 公式排版入口：有 math_* 才动态加载 MathJax；结果进 LRU，渲染不得改文档。
 * 视口外不排版；样式在第一次 convert 时挂到编辑器根。
 */
import type { MathJaxEngine } from "./mathjax-engine";

const CACHE_LIMIT = 256;
const cache = new Map<string, HTMLElement>();
let enginePromise: Promise<MathJaxEngine> | null = null;

function cacheKey(tex: string, display: boolean): string {
  return `${display ? "d" : "i"}:${tex}`;
}

function cacheGet(key: string): HTMLElement | undefined {
  const hit = cache.get(key);
  if (hit === undefined) {
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: HTMLElement): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= CACHE_LIMIT) {
    return;
  }
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) {
    cache.delete(oldest);
  }
}

async function loadEngine(): Promise<MathJaxEngine> {
  if (enginePromise === null) {
    enginePromise = import("./mathjax-engine").then((mod) => mod.createMathJaxEngine());
  }
  return enginePromise;
}

function cloneCached(node: HTMLElement): HTMLElement {
  const clone = node.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error("公式缓存节点无法克隆");
  }
  return clone;
}

function errorNode(tex: string, display: boolean, message: string): HTMLElement {
  const el = document.createElement(display ? "div" : "span");
  el.className = "math-error";
  el.textContent = message;
  el.dataset.mathTex = tex;
  return el;
}

/**
 * 取出已排好的 CHTML 克隆；未命中返回 null，由调用方走异步排版。
 *
 * @param tex TeX 源。
 * @param display 是否块级。
 */
export function peekRenderedTex(tex: string, display: boolean): HTMLElement | null {
  const hit = cacheGet(cacheKey(tex, display));
  return hit === undefined ? null : cloneCached(hit);
}

/**
 * 把一条 TeX 排成 CHTML。命中 LRU 则不再调用 tex 引擎。
 *
 * 只改返回的 DOM，绝不 dispatch 文档 transaction。
 *
 * @param tex TeX 源，非法时仍返回可见错误节点。
 * @param display 是否块级。
 * @param styleRoot 编辑器根；首次排版时把 CHTML 样式挂到这里。
 */
export async function renderTex(
  tex: string,
  display: boolean,
  styleRoot?: HTMLElement,
): Promise<HTMLElement> {
  const key = cacheKey(tex, display);
  const hit = cacheGet(key);
  if (hit !== undefined) {
    return cloneCached(hit);
  }
  try {
    const engine = await loadEngine();
    if (styleRoot !== undefined) {
      engine.attachStyles(styleRoot);
    }
    const node = await engine.convert(tex, display);
    cacheSet(key, node);
    return cloneCached(node);
  } catch (err) {
    const message = err instanceof Error ? err.message : "公式排版失败";
    return errorNode(tex, display, message);
  }
}
