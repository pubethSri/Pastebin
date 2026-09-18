import { describe, expect, test } from "bun:test";
import { MAX_BLOCK_CHARS, MAX_FILENAME_CHARS } from "@pastebin/protocol";
import { decodeText, shortName, textFromBytes } from "../src/text";

const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("decodeText", () => {
  test("plain UTF-8", () => {
    expect(decodeText(utf8("héllo"))).toBe("héllo");
  });

  test("a UTF-8 BOM is stripped", () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69))).toBe("hi");
  });

  test("UTF-16 with a BOM decodes, which is what a Notepad Unicode save is", () => {
    expect(decodeText(bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00))).toBe("hi");
    expect(decodeText(bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69))).toBe("hi");
  });

  test("a NUL byte or invalid UTF-8 means binary", () => {
    expect(decodeText(bytes(0x68, 0x00, 0x69))).toBeNull();
    expect(decodeText(bytes(0xc3, 0x28))).toBeNull();
    expect(decodeText(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
  });
});

describe("textFromBytes", () => {
  test("normalises CRLF and lone CR to LF", () => {
    expect(textFromBytes(utf8("a\r\nb\rc\n"), "x")).toBe("a\nb\nc\n");
  });

  test("names the input in every refusal", () => {
    expect(() => textFromBytes(bytes(), "stdin")).toThrow("stdin is empty");
    expect(() => textFromBytes(utf8("  \n"), "notes.txt")).toThrow("notes.txt has nothing in it");
    expect(() => textFromBytes(bytes(0, 1, 2), "a.zip")).toThrow("a.zip isn't a text file");
  });

  test("over the cap is refused with the real count", () => {
    expect(() => textFromBytes(utf8("x".repeat(MAX_BLOCK_CHARS + 1)), "big.js")).toThrow(
      "big.js is 100,001 characters -- the cap is 100,000",
    );
    expect(textFromBytes(utf8("x".repeat(MAX_BLOCK_CHARS)), "ok.js").length).toBe(MAX_BLOCK_CHARS);
  });

  test("something that could not possibly fit is refused on size alone", () => {
    expect(() => textFromBytes(new Uint8Array(MAX_BLOCK_CHARS * 4 + 1), "huge")).toThrow("huge is too big");
  });
});

describe("shortName", () => {
  test("keeps a label inside the wire limit", () => {
    const long = "a".repeat(MAX_FILENAME_CHARS + 50);
    expect(shortName(long).length).toBe(MAX_FILENAME_CHARS);
    expect(shortName("main.ts")).toBe("main.ts");
  });
});
