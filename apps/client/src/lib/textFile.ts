import { MAX_BLOCK_CHARS, MAX_FILENAME_CHARS } from "@pastebin/protocol";

/**
 * Reading a dropped file as a text block.
 *
 * The whole accept-or-refuse policy lives here so the drop zone and the file
 * picker cannot drift apart, and so every refusal comes back as a sentence
 * naming the file rather than as silence — which is what dropping a `.ts` used
 * to get you.
 *
 * There is no extension allowlist on purpose. The browser reports no `type` at
 * all for `.ts`, `.rs`, `.toml` or a bare `Dockerfile`, so a type check would
 * reject exactly the files this feature exists for. Whether the bytes decode as
 * text is the only question that actually matters, so it is the only one asked.
 */

/** `name` is null when the browser handed over a file without one — rare, but
 *  a block labelled "that file" would be worse than one labelled nothing. */
export type TextFileResult = { ok: true; text: string; name: string | null } | { ok: false; reason: string };

/**
 * The most bytes a file can occupy and still fit under a *character* cap: UTF-8
 * spends at most four bytes per code unit. Anything larger cannot possibly fit,
 * so it is refused on `size` alone and the bytes are never read — which is also
 * what stops someone dropping a 2 GB file from parking it in memory.
 */
export const MAX_TEXT_FILE_BYTES = MAX_BLOCK_CHARS * 4;

const fail = (reason: string): TextFileResult => ({ ok: false, reason });

/** Keeps a pathological name from crowding out the rest of the message. */
const shortName = (name: string): string =>
  name.length > MAX_FILENAME_CHARS ? `${name.slice(0, MAX_FILENAME_CHARS - 1)}…` : name;

/**
 * Decodes by BOM when there is one, and this order matters: a UTF-16 file is
 * half NUL bytes, so the binary check below would reject a perfectly good
 * Notepad "Unicode" save if it ran first.
 *
 * Without a BOM the bytes must be valid UTF-8 — `fatal: true` throws otherwise,
 * and that throw is the binary rejection. A `.zip` or a `.pdf` fails here
 * instead of becoming a block of mojibake nobody can use.
 */
function decode(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return tryDecode(bytes.subarray(2), "utf-16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return tryDecode(bytes.subarray(2), "utf-16be");
  }
  // A NUL byte in something claiming to be UTF-8 means it isn't text. This also
  // catches UTF-16 saved without a BOM, which would otherwise decode into
  // alternating nulls rather than failing outright.
  if (bytes.includes(0)) return null;
  return tryDecode(bytes, "utf-8");
}

function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function readTextFile(file: File): Promise<TextFileResult> {
  const given = (file.name ?? "").trim();
  const name = given ? shortName(given) : null;
  // What the refusals call it. Only the label falls back — `name` stays null so
  // nothing ever posts a block labelled "that file".
  const label = name ?? "that file";

  // Checked before the read, so the refusal costs nothing.
  if (file.size > MAX_TEXT_FILE_BYTES) {
    return fail(`${label} is too big — a paste is capped at ${MAX_BLOCK_CHARS.toLocaleString()} characters`);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    // A dragged directory arrives looking like a File and fails right here.
    return fail(`${label} could not be read — folders can't be dropped, only files`);
  }

  if (bytes.length === 0) return fail(`${label} is empty`);

  const decoded = decode(bytes);
  if (decoded === null) return fail(`${label} isn't a text file`);

  // A stray CR inside a <pre> is invisible on screen and then rides along into
  // everyone's clipboard. Normalising on the way in is the only edit made to
  // the file's contents, and it is one nobody has ever wanted undone.
  const text = decoded.replace(/\r\n?/g, "\n");

  // Whitespace-only matches what the composer's own Post button refuses, and an
  // empty string would come back from the server as BAD_MESSAGE anyway.
  if (text.trim().length === 0) return fail(`${label} has nothing in it`);

  // Last, and on the decoded string, so the number quoted is the real one.
  if (text.length > MAX_BLOCK_CHARS) {
    return fail(
      `${label} is ${text.length.toLocaleString()} characters — the cap is ${MAX_BLOCK_CHARS.toLocaleString()}`,
    );
  }

  return { ok: true, text, name };
}
