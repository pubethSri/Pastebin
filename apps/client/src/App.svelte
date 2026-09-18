<script lang="ts">
  import { route } from "./lib/router.svelte";
  import Home from "./routes/Home.svelte";
  import Room from "./routes/Room.svelte";

  const current = $derived(route.current);
</script>

{#if current.name === "room"}
  <Room code={current.code} paperId={current.paperId} />
{:else}
  <Home />
{/if}
