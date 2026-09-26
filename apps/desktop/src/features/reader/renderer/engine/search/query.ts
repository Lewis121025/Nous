/**
 * 搜索查询文本解析与摘要切分。
 *
 * 谓词语法（与内核 `SearchQuery` 语义一一对应）：
 *
 * - `tag:名称` 或以 `#` 开头的词 → 标签谓词（祖先标签前缀匹配嵌套子标签）；
 * - `path:子串` → 路径过滤；只有第一个生效，重复的按全文词处理；
 * - `key:value` → frontmatter 属性谓词；键不含 `/` 且值不以 `/` 开头，
 *   避免把 `https://example.com` 这类 URL 误判成属性；
 * - 双引号包裹含空格的词，引号内 `""` 表示字面引号；引号内不解析谓词；
 * - 其余按全文词处理，词间 AND。
 *
 * 大小写与 `#` 前缀的规范化由内核统一执行，这里保留用户原文。
 */

import type { SearchHit, SearchQuery } from "../../../shared/api";

/** 结果上限；与内核默认一致，界面不提供调项。 */
export const SEARCH_LIMIT = 100;

/** 摘要片段；`mark` 为 true 时是命中词，界面渲染为高亮。 */
export type SnippetPart = { text: string; mark: boolean };

/** 分词结果；`quoted` 表示来自引号内，按字面全文词处理。 */
type Token = { text: string; quoted: boolean };

/**
 * 把查询文本解析为结构化检索条件。
 *
 * @param text 搜索框原文，允许为空。
 * @returns 结构化条件；空文本返回全空条件（调用方据 `isEmptyQuery` 退出结果模式）。
 */
export function parseSearchQuery(text: string): SearchQuery {
  const query: SearchQuery = {
    terms: [],
    tags: [],
    attributes: [],
    pathContains: null,
    limit: SEARCH_LIMIT,
  };
  for (const token of tokenize(text)) {
    classify(token, query);
  }
  return query;
}

/** 条件是否为空：没有任何词与谓词时不应发起检索。 */
export function isEmptyQuery(query: SearchQuery): boolean {
  return (
    query.terms.length === 0 &&
    query.tags.length === 0 &&
    query.attributes.length === 0 &&
    query.pathContains === null
  );
}

/** 引号感知的空白分词；引号内 `""` 折叠为字面引号。 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let inQuotes = false;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index] as string;
    if (ch === '"') {
      if (inQuotes && text[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      quoted = quoted || inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (started) tokens.push({ text: current, quoted });
      current = "";
      quoted = false;
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push({ text: current, quoted });
  return tokens.filter((token) => token.text !== "");
}

/** 按谓词语法把一个词归入检索条件；不符合任何谓词结构的按全文词处理。 */
function classify(token: Token, query: SearchQuery): void {
  const raw = token.text;
  if (token.quoted) {
    pushTerm(query, raw);
    return;
  }
  if (raw.startsWith("#")) {
    const tag = raw.slice(1);
    if (tag !== "") {
      pushTag(query, tag);
      return;
    }
  }
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const key = raw.slice(0, colon);
    const value = raw.slice(colon + 1);
    if ((key === "tag" || key === "tags") && value !== "") {
      pushTag(query, value.replace(/^#/, ""));
      return;
    }
    if (key === "path" && value !== "") {
      if (query.pathContains === null) query.pathContains = value;
      else pushTerm(query, raw);
      return;
    }
    // 属性谓词：键不含 `/`、值非空且不以 `/` 开头，URL 与盘符路径保持字面。
    if (!key.includes("/") && value !== "" && !value.startsWith("/")) {
      query.attributes.push({ key, value });
      return;
    }
  }
  pushTerm(query, raw);
}

function pushTerm(query: SearchQuery, text: string): void {
  const term = text.trim();
  if (term !== "" && !query.terms.includes(term)) query.terms.push(term);
}

function pushTag(query: SearchQuery, text: string): void {
  const tag = text.trim();
  if (tag !== "" && !query.tags.includes(tag)) query.tags.push(tag);
}

/**
 * 摘要按控制字符切分为高亮片段；标记不成对时剩余文本按普通片段处理。
 *
 * @param snippet 内核返回的摘要，命中词以 U+0001/U+0002 包围。
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let current = "";
  let marked = false;
  for (const ch of snippet) {
    if (ch === "\u{1}" || ch === "\u{2}") {
      if (current !== "") parts.push({ text: current, mark: marked });
      current = "";
      marked = ch === "\u{1}";
      continue;
    }
    current += ch;
  }
  if (current !== "") parts.push({ text: current, mark: marked });
  return parts;
}

/**
 * 提取跳转定位用的命中词：优先摘要中第一个高亮片段，其次是第一个全文词。
 *
 * 谓词查询（无全文词）没有可定位文本，返回空串，调用方只打开文件不定位。
 */
export function matchNeedle(hit: SearchHit, query: SearchQuery): string {
  const marked = snippetParts(hit.snippet).find((part) => part.mark && part.text.trim() !== "");
  if (marked !== undefined) return marked.text;
  return query.terms[0] ?? "";
}
