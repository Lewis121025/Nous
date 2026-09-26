import { describe, expect, it, vi } from "vitest";
import { ReaderSearch } from "@reader/renderer/state/search.svelte";
import type { SearchHit } from "@reader/shared/api";
import { parseSearchQuery } from "@reader/renderer/engine/search/query";

const hit = (path: string): SearchHit => ({ path, title: path, snippet: "" });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ReaderSearch", () => {
  it("提交查询进入结果模式，条件按查询文本解析", async () => {
    const searchQuery = vi.fn(async () => [hit("a.md")]);
    const search = new ReaderSearch({ searchQuery });
    expect(search.active).toBe(false);
    await search.run("alpha tag:keep");
    expect(search.active).toBe(true);
    expect(searchQuery).toHaveBeenCalledWith(parseSearchQuery("alpha tag:keep"));
    expect(search.hits.map((item) => item.path)).toEqual(["a.md"]);
    expect(search.error).toBeNull();
    expect(search.busy).toBe(false);
  });

  it("过期响应被丢弃：先发的查询后完成不覆盖后发结果", async () => {
    const first = deferred<SearchHit[]>();
    const second = deferred<SearchHit[]>();
    const searchQuery = vi
      .fn<(query: unknown) => Promise<SearchHit[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const search = new ReaderSearch({ searchQuery });
    const runA = search.run("alpha");
    const runB = search.run("beta");
    second.resolve([hit("b.md")]);
    await runB;
    expect(search.hits.map((item) => item.path)).toEqual(["b.md"]);
    first.resolve([hit("a.md")]);
    await runA;
    expect(search.hits.map((item) => item.path)).toEqual(["b.md"]);
    expect(search.busy).toBe(false);
  });

  it("reset 退出结果模式并丢弃在途响应", async () => {
    const pending = deferred<SearchHit[]>();
    const searchQuery = vi
      .fn<(query: unknown) => Promise<SearchHit[]>>()
      .mockReturnValueOnce(pending.promise);
    const search = new ReaderSearch({ searchQuery });
    const running = search.run("alpha");
    search.reset();
    expect(search.active).toBe(false);
    pending.resolve([hit("a.md")]);
    await running;
    expect(search.hits).toEqual([]);
    expect(search.busy).toBe(false);
  });

  it("空文本不发起请求并退出结果模式", async () => {
    const searchQuery = vi.fn(async () => []);
    const search = new ReaderSearch({ searchQuery });
    await search.run("alpha");
    await search.run("   ");
    expect(searchQuery).toHaveBeenCalledTimes(1);
    expect(search.active).toBe(false);
  });

  it("检索失败展示原因并清空结果，下一次成功自动清除错误", async () => {
    const searchQuery = vi
      .fn<(query: unknown) => Promise<SearchHit[]>>()
      .mockRejectedValueOnce(new Error("索引损坏"))
      .mockResolvedValueOnce([hit("a.md")]);
    const search = new ReaderSearch({ searchQuery });
    await search.run("alpha");
    expect(search.error).toContain("搜索失败");
    expect(search.error).toContain("索引损坏");
    expect(search.hits).toEqual([]);
    expect(search.busy).toBe(false);
    await search.run("alpha");
    expect(search.error).toBeNull();
    expect(search.hits).toHaveLength(1);
  });
});
