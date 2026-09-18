<script lang="ts">
  import {
    DEFAULT_EMPTY_ROOM_GRACE_MINUTES,
    MAX_PAPERS_PER_ROOM,
    MAX_TITLE_CHARS,
    type PaperKind,
    type PaperSummary,
  } from "@pastebin/protocol";
  import { clockTime } from "../format";
  import { serverInfo } from "../serverInfo.svelte";

  let {
    papers,
    code,
    onOpen,
    onCreate,
    onRename,
    onDelete,
    onDeleteRoom,
  }: {
    papers: PaperSummary[];
    code: string;
    onOpen: (id: string) => void;
    onCreate: (title: string, kind: PaperKind) => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onDeleteRoom: () => void;
  } = $props();

  let confirmingRoom = $state(false);
  let graceMinutes = $state(DEFAULT_EMPTY_ROOM_GRACE_MINUTES);
  $effect(() => {
    serverInfo().then((info) => (graceMinutes = info.emptyRoomGraceMinutes));
  });

  let creating = $state(false);
  let newTitle = $state("");
  // A paper's kind is fixed at creation, so it is chosen here and nowhere else.
  let newKind = $state<PaperKind>("text");
  let renamingId = $state<string | null>(null);
  let draftTitle = $state("");
  let confirmingId = $state<string | null>(null);

  const full = $derived(papers.length >= MAX_PAPERS_PER_ROOM);

  function startCreate(kind: PaperKind) {
    newKind = kind;
    const existing = papers.filter((p) => p.kind === kind).length;
    newTitle = kind === "draw" ? `Board ${existing + 1}` : `Paper ${papers.length + 1}`;
    creating = true;
  }

  function submitCreate() {
    const title = newTitle.trim();
    if (title) onCreate(title, newKind);
    creating = false;
  }

  function startRename(paper: PaperSummary) {
    renamingId = paper.id;
    draftTitle = paper.title;
    confirmingId = null;
  }

  function submitRename() {
    const title = draftTitle.trim();
    if (renamingId && title) onRename(renamingId, title);
    renamingId = null;
  }
</script>

