export type Segment = { kind: "text"; value: string } | { kind: "link"; value: string; href: string };

/*
 * http(s) only, deliberately.
 *
 * Block text is untrusted — it is literally whatever anyone in the room typed —
 * so the set of schemes that can become a clickable `href` is the whole
 * security surface here. Matching only `http://` and `https://` means
 * `javascript:`, `data:` and friends can never reach an anchor, no sanitiser
 * required. Rendering still goes through Svelte's text interpolation, never
 * `{@html}`.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/**
 * Trailing punctuation almost always belongs to the sentence, not the URL:
 * `see https://bun.sh.` and `(https://bun.sh)` should not link the `.` or `)`.
 * Balanced brackets *inside* a URL are kept, because Wikipedia-style links
 * genuinely contain them.
 */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (".,;:!?".includes(ch)) {
      end--;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const open = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      const slice = url.slice(0, end);
      const opens = slice.split(open).length - 1;
      const closes = slice.split(ch).length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/** Splits text into plain runs and link runs, preserving every character. */
export function linkify(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;

  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m !== null; m = URL_RE.exec(text)) {
    const raw = m[0];
    const trimmed = trimTrailing(raw);
    if (trimmed.length === 0) continue;

    const start = m.index;
    if (start > last) segments.push({ kind: "text", value: text.slice(last, start) });

    let href = trimmed;
    try {
      // Normalise, and reject anything that somehow isn't a real URL.
      href = new URL(trimmed).toString();
      segments.push({ kind: "link", value: trimmed, href });
    } catch {
      segments.push({ kind: "text", value: trimmed });
    }
    last = start + trimmed.length;
    URL_RE.lastIndex = last;
  }

  if (last < text.length) segments.push({ kind: "text", value: text.slice(last) });
  return segments;
}

/** Unique hrefs in a block, in the order they appear — what the link strip lists. */
export function uniqueLinks(segments: Segment[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind !== "link" || seen.has(seg.href)) continue;
    seen.add(seg.href);
    out.push(seg.href);
  }
  return out;
}
