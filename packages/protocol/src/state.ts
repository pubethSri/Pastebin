import { z } from "zod";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_FILENAME_CHARS,
  MAX_NAME_CHARS,
  MAX_STROKE_POINTS,
  MAX_TITLE_CHARS,
} from "./limits";

export const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}$/, "room codes are four letters");

export const MemberNameSchema = z.string().trim().min(1).max(MAX_NAME_CHARS);
export const PaperTitleSchema = z.string().trim().min(1).max(MAX_TITLE_CHARS);
/**
 * Deliberately unbounded here: the length cap is enforced in `Room` so an
 * oversized paste comes back as `TOO_LARGE` — which the composer can explain —
 * rather than as the `BAD_MESSAGE` a schema rejection would produce. The real
 * ceiling on a hostile frame is the socket's `maxPayloadLength`.
 */
export const BlockTextSchema = z.string().min(1);

/**
 * Bounded here rather than in `Room`, unlike block text: a filename is a label,
 * never the payload, so an over-long one is a malformed frame and not a paste
 * someone will be sad to lose. `.max()` after `.trim()` so trailing space can't
 * push a legitimate name over.
 */
export const FilenameSchema = z.string().trim().min(1).max(MAX_FILENAME_CHARS);

/**
 * What a paper is. A `draw` paper holds strokes and renders as a whiteboard; a
 * `text` paper is everything this app was before. The kind is fixed at creation
 * — a board half-converted into a feed is a state nobody asked for.
 */
export const PaperKindSchema = z.enum(["text", "draw"]);
export type PaperKind = z.infer<typeof PaperKindSchema>;

/**
 * One stroke: a width, an eraser flag, and a **flat** array of board
 * coordinates — `[x0, y0, x1, y1, …]`. Flat rather than nested pairs because
 * `[[1,2],[3,4]]` spends four characters per point on brackets that carry no
 * information, and every stroke is re-sent to every joiner.
 *
 * There is deliberately **no colour**. A stroke is drawn in its author's palette
 * colour, which already rides on the block as `authorColor` — storing it twice
 * would let the two disagree, and lets someone paste a stroke claiming a colour
 * that isn't theirs.
 */
export const StrokeSchema = z
  .object({
    /** Board units. */
    w: z.number().int().positive(),
    /** 1 erases, 0 draws. A number rather than a boolean to keep the frame small. */
    e: z.union([z.literal(0), z.literal(1)]),
    p: z
      .array(z.number().int())
      .min(2)
      .max(MAX_STROKE_POINTS * 2),
  })
  .refine((s) => s.p.length % 2 === 0, { message: "points must be x,y pairs" })
  // Bounds are checked here rather than clamped on the server: a coordinate
  // outside the board is a broken client, not a drawing to be quietly repaired.
  .refine(
    (s) => s.p.every((v, i) => v >= 0 && v <= (i % 2 === 0 ? BOARD_WIDTH : BOARD_HEIGHT)),
    { message: "points must lie inside the board" },
  );
export type Stroke = z.infer<typeof StrokeSchema>;

/**
 * `connected` is live socket state and is the only field here that isn't
 * persisted — membership outlives a session on purpose, because owning what you
 * pasted has to survive closing the tab.
 */
export const MemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  connected: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

/** What the paper picker needs, without shipping any paper's blocks. */
export const PaperSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: PaperKindSchema,
  blockCount: z.number().int(),
  /** Epoch ms of the newest block, or the paper's creation time when empty. */
  lastActivity: z.number().int(),
  /** First couple of lines of the newest block; "" for an empty paper. */
  preview: z.string(),
});
export type PaperSummary = z.infer<typeof PaperSummarySchema>;

export const PublicRoomStateSchema = z.object({
  code: RoomCodeSchema,
  papers: z.array(PaperSummarySchema),
  members: z.array(MemberSchema),
});
export type PublicRoomState = z.infer<typeof PublicRoomStateSchema>;

/**
 * Author name and colour are snapshotted onto the block rather than joined from
 * `members` at read time: an author who renames themselves, or who never comes
 * back at all, still has to render exactly as they did when they pasted.
 */
/**
 * An uploaded image. The bytes never travel on the wire — `id` addresses them
 * at `/media/:id`, so the socket keeps carrying only small JSON frames and the
 * browser gets to cache the picture like any other image.
 *
 * Dimensions are display-only, used to reserve the right aspect ratio before
 * the image arrives so the feed doesn't jump. They come from the client and are
 * not load-bearing, which is why nothing validates them.
 */
export const MediaSchema = z.object({
  id: z.string(),
  mime: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  byteSize: z.number().int(),
  name: z.string().nullable(),
});
export type Media = z.infer<typeof MediaSchema>;

export const BlockSchema = z.object({
  id: z.string(),
  paperId: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  authorColor: z.string(),
  /**
   * `text` blocks carry prose/code in `text`; `image` blocks carry `media`;
   * `stroke` blocks carry a JSON `Stroke` in `text`. Strokes reuse the text
   * column rather than getting a table of their own — every query, the
   * authorship gate and deletion then work on them unchanged, which is the
   * whole reason a stroke is a block in the first place.
   */
  kind: z.enum(["text", "image", "stroke"]),
  /** Always a string — "" on an image block, so nothing has to null-check it. */
  text: z.string(),
  /**
   * Where the text came from, when it came from a dropped file rather than the
   * composer. Display only: it labels the block, never joins the text, so a
   * copy still hands over exactly what was in the file and nothing else.
   */
  filename: z.string().nullable(),
  media: MediaSchema.nullable(),
  createdAt: z.number().int(),
  editedAt: z.number().int().nullable(),
});
export type Block = z.infer<typeof BlockSchema>;

/**
 * A full snapshot, sent when a socket opens a paper. Everything after it is a
 * `block.*` delta stamped with the next `rev` — see messages.ts.
 */
export const PaperStateSchema = z.object({
  paperId: z.string(),
  title: z.string(),
  rev: z.number().int(),
  blocks: z.array(BlockSchema),
});
export type PaperState = z.infer<typeof PaperStateSchema>;
