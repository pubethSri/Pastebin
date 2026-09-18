import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RoomSession {
  server: string;
  memberId: string;
  token: string;
  /** The paper `post`, `get` and `tail` use when the room has more than one text paper. */
  paperId: string | null;
}

export interface SessionsFile {
  /** The room commands act on when `--room` isn't given: the last one joined. */
  current: string | null;
  /** Default for the next first-time `join`, so a class needs `--server` typed once. */
  lastServer: string | null;
  rooms: Record<string, RoomSession>;
}

export type Env = Record<string, string | undefined>;

/**
 * Where identities live. This is the CLI's `localStorage`: the browser keeps
 * the same three fields under `pastebin_sessions`, keyed by room code, for the
 * same reason — the member id and token are what still make a paste yours
 * tomorrow. `PASTEBIN_CONFIG_DIR` overrides everything (tests use it); otherwise
 * the platform's usual place for per-user config.
 */
export function configDir(env: Env = process.env, platform: string = process.platform): string {
  if (env.PASTEBIN_CONFIG_DIR) return env.PASTEBIN_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "pastebin");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pastebin");
}

export const sessionsPath = (env?: Env, platform?: string): string => join(configDir(env, platform), "sessions.json");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * A hand-edited or half-written file must not break every command, so anything
 * malformed is dropped rather than fatal. Losing a cached identity costs a
 * rejoin; a CLI that can't start costs the whole tool.
 */
function sanitize(raw: unknown): SessionsFile {
  const file: SessionsFile = { current: null, lastServer: null, rooms: {} };
  if (!isRecord(raw)) return file;
  if (isRecord(raw.rooms)) {
    for (const [code, value] of Object.entries(raw.rooms)) {
      if (!isRecord(value)) continue;
      const server = str(value.server);
      const memberId = str(value.memberId);
      const token = str(value.token);
      if (!server || !memberId || !token) continue;
      file.rooms[code] = { server, memberId, token, paperId: str(value.paperId) };
    }
  }
  const current = str(raw.current);
  file.current = current && file.rooms[current] ? current : null;
  file.lastServer = str(raw.lastServer);
  return file;
}

export class Sessions {
  private constructor(
    readonly file: string,
    private readonly platform: string,
    private data: SessionsFile,
  ) {}

  static async load(env: Env = process.env, platform: string = process.platform): Promise<Sessions> {
    const file = sessionsPath(env, platform);
    let data: SessionsFile = { current: null, lastServer: null, rooms: {} };
    try {
      data = sanitize(JSON.parse(await readFile(file, "utf8")));
    } catch {
      /* no file yet, or unreadable: start empty. It is a cache of identities, not the source of truth. */
    }
    return new Sessions(file, platform, data);
  }

  get current(): string | null {
    return this.data.current;
  }

  get lastServer(): string | null {
    return this.data.lastServer;
  }

  codes(): string[] {
    return Object.keys(this.data.rooms).sort();
  }

  room(code: string): RoomSession | null {
    return this.data.rooms[code] ?? null;
  }

  /** A new identity in `code`. It becomes the current room, and its server the default for the next join. */
  set(code: string, session: RoomSession): void {
    this.data.rooms[code] = session;
    this.data.current = code;
    this.data.lastServer = session.server;
  }

  update(code: string, patch: Partial<RoomSession>): void {
    const existing = this.data.rooms[code];
    if (existing) this.data.rooms[code] = { ...existing, ...patch };
  }

  setCurrent(code: string): void {
    const session = this.data.rooms[code];
    if (!session) return;
    this.data.current = code;
    this.data.lastServer = session.server;
  }

  /** Forgets an identity. If it was the current room, another saved one takes over so commands keep working. */
  drop(code: string): void {
    delete this.data.rooms[code];
    if (this.data.current === code) this.data.current = this.codes()[0] ?? null;
  }

  /**
   * Written whole, to a sibling file first and renamed over it, so a crash
   * mid-write leaves the old file rather than half of the new one. 0600 because
   * the file holds tokens; the mode is a no-op on Windows, where the profile
   * directory is already the user's own.
   */
  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    if (this.platform !== "win32") await chmod(this.file, 0o600);
  }

  snapshot(): SessionsFile {
    return structuredClone(this.data);
  }
}
