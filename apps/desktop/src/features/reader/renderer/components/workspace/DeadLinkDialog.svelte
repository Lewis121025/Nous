<script lang="ts">
  /**
   * 死链创建确认：路径已按链接原文算好，取消不写文件。
   */
  import { onMount } from "svelte";

  let {
    path,
    anchor,
    onConfirm,
    onDismiss,
  }: {
    /** 将要创建的库内路径。 */
    path: string;
    /** 创建后继续定位的锚点；没有则为 null。 */
    anchor: string | null;
    /** 创建并打开。 */
    onConfirm: () => void;
    /** 放弃创建。 */
    onDismiss: () => void;
  } = $props();

  let dialog: HTMLDialogElement;

  onMount(() => {
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".primary")?.focus();
  });
</script>

<dialog
  class="dead-link-dialog"
  bind:this={dialog}
  aria-labelledby="dead-link-title"
  oncancel={(event) => {
    event.preventDefault();
    onDismiss();
  }}
>
  <h2 id="dead-link-title">笔记不存在</h2>
  <p class="hint">
    创建 <span class="path">{path}</span>？
    {#if anchor !== null}
      新笔记是空的，打开后会尝试定位到{anchor.startsWith("^") ? "块" : "标题"}「{anchor}」。
    {/if}
  </p>
  <div class="actions">
    <button class="reader-button" type="button" onclick={onDismiss}>取消</button>
    <button class="reader-button primary" type="button" onclick={onConfirm}>创建笔记</button>
  </div>
</dialog>

<style>
  .dead-link-dialog {
    width: min(26rem, calc(100vw - 2rem));
    padding: 1.5rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    box-shadow:
      0 8px 24px var(--shadow),
      0 24px 80px var(--shadow);
  }
  .dead-link-dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.05rem;
    font-weight: 560;
  }
  .hint {
    margin: 0 0 1.25rem;
    color: var(--muted);
    line-height: 1.6;
  }
  .path {
    color: var(--fg);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
