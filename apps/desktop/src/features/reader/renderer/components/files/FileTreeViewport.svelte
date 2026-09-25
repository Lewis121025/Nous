<script lang="ts">
  import { onMount, tick, type Snippet } from "svelte";
  import type { FileTreeRow } from "../../engine/navigation/file-tree";
  import { fileTreeWindow } from "../../engine/navigation/file-tree-window";

  let {
    rows,
    focusable,
    dragging,
    children,
  }: {
    rows: FileTreeRow[];
    focusable: string | null;
    dragging: string | null;
    children: Snippet<[FileTreeRow]>;
  } = $props();
  const descriptionId = $props.id();
  let element: HTMLUListElement;
  let measure: HTMLLIElement;
  let scrollTop = $state(0);
  let height = $state(0);
  let rowHeight = $state(35.2);
  const positions = $derived(new Map(rows.map((row, index) => [row.node.path, index])));
  const indices = $derived(
    fileTreeWindow(rows.length, scrollTop, height, rowHeight, [
      positions.get(focusable ?? "") ?? -1,
      positions.get(dragging ?? "") ?? -1,
    ]),
  );

  onMount(() => {
    function measureViewport(): void {
      height = element.clientHeight;
      scrollTop = element.scrollTop;
      const measured = measure.getBoundingClientRect().height;
      if (measured > 0) rowHeight = measured;
    }
    measureViewport();
    const observer = new ResizeObserver(measureViewport);
    observer.observe(element);
    observer.observe(measure);
    return () => observer.disconnect();
  });

  /** 新查询从顶部展示结果；保留完整目录的选中项和展开状态。 */
  export function resetScroll(): void {
    element.scrollTop = 0;
    scrollTop = 0;
  }

  /**
   * 将完整目录中的条目滚入视口，挂载后再交还键盘焦点。
   * @param path 可见目录模型中的完整相对路径；已消失的条目不产生操作。
   */
  export async function focusPath(path: string): Promise<void> {
    const index = positions.get(path);
    if (index === undefined) return;
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = bottom - element.clientHeight;
    scrollTop = element.scrollTop;
    await tick();
    Array.from(element.querySelectorAll<HTMLButtonElement>("[data-path]"))
      .find((button) => button.dataset.path === path)
      ?.focus({ preventScroll: true });
  }
</script>

<span id={descriptionId} hidden>共 {rows.length} 个文件和文件夹，可用方向键浏览。</span>
<ul
  class="list-body"
  class:empty-tree={rows.length === 0}
  role="tree"
  aria-label="笔记库目录"
  aria-describedby={descriptionId}
  bind:this={element}
  onscroll={() => {
    scrollTop = element.scrollTop;
  }}
>
  <li class="measure" aria-hidden="true" bind:this={measure}></li>
  <li class="extent" aria-hidden="true" style:height="{rows.length * rowHeight}px"></li>
  {#each indices as index (rows[index]!.node.path)}
    <li class="tree-row" role="none" style:top="{index * rowHeight}px">
      {@render children(rows[index]!)}
    </li>
  {/each}
</ul>

<style>
  .list-body {
    --file-row-height: 2.2rem;
    position: relative;
    list-style: none;
    margin: 0;
    overflow: auto;
    flex: 1 1 auto;
    min-height: 0;
    padding: 0 0.55rem 0.75rem;
    overflow-anchor: none;
  }
  .measure {
    position: absolute;
    width: 0;
    height: var(--file-row-height);
    visibility: hidden;
    pointer-events: none;
  }
  .extent {
    pointer-events: none;
  }
  .tree-row {
    position: absolute;
    left: 0.55rem;
    right: 0.55rem;
    height: var(--file-row-height);
  }
  .empty-tree {
    flex: 0;
    padding: 0;
  }
</style>
