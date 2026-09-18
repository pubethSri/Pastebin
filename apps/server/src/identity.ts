/**
 * Colours are assigned round-robin by join order, never hashed from the name.
 * A hash collides, and two people in the same small room drawing the same chip
 * colour defeats the only thing the chip is for. Twelve is more than a LAN room
 * needs; member 13 wraps and reuses, which is the honest failure mode.
 */
export const PALETTE = [
  { name: "Teal", hex: "#0f766e" },
  { name: "Amber", hex: "#b45309" },
  { name: "Violet", hex: "#6d28d9" },
  { name: "Rose", hex: "#be123c" },
  { name: "Sky", hex: "#0369a1" },
  { name: "Lime", hex: "#4d7c0f" },
  { name: "Orange", hex: "#c2410c" },
  { name: "Magenta", hex: "#a21caf" },
  { name: "Indigo", hex: "#4338ca" },
  { name: "Emerald", hex: "#047857" },
  { name: "Slate", hex: "#475569" },
  { name: "Gold", hex: "#a16207" },
] as const;

/**
 * Names are *not* generated here. The landing page has to show a filled-in name
 * before anyone has joined anything, so the suggestion lives on the client
 * (`lib/autoName.ts`) and arrives with the join intent like any typed name.
 */
export function colorForIndex(index: number): string {
  return PALETTE[index % PALETTE.length]!.hex;
}
