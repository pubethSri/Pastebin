<script lang="ts">
  import qrcode from "qrcode-generator";

  let { text, size = 200 }: { text: string; size?: number } = $props();

  /** Modules of white margin. Four is the spec minimum for a reliable scan. */
  const QUIET = 4;

  const model = $derived.by(() => {
    // Type 0 = pick the smallest version that fits. "M" tolerates ~15% damage,
    // which is the usual trade for a code being read off a screen at an angle.
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();

    const count = qr.getModuleCount();
    // One path of 1×1 squares rather than a rect per module: same pixels, one
    // node, and it stays crisp at any size because the viewBox is in modules.
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
      }
    }
    return { extent: count + QUIET * 2, d };
  });
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 {model.extent} {model.extent}"
  shape-rendering="crispEdges"
  role="img"
  aria-label="QR code for {text}"
  class="rounded-[var(--radius-button)]"
>
  <!-- Ink on white, always — a QR inverted by a dark theme does not scan. -->
  <rect width={model.extent} height={model.extent} fill="#ffffff" />
  <path d={model.d} fill="#000000" />
</svg>
