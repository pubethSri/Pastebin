<script lang="ts">
  import { untrack } from "svelte";
  import { MAX_NAME_CHARS } from "@pastebin/protocol";
  import { navigate } from "../lib/router.svelte";
  import { socket } from "../lib/socket.svelte";
  import { isImageFile, uploadImage } from "../lib/upload";
  import { readTextFile } from "../lib/textFile";
  import DrawView from "../lib/room/DrawView.svelte";
  import PaperGrid from "../lib/room/PaperGrid.svelte";
  import PaperView from "../lib/room/PaperView.svelte";
  import PresenceRow from "../lib/room/PresenceRow.svelte";
  import SharePanel from "../lib/room/SharePanel.svelte";

  let { code, paperId }: { code: string; paperId: string | null } = $props();

  let renaming = $state(false);
  let draftName = $state("");
  let sharing = $state(false);

  /*
   * Armed on the route, not on socket state.
   *
   * `resumeRoom` reads the socket's status and code, so calling it inside a
   * plain effect would make this re-run every time the connection flickers —
   * and each run would race the socket's own retry. The key guard means the
   * route is what arms it, exactly once per navigation.
   */
  let armed = "";
  $effect(() => {
    const key = `${code}|${paperId ?? ""}`;
    if (key === armed) return;
    armed = key;
    untrack(() => socket.resumeRoom(code, paperId));
  });

  // No stored identity for this room (never joined, or it was swept): the
  // landing page can get one, with the code already filled in.
  $effect(() => {
    if (socket.needsJoin) navigate(`/?code=${code}`, true);
  });

  // The room itself ended — deleted, or expired while empty. Home, with no code
  // to rejoin, because there is nothing to rejoin.
  $effect(() => {
    if (socket.closedNotice) navigate("/", true);
  });

  const papers = $derived(socket.roomState?.papers ?? []);
  const paper = $derived(socket.paper);
  const online = $derived(socket.roomState?.members.filter((m) => m.connected) ?? []);
  const connected = $derived(socket.status === "open");
  const me = $derived(socket.identity);
  const onGrid = $derived(paperId === null);
  /*
   * A paper's kind lives on the room's summary list, not on `PaperState` — the
   * snapshot carries the blocks, and the picker already knows what each paper
   * is. Defaults to a text paper so the view never flickers into a whiteboard
   * while the summaries are still on their way.
   */
  const paperKind = $derived(papers.find((p) => p.id === paperId)?.kind ?? "text");

  /*
   * Which paper you land on needs the whole list, so it is decided here rather
   * than by the server handing out a default: one paper goes straight through
   * and you never meet a picker you didn't ask for, several show the grid.
   * `replace` so the pass-through doesn't leave a dead entry in the back stack.
   *
   * `forwardedFor` makes the pass-through happen on *arrival* only. Without it,
   * a one-paper room could never reach its own picker — every visit to
   * `/r/CODE` bounced straight back into the paper, and since "+ New paper"
   * lives on the picker, the room could never get a second paper at all.
   * Asking for the picker explicitly has to keep you there.
   */
  let forwardedFor = "";
  $effect(() => {
    if (papers.length === 0) return;
    if (paperId === null) {
      if (papers.length === 1 && forwardedFor !== code) {
        forwardedFor = code;
        navigate(`/r/${code}/p/${papers[0]!.id}`, true);
      }
      return;
    }
    forwardedFor = code;
    // The paper we're on was deleted by someone else — fall back to the picker.
    if (!papers.some((p) => p.id === paperId)) navigate(`/r/${code}`, true);
  });

  /**
   * Uploads run here rather than in the composer so the count survives the
   * composer being disabled by a reconnect mid-upload, and so a failure has
   * somewhere to be reported — the room's error strip.
   */
  let uploading = $state(0);

  /**
   * The one place that decides what a dropped file *is*. The drop zone and the
   * picker both hand everything here rather than filtering, so the answer can't
   * differ between them.
   *
   * Images take the HTTP upload; anything else has to decode as text to become
   * a block. Only images move the `uploading` counter — reading a text file is
   * a local read of at most a few hundred KB and is over before a spinner would
   * finish appearing.
   */
  async function handleFiles(files: File[], refusals: string[] = []) {
    const session = socket.sessionForUpload;
    if (!session) return;

    // Collected rather than reported one at a time: assigning `lastError` per
    // file means dropping five bad ones shows only whichever lost the race.
    const problems = [...refusals];
    const images = files.filter(isImageFile);
    uploading += images.length;

    for (const file of files) {
      if (isImageFile(file)) {
        try {
          const media = await uploadImage(file, session);
          socket.postImage(media.id);
        } catch (e) {
          problems.push(e instanceof Error ? e.message : `could not upload ${file.name}`);
        } finally {
          uploading--;
        }
        continue;
      }

      const read = await readTextFile(file);
      if (read.ok) socket.post(read.text, read.name);
      else problems.push(read.reason);
    }

    if (problems.length > 0) socket.lastError = { code: "BAD_FILE", message: summarise(problems) };
  }

  /** Three is enough to see the pattern; past that a count reads better than a wall. */
  function summarise(problems: string[]): string {
    if (problems.length === 1) return problems[0]!;
    const shown = problems.slice(0, 3).join("; ");
    return problems.length > 3 ? `${shown} — and ${problems.length - 3} more` : shown;
  }

  function leave() {
    socket.leave();
    navigate("/");
  }

  function startRename() {
    draftName = me?.name ?? "";
    renaming = true;
  }

  function saveName() {
    const next = draftName.trim();
    if (next && next !== me?.name) socket.rename(next);
    renaming = false;
  }
