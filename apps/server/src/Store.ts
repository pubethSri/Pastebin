import type { Database } from "bun:sqlite";
import type { Block, PaperKind, PaperSummary } from "@pastebin/protocol";
import { colorForIndex } from "./identity";

export interface RoomRow {
  id: string;
  code: string;
  created_at: number;
  touched_at: number;
  /** When the last socket left; NULL while anyone is connected. */
  emptied_at: number | null;
}

export interface MemberRow {
  id: string;
  room_id: string;
  name: string;
  color: string;
  token: string;
  joined_at: number;
}

export interface PaperRow {
  id: string;
  room_id: string;
  title: string;
  kind: PaperKind;
  created_at: number;
  rev: number;
}

/** A block row joined to its media row, which is why the `m_` columns exist. */
interface BlockRow {
  id: string;
  paper_id: string;
  author_id: string;
  author_name: string;
  author_color: string;
  kind: string;
  text: string;
  filename: string | null;
  media_id: string | null;
  created_at: number;
  edited_at: number | null;
  m_mime?: string | null;
  m_bytes?: number | null;
  m_width?: number | null;
  m_height?: number | null;
  m_name?: string | null;
}

const toBlock = (r: BlockRow): Block => ({
  id: r.id,
  paperId: r.paper_id,
  authorId: r.author_id,
  authorName: r.author_name,
  authorColor: r.author_color,
  // Narrowed rather than cast: the column is free text as far as SQLite is
  // concerned, and a row with an unknown kind should read as a plain paste
  // rather than as a shape the client will try to parse as geometry.
  kind: r.kind === "image" ? "image" : r.kind === "stroke" ? "stroke" : "text",
  text: r.text,
  filename: r.filename ?? null,
  media:
    r.media_id && r.m_mime
      ? {
          id: r.media_id,
          mime: r.m_mime,
          width: r.m_width ?? null,
          height: r.m_height ?? null,
          byteSize: r.m_bytes ?? 0,
          name: r.m_name ?? null,
        }
      : null,
  createdAt: r.created_at,
  editedAt: r.edited_at,
});

/** Every block read goes through this, so `media` is never accidentally absent. */
const BLOCK_SELECT = `
  SELECT b.id, b.paper_id, b.author_id, b.author_name, b.author_color, b.kind, b.text,
         b.filename, b.media_id, b.created_at, b.edited_at,
         m.mime AS m_mime, m.byte_size AS m_bytes, m.width AS m_width,
         m.height AS m_height, m.name AS m_name
    FROM blocks b
    LEFT JOIN media m ON m.id = b.media_id`;

export interface NewMedia {
  mime: string;
  width: number | null;
  height: number | null;
  name: string | null;
  data: Uint8Array;
}

export interface MediaRow {
  id: string;
  room_id: string;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  name: string | null;
}

const PREVIEW_LINES = 2;
const PREVIEW_LINE_CHARS = 80;

