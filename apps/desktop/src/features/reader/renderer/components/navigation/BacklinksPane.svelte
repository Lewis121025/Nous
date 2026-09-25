<script lang="ts">
  /** 正文末尾的引用：默认收起，按来源笔记计数，候选提及独立展示。 */
  import type { MentionRecord, Mentions } from "../../../shared/api";
  import {
    displaySnippet,
    presentMentions,
    type MentionGroup,
  } from "../../engine/navigation/backlinks";

  type Props = {
    /** 仅包含当前笔记的查询结果；由外壳保证异步归属。 */
    mentions: Mentions;
    /** 打开来源并定位到该次出现。 */
    onOpen: (mention: MentionRecord) => void;
  };
  let { mentions, onOpen }: Props = $props();
  const linkedGroups = $derived(presentMentions(mentions.linked, { query: "", sort: "pathAsc" }));
  const unlinkedGroups = $derived(
    presentMentions(mentions.unlinked, { query: "", sort: "pathAsc" }),
  );

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

{#if linkedGroups.length > 0 || unlinkedGroups.length > 0}
  <section class="references" aria-label="笔记引用">
    {#if linkedGroups.length > 0}
      <details>
        <summary>被 {linkedGroups.length} 篇笔记引用</summary>
        {@render groups(linkedGroups)}
      </details>
    {/if}
    {#if unlinkedGroups.length > 0}
      <details class="suggestions">
        <summary>可能相关的提及（{unlinkedGroups.length} 篇）</summary>
        {@render groups(unlinkedGroups)}
      </details>
    {/if}
  </section>
{/if}

{#snippet groups(items: MentionGroup[])}
  <div class="groups">
    {#each items as group (group.fromPath)}
      <div class="group">
        <h3>{group.fromTitle}</h3>
        <ul>
          {#each group.items as item, index (`${item.startByte}:${index}`)}
            {@const shown = displaySnippet(item.snippet, false, 180, item.toRaw)}
            <li>
              <button type="button" class="hit" onclick={() => onOpen(item)}>
                {#each pieces(shown, item.toRaw) as part, partIndex (`${partIndex}`)}
                  {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
{/snippet}

<style>
  .references {
    margin-top: 3rem;
    padding: 1rem 0 0.5rem;
    border-top: 1px solid var(--border);
    font-size: 0.875rem;
  }
  details + details {
    margin-top: 0.65rem;
  }
  summary {
    color: var(--muted);
    cursor: pointer;
    padding: 0.25rem 0;
    width: fit-content;
  }
  summary:hover,
  details[open] > summary {
    color: var(--fg);
  }
  .groups {
    padding-top: 0.8rem;
  }
  .group + .group {
    margin-top: 1rem;
  }
  h3 {
    font-size: 0.875rem;
    font-weight: 500;
    margin: 0 0 0.3rem;
    overflow-wrap: anywhere;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .hit {
    display: block;
    width: 100%;
    padding: 0.35rem 0.5rem;
    margin-left: -0.5rem;
    border: 0;
    border-radius: 0.35rem;
    background: transparent;
    color: var(--muted);
    font: inherit;
    line-height: 1.7;
    text-align: left;
    cursor: pointer;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .hit:hover {
    color: var(--fg);
    background: var(--selected);
  }
  mark {
    color: var(--fg);
    background: transparent;
    font-weight: 500;
  }
</style>
