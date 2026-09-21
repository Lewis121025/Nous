<script lang="ts">
  /**
   * 可调宽的左右侧栏容器。折叠由外壳决定是否挂载。
   */
  import type { Snippet } from "svelte";
  import { SIDEBAR_LAYOUT } from "../../shared/api";

  type Props = {
    /** 在编辑器哪一侧。 */
    side: "left" | "right";
    /** 当前宽度（像素）。 */
    width: number;
    /** 拖拽调宽。 */
    onWidth: (width: number) => void;
    children: Snippet;
  };

  let { side, width, onWidth, children }: Props = $props();

  function onPointerDown(event: PointerEvent): void {
    const startX = event.clientX;
    const startWidth = width;
    const sign = side === "left" ? 1 : -1;
    const move = (next: PointerEvent): void => {
      const raw = startWidth + sign * (next.clientX - startX);
      onWidth(
        Math.min(SIDEBAR_LAYOUT.maxWidth, Math.max(SIDEBAR_LAYOUT.minWidth, Math.round(raw))),
      );
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<aside
  class="sidebar"
  class:left={side === "left"}
  class:right={side === "right"}
  style:width="{width}px"
>
  <div class="body">{@render children()}</div>
  <button type="button" class="resize" aria-label="调整侧栏宽度" onpointerdown={onPointerDown}
  ></button>
</aside>

<style>
  .sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .left {
    border-right: 1px solid var(--border);
  }

  .right {
    border-left: 1px solid var(--border);
  }

  .body {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .resize {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: col-resize;
  }

  .left .resize {
    right: 0;
  }

  .right .resize {
    left: 0;
  }
</style>
