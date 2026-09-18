import { join } from "node:path";

export interface NamePool {
  adjectives: string[];
  names: string[];
}

/**
 * The floor. Kept in code, not in the file, so a typo in `data/names.json`
 * degrades to a working landing page instead of an empty name field — which
 * would block Create and Join, since both require a name.
 */
const BUILT_IN: NamePool = {
  adjectives: ["Swift", "Lazy", "Glorious", "Clumsy", "Nimble", "Keen", "Stunned", "Vibing"],
  names: ["Ishtar", "Gilgamesh", "Altria", "Morgan", "Merlin", "Enkidu", "Oberon", "Okita"],
};

const defaultPath = () => process.env.NAMES_PATH ?? join(import.meta.dir, "../../../data/names.json");

const cleanList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];

/**
 * Read fresh on every call rather than cached at boot.
 *
 * The point of moving these words out of the bundle was to make them editable,
 * and "edit the file, restart the server" is a worse loop than the one it
 * replaced. The file is a couple of hundred bytes and this is read once per
 * landing-page load, so re-reading costs nothing worth measuring.
 */
export async function loadNamePool(path = defaultPath()): Promise<NamePool> {
  try {
    const raw = await Bun.file(path).json();
    const adjectives = cleanList(raw?.adjectives);
    const names = cleanList(raw?.names);
    // Both lists have to be usable; one empty list would make every suggested
    // name identical, which reads as a bug rather than as a deliberate choice.
    if (adjectives.length === 0 || names.length === 0) return BUILT_IN;
    return { adjectives, names };
  } catch {
    return BUILT_IN;
  }
}
