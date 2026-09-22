<script lang="ts">
  import CopyButton from "./CopyButton.svelte";

  let { code, paperTitle, onClose }: { code: string; paperTitle: string | null; onClose: () => void } =
    $props();

  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  /**
   * How the binary is invoked, so every example below is pasteable as-is.
   *
   * PowerShell will not run a binary in the current directory by bare name, and
   * the downloaded file is `pastebin.exe` there — the same two facts
   * `cliDownloadCommand` already encodes for the download line. A student who
   * has moved it onto PATH just types `pastebin`, which the note under the
   * table says rather than trying to detect.
   */
  const windows = /Windows|Win32|Win64/i.test(navigator.userAgent);
  const bin = windows ? ".\pastebin" : "./pastebin";

  /*
   * The real room, the real paper, the real origin — a guide made of
   * placeholders is one the reader has to translate before it works.
   *
   * `location.origin` is the right server *unless* you are reading this on the
   * host machine, where it is loopback and means nothing to anyone else. That
   * case gets a note instead of the share panel's address picker: duplicating
   * the /api/host fetch to put a second picker on screen would be two sources
   * of truth for one answer.
   */
  const server = location.origin;

  /** Quoted always: paper titles routinely contain spaces, and "Paper 1" is the default. */
  const paper = $derived(paperTitle ? `"${paperTitle.replace(/"/g, '\\"')}"` : '"Paper 1"');

  const rows = $derived([
    {
      what: "Join this room",
      cmd: `${bin} join ${code} --server ${server}`,
      note: "--server is only needed the first time. Joining again resumes the same identity.",
    },
    { what: "Post a file", cmd: `${bin} post notes.txt` },
    {
      what: "Post from a pipe",
      cmd: `cat error.log | ${bin} post`,
      note: "With no FILE, post reads stdin — the reason the CLI exists.",
    },
    {
      what: "Post to one paper",
      cmd: `${bin} post notes.txt --paper ${paper}`,
      note: "Without --paper it goes to the paper `use` selected.",
    },
    { what: "List the papers", cmd: `${bin} papers`, note: "* marks where post, get and tail go." },
    { what: "Switch paper", cmd: `${bin} use ${paper}` },
    { what: "Read the newest block", cmd: `${bin} get`, note: "--last 3 prints the newest three." },
    {
      what: "Follow new blocks",
      cmd: `${bin} tail`,
      note: "Prints each block as it arrives, until Ctrl+C.",
    },
    {
      what: "Leave the room",
      cmd: `${bin} leave`,
      note: "Forgets your identity on this machine. The room itself is untouched.",
    },
    { what: "Where am I?", cmd: `${bin} status` },
  ]);

  const all = $derived(rows.map((r) => r.cmd).join("\n"));
</script>

<div class="border-b border-line bg-paper px-3 py-3">
  <div class="mx-auto flex max-w-3xl flex-col gap-3">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-medium">Command line</div>
        <p class="mt-0.5 text-[11px] leading-relaxed text-muted">
          Same room, same papers, from a terminal. Need the binary first? It's in the
          <strong class="font-medium">QR</strong> panel — one download line per platform. Full reference:
          <code class="rounded border border-line bg-card px-1">{bin} --help</code>
        </p>
      </div>
      <CopyButton text={() => all} label="Copy all" title="Copy every command" />
      <button type="button" onclick={onClose} class="shrink-0 px-2 py-1 text-[12px] text-muted underline">
        close
      </button>
    </div>

    {#if loopback}
      <p class="rounded-[var(--radius-button)] border border-line bg-card px-2 py-1 text-[11px] text-muted">
        You're on <code>{location.host}</code>, so the join line below only works on this machine. The
        <strong class="font-medium">QR</strong> panel has an address other people can reach.
      </p>
    {/if}

    <div class="flex flex-col gap-1.5">
      {#each rows as row (row.what)}
        <div class="flex items-start gap-2">
          <span class="w-32 shrink-0 pt-1 text-[11px] leading-tight text-muted">{row.what}</span>
          <div class="min-w-0 flex-1">
            <pre
              class="min-w-0 overflow-x-auto rounded-[var(--radius-button)] border border-line bg-card px-2 py-1 text-[11px] leading-relaxed">{row.cmd}</pre>
            {#if row.note}
              <p class="mt-0.5 text-[11px] leading-tight text-muted">{row.note}</p>
            {/if}
          </div>
          <CopyButton text={() => row.cmd} />
        </div>
      {/each}
    </div>

    <p class="text-[11px] leading-relaxed text-muted">
      {#if windows}
        <code class="rounded border border-line bg-card px-1">.\pastebin</code> assumes the binary is in the
        current folder — PowerShell won't run it by bare name. On PATH, it's just
        <code class="rounded border border-line bg-card px-1">pastebin</code>.
      {:else}
        <code class="rounded border border-line bg-card px-1">./pastebin</code> assumes the binary is in the
        current folder. On PATH, it's just
        <code class="rounded border border-line bg-card px-1">pastebin</code>.
      {/if}
      Text goes to stdout and everything else to stderr, so
      <code class="rounded border border-line bg-card px-1">{bin} get &gt; out.txt</code> stays clean.
    </p>
  </div>
</div>
