import { describe, expect, test } from "bun:test";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  ClientIntentSchema,
  MAX_FILENAME_CHARS,
  MAX_STROKE_POINTS,
  PROTOCOL_VERSION,
  RoomCodeSchema,
  ServerMessageSchema,
  StrokeSchema,
} from "../src";

describe("protocol", () => {
  // A literal on purpose: bumping the version should fail here and send you to
  // look at the client before you ship a wire change.
  test("PROTOCOL_VERSION is 6", () => {
    expect(PROTOCOL_VERSION).toBe(6);
  });

  test("room codes normalise to four uppercase letters", () => {
    expect(RoomCodeSchema.parse(" abcd ")).toBe("ABCD");
    expect(RoomCodeSchema.safeParse("AB1D").success).toBe(false);
    expect(RoomCodeSchema.safeParse("ABCDE").success).toBe(false);
  });

  test("an unknown intent type is rejected", () => {
    expect(ClientIntentSchema.safeParse({ type: "block.nuke", payload: {} }).success).toBe(false);
  });

  test("block.post round-trips", () => {
    const parsed = ClientIntentSchema.safeParse({
      type: "block.post",
      payload: { paperId: "p1", text: "bun install" },
    });
    expect(parsed.success).toBe(true);
  });

  test("block.post carries an optional filename", () => {
    // Absent, explicitly null and present all have to parse: a typed paste
    // sends nothing, a dropped file sends a name, and the client sends null.
    for (const payload of [
      { paperId: "p1", text: "bun install" },
      { paperId: "p1", text: "bun install", filename: null },
      { paperId: "p1", text: "bun install", filename: "install.sh" },
    ]) {
      expect(ClientIntentSchema.safeParse({ type: "block.post", payload }).success).toBe(true);
    }
  });

  test("an over-long filename is a malformed frame, not a truncation", () => {
    const parsed = ClientIntentSchema.safeParse({
      type: "block.post",
      payload: { paperId: "p1", text: "x", filename: "a".repeat(MAX_FILENAME_CHARS + 1) },
    });
    expect(parsed.success).toBe(false);
  });

  test("an empty paste is not a paste", () => {
    const parsed = ClientIntentSchema.safeParse({
      type: "block.post",
      payload: { paperId: "p1", text: "" },
    });
    expect(parsed.success).toBe(false);
  });

  test("a stroke's geometry is validated, not trusted", () => {
    const ok = { w: 3, e: 0, p: [0, 0, 100, 100] };
    expect(StrokeSchema.safeParse(ok).success).toBe(true);
    // A single point is a tap, and a legitimate stroke.
    expect(StrokeSchema.safeParse({ w: 3, e: 1, p: [10, 10] }).success).toBe(true);

    const rejected = [
      { ...ok, p: [0, 0, 100] }, // odd length — not x,y pairs
      { ...ok, p: [] }, // no points at all
      { ...ok, p: [0, 0, BOARD_WIDTH + 1, 0] }, // x past the right edge
      { ...ok, p: [0, 0, 0, BOARD_HEIGHT + 1] }, // y past the bottom
      { ...ok, p: [0, -1] }, // negative
      { ...ok, p: [0.5, 0.5] }, // not integers
      { ...ok, w: 0 }, // zero width
      { ...ok, e: 2 }, // the flag is 0 or 1
      { ...ok, p: Array.from({ length: MAX_STROKE_POINTS * 2 + 2 }, () => 1) },
    ];
    for (const bad of rejected) expect(StrokeSchema.safeParse(bad).success).toBe(false);
  });

  test("x and y are bounded separately, not by the larger of the two", () => {
    // The board isn't square, so a y of 1500 is off it even though an x of 1500
    // is fine. A single shared bound would have let this through.
    expect(StrokeSchema.safeParse({ w: 3, e: 0, p: [1500, 100] }).success).toBe(true);
    expect(StrokeSchema.safeParse({ w: 3, e: 0, p: [100, 1500] }).success).toBe(false);
  });

  test("paper.create defaults to a text paper when no kind is given", () => {
    const parsed = ClientIntentSchema.safeParse({ type: "paper.create", payload: { title: "Notes" } });
    expect(parsed.success).toBe(true);
    expect(ClientIntentSchema.safeParse({ type: "paper.create", payload: { title: "B", kind: "draw" } }).success).toBe(
      true,
    );
    expect(ClientIntentSchema.safeParse({ type: "paper.create", payload: { title: "B", kind: "wat" } }).success).toBe(
      false,
    );
  });

  test("server messages are a closed union", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "error",
        payload: { code: "NOT_AUTHOR", message: "not yours" },
      }).success,
    ).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "surprise", payload: {} }).success).toBe(false);
  });
});
