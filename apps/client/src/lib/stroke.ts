import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_STROKE_POINTS,
  type Stroke,
} from "@pastebin/protocol";

/**
 * Stroke geometry: turning a finger's worth of pointer events into something
 * small enough to store and re-send forever.
 *
 * The reason any of this exists is the join snapshot. Every stroke on a board is
 * shipped to every joiner, and a phone rejoins every time its screen wakes — so
 * the difference between a raw 200-point drag and a simplified 25-point one is
 * paid again on every reconnect, by everyone, for as long as the room lives.
 *
 * Everything here is pure and works in board coordinates (integers inside
 * BOARD_WIDTH × BOARD_HEIGHT), never in screen pixels — that is what lets a
 * phone and a desktop look at the same drawing.
 */

/** A point in board space. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Points closer together than this are dropped as they arrive. A pointer emits
 * 60–120 events a second and most of them land within a hair of the last one,
 * carrying no shape at all.
 */
const MIN_STEP = 2;

/**
 * How far a simplified line may stray from the original, in board units. At 2
 * on a 1600-wide board the difference is invisible at any zoom the app offers,
 * and it typically removes 85–90% of the points.
 */
const TOLERANCE = 2;

/** Perpendicular distance from `p` to the segment `a`–`b`. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  // Where the foot of the perpendicular falls along a→b, clamped to the segment
  // so an endpoint is measured to the endpoint rather than to the infinite line.
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker, iteratively rather than recursively: a long drag can
 * be thousands of points, and a recursive version blows the stack on exactly
 * the input this exists to handle.
 *
 * Both endpoints always survive, so a stroke never shrinks away from where it
 * was drawn.
 */
export function simplify(points: Point[], tolerance: number = TOLERANCE): Point[] {
  if (points.length <= 2) return points.slice();

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let worstAt = -1;

    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i]!, points[first]!, points[last]!);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }

    if (worstAt !== -1 && worst > tolerance) {
      keep[worstAt] = true;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  return points.filter((_, i) => keep[i]!);
}

/**
 * Appends a point unless it is too close to the last one to carry any shape.
 * Returns whether it was taken, so the caller can skip redrawing for nothing.
 */
export function appendPoint(points: Point[], next: Point): boolean {
  const last = points[points.length - 1];
  if (last && Math.hypot(next.x - last.x, next.y - last.y) < MIN_STEP) return false;
  points.push(next);
  return true;
}

/**
 * Screen coordinates to board coordinates.
 *
 * `rect` is the canvas's own bounding box, so this handles the letterboxing for
 * free: the canvas element is sized to the board's aspect ratio by CSS, and
 * everything here does is map one box onto the other. Rounded to integers
 * because that is what the wire format stores, and clamped because a pointer
 * can be captured slightly outside the element it started in.
 */
export function toBoard(clientX: number, clientY: number, rect: DOMRect): Point {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  return {
    x: clamp(((clientX - rect.left) / rect.width) * BOARD_WIDTH, BOARD_WIDTH),
    y: clamp(((clientY - rect.top) / rect.height) * BOARD_HEIGHT, BOARD_HEIGHT),
  };
}

/**
 * Packs points into the flat array the wire format uses, simplifying first and
 * truncating to the protocol's point cap.
 *
 * The cap should never bite — simplification lands well under it — so hitting
 * it means something upstream is wrong, and dropping the tail is better than
 * having the whole stroke rejected by the server's schema.
 */
export function encode(points: Point[], width: number, eraser: boolean): Stroke {
  const simplified = simplify(points).slice(0, MAX_STROKE_POINTS);
  const p: number[] = [];
  for (const point of simplified) p.push(point.x, point.y);
  return { w: width, e: eraser ? 1 : 0, p };
}

/** Unpacks a stored stroke. Returns [] for anything malformed rather than throwing. */
export function decode(json: string): { points: Point[]; width: number; eraser: boolean } | null {
  try {
    const raw = JSON.parse(json) as Stroke;
    if (!raw || !Array.isArray(raw.p) || raw.p.length < 2 || raw.p.length % 2 !== 0) return null;
    const points: Point[] = [];
    for (let i = 0; i < raw.p.length; i += 2) points.push({ x: raw.p[i]!, y: raw.p[i + 1]! });
    return { points, width: raw.w, eraser: raw.e === 1 };
  } catch {
    // A block whose text isn't a stroke shouldn't take the whole board down.
    return null;
  }
}
