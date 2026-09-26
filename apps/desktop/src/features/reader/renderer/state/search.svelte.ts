import type { ReaderApi, SearchHit, SearchQuery } from "../../shared/api";
import { isEmptyQuery, parseSearchQuery } from "../engine/search/query";

/**
 * 全库搜索状态：已提交的查询、结果与错误。
 *
 * 结果模式与文件树互斥：`active` 为 true 时文件栏展示检索结果。
 * 过期响应按代次丢弃，切库或清空时必须 `reset`，避免旧库结果串到新库。
 */
export class ReaderSearch {
  private submitted = $state<SearchQuery | null>(null);
  private results = $state<SearchHit[]>([]);
  private failure = $state<string | null>(null);
  private running = $state(false);
  private generation = 0;

  /** @param api 只需要检索命令；定位与打开文件由导航和工作区负责。 */
  constructor(private readonly api: Pick<ReaderApi, "searchQuery">) {}

  /** 是否处于结果模式。 */
  get active(): boolean {
    return this.submitted !== null;
  }
  /** 已提交的检索条件；结果模式外为 `null`。 */
  get query(): SearchQuery | null {
    return this.submitted;
  }
  /** 当前结果列表；仅对最近一次成功的检索有效。 */
  get hits(): SearchHit[] {
    return this.results;
  }
  /** 检索失败的原因；成功后自动清除。 */
  get error(): string | null {
    return this.failure;
  }
  /** 是否有检索在途。 */
  get busy(): boolean {
    return this.running;
  }

  /**
   * 提交查询文本执行检索；空文本或纯空白等价于退出结果模式。
   *
   * @param text 搜索框原文，可含谓词。
   */
  async run(text: string): Promise<void> {
    const query = parseSearchQuery(text);
    if (isEmptyQuery(query)) {
      this.reset();
      return;
    }
    const generation = ++this.generation;
    this.submitted = query;
    this.running = true;
    this.failure = null;
    try {
      const hits = await this.api.searchQuery(query);
      if (generation !== this.generation) return;
      this.results = hits;
    } catch (error) {
      if (generation !== this.generation) return;
      this.results = [];
      this.failure = `搜索失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (generation === this.generation) this.running = false;
    }
  }

  /** 退出结果模式并丢弃在途检索的响应。 */
  reset(): void {
    this.generation += 1;
    this.submitted = null;
    this.results = [];
    this.failure = null;
    this.running = false;
  }
}
