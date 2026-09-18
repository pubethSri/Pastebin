<script lang="ts">
  import { CLI_BUILDS, cliSetupCommands } from "@pastebin/protocol";
  import CopyButton from "./CopyButton.svelte";
  import QrCode from "./QrCode.svelte";

  let { code, onClose }: { code: string; onClose: () => void } = $props();

  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  /**
   * Addresses this room can be reached at, best first.
   *
   * If you are looking at this on the host PC, `location.origin` is
   * `http://localhost:3000` — a QR of which scans perfectly and then fails on
   * the phone, which reads as the app being broken. So when the current host is
   * loopback we ask the server which addresses it actually answers on and offer
   * those instead.
   */
  let hosts = $state<string[]>([location.host]);
  let chosen = $state(location.host);

  $effect(() => {
    if (!loopback) return;
    fetch("/api/host")
      .then((r) => r.json())
      .then((data: { addresses: string[] }) => {
        const port = location.port ? `:${location.port}` : "";
        const lan = data.addresses.map((a) => `${a}${port}`);
        if (lan.length === 0) return;
        hosts = [...lan, location.host];
        chosen = lan[0]!;
      })
      .catch(() => {
        /* keep the loopback host; the code still works by hand */
      });
  });

  const url = $derived(`${location.protocol}//${chosen}/r/${code}`);
  const server = $derived(`${location.protocol}//${chosen}`);

  /**
   * Which command-line builds this server actually has on disk. Empty until
   * someone runs `bun run build:cli`, and the section stays hidden rather than
   * offering a download that would 404. The commands use `chosen`, so picking
   * a LAN address above rewrites them too — the same reason the link does.
   */
  let cliFiles = $state<string[]>([]);
  $effect(() => {
    fetch("/api/cli")
      .then((r) => r.json())
      .then((data: { files?: unknown }) => {
        cliFiles = Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === "string") : [];
      })
      .catch(() => {
        /* no CLI section, which is also what an old server gets */
      });
  });
  const builds = $derived(CLI_BUILDS.filter((b) => cliFiles.includes(b.file)));
</script>

<div class="border-b border-line bg-paper px-3 py-3">
  <div class="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-start">
    <div class="shrink-0 self-center rounded-[var(--radius-button)] border border-line bg-white p-2 sm:self-start">
      <QrCode text={url} size={160} />
    </div>

    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <div>
        <div class="text-[11px] text-muted">Room code</div>
        <div class="font-mono text-[22px] font-semibold tracking-[0.3em]">{code}</div>
      </div>

      <div class="min-w-0">
        <div class="text-[11px] text-muted">Link</div>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded-[var(--radius-button)] border border-line bg-card px-2 py-1 text-[12px]">
            {url}
          </code>
          <CopyButton text={() => url} label="Copy link" />
        </div>
      </div>

      {#if hosts.length > 1}
        <div>
          <div class="text-[11px] text-muted">
            {loopback ? "You're on localhost — phones need one of these:" : "Address"}
          </div>
          <div class="mt-1 flex flex-wrap gap-1.5">
            {#each hosts as host (host)}
              <button
                type="button"
                onclick={() => (chosen = host)}
                class="rounded-[var(--radius-button)] border px-2 py-1 font-mono text-[11px]
                  {chosen === host ? 'border-ink bg-ink text-white' : 'border-line-strong bg-card hover:bg-paper'}"
              >
                {host}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if builds.length > 0}
        <div class="min-w-0">
          <div class="text-[11px] text-muted">Command line — download once, then join. Both lines copy together.</div>
          <div class="mt-1 flex flex-col gap-1.5">
            {#each builds as build (build.file)}
              {@const commands = cliSetupCommands(server, code, build)}
              <div class="flex items-start gap-2">
                <span class="w-32 shrink-0 pt-1 text-[11px] leading-tight text-muted">{build.label}</span>
                <pre
                  class="min-w-0 flex-1 overflow-x-auto rounded-[var(--radius-button)] border border-line bg-card px-2 py-1 text-[11px] leading-relaxed"
                >{commands}</pre>
                <CopyButton text={() => commands} />
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <button type="button" onclick={onClose} class="shrink-0 self-start px-2 py-1 text-[12px] text-muted underline">
      close
    </button>
  </div>
</div>
