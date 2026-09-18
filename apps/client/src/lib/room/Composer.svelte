<script lang="ts">
  import { MAX_BLOCK_CHARS } from "@pastebin/protocol";

  let {
    disabled = false,
    uploading = 0,
    onPost,
    onFiles,
  }: {
    disabled?: boolean;
    /** How many uploads are in flight, so the bar can say so. */
    uploading?: number;
    onPost: (text: string) => void;
    onFiles: (files: File[]) => void;
  } = $props();

  let text = $state("");
  let el = $state<HTMLTextAreaElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);

  const tooLong = $derived(text.length > MAX_BLOCK_CHARS);
  // Only speak up near the ceiling. A counter on every paste is noise.
  const showCount = $derived(text.length > MAX_BLOCK_CHARS * 0.8);
  const canPost = $derived(!disabled && text.trim().length > 0 && !tooLong);

  function post() {
    if (!canPost) return;
    onPost(text);
    text = "";
    resize();
  }

  function onKeydown(e: KeyboardEvent) {
    // Enter alone inserts a newline — pasted text is usually multi-line, and
    // send-on-Enter would post half of it.
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      post();
    }
  }

  /**
   * Ctrl+V of a screenshot — the case this whole feature exists for — and, since
   * copying a file in Explorer or Finder puts it here too, Ctrl+V of a file.
   *
   * `clipboardData.files` is only non-empty for an actual file on the clipboard;
   * a normal text paste leaves it empty and falls through untouched, so this
   * never interferes with the primary use of the box.
   */
  function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    onFiles(files);
  }

  function onPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length > 0) onFiles(files);
    input.value = ""; // so picking the same file twice still fires
  }

  function resize() {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  $effect(() => {
    text; // re-measure as the draft grows or is cleared
    resize();
  });
</script>

<div class="safe-bottom border-t border-line bg-card px-3 pt-2">
  <!-- Same max width as the feed above, so the composer and the blocks share
       one column rather than the text jumping edge-to-edge as you type. -->
  <div class="mx-auto max-w-3xl">
    <textarea
      bind:this={el}
      bind:value={text}
      onkeydown={onKeydown}
      onpaste={onPaste}
      {disabled}
      rows="2"
      placeholder={disabled ? "Reconnecting…" : "Paste text, or drop a file…"}
      class="w-full resize-none rounded-[var(--radius-button)] border p-2 text-[13px] leading-[1.55] outline-none disabled:bg-paper disabled:text-muted
        {tooLong ? 'border-rose-500' : 'border-line-strong focus:border-ink'}"
    ></textarea>

    <div class="flex items-center gap-3 py-2">
      <!-- No `accept`: it would grey out exactly the files this is for — the
           browser reports no type for `.ts`, `.toml` or a bare `Dockerfile`, so
           an accept list hides them from the picker entirely. Whether the bytes
           decode as text is the real gate, and it lives in `textFile.ts`. -->
      <input bind:this={picker} type="file" multiple onchange={onPicked} class="hidden" />
      <button
        type="button"
        onclick={() => picker?.click()}
        {disabled}
        title="Add a file — an image, or any text or code file"
        class="shrink-0 rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[12px] hover:bg-paper disabled:opacity-50"
      >
        File
      </button>

      <span class="min-w-0 truncate text-[11px] text-muted">
        {#if uploading > 0}
          <span class="text-ink">uploading {uploading} image{uploading === 1 ? "" : "s"}…</span>
        {:else if tooLong}
          <span class="text-rose-700">
            {text.length.toLocaleString()} / {MAX_BLOCK_CHARS.toLocaleString()} — too long to post
          </span>
        {:else if showCount}
          {text.length.toLocaleString()} / {MAX_BLOCK_CHARS.toLocaleString()}
        {:else}
          <span class="hidden sm:inline">Ctrl+Enter to post · paste or drop a file</span>
        {/if}
      </span>

      <button
        type="button"
        onclick={post}
        disabled={!canPost}
        class="ml-auto shrink-0 rounded-[var(--radius-button)] bg-ink px-4 py-1.5 text-[13px] font-medium text-white disabled:bg-line-strong disabled:text-muted"
      >
        Post
      </button>
    </div>
  </div>
</div>
