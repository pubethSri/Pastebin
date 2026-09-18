import { MAX_BLOCK_CHARS, MAX_FILENAME_CHARS } from "@pastebin/protocol";
import { CliError } from "./errors";

/** Most bytes that can still fit under a character cap: UTF-8 spends at most four per code unit. */
export const MAX_TEXT_BYTES = MAX_BLOCK_CHARS * 4;

export const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * The same decoding policy as the browser's dropped-file path in
 * `apps/client/src/lib/textFile.ts`, kept in step by hand: a BOM picks UTF-8 or
 * UTF-16 (a Notepad "Unicode" save is half NUL bytes, so this has to run before
 * the binary check), and otherwise the bytes must be valid UTF-8 with no NUL in
 * them. A `.zip` or a `.pdf` fails here instead of becoming a block of mojibake.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return tryDecode(bytes.subarray(2), "utf-16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return tryDecode(bytes.subarray(2), "utf-16be");
  if (bytes.includes(0)) return null;
  return tryDecode(bytes, "utf-8");
}

function tryDecode(bytes: Uint8Array, encoding: "utf-8" | "utf-16le" | "utf-16be"): string | null {
  try {
    // bun-types narrows the label to a union without the UTF-16 variants; the
    // runtime accepts them (text.test.ts checks both), so the assertion is
    // about the type, not the code.
    return new TextDecoder(encoding as "utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Bytes to a block's text, refusing exactly what the browser refuses and naming
 * `label` in every refusal so the message says which input was the problem.
 * CRLF is normalised to LF on the way in, as the browser does: a stray CR is
 * invisible in the feed and then rides along into everyone's clipboard.
 */
export function textFromBytes(bytes: Uint8Array, label: string): string {
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new CliError(`${label} is too big -- a paste is capped at ${fmt(MAX_BLOCK_CHARS)} characters`);
  }
  if (bytes.length === 0) throw new CliError(`${label} is empty`);
  const decoded = decodeText(bytes);
  if (decoded === null) throw new CliError(`${label} isn't a text file`);
  const text = decoded.replace(/\r\n?/g, "\n");
  if (text.trim().length === 0) throw new CliError(`${label} has nothing in it`);
  if (text.length > MAX_BLOCK_CHARS) {
    throw new CliError(`${label} is ${fmt(text.length)} characters -- the cap is ${fmt(MAX_BLOCK_CHARS)}`);
  }
  return text;
}

/** Keeps a pathological name inside the wire limit for a label. */
export const shortName = (name: string): string =>
  name.length > MAX_FILENAME_CHARS ? `${name.slice(0, MAX_FILENAME_CHARS - 1)}~` : name;

export async function readFileText(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new CliError(`${path}: no such file`);
  // Refused on size before the read, so a huge file costs nothing.
  if (file.size > MAX_TEXT_BYTES) {
    throw new CliError(`${path} is too big -- a paste is capped at ${fmt(MAX_BLOCK_CHARS)} characters`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new CliError(`${path} could not be read -- is it a folder?`);
  }
  return textFromBytes(bytes, path);
}
