<script lang="ts">
  import { copyText } from "../clipboard";

  /**
   * `text` is a getter, not a string: "copy all" would otherwise rebuild and
   * hold a concatenation of the whole paper on every render, for a button
   * almost nobody presses.
   */
  let {
    text,
    label = "Copy",
    title = "Copy to clipboard",
  }: { text: () => string; label?: string; title?: string } = $props();

  let state = $state<"idle" | "done" | "failed">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    const ok = await copyText(text());
    state = ok ? "done" : "failed";
    clearTimeout(timer);
    // A failure needs longer on screen — it asks the user to do something.
    timer = setTimeout(() => (state = "idle"), ok ? 1200 : 4000);
  }
</script>

<button
  type="button"
  onclick={copy}
  {title}
  class="shrink-0 rounded-[var(--radius-button)] border px-2 py-1 text-[11px] font-medium transition-colors
    {state === 'done'
      ? 'border-emerald-600 bg-emerald-50 text-emerald-700'
      : state === 'failed'
        ? 'border-rose-500 bg-rose-50 text-rose-700'
        : 'border-line-strong bg-card text-ink hover:bg-paper'}"
>
  {#if state === "done"}
    Copied
  {:else if state === "failed"}
    Select it and press Ctrl+C
  {:else}
    {label}
  {/if}
</button>
