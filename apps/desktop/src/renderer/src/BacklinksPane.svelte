<script lang="ts">
  /**
   * 入链视图：已链接/未链接分组、过滤、排序、上下文、钉住。
   */
  import type { MentionRecord, Mentions } from "../../shared/api";
  import { SvelteSet } from "svelte/reactivity";
  import { displaySnippet, presentMentions, type MentionSort } from "./engine/backlinks";

  type Props = {
    /** 当前跟随或钉住的笔记路径，仅展示。 */
    notePath: string | null;
    mentions: Mentions;
    pinned: boolean;
    onTogglePin: () => void;
    onOpen: (mention: MentionRecord) => void;
    /** 文档内嵌入时不显示钉住。 */
    embedded?: boolean;
  };

  let { notePath, mentions, pinned, onTogglePin, onOpen, embedded = false }: Props = $props();

  let query = $state("");
  let sort = $state<MentionSort>("pathAsc");
  let collapsedResults = $state(false);
  let moreContext = $state(false);
  let collapsedGroups = new SvelteSet<string>();
  let linkedOpen = $state(true);
  let unlinkedOpen = $state(true);

  const linkedGroups = $derived(presentMentions(mentions.linked, { query, sort }));
  const unlinkedGroups = $derived(presentMentions(mentions.unlinked, { query, sort }));
  const linkedCount = $derived(countItems(linkedGroups));
  const unlinkedCount = $derived(countItems(unlinkedGroups));

  function countItems(groups: { items: MentionRecord[] }[]): number {
    return groups.reduce((sum, group) => sum + group.items.length, 0);
  }

  function toggleGroup(key: string): void {
    if (collapsedGroups.has(key)) {
      collapsedGroups.delete(key);
    } else {
      collapsedGroups.add(key);
    }
  }

  function pieces(snippet: string, match: string): Array<{ text: string; hit: boolean }> {
    if (match === "") {
      return [{ text: snippet, hit: false }];
    }
    const lower = snippet.toLowerCase();
    const needle = match.toLowerCase();
    const out: Array<{ text: string; hit: boolean }> = [];
    let from = 0;
    let at = lower.indexOf(needle, from);
    while (at !== -1) {
      if (at > from) {
        out.push({ text: snippet.slice(from, at), hit: false });
      }
      out.push({ text: snippet.slice(at, at + match.length), hit: true });
      from = at + match.length;
      at = lower.indexOf(needle, from);
    }
    if (from < snippet.length) {
      out.push({ text: snippet.slice(from), hit: false });
    }
    return out.length === 0 ? [{ text: snippet, hit: false }] : out;
  }
</script>

<div class="pane">
  <div class="tools">
    <input type="search" bind:value={query} placeholder="过滤" aria-label="过滤入链" />
    <label>
      排序
      <select bind:value={sort}>
        <option value="pathAsc">文件名 A→Z</option>
        <option value="pathDesc">文件名 Z→A</option>
        <option value="mtimeDesc">修改时间新→旧</option>
        <option value="mtimeAsc">修改时间旧→新</option>
      </select>
    </label>
    <label>
      <input type="checkbox" bind:checked={collapsedResults} />
      折叠结果
    </label>
    <label>
      <input type="checkbox" bind:checked={moreContext} />
      更多上下文
    </label>
    {#if !embedded}
      <button
        type="button"
        aria-pressed={pinned}
        onclick={onTogglePin}
        disabled={notePath === null}
      >
        {pinned ? "取消钉住" : "钉住"}
      </button>
    {/if}
  </div>
  {#if notePath === null}
    <p class="empty">打开一篇笔记以查看入链。</p>
  {:else}
    <div class="lists">
      <section>
        <button type="button" class="section" onclick={() => (linkedOpen = !linkedOpen)}>
          {linkedOpen ? "▾" : "▸"} 已链接提及（{linkedCount}）
        </button>
        {#if linkedOpen}
          {#if linkedGroups.length === 0}
            <p class="empty">没有已链接提及。</p>
          {:else}
            {#each linkedGroups as group (`l:${group.fromPath}`)}
              {@render groupBlock(group, "l")}
            {/each}
          {/if}
        {/if}
      </section>
      <section>
        <button type="button" class="section" onclick={() => (unlinkedOpen = !unlinkedOpen)}>
          {unlinkedOpen ? "▾" : "▸"} 未链接提及（{unlinkedCount}）
        </button>
        {#if unlinkedOpen}
          {#if unlinkedGroups.length === 0}
            <p class="empty">没有未链接提及。</p>
          {:else}
            {#each unlinkedGroups as group (`u:${group.fromPath}`)}
              {@render groupBlock(group, "u")}
            {/each}
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</div>

{#snippet groupBlock(
  group: { fromPath: string; fromTitle: string; items: MentionRecord[] },
  keyPrefix: string,
)}
  {@const groupKey = `${keyPrefix}:${group.fromPath}`}
  {@const folded = collapsedGroups.has(groupKey)}
  <div class="group">
    <button type="button" class="file" onclick={() => toggleGroup(groupKey)}>
      {folded ? "▸" : "▾"}
      {group.fromTitle}
    </button>
    {#if !folded && !collapsedResults}
      <ul>
        {#each group.items as item, index (`${item.startByte}:${index}`)}
          {@const shown = displaySnippet(item.snippet, moreContext, 180, item.toRaw)}
          <li>
            <button type="button" class="hit" onclick={() => onOpen(item)}>
              {#each pieces(shown, item.toRaw) as part, partIndex (`${partIndex}`)}
                {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
              {/each}
            </button>
          </li>
        {/each}
      </ul>
    {:else if !folded && collapsedResults}
      <button type="button" class="hit" onclick={() => group.items[0] && onOpen(group.items[0])}>
        {group.fromPath}
      </button>
    {/if}
  </div>
{/snippet}

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    font-size: 0.9rem;
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.5rem;
    align-items: center;
    padding: 0.4rem;
    border-bottom: 1px solid var(--border);
  }

  .lists {
    overflow: auto;
    flex: 1 1 auto;
    min-height: 0;
    padding: 0.35rem 0.5rem 0.8rem;
  }

  .section {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    padding: 0.35rem 0;
    font-weight: 600;
    cursor: pointer;
  }

  .empty {
    margin: 0.5rem 0;
    opacity: 0.7;
  }

  .file {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    padding: 0.25rem 0;
    font-weight: 600;
    cursor: pointer;
  }

  ul {
    margin: 0 0 0.4rem;
    padding-left: 1rem;
  }

  .hit {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0.15rem 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  mark {
    background: color-mix(in srgb, var(--fg) 18%, transparent);
    color: inherit;
    font-weight: 600;
  }

  input,
  select,
  button {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
  }

  input[type="search"] {
    min-width: 6rem;
    flex: 1 1 6rem;
    padding: 0.15rem 0.3rem;
  }

  button {
    padding: 0.15rem 0.4rem;
    cursor: pointer;
  }
</style>
