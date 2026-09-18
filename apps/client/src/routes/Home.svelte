<script lang="ts">
  import { MAX_NAME_CHARS } from "@pastebin/protocol";
  import { suggestName, suggestNameAsync } from "../lib/autoName";
  import { navigate } from "../lib/router.svelte";
  import { savedRooms, socket } from "../lib/socket.svelte";

  // Pre-filled, not empty: on a phone this is the difference between two taps
  // and typing a name you didn't care about.
  //
  // A *fresh* suggestion every visit — nothing about the name is persisted, so
  // arriving at this page never reveals what you called yourself last time.
  let name = $state(suggestName());
  // Upgrade the placeholder suggestion once the server's word pool arrives, but
  // never over something already being typed.
  let untouched = $state(true);

  $effect(() => {
    if (!untouched) return;
    suggestNameAsync().then((suggested) => {
      if (untouched) name = suggested;
    });
  });
  let code = $state((new URLSearchParams(location.search).get("code") ?? "").toUpperCase());
  let submitted = $state(false);

  const rooms = savedRooms();
  const trimmed = $derived(name.trim());
  const codeReady = $derived(/^[A-Z]{4}$/.test(code.trim().toUpperCase()));
  const busy = $derived(submitted && !socket.lastError && socket.status !== "closed");

  function create() {
    if (!trimmed) return;
    submitted = true;
    socket.createRoom(trimmed);
  }

  function join() {
    if (!trimmed || !codeReady) return;
    submitted = true;
    socket.joinRoom(code.trim().toUpperCase(), trimmed);
  }

  $effect(() => {
    if (submitted && socket.code && socket.identity) navigate(`/r/${socket.code}`);
  });
</script>

<main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Pastebin</h1>
    <p class="mt-1 text-[13px] text-muted">Drop text in a room. Everyone else copies it in one tap.</p>
  </header>

  <section class="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-card p-4">
    <label class="flex flex-col gap-1 text-[12px] font-medium">
      Your name
      <input
        bind:value={name}
        oninput={() => (untouched = false)}
        maxlength={MAX_NAME_CHARS}
        class="rounded-[var(--radius-button)] border border-line-strong px-3 py-2 font-ui text-[14px] font-normal outline-none focus:border-ink"
      />
    </label>

    <button
      type="button"
      onclick={create}
      disabled={!trimmed || busy}
      class="rounded-[var(--radius-button)] bg-ink px-4 py-2.5 text-[14px] font-medium text-white disabled:bg-line-strong disabled:text-muted"
    >
      Create room
    </button>

    <div class="my-1 flex items-center gap-2 text-[11px] text-muted">
      <span class="h-px flex-1 bg-line"></span>
      or join with a code
      <span class="h-px flex-1 bg-line"></span>
    </div>

    <label class="flex flex-col gap-1 text-[12px] font-medium">
      Room code
      <input
        bind:value={code}
        maxlength="4"
        placeholder="ABCD"
        autocapitalize="characters"
        autocomplete="off"
        class="rounded-[var(--radius-button)] border border-line-strong px-3 py-2 font-mono text-[14px] font-normal uppercase tracking-[0.2em] outline-none focus:border-ink"
      />
    </label>
    <button
      type="button"
      onclick={join}
      disabled={!trimmed || !codeReady || busy}
      class="rounded-[var(--radius-button)] border border-ink px-4 py-2.5 text-[14px] font-medium disabled:border-line-strong disabled:text-muted"
    >
      Join room
    </button>
  </section>

  {#if rooms.length > 0}
    <section class="text-[12px] text-muted">
      <span>Rooms you've been in:</span>
      <span class="inline-flex flex-wrap gap-1.5 pl-1 align-middle">
        {#each rooms as saved (saved)}
          <a
            href={`/r/${saved}`}
            onclick={(e) => {
              e.preventDefault();
              navigate(`/r/${saved}`);
            }}
            class="rounded-[var(--radius-button)] border border-line-strong bg-card px-2 py-0.5 font-mono tracking-[0.15em] text-ink"
          >
            {saved}
          </a>
        {/each}
      </span>
    </section>
  {/if}

  {#if socket.closedNotice}
    <p class="text-[12px] text-muted">{socket.closedNotice}</p>
  {:else if socket.lastError}
    <p class="text-[12px] text-rose-700">{socket.lastError.message}</p>
  {/if}
</main>
