<script lang="ts">
  import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    BRUSH_WIDTH,
    ERASER_WIDTH,
    type Block,
    type Stroke,
  } from "@pastebin/protocol";
  import { appendPoint, decode, encode, toBoard, type Point } from "../stroke";

  let {
    blocks,
    canDraw,
    /**
     * The room's last socket error, passed for its *identity* rather than its
     * contents. A stroke is painted the moment you draw it, before the server
     * has agreed to it — if the post was refused those pixels are a lie, and
     * the cheapest honest fix is to repaint from what the server actually has.
     */
    errorSignal = null,
    myColor,
    onStroke,
    onClearMine,
  }: {
    blocks: Block[];
    canDraw: boolean;
    errorSignal?: unknown;
    /**
     * The drawer's own palette colour — the same one their chip uses, so a
     * board shows at a glance who drew what. Only needed for the live stroke;
     * every committed stroke reads it off its own block's `authorColor`.
     */
    myColor: string;
    onStroke: (stroke: Stroke) => void;
    onClearMine: () => void;
  } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let holder = $state<HTMLDivElement | null>(null);
  let tool = $state<"brush" | "eraser">("brush");
  let confirmingClear = $state(false);
  let ctx: CanvasRenderingContext2D | null = null;

  const strokes = $derived(blocks.filter((b) => b.kind === "stroke"));
  const width = $derived(tool === "eraser" ? ERASER_WIDTH : BRUSH_WIDTH);

  /*
   * Painting is incremental, and these two are how it knows it can be.
   *
   * A new stroke — anyone's — only ever appends, so the common case is to paint
   * the tail and leave the rest of the canvas alone. Anything else (a deletion,
   * a clear, a fresh snapshot after a reconnect) fails the prefix check below
   * and repaints from scratch, which is rare enough not to matter and simple
   * enough not to get wrong. Plain `let`, not `$state`: writing these inside the
   * effect that reads them would be a loop.
   */
  let paintedCount = 0;
  let paintedLastId: string | null = null;

  /**
   * Letterboxes the board into whatever space is going, then matches the
   * backing store to it. `Math.min` of the two scales is the letterboxing: the
   * board keeps its shape and the leftover space stays empty, so two people on
   * different screens see the same drawing rather than different crops of one.
   */
  function fit(): void {
    if (!canvas || !ctx || !holder) return;
    const available = holder.getBoundingClientRect();
    if (available.width === 0 || available.height === 0) return;

    const scale = Math.min(available.width / BOARD_WIDTH, available.height / BOARD_HEIGHT);
    const cssWidth = Math.max(1, Math.floor(BOARD_WIDTH * scale));
    const cssHeight = Math.max(1, Math.floor(BOARD_HEIGHT * scale));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    // Setting width/height resets the context, so every bit of state below has
    // to be established after it, not before.
    const devicePerBoard = (cssWidth * dpr) / BOARD_WIDTH;
    ctx.setTransform(devicePerBoard, 0, 0, devicePerBoard, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    redrawAll();
  }

  function paint(block: Block): void {
    if (!ctx) return;
    const stroke = decode(block.text);
    if (!stroke || stroke.points.length === 0) return;

    /*
     * The eraser is a stroke like any other, drawn `destination-out`.
     *
     * That is why the canvas is never filled with a background colour — the
     * paper colour is CSS behind a transparent canvas, so erasing punches
     * through to it and reads exactly like erasing. Fill the canvas and you get
     * a hole through the card instead.
     *
     * Nothing is destroyed by this: the strokes underneath are still blocks, so
     * removing the eraser stroke brings them back on the next repaint.
     */
    ctx.globalCompositeOperation = stroke.eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = block.authorColor;
    ctx.fillStyle = block.authorColor;
    ctx.lineWidth = stroke.width;

    if (stroke.points.length === 1) {
      // A tap. A zero-length line doesn't reliably paint even with a round cap,
      // so a dot is drawn as a dot.
      const [dot] = stroke.points;
      ctx.beginPath();
      ctx.arc(dot!.x, dot!.y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(stroke.points[0]!.x, stroke.points[0]!.y);
    for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i]!.x, stroke.points[i]!.y);
    ctx.stroke();
  }

  function redrawAll(): void {
    if (!ctx || !canvas) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    for (const block of strokes) paint(block);
    paintedCount = strokes.length;
    paintedLastId = strokes[strokes.length - 1]?.id ?? null;
  }

  function sync(): void {
    if (!ctx) return;
    const appendable =
      paintedCount === 0 ||
      (strokes.length >= paintedCount && strokes[paintedCount - 1]?.id === paintedLastId);
    if (!appendable) return redrawAll();

    for (let i = paintedCount; i < strokes.length; i++) paint(strokes[i]!);
    paintedCount = strokes.length;
    paintedLastId = strokes[strokes.length - 1]?.id ?? null;
  }

  /* ------------------------------ drawing ------------------------------ */

  let drawing = $state(false);
  let points: Point[] = [];
  let pointerId: number | null = null;

  /**
   * Applies the live stroke's settings before every segment.
   *
   * Not once at pointer-down: someone else's stroke can arrive mid-drag, and
   * painting it changes the composite mode, colour and width out from under us.
   */
  function armLive(): void {
    if (!ctx) return;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = myColor;
    ctx.fillStyle = myColor;
    ctx.lineWidth = width;
  }

  function onPointerDown(e: PointerEvent): void {
    if (!canDraw || !canvas || !ctx || drawing) return;
    // Capture keeps the stroke coming even when the finger leaves the canvas,
    // which is what `toBoard`'s clamping is there to absorb. It throws if the
    // pointer is already gone by the time this runs — a released pointer is not
    // a reason to refuse to draw the rest of the stroke.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable; the stroke still works, it just won't track off-canvas */
    }
    pointerId = e.pointerId;
    drawing = true;
    confirmingClear = false;

    const p = toBoard(e.clientX, e.clientY, canvas.getBoundingClientRect());
    points = [p];

    // Paint the dot immediately, so a tap shows up before it is posted.
    armLive();
    ctx.beginPath();
    ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drawing || !canvas || !ctx || e.pointerId !== pointerId) return;
    const p = toBoard(e.clientX, e.clientY, canvas.getBoundingClientRect());
    const previous = points[points.length - 1]!;
    if (!appendPoint(points, p)) return;

    armLive();
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drawing || e.pointerId !== pointerId) return;
    drawing = false;
    pointerId = null;
    try {
      canvas?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released — pointercancel and pointerup can both land here */
    }

    const finished = points;
    points = [];
    if (finished.length === 0) return;

    /*
     * The live pixels above are already on the canvas, and the block that comes
     * back paints the same simplified line over them. Counting it as painted
     * now would make `sync` skip the echo and leave the two out of step, so it
     * deliberately isn't — repainting a line on top of itself costs nothing.
     */
    onStroke(encode(finished, width, tool === "eraser"));
  }

  /* ------------------------------- effects ------------------------------ */

  $effect(() => {
    if (!canvas || !holder) return;
    ctx = canvas.getContext("2d");
    // The holder, never the canvas: observing an element whose size this
    // callback changes is the loop described in the markup below.
    const observer = new ResizeObserver(() => fit());
    observer.observe(holder);
    fit();
    return () => observer.disconnect();
  });

  $effect(() => {
    strokes;
    sync();
  });

  $effect(() => {
    if (errorSignal && ctx) redrawAll();
  });
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <!--
    The board keeps its aspect ratio and is letterboxed inside whatever space is
    going, so a phone and a desktop are looking at the same drawing rather than
    at different crops of one.
  -->
  <div class="flex min-h-0 flex-1 overflow-hidden p-3">
    <!--
      The canvas is absolutely positioned inside this box and sized by `fit()`
      in JavaScript, which is not a preference — two separate things go wrong
      the obvious way.

      A canvas's *intrinsic* size is its width/height attributes, so a canvas
      laid out by its own content box makes `fit()` writing canvas.width change
      the layout, which fires the ResizeObserver, which calls `fit()` again;
      the browser throttles that loop and strands the backing store at the wrong
      size. And CSS `aspect-ratio` does not shrink a definite width when
      `max-height` clamps, so the letterboxing simply doesn't happen — you get a
      board with the bottom cut off.

      Absolute positioning takes the canvas out of flow, so this box's size
      never depends on it, and the observer below can watch this box safely.
    -->
    <div bind:this={holder} class="relative min-h-0 flex-1">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <canvas
        bind:this={canvas}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        style="touch-action: none;"
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)] border border-line bg-card
          {canDraw ? (tool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair') : 'cursor-not-allowed opacity-60'}"
      ></canvas>
    </div>
  </div>

  <div class="safe-bottom border-t border-line bg-card px-3 pt-2">
    <div class="mx-auto flex max-w-3xl items-center gap-2 pb-2">
      <button
        type="button"
        onclick={() => (tool = "brush")}
        disabled={!canDraw}
        aria-pressed={tool === "brush"}
        class="rounded-[var(--radius-button)] border px-3 py-1 text-[12px] disabled:opacity-50
          {tool === 'brush' ? 'border-ink bg-ink text-white' : 'border-line-strong hover:bg-paper'}"
      >
        Brush
      </button>
      <button
        type="button"
        onclick={() => (tool = "eraser")}
        disabled={!canDraw}
        aria-pressed={tool === "eraser"}
        class="rounded-[var(--radius-button)] border px-3 py-1 text-[12px] disabled:opacity-50
          {tool === 'eraser' ? 'border-ink bg-ink text-white' : 'border-line-strong hover:bg-paper'}"
      >
        Eraser
      </button>

      <span class="min-w-0 flex-1 truncate text-[11px] text-muted">
        {#if !canDraw}
          Reconnecting…
        {:else}
          <span class="hidden sm:inline">You draw in your own colour · erasing is undone by Clear mine</span>
        {/if}
      </span>

      <!-- Two-step, like deleting a block: this can remove a lot of work, and
           it is the one button on the board that takes something away. -->
      {#if confirmingClear}
        <button
          type="button"
          onclick={() => {
            onClearMine();
            confirmingClear = false;
          }}
          class="shrink-0 rounded-[var(--radius-button)] border border-rose-500 bg-rose-50 px-3 py-1 text-[12px] font-medium text-rose-700"
        >
          Clear mine?
        </button>
        <button
          type="button"
          onclick={() => (confirmingClear = false)}
          class="shrink-0 rounded-[var(--radius-button)] border border-line-strong px-2 py-1 text-[12px] text-muted"
        >
          No
        </button>
      {:else}
        <button
          type="button"
          onclick={() => (confirmingClear = true)}
          disabled={!canDraw}
          title="Remove everything you drew — nobody else's work is touched"
          class="shrink-0 rounded-[var(--radius-button)] border border-line-strong px-3 py-1 text-[12px] hover:bg-paper disabled:opacity-50"
        >
          Clear mine
        </button>
      {/if}
    </div>
  </div>
</div>
