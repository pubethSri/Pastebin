<script lang="ts">
  import type { Member } from "@pastebin/protocol";
  import Chip from "./Chip.svelte";

  let {
    members,
    meId,
    onRenameSelf,
  }: { members: Member[]; meId: string | null; onRenameSelf: () => void } = $props();

  /** Past this the row starts eating the title on a phone. */
  const MAX_SHOWN = 4;

  // You first, always — your own chip is also the rename button, so it must not
  // be the one that gets collapsed into the "+3".
  const ordered = $derived([...members].sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : 0)));
  const shown = $derived(ordered.slice(0, MAX_SHOWN));
  const hidden = $derived(ordered.slice(MAX_SHOWN));
</script>

<div class="flex shrink-0 items-center gap-1">
  {#each shown as member (member.id)}
    {#if member.id === meId}
      <button
        type="button"
        onclick={onRenameSelf}
        title="{member.name} (you) — tap to rename"
        class="rounded-full ring-2 ring-ink ring-offset-1"
      >
        <Chip name={member.name} color={member.color} size={22} />
      </button>
    {:else}
      <Chip name={member.name} color={member.color} size={22} />
    {/if}
  {/each}

  {#if hidden.length > 0}
    <span
      class="inline-flex h-[22px] shrink-0 items-center rounded-full border border-line-strong px-1.5 text-[10px] text-muted"
      title={hidden.map((m) => m.name).join(", ")}
    >
      +{hidden.length}
    </span>
  {/if}
</div>
