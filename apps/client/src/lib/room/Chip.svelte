<script lang="ts">
  /**
   * The whole ownership signal: a colour and one letter. Deliberately not an
   * avatar, a badge or a full name — it has to read at a glance next to a wall
   * of monospace without competing with it.
   */
  let {
    name,
    color,
    size = 20,
  }: { name: string; color: string; size?: number } = $props();

  const letter = $derived((name.trim()[0] ?? "?").toUpperCase());
</script>

<span
  class="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none text-white"
  style="background:{color};width:{size}px;height:{size}px;font-size:{Math.round(size * 0.48)}px"
  title={name}
>{letter}</span>
