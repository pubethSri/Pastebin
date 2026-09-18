<script lang="ts">
  interface Preview {
    url: string;
    title: string | null;
    description: string | null;
    siteName: string | null;
    imageUrl: string | null;
  }

  type Entry =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; preview: Preview }
    | { status: "error"; message: string };

  let { links }: { links: string[] } = $props();

  let entries = $state<Record<string, Entry>>({});
  /** og:image URLs that failed to load — the card just drops the thumbnail. */
  let brokenImages = $state<Record<string, true>>({});

  /**
   * Nothing is fetched because a link was pasted — only because someone pressed
   * this button. That's the whole reason previews are opt-in: otherwise your PC
   * quietly visits whatever anyone drops in a room, including by accident.
   */
  async function preview(url: string) {
    const current = entries[url];
    if (current && current.status !== "idle" && current.status !== "error") return;
    entries = { ...entries, [url]: { status: "loading" } };
    try {
      const res = await fetch(`/api/preview?url=${encodeURIComponent(url)}`);
      const body = await res.json();
      entries = res.ok
        ? { ...entries, [url]: { status: "done", preview: body as Preview } }
        : { ...entries, [url]: { status: "error", message: body?.error ?? "no preview available" } };
    } catch {
      entries = { ...entries, [url]: { status: "error", message: "could not reach the server" } };
    }
  }

  /** host + path, without the scheme — the part that says where you're going. */
  function shortLabel(url: string): string {
    try {
      const u = new URL(url);
      const tail = `${u.pathname}${u.search}`.replace(/\/$/, "");
      return `${u.host.replace(/^www\./, "")}${tail}`;
    } catch {
      return url;
    }
  }
</script>

<div class="flex flex-col gap-1.5 border-t border-line px-3 py-2">
  {#each links as url (url)}
    {@const entry = entries[url] ?? { status: "idle" }}
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2">
        <span class="shrink-0 text-[11px] text-muted">↗</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          class="min-w-0 flex-1 truncate text-[11px] text-sky-700 hover:underline"
          title={url}
        >
          {shortLabel(url)}
        </a>
        <button
          type="button"
          onclick={() => preview(url)}
          disabled={entry.status === "loading"}
          class="shrink-0 rounded-[var(--radius-button)] border border-line-strong px-2 py-0.5 text-[11px] text-muted hover:bg-paper disabled:opacity-50"
        >
          {entry.status === "loading" ? "…" : entry.status === "done" ? "refresh" : "preview"}
        </button>
      </div>

      {#if entry.status === "done"}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          class="flex gap-2 rounded-[var(--radius-button)] border border-line bg-paper p-2 hover:bg-card"
        >
          {#if entry.preview.imageUrl && !brokenImages[entry.preview.imageUrl]}
            <!--
              Proxied through our own server, never loaded from the remote host
              directly: a raw <img src> would leak every viewer's IP to the site
              and would sidestep the private-address guard, since the browser
              doing the fetching sits inside the LAN.

              No `loading="lazy"`: this thumbnail only exists because someone
              pressed preview, so it is already as lazy as it needs to be, and
              deferring a 56px image inside a scroll container is a reliable way
              to end up with one that silently never loads.
            -->
            {@const imageUrl = entry.preview.imageUrl}
            <img
              src={`/api/preview/image?url=${encodeURIComponent(imageUrl)}`}
              alt=""
              class="h-14 w-14 shrink-0 rounded object-cover"
              onerror={() => (brokenImages = { ...brokenImages, [imageUrl]: true })}
            />
          {/if}
          <div class="min-w-0 font-ui">
            {#if entry.preview.title}
              <div class="truncate text-[12px] font-medium text-ink">{entry.preview.title}</div>
            {/if}
            {#if entry.preview.description}
              <p class="line-clamp-2 text-[11px] leading-snug text-muted">{entry.preview.description}</p>
            {/if}
            {#if entry.preview.siteName}
              <div class="mt-0.5 truncate text-[10px] text-muted">{entry.preview.siteName}</div>
            {/if}
          </div>
        </a>
      {:else if entry.status === "error"}
        <p class="text-[11px] text-muted">{entry.message}</p>
      {/if}
    </div>
  {/each}
</div>
