import { MAX_NAME_CHARS } from "@pastebin/protocol";

/**
 * The same "<adjective> <name>" suggestion the landing page makes, from the
 * same `/api/names` pool, so a student who never passes `--name` shows up in
 * the room looking like everyone else rather than as "cli-user". The fallback
 * matches the server's built-in list for when the pool can't be fetched.
 */
const FALLBACK = {
  adjectives: ["Swift", "Lazy", "Glorious", "Clumsy", "Nimble", "Keen", "Stunned", "Vibing"],
  names: ["Ishtar", "Gilgamesh", "Altria", "Morgan", "Merlin", "Enkidu", "Oberon", "Okita"],
};

interface Pool {
  adjectives: string[];
  names: string[];
}

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

function compose(pool: Pool): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${pick(pool.adjectives)} ${pick(pool.names)}`;
    if (candidate.length <= MAX_NAME_CHARS) return candidate;
  }
  return `${pick(pool.adjectives)} ${pick(pool.names)}`.slice(0, MAX_NAME_CHARS).trimEnd();
}

export async function suggestName(server: string): Promise<string> {
  try {
    const res = await fetch(`${server}/api/names`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return compose(FALLBACK);
    const pool = (await res.json()) as Partial<Pool>;
    if (!pool.adjectives?.length || !pool.names?.length) return compose(FALLBACK);
    return compose({ adjectives: pool.adjectives, names: pool.names });
  } catch {
    return compose(FALLBACK);
  }
}