function previewOf(text: string | null): string {
  if (!text) return "";
  return text
    .split("\n")
    .slice(0, PREVIEW_LINES)
    .map((line) => (line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…` : line))
    .join("\n");
}

const id = () => crypto.randomUUID();

/**
 * Every SQL statement in the app lives here. `Room` holds sockets and rules;
 * it never touches the database directly, so "what is persisted" is answerable
 * by reading one file.
 */
export class Store {
  constructor(private db: Database) {}

  /* --------------------------------- rooms -------------------------------- */

  createRoom(code: string): RoomRow {
    const now = Date.now();
    // Born empty: the creator's socket attaches a moment later and clears it.
    // If that never happens, the room expires on schedule rather than lingering.
    const row: RoomRow = { id: id(), code, created_at: now, touched_at: now, emptied_at: now };
    this.db
      .query("INSERT INTO rooms (id, code, created_at, touched_at, emptied_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.code, row.created_at, row.touched_at, row.emptied_at);
    return row;
  }

  deleteRoom(roomId: string): void {
    // Cascades to members, papers, blocks and media.
    this.db.query("DELETE FROM rooms WHERE id = ?").run(roomId);
  }

  roomByCode(code: string): RoomRow | null {
    return this.db.query<RoomRow, [string]>("SELECT * FROM rooms WHERE code = ?").get(code);
  }

  codeExists(code: string): boolean {
    return this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM rooms WHERE code = ?").get(code)!.n > 0;
  }

  /** Pushes the TTL out. Called on join and on every write. */
  touchRoom(roomId: string): void {
    this.db.query("UPDATE rooms SET touched_at = ? WHERE id = ?").run(Date.now(), roomId);
  }

  /** Someone is in the room — stops the expiry clock. */
  markRoomOccupied(roomId: string): void {
    this.db.query("UPDATE rooms SET emptied_at = NULL, touched_at = ? WHERE id = ?").run(Date.now(), roomId);
  }

  /** The last socket left — starts the expiry clock. */
  markRoomEmpty(roomId: string, at = Date.now()): void {
    this.db.query("UPDATE rooms SET emptied_at = ? WHERE id = ?").run(at, roomId);
  }

  /**
   * Called once at boot, because a process restart means there are no sockets
   * anywhere and every room is empty by definition.
   *
   * Stamping *now* rather than deleting immediately is the point: a restart
   * mid-session gives everyone the full grace period to reconnect instead of
   * destroying rooms the instant the server comes back. Rooms whose `emptied_at`
   * was already set keep their original, older timestamp, so a room that went
   * empty long before the restart still expires on time.
   */
  markAllRoomsEmpty(at = Date.now()): void {
    this.db.query("UPDATE rooms SET emptied_at = ? WHERE emptied_at IS NULL").run(at);
  }

  /**
   * Deletes rooms that have been empty for longer than the grace period.
   * A room with anyone connected has `emptied_at IS NULL` and is never matched.
   */
  sweepExpiredRooms(graceMs: number): string[] {
    const cutoff = Date.now() - graceMs;
    const doomed = this.db
      .query<{ id: string; code: string }, [number]>(
        "SELECT id, code FROM rooms WHERE emptied_at IS NOT NULL AND emptied_at < ?",
      )
      .all(cutoff);
    if (doomed.length > 0) {
      this.db.query("DELETE FROM rooms WHERE emptied_at IS NOT NULL AND emptied_at < ?").run(cutoff);
    }
    return doomed.map((r) => r.code);
  }

  /**
   * Cascades to members, papers and blocks. Returns how many *rooms* went.
   *
   * Counted with a SELECT rather than taken from the DELETE's `.changes`: the
   * cascade's own row deletions land in that number too, so a single swept room
   * that happened to hold one paper reports as two. The count is only ever used
   * for a log line, but a log line that lies is worse than no log line.
   */
  sweepIdleRooms(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    const doomed = this.db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM rooms WHERE touched_at < ?")
      .get(cutoff)!.n;
    if (doomed > 0) this.db.query("DELETE FROM rooms WHERE touched_at < ?").run(cutoff);
    return doomed;
  }

  /* -------------------------------- members ------------------------------- */

  addMember(roomId: string, name: string): MemberRow {
    const seat = this.countMembers(roomId);
    const row: MemberRow = {
      id: id(),
      room_id: roomId,
      name,
      color: colorForIndex(seat),
      token: crypto.randomUUID(),
      joined_at: Date.now(),
    };
    this.db
      .query("INSERT INTO members (id, room_id, name, color, token, joined_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, row.room_id, row.name, row.color, row.token, row.joined_at);
    return row;
  }

  countMembers(roomId: string): number {
    return this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM members WHERE room_id = ?")
      .get(roomId)!.n;
  }

  member(roomId: string, memberId: string): MemberRow | null {
    return this.db
      .query<MemberRow, [string, string]>("SELECT * FROM members WHERE room_id = ? AND id = ?")
      .get(roomId, memberId);
  }

  listMembers(roomId: string): MemberRow[] {
    return this.db
      .query<MemberRow, [string]>("SELECT * FROM members WHERE room_id = ? ORDER BY joined_at ASC")
      .all(roomId);
  }

  renameMember(memberId: string, name: string): void {
    this.db.query("UPDATE members SET name = ? WHERE id = ?").run(name, memberId);
  }

  /* -------------------------------- papers -------------------------------- */

  createPaper(roomId: string, title: string, kind: PaperKind = "text"): PaperRow {
    const row: PaperRow = { id: id(), room_id: roomId, title, kind, created_at: Date.now(), rev: 0 };
    this.db
      .query("INSERT INTO papers (id, room_id, title, kind, created_at, rev) VALUES (?, ?, ?, ?, ?, 0)")
      .run(row.id, row.room_id, row.title, row.kind, row.created_at);
    return row;
  }

  paper(paperId: string): PaperRow | null {
    return this.db.query<PaperRow, [string]>("SELECT * FROM papers WHERE id = ?").get(paperId);
  }

  countPapers(roomId: string): number {
    return this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM papers WHERE room_id = ?")
      .get(roomId)!.n;
  }

  renamePaper(paperId: string, title: string): void {
    this.db.query("UPDATE papers SET title = ? WHERE id = ?").run(title, paperId);
  }

  /** Cascades to the paper's blocks. */
  deletePaper(paperId: string): void {
    this.db.query("DELETE FROM papers WHERE id = ?").run(paperId);
  }

  /** Summaries for the picker — never carries a paper's blocks. */
  listPaperSummaries(roomId: string): PaperSummary[] {
    const rows = this.db
      .query<
        { id: string; title: string; kind: PaperKind; created_at: number; block_count: number; last_at: number | null; last_text: string | null },
        [string]
      >(
        `SELECT p.id, p.title, p.kind, p.created_at,
                (SELECT COUNT(*) FROM blocks b WHERE b.paper_id = p.id) AS block_count,
                (SELECT MAX(b.created_at) FROM blocks b WHERE b.paper_id = p.id) AS last_at,
                -- An image block has no text and a stroke block's text is JSON,
                -- so without these the picker shows either a blank card for a
                -- paper that plainly has something on it, or a wall of digits.
                (SELECT CASE b.kind WHEN 'image' THEN '[image]' WHEN 'stroke' THEN '' ELSE b.text END
                   FROM blocks b WHERE b.paper_id = p.id
                   ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1) AS last_text
           FROM papers p
          WHERE p.room_id = ?
          ORDER BY p.created_at ASC`,
      )
      .all(roomId);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      blockCount: r.block_count,
      lastActivity: r.last_at ?? r.created_at,
      preview: previewOf(r.last_text),
    }));
  }

  /* -------------------------------- blocks -------------------------------- */

  listBlocks(paperId: string): Block[] {
    return this.db
      .query<BlockRow, [string]>(`${BLOCK_SELECT} WHERE b.paper_id = ? ORDER BY b.created_at ASC, b.rowid ASC`)
      .all(paperId)
      .map(toBlock);
  }

  countBlocks(paperId: string): number {
    return this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM blocks WHERE paper_id = ?")
      .get(paperId)!.n;
  }

  block(blockId: string): Block | null {
    const row = this.db.query<BlockRow, [string]>(`${BLOCK_SELECT} WHERE b.id = ?`).get(blockId);
    return row ? toBlock(row) : null;
  }

  /* --------------------------------- media -------------------------------- */

  addMedia(roomId: string, media: NewMedia): MediaRow {
    const row: MediaRow = {
      id: id(),
      room_id: roomId,
      mime: media.mime,
      byte_size: media.data.byteLength,
      width: media.width,
      height: media.height,
      name: media.name,
    };
    this.db
      .query(
        `INSERT INTO media (id, room_id, mime, byte_size, width, height, name, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.room_id, row.mime, row.byte_size, row.width, row.height, row.name, media.data, Date.now());
    return row;
  }

  /** Metadata only — deliberately never loads the BLOB just to validate an id. */
  mediaMeta(mediaId: string): MediaRow | null {
    return this.db
      .query<MediaRow, [string]>("SELECT id, room_id, mime, byte_size, width, height, name FROM media WHERE id = ?")
      .get(mediaId);
  }

  mediaBytes(mediaId: string): { mime: string; data: Uint8Array } | null {
    const row = this.db
      .query<{ mime: string; data: Uint8Array }, [string]>("SELECT mime, data FROM media WHERE id = ?")
      .get(mediaId);
    return row ?? null;
  }

  /*
   * The three mutations below each pair a row change with a `rev` bump, in one
   * transaction. If they could drift apart, a client would either apply a delta
   * whose rev it already had or refresh forever — so they don't get to.
   */

  addBlock(
    paperId: string,
    author: MemberRow,
    text: string,
    filename: string | null = null,
  ): { block: Block; rev: number } {
    return this.insertBlock(paperId, author, { kind: "text", text, filename, mediaId: null });
  }

  addImageBlock(paperId: string, author: MemberRow, mediaId: string): { block: Block; rev: number } {
    // An image already carries its own name on the media row; duplicating it
    // here would give the same picture two names that could disagree.
    return this.insertBlock(paperId, author, { kind: "image", text: "", filename: null, mediaId });
  }

  /**
   * A stroke, stored as JSON in the text column. Nothing about it is special:
   * it is an author-owned block, so deletion, the authorship gate and the
   * snapshot all work on it without knowing what it is.
   */
  addStrokeBlock(paperId: string, author: MemberRow, strokeJson: string): { block: Block; rev: number } {
    return this.insertBlock(paperId, author, {
      kind: "stroke",
      text: strokeJson,
      filename: null,
      mediaId: null,
    });
  }

  private insertBlock(
    paperId: string,
    author: MemberRow,
    content: {
      kind: "text" | "image" | "stroke";
      text: string;
      filename: string | null;
      mediaId: string | null;
    },
  ): { block: Block; rev: number } {
    const blockId = id();
    const createdAt = Date.now();
    const rev = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO blocks (id, paper_id, author_id, author_name, author_color, kind, text, filename, media_id, created_at, edited_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          blockId,
          paperId,
          author.id,
          author.name,
          author.color,
          content.kind,
          content.text,
          content.filename,
          content.mediaId,
          createdAt,
        );
      return this.bumpRev(paperId);
    })();
    // Read it back rather than reconstructing it, so the broadcast block and a
    // block from a later snapshot are built by the same code path — including
    // the media join, which a hand-built object would have to duplicate.
    return { block: this.block(blockId)!, rev };
  }

  editBlock(blockId: string, paperId: string, text: string): { block: Block; rev: number } {
    const editedAt = Date.now();
    const rev = this.db.transaction(() => {
      this.db.query("UPDATE blocks SET text = ?, edited_at = ? WHERE id = ?").run(text, editedAt, blockId);
      return this.bumpRev(paperId);
    })();
    return { block: this.block(blockId)!, rev };
  }

  deleteBlock(blockId: string, paperId: string): number {
    return this.db.transaction(() => {
      this.db.query("DELETE FROM blocks WHERE id = ?").run(blockId);
      return this.bumpRev(paperId);
    })();
  }

  /**
   * Everything one author put on a paper, gone in one statement and one `rev`.
   *
   * The `author_id = ?` in the WHERE clause *is* the permission check — there
   * is no way to call this and touch someone else's row, which is a stronger
   * guarantee than a check somebody has to remember to write. One rev bump no
   * matter how many rows go, because clients see this as a single event.
   */
  clearBlocksByAuthor(paperId: string, authorId: string): { rev: number; removed: number } {
    return this.db.transaction(() => {
      const removed = this.db
        .query("DELETE FROM blocks WHERE paper_id = ? AND author_id = ?")
        .run(paperId, authorId).changes;
      return { rev: this.bumpRev(paperId), removed };
    })();
  }

  private bumpRev(paperId: string): number {
    return this.db
      .query<{ rev: number }, [string]>("UPDATE papers SET rev = rev + 1 WHERE id = ? RETURNING rev")
      .get(paperId)!.rev;
  }
}
