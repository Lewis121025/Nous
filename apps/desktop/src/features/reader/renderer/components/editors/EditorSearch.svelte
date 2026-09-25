<script lang="ts">
  /** 查找状态由插件持有，替换仍走同一事务和撤销栈；输入框保留焦点。 */
  import { onMount } from "svelte";
  import type { Command, EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import { SearchQuery, findNext, findPrev, setSearchState } from "prosemirror-search";
  import { replaceSearch } from "../../engine/editing/search-replace";
  import { createCompositionGuard, isCompositionKey } from "../../engine/editing/composition";

  let {
    view,
    state: editorState,
    onClose,
  }: { view: EditorView; state: EditorState; onClose: () => void } = $props();
  let term = $state("");
  let replacement = $state("");
  let caseSensitive = $state(false);
  let showReplace = $state(false);
  let input: HTMLInputElement;
  let form: HTMLFormElement;
  const replaceId = $props.id();
  const composition = createCompositionGuard();
  const query = $derived(
    new SearchQuery({ search: term, replace: replacement, caseSensitive, literal: true }),
  );
  const hasMatch = $derived(query.valid && query.findNext(editorState) !== null);

  $effect(() => {
    view.dispatch(setSearchState(view.state.tr, query));
  });
  onMount(() => {
    const { from, to } = view.state.selection;
    term = view.state.doc.textBetween(from, to, " ");
    focusQuery();
    form.addEventListener("keydown", onKey);
    return () => form.removeEventListener("keydown", onKey);
  });
  $effect(() => {
    const current = view;
    const scrollMargin = current.props.scrollMargin ?? 5;
    const scrollThreshold = current.props.scrollThreshold ?? 0;
    // 搜索栏的实际高度包含替换行和提示；向上定位时也必须露出命中正文。
    const resize = new ResizeObserver(() => {
      const top = form.offsetHeight + 12;
      current.setProps({
        scrollMargin: { top, bottom: 12, left: 5, right: 5 },
        scrollThreshold: { top, bottom: 0, left: 0, right: 0 },
      });
    });
    resize.observe(form);
    return () => {
      resize.disconnect();
      if (!current.isDestroyed) {
        current.setProps({ scrollMargin, scrollThreshold });
        current.dispatch(setSearchState(current.state.tr, new SearchQuery({ search: "" })));
      }
    };
  });

  /** 再次查找时保留查询并选中输入，长文中滚到搜索栏以便直接改词。 */
  export function focusQuery(): void {
    input.focus();
    input.select();
  }

  function run(command: Command): void {
    if (composition.active) return;
    // ProseMirror 只滚动编辑器内的 DOM 选区；执行后把焦点还给原控件且不再次滚动。
    const focused = document.activeElement;
    view.focus();
    command(view.state, view.dispatch, view);
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
  function close(): void {
    if (composition.active) return;
    onClose();
    view.focus();
  }
  function onKey(event: KeyboardEvent): void {
    if (composition.active || isCompositionKey(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      run(event.shiftKey ? findPrev : findNext);
    }
  }
</script>

<form
  class="search-panel"
  bind:this={form}
  use:composition.bind
  aria-label="文内查找替换"
  onsubmit={(event) => event.preventDefault()}
>
  <div class="search-row">
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="替换选项"
      title="替换选项"
      aria-expanded={showReplace}
      aria-controls={replaceId}
      onclick={() => {
        if (!composition.active) showReplace = !showReplace;
      }}
    >
      <svg
        class="reader-icon disclosure"
        class:expanded={showReplace}
        viewBox="0 0 24 24"
        aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg
      >
    </button>
    <!-- 原生 search 在组词中收到 Escape 会清空内容且漏发 compositionend；清空由应用处理。 -->
    <input
      class="reader-input"
      aria-label="查找"
      placeholder="查找文中内容"
      bind:this={input}
      type="text"
      role="searchbox"
      bind:value={term}
    />
    <button
      class="reader-button icon-button case-option"
      type="button"
      aria-label="区分大小写"
      title="区分大小写"
      aria-pressed={caseSensitive}
      onclick={() => {
        if (!composition.active) caseSensitive = !caseSensitive;
      }}>Aa</button
    >
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="上一处"
      title="上一处（Shift + Enter）"
      onclick={() => run(findPrev)}
      disabled={!hasMatch}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m6 14 6-6 6 6" /></svg
      >
    </button>
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="下一处"
      title="下一处（Enter）"
      onclick={() => run(findNext)}
      disabled={!hasMatch}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m6 10 6 6 6-6" /></svg
      >
    </button>
    <button
      class="reader-button icon-button"
      type="button"
      onclick={close}
      aria-label="关闭查找"
      title="关闭查找（Esc）"
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m6 6 12 12M6 18 18 6" /></svg
      >
    </button>
  </div>
  <div id={replaceId} class="replace-row" hidden={!showReplace}>
    <input class="reader-input" aria-label="替换为" placeholder="替换为" bind:value={replacement} />
    <button
      class="reader-button"
      type="button"
      onclick={() => run(replaceSearch(false))}
      disabled={!hasMatch}>替换</button
    >
    <button
      class="reader-button"
      type="button"
      onclick={() => run(replaceSearch(true))}
      disabled={!hasMatch}>全部替换</button
    >
  </div>
  <div class="search-status" role="status">{term !== "" && !hasMatch ? "没有匹配项" : ""}</div>
</form>

<style>
  .search-panel {
    position: sticky;
    top: calc(-1 * var(--reader-inset, 0px));
    z-index: 1;
    padding: 0.5rem;
    margin-bottom: 1rem;
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    background: var(--bg);
    box-shadow: 0 2px 8px var(--shadow);
  }
  .search-row,
  .replace-row {
    display: flex;
    gap: 0.25rem;
    align-items: center;
  }
  .replace-row {
    padding: 0.5rem 0 0 2.25rem;
    gap: 0.4rem;
  }
  .replace-row[hidden] {
    display: none;
  }
  input {
    flex: 1;
    width: 0;
    padding: 0.35rem 0.5rem;
    background: var(--sidebar);
    border-color: transparent;
  }
  button {
    flex-shrink: 0;
    font-size: 0.85rem;
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border-color: transparent;
    background: transparent;
  }
  .case-option[aria-pressed="true"] {
    background: var(--selected);
    color: var(--accent);
  }
  .expanded {
    transform: rotate(90deg);
  }
  .search-status {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 0.4rem 0.25rem 0;
  }
  .search-status:empty {
    display: none;
  }
  @media (max-width: 640px) {
    .replace-row {
      padding-left: 0;
    }
  }
</style>
