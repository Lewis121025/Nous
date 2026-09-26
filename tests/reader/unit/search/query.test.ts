import { describe, expect, it } from "vitest";
import {
  isEmptyQuery,
  matchNeedle,
  parseSearchQuery,
  SEARCH_LIMIT,
  snippetParts,
} from "@reader/renderer/engine/search/query";

describe("parseSearchQuery", () => {
  it("裸词成为全文词，去重并容忍多余空白", () => {
    expect(parseSearchQuery("  alpha   beta alpha ").terms).toEqual(["alpha", "beta"]);
    expect(parseSearchQuery("全文 检索").terms).toEqual(["全文", "检索"]);
    expect(parseSearchQuery("alpha").tags).toEqual([]);
    expect(parseSearchQuery("alpha").attributes).toEqual([]);
    expect(parseSearchQuery("alpha").pathContains).toBeNull();
    expect(parseSearchQuery("alpha").limit).toBe(SEARCH_LIMIT);
  });

  it("引号内按字面处理：空格成词、双引号折叠、不解析谓词", () => {
    const query = parseSearchQuery('"tag:not-a-predicate" "a ""b"" c"');
    expect(query.terms).toEqual(["tag:not-a-predicate", 'a "b" c']);
    expect(query.tags).toEqual([]);
  });

  it("tag: 与 # 前缀等价成为标签谓词，# 前缀被剥掉", () => {
    const query = parseSearchQuery("tag:project #inline tags:#draft");
    expect(query.tags).toEqual(["project", "inline", "draft"]);
    expect(query.terms).toEqual([]);
  });

  it("path: 第一个生效，重复的按全文词处理", () => {
    const query = parseSearchQuery("path:notes/ path:docs word");
    expect(query.pathContains).toBe("notes/");
    expect(query.terms).toEqual(["path:docs", "word"]);
  });

  it("key:value 成为属性谓词；URL 与空值保持字面全文词", () => {
    const query = parseSearchQuery("status:draft https://example.com 时间: 上午 :lonely");
    expect(query.attributes).toEqual([{ key: "status", value: "draft" }]);
    expect(query.terms).toEqual(["https://example.com", "时间:", "上午", ":lonely"]);
  });

  it("空文本不产生条件，孤立 # 按字面全文词处理", () => {
    expect(isEmptyQuery(parseSearchQuery("   "))).toBe(true);
    expect(parseSearchQuery("#").terms).toEqual(["#"]);
    expect(isEmptyQuery(parseSearchQuery("tag:x"))).toBe(false);
  });
});

describe("snippetParts", () => {
  it("按控制字符切分高亮与普通片段", () => {
    expect(snippetParts("before\u{1}hit\u{2}after")).toEqual([
      { text: "before", mark: false },
      { text: "hit", mark: true },
      { text: "after", mark: false },
    ]);
    expect(snippetParts("plain")).toEqual([{ text: "plain", mark: false }]);
    expect(snippetParts("")).toEqual([]);
  });

  it("不成对标记不丢正文", () => {
    expect(snippetParts("a\u{1}b")).toEqual([
      { text: "a", mark: false },
      { text: "b", mark: true },
    ]);
  });
});

describe("matchNeedle", () => {
  const hit = (snippet: string) => ({ path: "a.md", title: "A", snippet });

  it("优先摘要高亮片段，其次第一个全文词，谓词查询为空", () => {
    expect(matchNeedle(hit("x\u{1}Alpha\u{2}y"), parseSearchQuery("alpha beta"))).toBe("Alpha");
    expect(matchNeedle(hit(""), parseSearchQuery("alpha beta"))).toBe("alpha");
    expect(matchNeedle(hit(""), parseSearchQuery("tag:t"))).toBe("");
  });
});
