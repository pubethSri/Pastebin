import { Room } from "./Room";
import type { Store } from "./Store";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DEFAULT_PAPER_TITLE = "Paper 1";

/**
 * A cache of live `Room` objects over the database, not an owner of rooms.
 *
 * The difference from YAWBG matters: there, `onEmpty` deletes the room outright
 * when the last player leaves, because a game with nobody in it is over. Here
 * the last person leaving is the *normal* case — you paste something and close
 * the tab — so an empty room is only evicted from memory. Its rows live until
 * the TTL sweeper takes them, and `get()` rebuilds the object on the next visit.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();

  constructor(private store: Store) {}

  create(): Room {
    const code = this.generateCode();
    const row = this.store.createRoom(code);
    // Every room is born with exactly one paper, so nobody ever meets a picker
    // they didn't ask for.
    this.store.createPaper(row.id, DEFAULT_PAPER_TITLE);
    const room = new Room(row, this.store, { onDestroyed: () => this.rooms.delete(code) });
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    const cached = this.rooms.get(code);
    if (cached) return cached;
    const row = this.store.roomByCode(code);
    if (!row) return undefined;
    const room = new Room(row, this.store, { onDestroyed: () => this.rooms.delete(code) });
    this.rooms.set(code, room);
    return room;
  }

  /** Frees the socket registry only. Deletes nothing. */
  evictIfEmpty(code: string): void {
    const room = this.rooms.get(code);
    if (room && room.isEmpty) this.rooms.delete(code);
  }

  /** Drops a cached room whose rows the sweeper has already removed. */
  forget(code: string): void {
    this.rooms.delete(code);
  }

  private generateCode(): string {
    let code: string;
    do {
      code = Array.from(
        { length: 4 },
        () => LETTERS[Math.floor(Math.random() * LETTERS.length)],
      ).join("");
      // Checked against the database, not the cache: a code is taken for as long
      // as its row exists, whether or not anyone is currently connected to it.
    } while (this.store.codeExists(code));
    return code;
  }
}
