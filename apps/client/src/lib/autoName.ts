import { MAX_NAME_CHARS } from "@pastebin/protocol";

/**
 * Fallback pool, used only if `/api/names` can't be reached.
 *
 * The real word lists live in `data/names.json`, which the server re-reads on
 * every request so you can edit them and just refresh. This copy exists so the
 * landing page always has *a* name to show — the field can't be empty, since
 * both Create and Join require one.
 */
const FALLBACK = {
  adjectives: ["Swift", "Lazy", "Glorious", "Clumsy", "Nimble", "Keen", "Stunned", "Vibing"],
  names: ["Ishtar", "Gilgamesh", "Altria", "Morgan", "Merlin", "Enkidu", "Oberon", "Okita"],
};

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

interface Pool {
  adjectives: string[];
  names: string[];
}

/**
 * Builds "<adjective> <name>", retrying if the pairing is too long for the
 * server's own name schema.
 *
 * The lists are user-editable, so an over-long pairing is a matter of when, not
 * if — and it would be rejected by the very schema that validates the join,
 * leaving the landing page unable to submit a name it filled in itself. Trying
 * a few combinations finds a short one when the pool has any; the final trim is
 * the guarantee.
 */
function compose(pool: Pool): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${pick(pool.adjectives)} ${pick(pool.names)}`;
    if (candidate.length <= MAX_NAME_CHARS) return candidate;
  }
  return `${pick(pool.adjectives)} ${pick(pool.names)}`.slice(0, MAX_NAME_CHARS).trimEnd();
}

/**
 * Synchronous suggestion from the fallback pool, for the very first paint —
 * the field is filled before the network answers, then upgraded by
 * `suggestNameAsync` once the server's pool arrives.
 *
 * Names are deliberately not tied to member colour. An earlier version had the
 * auto name carry its colour ("Teal Fox") so name and chip agreed, but colours
 * are assigned by join order and the client cannot know its index before it
 * joins. A name promising a colour it might not get is worse than one that
 * promises nothing.
 */
export const suggestName = (): string => compose(FALLBACK);

export async function suggestNameAsync(): Promise<string> {
  try {
    const res = await fetch("/api/names");
    if (!res.ok) return compose(FALLBACK);
    const pool = (await res.json()) as Partial<Pool>;
    if (!pool.adjectives?.length || !pool.names?.length) return compose(FALLBACK);
    return compose({ adjectives: pool.adjectives, names: pool.names });
  } catch {
    return compose(FALLBACK);
  }
}