</script>

<div class="flex h-dvh flex-col">
  <header class="flex items-center gap-2 border-b border-line bg-card px-3 py-2">
    {#if !onGrid}
      <!-- Always available, even in a one-paper room: the picker is where
           "+ New paper" lives, so it has to be reachable from inside a paper. -->
      <button
        type="button"
        onclick={() => navigate(`/r/${code}`)}
        title="All papers"
        class="shrink-0 rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[12px] hover:bg-paper"
      >
        ← Papers
      </button>
    {:else}
      <button
        type="button"
        onclick={leave}
        title="Leave room"
        class="shrink-0 rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[12px] hover:bg-paper"
      >
        ←
      </button>
    {/if}

    <div class="min-w-0">
      <div class="truncate text-[14px] font-medium">
        {onGrid ? "Papers" : (paper?.title ?? "…")}
      </div>
      <div class="font-mono text-[11px] tracking-[0.15em] text-muted">{code}</div>
    </div>

    <div class="ml-auto flex shrink-0 items-center gap-2">
      {#if !connected}
        <span class="text-[11px] text-rose-700">offline</span>
      {/if}
      <PresenceRow members={online} meId={me?.memberId ?? null} onRenameSelf={startRename} />
      <button
        type="button"
        onclick={() => (sharing = !sharing)}
        title="Show QR code and link"
        aria-pressed={sharing}
        class="shrink-0 rounded-[var(--radius-button)] border px-2 py-1 text-[12px]
          {sharing ? 'border-ink bg-ink text-white' : 'border-line-strong hover:bg-paper'}"
      >
        QR
      </button>
    </div>
  </header>

  {#if sharing}
    <SharePanel {code} onClose={() => (sharing = false)} />
  {/if}

  {#if renaming}
    <div class="flex items-center gap-2 border-b border-line bg-paper px-3 py-2">
      <input
        bind:value={draftName}
        maxlength={MAX_NAME_CHARS}
        onkeydown={(e) => {
          if (e.key === "Enter") saveName();
          if (e.key === "Escape") renaming = false;
        }}
        class="min-w-0 flex-1 rounded-[var(--radius-button)] border border-line-strong px-2 py-1 font-ui text-[13px] outline-none focus:border-ink"
      />
      <button type="button" class="rounded-[var(--radius-button)] bg-ink px-3 py-1 text-[12px] text-white" onclick={saveName}>
        Save
      </button>
      <button type="button" class="px-2 py-1 text-[12px] text-muted" onclick={() => (renaming = false)}>Cancel</button>
      <!-- Renaming is forward-only; anything already posted keeps the name it
           was posted under, which is what makes old blocks still make sense. -->
    </div>
  {/if}

  {#if socket.lastError}
    <div class="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-3 py-1.5 text-[12px] text-rose-700">
      <span class="min-w-0 flex-1">{socket.lastError.message}</span>
      <button type="button" class="shrink-0 underline" onclick={() => (socket.lastError = null)}>dismiss</button>
    </div>
  {/if}

  {#if onGrid}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <PaperGrid
        {papers}
        {code}
        onDeleteRoom={() => socket.deleteRoom()}
        onOpen={(id) => navigate(`/r/${code}/p/${id}`)}
        onCreate={(title, kind) => socket.createPaper(title, kind)}
        onRename={(id, title) => socket.renamePaper(id, title)}
        onDelete={(id) => socket.deletePaper(id)}
      />
    </div>
  {:else if paper && paperKind === "draw"}
    {#key paper.paperId}
      <DrawView
        blocks={paper.blocks}
        canDraw={connected}
        myColor={me?.color ?? "#16181d"}
        errorSignal={socket.lastError}
        onStroke={(stroke) => socket.postStroke(stroke)}
        onClearMine={() => socket.clearMine()}
      />
    {/key}
  {:else if paper}
    {#key paper.paperId}
      <PaperView
        {paper}
        myId={me?.memberId ?? null}
        canPost={connected}
        {uploading}
        onPost={(text) => socket.post(text)}
        onFiles={handleFiles}
        onEdit={(id, text) => socket.edit(id, text)}
        onDelete={(id) => socket.remove(id)}
      />
    {/key}
  {:else}
    <div class="flex flex-1 items-center justify-center text-[13px] text-muted">
      {connected ? "Opening paper…" : "Connecting…"}
    </div>
  {/if}
</div>
