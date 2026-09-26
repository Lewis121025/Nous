import { HISTORY_LIMIT, type HistoryEntry, type SessionHistory } from "../../shared/session";

/** 会话内的阅读栈条目：持久化形态加上滚动位置（只对本次运行有意义）。 */
export type ReadingStep = HistoryEntry & { scrollTop: number | null };

/** 滚动捕获与恢复能力，由工作区外壳绑定到真实滚动容器。 */
export type ScrollBridge = {
  /** 离开文档前记录滚动位置；容器缺席时返回 null。 */
  capture: () => number | null;
  /** 回到文档后恢复滚动位置。 */
  apply: (top: number) => void;
};

/**
 * 阅读栈：文档导航的后退/前进双栈。
 *
 * 语义与浏览器一致：新导航清空前进栈；后退把当前位置压入前进栈。
 * 滚动位置只在会话内恢复，持久化形态只保留路径与锚点（重启后布局
 * 与滚动值不再可靠，锚点是稳定的落点）。
 */
export class ReaderHistory {
  private backward = $state<ReadingStep[]>([]);
  private forward = $state<ReadingStep[]>([]);
  private scroll: ScrollBridge | null = null;

  /** 绑定滚动容器；未绑定时条目不携带滚动位置。 */
  attachScroll(scroll: ScrollBridge): void {
    this.scroll = scroll;
  }

  /** 是否可后退。 */
  get canBack(): boolean {
    return this.backward.length > 0;
  }
  /** 是否可前进。 */
  get canForward(): boolean {
    return this.forward.length > 0;
  }

  /** 捕获当前位置为完整条目（含滚动）。 */
  captureStep(entry: HistoryEntry): ReadingStep {
    return { ...entry, scrollTop: this.scroll?.capture() ?? null };
  }

  /** 新导航入栈：清空前进栈，超限丢最旧。 */
  pushStep(step: ReadingStep): void {
    this.backward = [...this.backward, step].slice(-HISTORY_LIMIT);
    this.forward = [];
  }

  /** 后退目标（不出栈）；门禁通过后由 `commitBack` 提交。 */
  peekBack(): ReadingStep | null {
    return this.backward[this.backward.length - 1] ?? null;
  }

  /** 前进目标（不出栈）；门禁通过后由 `commitForward` 提交。 */
  peekForward(): ReadingStep | null {
    return this.forward[0] ?? null;
  }

  /** 提交后退：目标出后退栈，当前位置入前进栈。 */
  commitBack(current: ReadingStep): void {
    this.backward = this.backward.slice(0, -1);
    this.forward = [current, ...this.forward].slice(0, HISTORY_LIMIT);
  }

  /** 提交前进：目标出前进栈，当前位置入后退栈。 */
  commitForward(current: ReadingStep): void {
    this.forward = this.forward.slice(1);
    this.backward = [...this.backward, current].slice(-HISTORY_LIMIT);
  }

  /** 按当前滚动位置恢复条目；无值时不动滚动。 */
  applyScroll(step: ReadingStep): void {
    if (step.scrollTop !== null) this.scroll?.apply(step.scrollTop);
  }

  /**
   * 改名/移动后的路径跟随；`to === null`（删除）时移除受影响条目。
   * 目录前缀整体迁移，与文件栏的路径跟随同一语义。
   */
  remapPath(from: string, to: string | null): void {
    const remap = (step: ReadingStep): ReadingStep | null => {
      if (step.path === from) return to === null ? null : { ...step, path: to };
      if (step.path.startsWith(`${from}/`))
        return to === null ? null : { ...step, path: `${to}${step.path.slice(from.length)}` };
      return step;
    };
    const apply = (steps: ReadingStep[]): ReadingStep[] =>
      steps.flatMap((step) => {
        const mapped = remap(step);
        return mapped === null ? [] : [mapped];
      });
    this.backward = apply(this.backward);
    this.forward = apply(this.forward);
  }

  /** 清空双栈；切库时使用。 */
  clear(): void {
    this.backward = [];
    this.forward = [];
  }

  /** 持久化快照：剥离滚动位置。 */
  snapshot(): SessionHistory {
    const strip = (steps: ReadingStep[]): HistoryEntry[] =>
      steps.map(({ path, anchor }) => ({ path, anchor }));
    return { back: strip(this.backward), forward: strip(this.forward) };
  }

  /**
   * 从会话恢复；按当前文件列表过滤失效条目。
   *
   * @param history 会话里的持久化形态。
   * @param exists 路径是否仍存在于当前库。
   */
  restore(history: SessionHistory, exists: (path: string) => boolean): void {
    const filter = (entries: readonly HistoryEntry[]): ReadingStep[] =>
      entries.filter((entry) => exists(entry.path)).map((entry) => ({ ...entry, scrollTop: null }));
    this.backward = filter(history.back).slice(-HISTORY_LIMIT);
    this.forward = filter(history.forward).slice(0, HISTORY_LIMIT);
  }
}
