import { describe, expect, test } from "bun:test";
import { BOARD_HEIGHT, BOARD_WIDTH, MAX_STROKE_POINTS, StrokeSchema } from "@pastebin/protocol";
import { appendPoint, decode, encode, simplify, toBoard, type Point } from "../src/lib/stroke";

const p = (x: number, y: number): Point => ({ x, y });

/** A canvas box, as `getBoundingClientRect` would report it. */
const rect = (width: number, left = 0, top = 0): DOMRect =>
  ({ left, top, width, height: (width * BOARD_HEIGHT) / BOARD_WIDTH }) as DOMRect;

/** Greatest distance from any original point to the simplified polyline. */
function maxDeviation(original: Point[], kept: Point[]): number {
  const distance = (q: Point, a: Point, b: Point) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) return Math.hypot(q.x - a.x, q.y - a.y);
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
  };
  let worst = 0;
  for (const q of original) {
    let best = Infinity;
    for (let i = 0; i < kept.length - 1; i++) best = Math.min(best, distance(q, kept[i]!, kept[i + 1]!));
    worst = Math.max(worst, best);
  }
  return worst;
}

describe("simplify", () => {
  test("both endpoints always survive", () => {
    // A stroke that drifted from where it was drawn would be worse than one
    // that kept every point.
    const points = Array.from({ length: 50 }, (_, i) => p(i * 7, Math.round(Math.sin(i / 4) * 60) + 200));
    const kept = simplify(points);
    expect(kept[0]).toEqual(points[0]!);
    expect(kept[kept.length - 1]).toEqual(points[points.length - 1]!);
  });

  test("no original point ends up further from the line than the tolerance", () => {
    const points = Array.from({ length: 300 }, (_, i) => p(i * 5, Math.round(Math.sin(i / 9) * 120) + 400));
    const kept = simplify(points, 2);
    expect(maxDeviation(points, kept)).toBeLessThanOrEqual(2 + 1e-9);
  });

  test("a hand-drawn line loses most of its points and none of its shape", () => {
    // A slow drag: many samples, small steps, a little jitter — the input this
    // exists for, and the reason the join snapshot stays affordable.
    const points = Array.from({ length: 400 }, (_, i) =>
      p(Math.round(i * 2 + Math.sin(i) * 0.4), Math.round(300 + Math.sin(i / 30) * 150 + Math.cos(i) * 0.4)),
    );
    const kept = simplify(points);
    expect(kept.length).toBeLessThan(points.length / 5);
    expect(maxDeviation(points, kept)).toBeLessThanOrEqual(2 + 1e-9);
  });

  test("a straight line collapses to its two ends", () => {
    const points = Array.from({ length: 100 }, (_, i) => p(i * 4, 500));
    expect(simplify(points)).toEqual([p(0, 500), p(396, 500)]);
  });

  test("running it again changes nothing", () => {
    const points = Array.from({ length: 200 }, (_, i) => p(i * 3, Math.round(Math.cos(i / 7) * 90) + 300));
    const once = simplify(points);
    expect(simplify(once)).toEqual(once);
  });

  test("degenerate input comes back unharmed", () => {
    expect(simplify([])).toEqual([]);
    expect(simplify([p(5, 5)])).toEqual([p(5, 5)]);
    expect(simplify([p(5, 5), p(9, 9)])).toEqual([p(5, 5), p(9, 9)]);
    // Every point identical: the segment has no direction to measure against.
    expect(simplify(Array.from({ length: 20 }, () => p(7, 7)))).toEqual([p(7, 7), p(7, 7)]);
  });

  test("a very long drag doesn't blow the stack", () => {
    // Recursive RDP dies on exactly this input, which is why the real one is
    // iterative. A zig-zag defeats the divide-and-conquer split.
    const points = Array.from({ length: 20_000 }, (_, i) => p(i % BOARD_WIDTH, i % 2 === 0 ? 0 : 400));
    expect(() => simplify(points)).not.toThrow();
  });
});

