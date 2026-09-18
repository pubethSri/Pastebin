import { z } from "zod";
import {
  BlockTextSchema,
  FilenameSchema,
  MemberNameSchema,
  PaperKindSchema,
  PaperTitleSchema,
  RoomCodeSchema,
  StrokeSchema,
} from "./state";

const protocolVersion = z.number().int();

/* -- binding intents: they attach a socket to a room, and carry the version -- */

export const RoomCreateIntentSchema = z.object({
  type: z.literal("room.create"),
  payload: z.object({ memberName: MemberNameSchema, protocolVersion }),
});

export const RoomJoinIntentSchema = z.object({
  type: z.literal("room.join"),
  payload: z.object({ code: RoomCodeSchema, memberName: MemberNameSchema, protocolVersion }),
});

/**
 * Reclaims an *identity*, not a seat. Unlike YAWBG there is nothing to hold
 * open — the member row is permanent, so a resume can succeed days later.
 */
export const SessionResumeIntentSchema = z.object({
  type: z.literal("session.resume"),
  payload: z.object({
    code: RoomCodeSchema,
    memberId: z.string(),
    token: z.string(),
    protocolVersion,
  }),
});

/* ------------------------------ room intents ------------------------------ */

/**
 * Deletes the room and everything in it, for everyone, immediately.
 *
 * Open to any member, like paper management — this app has no host tier, and
 * inventing one for a single button would be a bigger change than the button.
 * Rooms are short-lived by design anyway, so the blast radius is a session.
 * The confirmation lives in the UI.
 */
export const RoomDeleteIntentSchema = z.object({
  type: z.literal("room.delete"),
  payload: z.object({}),
});

/** Renames forward only: blocks already posted keep their snapshotted name. */
export const MemberRenameIntentSchema = z.object({
  type: z.literal("member.rename"),
  payload: z.object({ name: MemberNameSchema }),
});

/** Subscribes this socket to one paper's delta stream and returns a snapshot. */
export const PaperOpenIntentSchema = z.object({
  type: z.literal("paper.open"),
  payload: z.object({ paperId: z.string() }),
});

/** Asks for a fresh snapshot after the client notices a `rev` gap. */
export const PaperRefreshIntentSchema = z.object({
  type: z.literal("paper.refresh"),
  payload: z.object({ paperId: z.string() }),
});

/**
 * Stop watching whatever this socket had open — sent when you back out to the
 * picker. Without it a socket sitting on the grid keeps receiving deltas for
 * the paper it last viewed, and a delta carries a whole block, which is exactly
 * the traffic the snapshot-plus-delta design exists to avoid.
 */
export const PaperCloseIntentSchema = z.object({
  type: z.literal("paper.close"),
  payload: z.object({}),
});

/* Paper management is open to anyone in the room — there is no host tier. */

/**
 * `kind` is optional rather than defaulted, so an omitted one stays omitted in
 * the inferred type and the server reads it as `?? "text"` — the same shape
 * `filename` uses on `block.post`. A paper's kind is fixed at creation: a board
 * half-converted into a feed is a state nobody asked for.
 */
export const PaperCreateIntentSchema = z.object({
  type: z.literal("paper.create"),
  payload: z.object({ title: PaperTitleSchema, kind: PaperKindSchema.optional() }),
});

export const PaperRenameIntentSchema = z.object({
  type: z.literal("paper.rename"),
  payload: z.object({ paperId: z.string(), title: PaperTitleSchema }),
});

/** Refused for a room's last paper: a room always has somewhere to paste. */
export const PaperDeleteIntentSchema = z.object({
  type: z.literal("paper.delete"),
  payload: z.object({ paperId: z.string() }),
});

/**
 * `filename` is set when the text was dropped as a file instead of typed. A
 * field rather than a second intent — the split below exists because a text
 * block and an image block have nothing in common on the wire, which is not the
 * case here: this is the same block carrying one extra label.
 */
export const BlockPostIntentSchema = z.object({
  type: z.literal("block.post"),
  payload: z.object({
    paperId: z.string(),
    text: BlockTextSchema,
    filename: FilenameSchema.nullable().optional(),
  }),
});

/**
 * Posts an already-uploaded image. Two intents rather than one with optional
 * fields: a text block and an image block have nothing in common on the wire,
 * and a single payload where each half is `.optional()` can express states that
 * mean nothing ("both", "neither") and then has to reject them at runtime.
 *
 * The bytes went over HTTP to `/api/upload` first; this only attaches the id.
 */
export const BlockPostImageIntentSchema = z.object({
  type: z.literal("block.postImage"),
  payload: z.object({ paperId: z.string(), mediaId: z.string() }),
});

/** One finished stroke on a draw paper. Sent on pointer-up, not while drawing. */
export const BlockPostStrokeIntentSchema = z.object({
  type: z.literal("block.postStroke"),
  payload: z.object({ paperId: z.string(), stroke: StrokeSchema }),
});

/**
 * Removes everything *you* drew on a paper, and nothing else.
 *
 * This needs no new authorship rule: the query is scoped to the caller's own
 * member id, so the guarantee is structural rather than a check that could be
 * forgotten. Deliberately not paired with a clear-all — anyone wanting a blank
 * board can add one, and that is already a single tap.
 */
export const PaperClearMineIntentSchema = z.object({
  type: z.literal("paper.clearMine"),
  payload: z.object({ paperId: z.string() }),
});

/** Author-only; enforced in `Room.handleIntent`, never in the schema. */
export const BlockEditIntentSchema = z.object({
  type: z.literal("block.edit"),
  payload: z.object({ blockId: z.string(), text: BlockTextSchema }),
});

/** Author-only. */
export const BlockDeleteIntentSchema = z.object({
  type: z.literal("block.delete"),
  payload: z.object({ blockId: z.string() }),
});

export const ClientIntentSchema = z.discriminatedUnion("type", [
  RoomCreateIntentSchema,
  RoomJoinIntentSchema,
  SessionResumeIntentSchema,
  RoomDeleteIntentSchema,
  MemberRenameIntentSchema,
  PaperOpenIntentSchema,
  PaperRefreshIntentSchema,
  PaperCloseIntentSchema,
  PaperCreateIntentSchema,
  PaperRenameIntentSchema,
  PaperDeleteIntentSchema,
  PaperClearMineIntentSchema,
  BlockPostIntentSchema,
  BlockPostImageIntentSchema,
  BlockPostStrokeIntentSchema,
  BlockEditIntentSchema,
  BlockDeleteIntentSchema,
]);
export type ClientIntent = z.infer<typeof ClientIntentSchema>;
