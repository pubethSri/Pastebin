import type { PaperSummary } from "@pastebin/protocol";

export type PaperResolution = { ok: true; paper: PaperSummary } | { ok: false; message: string };

const fail = (lead: string, papers: readonly PaperSummary[]): PaperResolution => ({
  ok: false,
  message: `${lead}\n${formatPapers(papers, null)}`,
});

/**
 * Which paper a command means.
 *
 * With `wanted`: an exact id, else an exact title, else a unique title prefix,
 * all case-insensitive on the title because ids are uuids nobody will type.
 * Without it: the room's only text paper if there is exactly one, else the
 * remembered default if it still exists, else a refusal that lists the papers
 * so the next attempt can name one. Whiteboards are never chosen and never
 * accepted — the server would answer WRONG_PAPER_KIND, and saying so here
 * saves the round trip and names the paper.
 */
export function resolvePaper(
  papers: readonly PaperSummary[],
  preferredId: string | null,
  wanted: string | undefined,
): PaperResolution {
  if (wanted !== undefined) {
    const query = wanted.trim();
    const lower = query.toLowerCase();
    const byId = papers.find((p) => p.id === query);
    const exact = papers.filter((p) => p.title.toLowerCase() === lower);
    const prefix = papers.filter((p) => p.title.toLowerCase().startsWith(lower));
    const found = byId ?? (exact.length === 1 ? exact[0] : prefix.length === 1 ? prefix[0] : undefined);
    if (!found) {
      const ambiguous = (exact.length > 1 ? exact : prefix).length > 1;
      return fail(
        ambiguous ? `"${query}" matches more than one paper -- use the full title:` : `no paper called "${query}" here:`,
        papers,
      );
    }
    if (found.kind !== "text") {
      return { ok: false, message: `"${found.title}" is a whiteboard -- the command line can only use text papers` };
    }
    return { ok: true, paper: found };
  }

  const texts = papers.filter((p) => p.kind === "text");
  if (texts.length === 1) return { ok: true, paper: texts[0]! };
  if (texts.length === 0) return { ok: false, message: "this room has no text paper -- add one in the browser" };
  const preferred = preferredId ? texts.find((p) => p.id === preferredId) : undefined;
  if (preferred) return { ok: true, paper: preferred };
  return fail(
    `which paper? this room has ${texts.length} text papers -- pass --paper <title>, or choose one for good with: pastebin use <title>`,
    papers,
  );
}

/** One line per paper; `*` marks the one `post`, `get` and `tail` would use. */
export function formatPapers(papers: readonly PaperSummary[], defaultId: string | null): string {
  const width = papers.reduce((w, p) => Math.max(w, p.title.length), 0);
  return papers
    .map((p) => {
      const mark = p.id === defaultId ? "*" : " ";
      const kind = p.kind === "draw" ? "whiteboard" : "text";
      const unit = p.kind === "draw" ? "stroke" : "block";
      const count = `${p.blockCount} ${unit}${p.blockCount === 1 ? "" : "s"}`;
      return `${mark} ${p.title.padEnd(width)}  ${kind.padEnd(10)}  ${count}`;
    })
    .join("\n");
}
