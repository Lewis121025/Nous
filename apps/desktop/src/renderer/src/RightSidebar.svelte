<script lang="ts">
  /**
   * 右侧栏视图宿主：标签切换，可上下拆成两个槽。
   */
  import type { Snippet } from "svelte";
  import type { SidebarSlot, SidebarViewId } from "../../shared/api";

  type Props = {
    split: boolean;
    slots: SidebarSlot[];
    onSelect: (index: number, viewId: SidebarViewId) => void;
    onToggleSplit: () => void;
    children: Snippet<[index: number, slot: SidebarSlot]>;
  };

  let { split, slots, onSelect, onToggleSplit, children }: Props = $props();

  function isActive(index: number, viewId: SidebarViewId): boolean {
    return slots[index]?.viewId === viewId;
  }
</script>

<div class="host">
  <div class="chrome">
    <button type="button" class="split" aria-pressed={split} onclick={onToggleSplit}>
      {split ? "合并" : "拆分"}
    </button>
  </div>
  <div class="slots" class:split>
    {#each slots as slot, index (index)}
      <div class="slot">
        <div class="tab-row">
          <button
            type="button"
            class="tab"
            aria-pressed={isActive(index, "backlinks")}
            onclick={() => onSelect(index, "backlinks")}
          >
            入链
          </button>
          <button
            type="button"
            class="tab"
            aria-pressed={isActive(index, "outline")}
            onclick={() => onSelect(index, "outline")}
          >
            目录
          </button>
        </div>
        <div class="slot-body">
          {@render children(index, slot)}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .host {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .chrome {
    display: flex;
    justify-content: flex-end;
    padding: 0.25rem 0.4rem;
    border-bottom: 1px solid var(--border);
  }

  .tab-row {
    display: flex;
    gap: 0.15rem;
    padding: 0.25rem 0.4rem;
    border-bottom: 1px solid var(--border);
  }

  .tab[aria-pressed="true"],
  .split[aria-pressed="true"] {
    font-weight: 600;
  }

  .slot-body {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .slots {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }

  .slots.split .slot {
    flex: 1 1 0;
    min-height: 0;
    border-bottom: 1px solid var(--border);
  }

  .slots.split .slot:last-child {
    border-bottom: none;
  }

  .slot {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  button {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 0.15rem 0.4rem;
    cursor: pointer;
  }
</style>
