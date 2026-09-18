import { z } from "zod";
import { BlockSchema, PaperStateSchema, PublicRoomStateSchema, RoomCodeSchema } from "./state";

export const ErrorCodeSchema = z.enum([
  "BAD_MESSAGE",
  "VERSION_MISMATCH",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "SESSION_INVALID",
  "PAPER_NOT_FOUND",
  "BLOCK_NOT_FOUND",
  "NOT_AUTHOR",
  "TOO_LARGE",
  "PAPER_FULL",
  "LAST_PAPER",
  "TOO_MANY_PAPERS",
  "MEDIA_NOT_FOUND",
  /** A paste aimed at a whiteboard, or a stroke aimed at a text paper. */
  "WRONG_PAPER_KIND",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const SessionCreatedMessageSchema = z.object({
  type: z.literal("session.created"),
  payload: z.object({
    code: RoomCodeSchema,
    memberId: z.string(),
    token: z.string(),
    name: z.string(),
    color: z.string(),
  }),
});
// No `defaultPaperId` here on purpose. Which paper you land on is a routing
// decision that needs the *whole* paper list — one paper goes straight through,
// several show the picker — and that list is already on `room.state`, which
// arrives in the same breath as this message.

export const RoomStateMessageSchema = z.object({
  type: z.literal("room.state"),
  payload: PublicRoomStateSchema,
});

export const PaperStateMessageSchema = z.object({
  type: z.literal("paper.state"),
  payload: PaperStateSchema,
});

/*
 * Deltas, not whole-paper frames.
 *
 * YAWBG rebroadcasts its entire room state on every change, which is fine when
 * a frame is a few hundred bytes. A paper here can hold a thousand blocks of up
 * to 100 KB each, and resending all of it because someone fixed a typo would be
 * unusable on a phone over Wi-Fi. So: one `paper.state` snapshot on open, then
 * deltas — each stamped with the paper's *new* `rev`.
 *
 * The client tracks the last rev it applied. A delta whose rev is not
 * `lastRev + 1` means it missed one (a dropped frame, a socket that reconnected
 * mid-edit), and it asks for a snapshot with `paper.refresh`. That one
 * comparison is the entire cost of not shipping the whole paper every time.
 */
export const BlockAddedMessageSchema = z.object({
  type: z.literal("block.added"),
  payload: z.object({ paperId: z.string(), rev: z.number().int(), block: BlockSchema }),
});

export const BlockUpdatedMessageSchema = z.object({
  type: z.literal("block.updated"),
  payload: z.object({ paperId: z.string(), rev: z.number().int(), block: BlockSchema }),
});

export const BlockRemovedMessageSchema = z.object({
  type: z.literal("block.removed"),
  payload: z.object({ paperId: z.string(), rev: z.number().int(), blockId: z.string() }),
});

/**
 * Everything one author drew on a paper is gone.
 *
 * Names the *author* rather than listing block ids, which keeps the frame at
 * about sixty bytes whether five strokes went or five hundred — every client
 * already holds the blocks and can drop that author's own. The `rev` still
 * moves exactly once, so gap detection is unaffected.
 */
export const BlocksClearedMessageSchema = z.object({
  type: z.literal("blocks.cleared"),
  payload: z.object({ paperId: z.string(), rev: z.number().int(), authorId: z.string() }),
});

/**
 * The room is gone. Sent to every socket in it just before the rows go, so the
 * UI can say what happened instead of leaving people staring at a dead room
 * until some later action fails with ROOM_NOT_FOUND.
 */
export const RoomClosedMessageSchema = z.object({
  type: z.literal("room.closed"),
  payload: z.object({ reason: z.enum(["deleted", "expired"]) }),
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  payload: z.object({ code: ErrorCodeSchema, message: z.string() }),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SessionCreatedMessageSchema,
  RoomStateMessageSchema,
  PaperStateMessageSchema,
  BlockAddedMessageSchema,
  BlockUpdatedMessageSchema,
  BlockRemovedMessageSchema,
  BlocksClearedMessageSchema,
  RoomClosedMessageSchema,
  ErrorMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