describe("appendPoint", () => {
  test("points too close together to carry shape are dropped", () => {
    const points = [p(100, 100)];
    expect(appendPoint(points, p(100, 101))).toBe(false);
    expect(points).toHaveLength(1);
  });

  test("a real step is taken", () => {
    const points = [p(100, 100)];
    expect(appendPoint(points, p(100, 110))).toBe(true);
    expect(points).toHaveLength(2);
  });

  test("the first point is always taken", () => {
    const points: Point[] = [];
    expect(appendPoint(points, p(0, 0))).toBe(true);
  });
});

describe("toBoard", () => {
  test("corners map to corners at any size", () => {
    for (const width of [375, 768, 1280]) {
      const box = rect(width);
      expect(toBoard(0, 0, box)).toEqual(p(0, 0));
      expect(toBoard(box.width, box.height, box)).toEqual(p(BOARD_WIDTH, BOARD_HEIGHT));
    }
  });

  test("the same physical spot means the same board point on a phone and a desktop", () => {
    // This is the property the whole fixed-board design exists for: two people
    // on different screens have to be looking at the same drawing.
    const phone = toBoard(0.25 * 375, 0.5 * ((375 * BOARD_HEIGHT) / BOARD_WIDTH), rect(375));
    const desktop = toBoard(0.25 * 1280, 0.5 * ((1280 * BOARD_HEIGHT) / BOARD_WIDTH), rect(1280));
    expect(Math.abs(phone.x - desktop.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(phone.y - desktop.y)).toBeLessThanOrEqual(1);
  });

  test("the canvas's offset on the page is accounted for", () => {
    expect(toBoard(140, 90, rect(400, 140, 90))).toEqual(p(0, 0));
  });

  test("a pointer dragged outside the canvas is clamped, not extrapolated", () => {
    // Pointer capture keeps delivering events past the element's edge.
    const box = rect(400);
    expect(toBoard(-500, -500, box)).toEqual(p(0, 0));
    expect(toBoard(9999, 9999, box)).toEqual(p(BOARD_WIDTH, BOARD_HEIGHT));
  });
});

describe("encode and decode", () => {
  test("what the client encodes is what the server's schema accepts", () => {
    // The two halves of the contract, checked against each other rather than
    // against my idea of the contract.
    const points = Array.from({ length: 120 }, (_, i) => p(i * 9, Math.round(Math.sin(i / 5) * 100) + 300));
    expect(StrokeSchema.safeParse(encode(points, 3, false)).success).toBe(true);
    expect(StrokeSchema.safeParse(encode(points, 24, true)).success).toBe(true);
    expect(StrokeSchema.safeParse(encode([p(1, 1)], 3, false)).success).toBe(true);
  });

  test("a stroke round-trips through JSON", () => {
    const points = [p(10, 20), p(300, 400), p(1599, 1199)];
    const back = decode(JSON.stringify(encode(points, 24, true)));
    expect(back).toEqual({ points, width: 24, eraser: true });
  });

  test("the eraser flag survives both ways", () => {
    expect(encode([p(1, 1), p(9, 9)], 3, false).e).toBe(0);
    expect(decode(JSON.stringify(encode([p(1, 1), p(9, 9)], 3, false)))!.eraser).toBe(false);
  });

  test("points are packed flat, two numbers per point", () => {
    const stroke = encode([p(1, 2), p(300, 400)], 3, false);
    expect(stroke.p).toEqual([1, 2, 300, 400]);
  });

  test("an implausibly long stroke is truncated rather than rejected outright", () => {
    // Simplification should make this unreachable; if it ever isn't, losing the
    // tail beats losing the stroke to a schema rejection.
    const points = Array.from({ length: MAX_STROKE_POINTS + 500 }, (_, i) =>
      p(i % BOARD_WIDTH, i % 2 === 0 ? 0 : BOARD_HEIGHT),
    );
    const stroke = encode(points, 3, false);
    expect(stroke.p.length).toBeLessThanOrEqual(MAX_STROKE_POINTS * 2);
    expect(StrokeSchema.safeParse(stroke).success).toBe(true);
  });

  test("a block whose text isn't a stroke returns null instead of throwing", () => {
    // Malformed geometry must not take the whole board down with it.
    for (const bad of ["", "not json", "{}", '{"p":[1]}', '{"p":[1,2,3]}', "null", "[]"]) {
      expect(decode(bad)).toBeNull();
    }
  });
});
