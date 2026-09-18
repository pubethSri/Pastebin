import { describe, expect, test } from "bun:test";
import { MAX_BLOCK_CHARS } from "@pastebin/protocol";
import { MAX_TEXT_FILE_BYTES, readTextFile } from "../src/lib/textFile";

const fileOf = (data: BlobPart, name = "notes.txt") => new File([data], name);
const bytes = (...values: number[]) => new Uint8Array(values);

/** The refusal reason, or a loud failure if it unexpectedly succeeded. */
async function refusal(file: File): Promise<string> {
  const result = await readTextFile(file);
  if (result.ok) throw new Error(`expected ${file.name} to be refused, got ${result.text.length} chars`);
  return result.reason;
}

async function accepted(file: File): Promise<string> {
  const result = await readTextFile(file);
  if (!result.ok) throw new Error(`expected ${file.name} to be accepted: ${result.reason}`);
  return result.text;
}

describe("readTextFile", () => {
  test("a plain UTF-8 source file comes through unchanged", async () => {
    const source = 'const greet = (who: string) => `hi ${who}`;\nexport { greet };\n';
    expect(await accepted(fileOf(source, "greet.ts"))).toBe(source);
  });

  test("the filename rides along, since the block is going to be labelled with it", async () => {
    const result = await readTextFile(fileOf("x", "tsconfig.json"));
    expect(result).toMatchObject({ ok: true, name: "tsconfig.json" });
  });

  test("a nameless file is accepted but stays unlabelled", async () => {
    // Better an unlabelled block than one labelled with a placeholder that
    // looks like it was the actual filename.
    const result = await readTextFile(new File(["x"], ""));
    expect(result).toMatchObject({ ok: true, name: null });
  });

  /* ------------------------------- encodings ------------------------------- */

  test("a UTF-8 BOM is stripped rather than posted as an invisible first character", async () => {
    expect(await accepted(fileOf(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69)))).toBe("hi");
  });

  test("UTF-16 from Notepad's \"Unicode\" save is readable, not mojibake", async () => {
    // The half of the file that is NUL bytes is why the BOM is checked first.
    const le = bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00);
    expect(await accepted(fileOf(le, "notepad-le.txt"))).toBe("hi");

    const be = bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69);
    expect(await accepted(fileOf(be, "notepad-be.txt"))).toBe("hi");
  });

  test("CRLF is normalised, so no stray carriage return reaches a clipboard", async () => {
    expect(await accepted(fileOf("one\r\ntwo\r\n", "windows.txt"))).toBe("one\ntwo\n");
  });

  test("non-ASCII survives the round trip", async () => {
    const source = "const s = 'café · 日本語 · 🎉';\n";
    expect(await accepted(fileOf(source, "unicode.ts"))).toBe(source);
  });

  /* -------------------------------- refusals ------------------------------- */

  test("a binary file is refused rather than decoded into mojibake", async () => {
    // A PNG header: invalid UTF-8, and it contains NULs.
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
    expect(await refusal(fileOf(png, "logo.png"))).toContain("isn't a text file");
  });

  test("a lone NUL byte is enough to disqualify a file", async () => {
    expect(await refusal(fileOf(bytes(0x68, 0x00, 0x69), "sneaky.txt"))).toContain("isn't a text file");
  });

  test("UTF-16 saved without a BOM is caught by the NUL check", async () => {
    // Decoding this as UTF-8 would yield "h\0i" — text-shaped, and wrong.
    expect(await refusal(fileOf(bytes(0x68, 0x00, 0x69, 0x00), "nobom.txt"))).toContain("isn't a text file");
  });

  test("invalid UTF-8 with no NUL bytes is still refused", async () => {
    // 0xC3 starts a two-byte sequence that never arrives.
    expect(await refusal(fileOf(bytes(0x68, 0xc3, 0x28), "bad.txt"))).toContain("isn't a text file");
  });

  test("a file that cannot be read is blamed on folders, the reason it usually happens", async () => {
    // The drop zone screens directories out via `webkitGetAsEntry`, but that is
    // not everywhere; where it is missing, a dragged folder arrives looking like
    // an ordinary File and only fails on read. This is that backstop.
    const folder = new File([], "src");
    Object.defineProperty(folder, "size", { value: 4096 });
    Object.defineProperty(folder, "arrayBuffer", {
      value: () => Promise.reject(new DOMException("NotFoundError")),
    });

    const reason = await refusal(folder);
    expect(reason).toContain("src");
    expect(reason).toContain("folders can't be dropped");
  });

  test("an empty file is refused, because an empty block is a BAD_MESSAGE", async () => {
    expect(await refusal(fileOf("", "empty.txt"))).toContain("is empty");
  });

  test("a whitespace-only file is refused, matching what Post already refuses", async () => {
    expect(await refusal(fileOf("\n\n   \t\n", "blank.txt"))).toContain("nothing in it");
  });

  /* ---------------------------------- size --------------------------------- */

  test("a file too big to possibly fit is refused on size, before any read", async () => {
    // `arrayBuffer` throws if called, proving the gate ran on `size` alone —
    // this is what stops a dropped multi-gigabyte file reaching memory.
    const huge = new File(["x"], "bundle.min.js");
    Object.defineProperty(huge, "size", { value: MAX_TEXT_FILE_BYTES + 1 });
    Object.defineProperty(huge, "arrayBuffer", {
      value: () => Promise.reject(new Error("must not read an oversized file")),
    });

    const reason = await refusal(huge);
    expect(reason).toContain("bundle.min.js");
    expect(reason).toContain("too big");
  });

  test("a file that fits in bytes but not in characters is refused with the real count", async () => {
    const overBy = 500;
    const source = "a".repeat(MAX_BLOCK_CHARS + overBy);
    expect(source.length).toBeLessThanOrEqual(MAX_TEXT_FILE_BYTES); // ASCII: one byte each

    const reason = await refusal(fileOf(source, "package-lock.json"));
    expect(reason).toContain("package-lock.json");
    expect(reason).toContain((MAX_BLOCK_CHARS + overBy).toLocaleString());
    expect(reason).toContain(MAX_BLOCK_CHARS.toLocaleString());
  });

  test("a file exactly at the cap is accepted", async () => {
    const source = "a".repeat(MAX_BLOCK_CHARS);
    expect(await accepted(fileOf(source, "exactly.txt"))).toHaveLength(MAX_BLOCK_CHARS);
  });

  test("multi-byte characters are counted as characters, not bytes", async () => {
    // 40k four-byte emoji is 160 KB on disk but only 80k UTF-16 code units, so
    // it fits — a byte-based cap would have wrongly refused it.
    const source = "🎉".repeat(40_000);
    expect(source.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    expect(await accepted(fileOf(source, "party.txt"))).toBe(source);
  });
});
