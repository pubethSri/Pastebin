import type { Env } from "./config";

/**
 * Terminal colour, for one job only: showing a member in the same colour the
 * browser gives them.
 *
 * The palette lives on the server (`identity.ts`) and rides on every block as
 * `authorColor`, so the CLI never chooses a colour — it renders the one it was
 * handed. That is the whole point: the person who is teal in the browser chip
 * is teal in the terminal, and nothing can make the two disagree.
 *
 * 24-bit escapes rather than the 16-colour palette, because the server sends a
 * hex value and the nearest of sixteen colours would put two palette entries on
 * the same ANSI colour — which defeats telling people apart, the only reason
 * the colour exists.
 */

const ESC = "";

/**
 * Whether to emit escapes at all.
 *
 * Off unless the stream is a terminal, so a redirect or a pipe never collects
 * escape codes — `pastebin tail > log` has to stay readable. `NO_COLOR` (any
 * non-empty value, per no-color.org) and `TERM=dumb` turn it off anyway;
 * `FORCE_COLOR` turns it on for a pipe that can render them, and `FORCE_COLOR=0`
 * is an explicit no. When both `NO_COLOR` and `FORCE_COLOR` are set, off wins:
 * the request not to be shown colour is the one worth honouring by mistake.
 */
export function shouldColor(env: Env, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (env.TERM === "dumb") return false;
  return isTTY;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` only, which is the one form the server sends. Anything else is null, and the caller prints plain. */
export function parseHex(hex: string | null | undefined): Rgb | null {
  if (!hex) return null;
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * What a command prints with. Made once per run from the stream it writes to,
 * so the decision is taken in one place and every call site is unconditional.
 */
export interface Style {
  readonly enabled: boolean;
  /** A member's name in their own colour. Falls back to the bare name. */
  name(text: string, hex: string | null | undefined): string;
  /** `text` as a clickable link to `url`, for terminals that support OSC 8. */
  link(text: string, url: string): string;
  /** Dim, for a detail line that should not compete with the content. */
  dim(text: string): string;
}

const plain: Style = {
  enabled: false,
  name: (text) => text,
  link: (text) => text,
  dim: (text) => text,
};

const styled: Style = {
  enabled: true,
  name(text, hex) {
    const rgb = parseHex(hex);
    // 39 restores the default foreground rather than resetting everything, so
    // this can never clobber an attribute the surrounding line set.
    return rgb ? `${ESC}[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}${ESC}[39m` : text;
  },
  /*
   * OSC 8. Windows Terminal, iTerm2, GNOME Terminal, WezTerm and kitty all
   * honour it; anywhere else the escape is swallowed and the text still reads
   * normally, which is why this is safe to emit without probing for support.
   * The URL is printed as its own text so a terminal that hides it entirely
   * still leaves something to copy by hand.
   */
  link: (text, url) => `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`,
  dim: (text) => `${ESC}[2m${text}${ESC}[22m`,
};

export const styleFor = (env: Env, isTTY: boolean): Style => (shouldColor(env, isTTY) ? styled : plain);
