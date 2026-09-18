<script lang="ts">
  import type { PaperState } from "@pastebin/protocol";
  import BlockCard from "./BlockCard.svelte";
  import Composer from "./Composer.svelte";
  import CopyButton from "./CopyButton.svelte";

  let {
    paper,
    myId,
    canPost,
    onPost,
    onFiles,
    uploading,
    onEdit,
    onDelete,
  }: {
    paper: PaperState;
    myId: string | null;
    canPost: boolean;
    onPost: (text: string) => void;
    /** `refusals` are things the drop already knows can't work, like folders. */
    onFiles: (files: File[], refusals?: string[]) => void;
    uploading: number;
    onEdit: (id: string, text: string) => void;
    onDelete: (id: string) => void;
  } = $props();

  let feed = $state<HTMLDivElement | null>(null);
  let atBottom = $state(true);
  let hasNew = $state(false);
  let dragging = $state(false);

  const textBlocks = $derived(paper.blocks.filter((b) => b.kind === "text"));
  /**
   * Blank line between blocks, so a copy-all round-trips as readable text.
   * Image blocks are skipped rather than represented by a placeholder — this
   * output is meant to be pasted into a terminal or an editor, and a line
   * saying "[image]" in the middle of a script helps nobody.
   */
  const allText = () => textBlocks.map((b) => b.text).join("\n\n");

  /*
   * Drag-and-drop is armed with a counter, not a boolean.
   *
   * `dragleave` fires every time the pointer crosses into a *child* element, so
   * a plain flag flickers off the moment the cursor moves over a block. Counting
   * enter/leave pairs is the standard fix.
   */
  let dragDepth = 0;

  function onDragEnter(e: DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    dragDepth++;
    dragging = true;
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging = false;
  }

  /**
   * Everything dropped goes up to the room, which decides what each file is —
   * an image to upload, text to post, or something to refuse out loud. Filtering
   * here is what used to make a dropped `.ts` vanish without a word.
   *
   * Folders are the one thing screened here rather than there, because a
   * directory only admits to being one through `dataTransfer.items`: by the time
   * it reaches `files` it looks like an ordinary zero-byte File whose read
   * fails for no visible reason.
   */
  function onDrop(e: DragEvent) {
    dragDepth = 0;
    dragging = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();

    const items = Array.from(e.dataTransfer?.items ?? []);
    const folders = new Set(
      items
        .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
        .filter((entry) => entry?.isDirectory)
        .map((entry) => entry!.name),
    );

    onFiles(
      files.filter((f) => !folders.has(f.name)),
      [...folders].map((name) => `${name} is a folder — drop the files inside it instead`),
    );
  }

  function onScroll() {
    if (!feed) return;
    atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    if (atBottom) hasNew = false;
  }

  function toBottom() {
    if (!feed) return;
    feed.scrollTop = feed.scrollHeight;
    hasNew = false;
  }

  /*
   * Keyed on block count, not on `paper`.
   *
   * Every delta replaces the whole `paper` object, so an effect that merely
   * reads it re-runs on every edit, every delete and every reconnect — the same
   * trap YAWBG documents for snapshot-derived state. Scrolling belongs to
   * "a block was added" only, so the count is the key and everything else
   * returns early.
   */
  let lastCount = -1;
  $effect(() => {
    const n = paper.blocks.length;
    if (n === lastCount) return;
    const grew = n > lastCount;
    lastCount = n;
    if (!grew) return;
    // Never yank a long paste out from under someone who scrolled up to read
    // it; offer them the jump instead.
    if (atBottom) queueMicrotask(toBottom);
    else hasNew = true;
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="relative flex min-h-0 flex-1 flex-col"
  ondragenter={onDragEnter}
  ondragleave={onDragLeave}
  ondragover={(e) => e.preventDefault()}
  ondrop={onDrop}
>
  {#if dragging}
    <div
      class="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed border-ink bg-paper/85 text-[13px] font-medium"
    >
      Drop a file to post it
    </div>
  {/if}

  <!-- `overflow-x-hidden` is deliberate, not decorative: `overflow-y-auto` alone
       would compute overflow-x to `auto` as well (CSS won't pair `visible` with
       `auto`), leaving a horizontal scroll container with no range that eats
       sideways swipes. Blocks scroll their own long lines; nothing else here
       should ever overflow sideways. -->
  <div bind:this={feed} onscroll={onScroll} class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3">
    <div class="mx-auto flex max-w-3xl flex-col gap-3">
      {#if paper.blocks.length === 0}
        <p class="py-16 text-center text-[13px] text-muted">
          Nothing here yet. Paste something below and it shows up for everyone in the room.
        </p>
      {:else}
        {#each paper.blocks as block (block.id)}
          <BlockCard {block} isMine={block.authorId === myId} {onEdit} {onDelete} />
        {/each}
        {#if textBlocks.length > 0}
          <div class="flex justify-end pb-1">
            <CopyButton
              text={allText}
              label="Copy all {textBlocks.length}"
              title="Copy every text paste on this paper — images are not included"
            />
          </div>
        {/if}
      {/if}
    </div>
  </div>

  {#if hasNew}
    <button
      type="button"
      onclick={toBottom}
      class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-white shadow-lg"
    >
      ↓ New paste
    </button>
  {/if}
</div>

<Composer disabled={!canPost} {onPost} {onFiles} {uploading} />
