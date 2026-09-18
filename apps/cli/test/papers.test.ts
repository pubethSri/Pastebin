import { describe, expect, test } from "bun:test";
import type { PaperSummary } from "@pastebin/protocol";
import { formatPapers, resolvePaper } from "../src/papers";

const paper = (id: string, title: string, kind: "text" | "draw" = "text", blockCount = 0): PaperSummary => ({
  id,
  title,
  kind,
  blockCount,
  lastActivity: 0,
  preview: "",
});

const p1 = paper("p1", "Paper 1", "text", 3);
const notes = paper("p2", "Notes");
const sketch = paper("p3", "Sketch", "draw", 12);
const nodes = paper("p4", "Nodes");

describe("without --paper", () => {
  test("the only text paper is chosen, and a whiteboard does not count", () => {
    expect(resolvePaper([p1], null, undefined)).toEqual({ ok: true, paper: p1 });
    expect(resolvePaper([sketch, p1], null, undefined)).toEqual({ ok: true, paper: p1 });
  });

  test("two text papers and no default is a refusal that lists them", () => {
    const r = resolvePaper([p1, notes], null, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("which paper?");
      expect(r.message).toContain("Paper 1");
      expect(r.message).toContain("Notes");
      expect(r.message).toContain("pastebin use");
    }
  });

  test("the remembered default wins while it exists, and is ignored once it is gone", () => {
    expect(resolvePaper([p1, notes], "p2", undefined)).toEqual({ ok: true, paper: notes });
    expect(resolvePaper([p1, notes], "deleted", undefined).ok).toBe(false);
    // A remembered whiteboard is never a default either.
    expect(resolvePaper([p1, notes, sketch], "p3", undefined).ok).toBe(false);
  });

  test("a room with only whiteboards has nowhere to post", () => {
    const r = resolvePaper([sketch], null, undefined);
    expect(r).toEqual({ ok: false, message: "this room has no text paper -- add one in the browser" });
  });
});

describe("with --paper", () => {
  test("an exact title, case-insensitively, beats everything", () => {
    expect(resolvePaper([p1, notes, nodes], null, "notes")).toEqual({ ok: true, paper: notes });
    expect(resolvePaper([p1, notes, nodes], null, "  PAPER 1 ")).toEqual({ ok: true, paper: p1 });
  });

  test("a unique prefix is enough; an ambiguous one is refused", () => {
    expect(resolvePaper([p1, notes, nodes], null, "pap")).toEqual({ ok: true, paper: p1 });
    const r = resolvePaper([p1, notes, nodes], null, "no");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("matches more than one paper");
  });

  test("an id works too, since the browser's URL shows one", () => {
    expect(resolvePaper([p1, notes], null, "p2")).toEqual({ ok: true, paper: notes });
  });

  test("a name nobody has lists what there is", () => {
    const r = resolvePaper([p1, notes], null, "Homework");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('no paper called "Homework"');
      expect(r.message).toContain("Notes");
    }
  });

  test("naming a whiteboard is refused by name", () => {
    const r = resolvePaper([p1, sketch], null, "sketch");
    expect(r).toEqual({ ok: false, message: '"Sketch" is a whiteboard -- the command line can only use text papers' });
  });
});

describe("formatPapers", () => {
  test("aligns titles, marks the default and pluralises", () => {
    expect(formatPapers([p1, notes, sketch], "p2")).toBe(
      ["  Paper 1  text        3 blocks", "* Notes    text        0 blocks", "  Sketch   whiteboard  12 strokes"].join("\n"),
    );
    expect(formatPapers([paper("x", "One", "text", 1)], null)).toBe("  One  text        1 block");
  });
});
