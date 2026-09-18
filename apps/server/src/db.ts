import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Unlike YAWBG — where SQLite holds decks and finished-game records while live
 * state stays in RAM and a restart dropping a game is accepted — this database
 * *is* the state. Every mutation writes through here before it broadcasts, so
 * the text you pasted survives a server restart, a crash, or a PC reboot. The
 * in-memory `Room` objects are a socket registry and a cache, nothing more.
 */
export function openDb(path: string): Database {
  // SQLite creates the file but not its directory. Skip the bare-filename case:
  // dirname() gives "." there, and mkdir(".") throws EEXIST on Windows even
  // with recursive (the same trap YAWBG's db.ts documents).
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && dir !== "." && dir !== path) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id         TEXT PRIMARY KEY,
      code       TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      -- Last time anyone joined or wrote. The TTL sweeper reads only this.
      touched_at INTEGER NOT NULL
    );

    -- Membership is persistent: it is what still makes a block yours tomorrow.
    -- Presence (connected/not) is live socket state and is deliberately absent.
    CREATE TABLE IF NOT EXISTS members (
      id        TEXT PRIMARY KEY,
      room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      color     TEXT NOT NULL,
      -- Bearer secret. Never leaves the server except to its own owner, once.
      token     TEXT NOT NULL,
      joined_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS members_room ON members (room_id, joined_at);

    CREATE TABLE IF NOT EXISTS papers (
      id         TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      -- Bumped on every block mutation; clients use the gap to detect a missed
      -- delta and ask for a fresh snapshot.
      rev        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS papers_room ON papers (room_id, created_at);

    -- author_name/author_color are snapshots, and author_id has no FK on
    -- purpose: a block must render correctly long after its author renamed
    -- themselves or stopped coming back.
    CREATE TABLE IF NOT EXISTS blocks (
      id           TEXT PRIMARY KEY,
      paper_id     TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      author_id    TEXT NOT NULL,
      author_name  TEXT NOT NULL,
      author_color TEXT NOT NULL,
      text         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      edited_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS blocks_paper ON blocks (paper_id, created_at);

    -- Link previews, cached by URL and shared across every room: what a public
    -- page says about itself is not room-specific. A row with a non-null
    -- error column is a cached *failure*, so a dead link isn't re-fetched on
    -- every click. No FK to blocks — the same URL can appear in many pastes, and the
    -- cache should outlive any one of them.
    CREATE TABLE IF NOT EXISTS link_previews (
      url         TEXT PRIMARY KEY,
      title       TEXT,
      description TEXT,
      site_name   TEXT,
      image_url   TEXT,
      error       TEXT,
      fetched_at  INTEGER NOT NULL
    );

    -- Uploaded images, bytes and all. A BLOB rather than a file on disk so the
    -- whole app stays one .sqlite you can copy, back up or delete — which is
    -- the same reason the rest of the state lives here. Scoped to a room so
    -- sweeping a room reclaims its pictures.
    CREATE TABLE IF NOT EXISTS media (
      id         TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      byte_size  INTEGER NOT NULL,
      width      INTEGER,
      height     INTEGER,
      name       TEXT,
      data       BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS media_room ON media (room_id);
  `);

  // Image support arrived after rooms already existed on disk, and SQLite has
  // no ADD COLUMN IF NOT EXISTS. Adding them conditionally means an existing
  // pastebin.sqlite keeps its rooms instead of needing to be thrown away.
  addColumnIfMissing(db, "blocks", "kind", "TEXT NOT NULL DEFAULT 'text'");
  addColumnIfMissing(db, "blocks", "media_id", "TEXT");
  // The name of the file a block was dropped from; NULL for anything typed.
  addColumnIfMissing(db, "blocks", "filename", "TEXT");
  // When the last socket left. NULL means someone is in there right now.
  addColumnIfMissing(db, "rooms", "emptied_at", "INTEGER");
  // 'text' or 'draw'. Existing papers are text papers, which the default says.
  addColumnIfMissing(db, "papers", "kind", "TEXT NOT NULL DEFAULT 'text'");

  return db;
}

function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