<div class="mx-auto w-full max-w-3xl px-3 py-4">
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    {#each papers as paper (paper.id)}
      <div class="flex flex-col rounded-[var(--radius-card)] border border-line bg-card">
        {#if renamingId === paper.id}
          <div class="flex flex-col gap-2 p-3">
            <input
              bind:value={draftTitle}
              maxlength={MAX_TITLE_CHARS}
              onkeydown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") renamingId = null;
              }}
              class="rounded-[var(--radius-button)] border border-line-strong px-2 py-1 font-ui text-[13px] outline-none focus:border-ink"
            />
            <div class="flex justify-end gap-2">
              <button type="button" class="px-2 py-1 text-[12px] text-muted" onclick={() => (renamingId = null)}>
                Cancel
              </button>
              <button
                type="button"
                class="rounded-[var(--radius-button)] bg-ink px-3 py-1 text-[12px] text-white"
                onclick={submitRename}>Save</button
              >
            </div>
          </div>
        {:else}
          <!-- The card body is the target; the actions below sit outside it so a
               rename never costs you a misfired navigation. -->
          <button type="button" onclick={() => onOpen(paper.id)} class="flex-1 p-3 text-left hover:bg-paper">
            <div class="flex items-center gap-1.5">
              <div class="min-w-0 shrink truncate text-[14px] font-medium">{paper.title}</div>
              {#if paper.kind === "draw"}
                <span class="shrink-0 rounded-full border border-line-strong px-1.5 py-px text-[10px] text-muted">
                  whiteboard
                </span>
              {/if}
            </div>
            <div class="mt-0.5 text-[11px] text-muted">
              {paper.blockCount}
              {#if paper.kind === "draw"}
                {paper.blockCount === 1 ? "stroke" : "strokes"}
              {:else}
                {paper.blockCount === 1 ? "paste" : "pastes"}
              {/if}
              {#if paper.blockCount > 0}· {clockTime(paper.lastActivity)}{/if}
            </div>
            <!-- A board has no text to preview, and its blocks are JSON
                 geometry — so it says what it is rather than showing nothing. -->
            {#if paper.kind === "draw"}
              <p class="mt-2 text-[11px] text-muted italic">
                {paper.blockCount > 0 ? "a drawing" : "nothing drawn yet"}
              </p>
            {:else if paper.preview}
              <pre class="mt-2 max-h-10 overflow-hidden text-[11px] leading-[1.4] text-muted">{paper.preview}</pre>
            {:else}
              <p class="mt-2 text-[11px] text-muted italic">empty</p>
            {/if}
          </button>

          <div class="flex items-center gap-1 border-t border-line px-2 py-1.5">
            {#if confirmingId === paper.id}
              <span class="mr-auto text-[11px] text-muted">
                Delete and everything {paper.kind === "draw" ? "drawn on it" : "in it"}?
              </span>
              <button
                type="button"
                class="rounded-[var(--radius-button)] border border-rose-500 bg-rose-50 px-2 py-1 text-[11px] text-rose-700"
                onclick={() => {
                  onDelete(paper.id);
                  confirmingId = null;
                }}>Delete</button
              >
              <button type="button" class="px-2 py-1 text-[11px] text-muted" onclick={() => (confirmingId = null)}>
                No
              </button>
            {:else}
              <button
                type="button"
                class="ml-auto rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[11px] hover:bg-paper"
                onclick={() => startRename(paper)}>Rename</button
              >
              <button
                type="button"
                disabled={papers.length <= 1}
                title={papers.length <= 1 ? "A room needs at least one paper" : "Delete this paper"}
                class="rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[11px] text-muted hover:bg-paper disabled:opacity-40"
                onclick={() => (confirmingId = paper.id)}>Delete</button
              >
            {/if}
          </div>
        {/if}
      </div>
    {/each}

    {#if creating}
      <div class="flex flex-col gap-2 rounded-[var(--radius-card)] border border-dashed border-line-strong bg-card p-3">
        <input
          bind:value={newTitle}
          maxlength={MAX_TITLE_CHARS}
          onkeydown={(e) => {
            if (e.key === "Enter") submitCreate();
            if (e.key === "Escape") creating = false;
          }}
          class="rounded-[var(--radius-button)] border border-line-strong px-2 py-1 font-ui text-[13px] outline-none focus:border-ink"
        />
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-muted">{newKind === "draw" ? "whiteboard" : "paper"}</span>
          <button type="button" class="ml-auto px-2 py-1 text-[12px] text-muted" onclick={() => (creating = false)}>
            Cancel
          </button>
          <button
            type="button"
            class="rounded-[var(--radius-button)] bg-ink px-3 py-1 text-[12px] text-white"
            onclick={submitCreate}>Add</button
          >
        </div>
      </div>
    {:else if !full}
      <!-- Two buttons rather than a kind toggle inside the form: the choice is
           permanent, so it belongs to the thing you press, not to a control you
           might not notice you left set. -->
      <div class="flex flex-col gap-2">
        <button
          type="button"
          onclick={() => startCreate("text")}
          class="rounded-[var(--radius-card)] border border-dashed border-line-strong p-3 text-left text-[13px] text-muted hover:bg-card"
        >
          + New paper
        </button>
        <button
          type="button"
          onclick={() => startCreate("draw")}
          class="rounded-[var(--radius-card)] border border-dashed border-line-strong p-3 text-left text-[13px] text-muted hover:bg-card"
        >
          + New whiteboard
        </button>
      </div>
    {/if}
  </div>

  {#if full}
    <p class="mt-3 text-[11px] text-muted">This room is at its {MAX_PAPERS_PER_ROOM}-paper limit.</p>
  {/if}

  <!--
    Room-level actions live on the picker, not in a paper: this is the only
    screen that is *about* the room. Stating the grace period next to the delete
    button is the point — the two together explain the room's whole lifetime, so
    a room vanishing on its own is never a surprise.
  -->
  <section class="mt-8 border-t border-line pt-4">
    <p class="text-[11px] text-muted">
      Room <span class="font-mono tracking-[0.15em] text-ink">{code}</span> and everything in it is deleted
      automatically once everyone has been gone for {graceMinutes}
      {graceMinutes === 1 ? "minute" : "minutes"}. Locking your phone counts as leaving.
    </p>

    <div class="mt-2 flex items-center gap-2">
      {#if confirmingRoom}
        <span class="text-[12px] text-rose-700">
          Delete this room now, for everyone? All papers, pastes and images go with it.
        </span>
        <button
          type="button"
          class="ml-auto shrink-0 rounded-[var(--radius-button)] border border-rose-500 bg-rose-50 px-3 py-1 text-[12px] font-medium text-rose-700"
          onclick={onDeleteRoom}>Delete room</button
        >
        <button type="button" class="shrink-0 px-2 py-1 text-[12px] text-muted" onclick={() => (confirmingRoom = false)}>
          Cancel
        </button>
      {:else}
        <button
          type="button"
          class="rounded-[var(--radius-button)] border border-line-strong px-3 py-1 text-[12px] text-muted hover:bg-card"
          onclick={() => (confirmingRoom = true)}>Delete room now</button
        >
      {/if}
    </div>
  </section>
</div>
