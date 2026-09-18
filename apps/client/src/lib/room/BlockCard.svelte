<script lang="ts">
  import type { Block } from "@pastebin/protocol";
  import { clockTime, countLines } from "../format";
  import { languageFor, richTokens } from "../highlight";
  import { linkify, uniqueLinks } from "../linkify";
  import { formatBytes } from "../upload";
  import BlockText from "./BlockText.svelte";
  import Chip from "./Chip.svelte";
  import CopyButton from "./CopyButton.svelte";
  import LinkStrip from "./LinkStrip.svelte";

  let {
    block,
    isMine,
    onEdit,
    onDelete,
  }: {
    block: Block;
    isMine: boolean;
    onEdit: (id: string, text: string) => void;
    onDelete: (id: string) => void;
  } = $props();

  /** Past this, a block would push everything else off the screen. */
  const COLLAPSE_AT = 20;

  let editing = $state(false);
  let draft = $state("");
  let expanded = $state(false);
  let confirmingDelete = $state(false);

  const lines = $derived(countLines(block.text));
  const collapsed = $derived(lines > COLLAPSE_AT && !expanded && !editing);
  // Copy always takes the full text — what's on screen is a display choice and
  // handing over a truncated command would be actively dangerous.
  const shown = $derived(collapsed ? block.text.split("\n").slice(0, COLLAPSE_AT).join("\n") : block.text);
  // Decided on the whole block, not on `shown`, so expanding a collapsed paste
  // doesn't change its colours — and so the size cutoff is a property of the
  // block rather than of how much of it you happen to be looking at.
  const language = $derived(languageFor(block.filename, block.text));
  const tokens = $derived(richTokens(shown, language));
  // Links are listed from the *whole* block, not just the visible part: a link
  // hidden inside a collapsed paste is exactly the one worth surfacing.
  const links = $derived(uniqueLinks(linkify(block.text)));

  function startEdit() {
    draft = block.text;
    editing = true;
    confirmingDelete = false;
  }

  function save() {
    if (draft.trim() && draft !== block.text) onEdit(block.id, draft);
    editing = false;
  }
</script>

<article class="rounded-[var(--radius-card)] border border-line bg-card">
  <header class="flex items-center gap-2 border-b border-line px-3 py-1.5">
    <Chip name={block.authorName} color={block.authorColor} />
    <span class="min-w-0 shrink truncate text-[13px] font-medium">{block.authorName}</span>
    {#if block.filename}
      <!-- A label, never part of the paste: Copy below still hands over
           `block.text` alone, so what you paste is what was in the file. Both
           this and the author name shrink, so a long name can't push the
           buttons off the row. -->
      <span class="min-w-0 shrink truncate font-mono text-[11px] text-muted" title={block.filename}>
        {block.filename}
      </span>
    {/if}
    <span class="shrink-0 text-[11px] text-muted">{clockTime(block.createdAt)}</span>
    {#if block.editedAt}
      <span class="shrink-0 text-[11px] text-muted" title="Edited {clockTime(block.editedAt)}">· edited</span>
    {/if}

    <div class="ml-auto flex shrink-0 items-center gap-1">
      {#if block.kind === "image" && block.media}
        <!--
          Download, not Copy.

          Copying image *bytes* needs `navigator.clipboard.write()` with a
          ClipboardItem, which is secure-context only — and this app is reached
          over plain http on a LAN IP, where that API does not exist. Unlike
          text, there is no execCommand fallback for images. So the honest
          affordance is a download; on a phone, long-press-save also works.
        -->
        <a
          href={`/media/${block.media.id}`}
          download={block.media.name ?? "image"}
          class="shrink-0 rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[11px] hover:bg-paper"
          title="Download this image"
        >
          Download
        </a>
      {:else if !editing}
        <CopyButton text={() => block.text} />
      {/if}
      {#if isMine && !editing}
        {#if confirmingDelete}
          <button
            type="button"
            class="rounded-[var(--radius-button)] border border-rose-500 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700"
            onclick={() => onDelete(block.id)}>Delete?</button
          >
          <button
            type="button"
            class="rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[11px] text-muted"
            onclick={() => (confirmingDelete = false)}>No</button
          >
        {:else}
          {#if block.kind === "text"}
            <!-- An image has no text to edit; delete and re-post is the only
                 meaningful change, and that button is right there. -->
            <button
              type="button"
              class="rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[11px] hover:bg-paper"
              onclick={startEdit}>Edit</button
            >
          {/if}
          <button
            type="button"
            class="rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[11px] text-muted hover:bg-paper"
            onclick={() => (confirmingDelete = true)}>Delete</button
          >
        {/if}
      {/if}
    </div>
  </header>

  {#if editing}
    <div class="p-2">
      <textarea
        bind:value={draft}
        rows={Math.min(Math.max(lines, 3), 20)}
        class="w-full resize-y rounded-[var(--radius-button)] border border-line-strong p-2 text-[13px] leading-[1.55] outline-none focus:border-ink"
      ></textarea>
      <div class="mt-2 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-[var(--radius-button)] border border-line-strong px-3 py-1 text-[12px] text-muted"
          onclick={() => (editing = false)}>Cancel</button
        >
        <button
          type="button"
          class="rounded-[var(--radius-button)] bg-ink px-3 py-1 text-[12px] font-medium text-white"
          onclick={save}>Save</button
        >
      </div>
    </div>
  {:else if block.kind === "image" && block.media}
    <a href={`/media/${block.media.id}`} target="_blank" rel="noopener noreferrer" class="block p-2" title="Open full size">
      <!--
        `width`/`height` are set from the stored dimensions so the browser
        reserves the right box before the bytes arrive — without them the feed
        reflows as each image loads, which is worst on the phone this is for.
        `max-h-96` keeps one screenshot from filling the whole screen.
      -->
      <img
        src={`/media/${block.media.id}`}
        alt={block.media.name ?? "pasted image"}
        width={block.media.width ?? undefined}
        height={block.media.height ?? undefined}
        class="max-h-96 w-auto max-w-full rounded border border-line bg-paper object-contain"
      />
    </a>
    <div class="px-3 pb-2 text-[11px] text-muted">
      {block.media.name ? `${block.media.name} · ` : ""}{formatBytes(block.media.byteSize)}{block.media.width &&
      block.media.height
        ? ` · ${block.media.width}×${block.media.height}`
        : ""}
    </div>
  {:else}
    <BlockText {tokens} />
    {#if links.length > 0}
      <LinkStrip {links} />
    {/if}
    {#if collapsed}
      <button
        type="button"
        class="w-full border-t border-line px-3 py-1.5 text-left text-[11px] text-muted hover:bg-paper"
        onclick={() => (expanded = true)}
      >
        Show all {lines} lines
      </button>
    {:else if lines > COLLAPSE_AT && expanded}
      <button
        type="button"
        class="w-full border-t border-line px-3 py-1.5 text-left text-[11px] text-muted hover:bg-paper"
        onclick={() => (expanded = false)}
      >
        Collapse
      </button>
    {/if}
  {/if}
</article>
