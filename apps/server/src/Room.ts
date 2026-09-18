import {
  MAX_BLOCKS_PER_PAPER,
  MAX_BLOCK_CHARS,
  MAX_PAPERS_PER_ROOM,
  MAX_STROKES_PER_PAPER,
  type ClientIntent,
  type ErrorCode,
  type PublicRoomState,
  type ServerMessage,
} from "@pastebin/protocol";
import type { PaperKind } from "@pastebin/protocol";
import type { MemberRow, PaperRow, RoomRow, Store } from "./Store";

/** Narrow view of a WS connection — keeps `any` at the handler boundary. */
export interface Socket {
  send(data: string): void;
  close(): void;
}

export const send = (ws: Socket, message: ServerMessage): void => ws.send(JSON.stringify(message));

export const sendError = (ws: Socket, code: ErrorCode, message: string): void =>
  send(ws, { type: "error", payload: { code, message } });

/**
 * One open socket. `paperId` is which paper this socket is *watching* — a
 * member with two tabs open on two papers is two conns, and each gets only its
 * own paper's deltas.
 */
export interface Conn {
  ws: Socket;
  memberId: string;
  paperId: string | null;
}

export type IntentResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

const OK: IntentResult = { ok: true };
const fail = (code: ErrorCode, message: string): IntentResult => ({ ok: false, code, message });

/**
 * A room's live socket registry plus its rules. It owns no data: everything it
 * reads and writes goes through `Store`, so a restart loses nothing but the
 * sockets.
 *
 * There is no phase, no host and no lobby here — a room is a container, not a
 * game. That is the main structural difference from YAWBG's `Room`.
 */
export class Room {
  readonly id: string;
  readonly code: string;
  private conns = new Set<Conn>();

  private onDestroyed: () => void;

  constructor(row: RoomRow, private store: Store, opts: { onDestroyed?: () => void } = {}) {
    this.id = row.id;
    this.code = row.code;
    this.onDestroyed = opts.onDestroyed ?? (() => {});
  }

  get isEmpty(): boolean {
    return this.conns.size === 0;
  }

  get memberCount(): number {
    return this.store.countMembers(this.id);
  }

  /* ------------------------------ membership ------------------------------ */

  addMember(name: string): MemberRow {
    const member = this.store.addMember(this.id, name);
    this.store.touchRoom(this.id);
    return member;
  }

  /**
   * Reclaims an identity. Unlike YAWBG's `resume` there is no seat being held
   * open and no grace timer to beat — the member row is permanent, so this can
   * succeed a week later. The token is the whole check.
   */
  resume(memberId: string, token: string): MemberRow | null {
    const member = this.store.member(this.id, memberId);
    if (!member || member.token !== token) return null;
    this.store.touchRoom(this.id);
    return member;
  }

  /*
   * Occupancy drives the room's lifetime, so it is recorded on the row rather
   * than only in memory: the expiry clock has to survive a process restart, and
   * a live `conns` set does not.
   */

  attach(ws: Socket, memberId: string): Conn {
    const conn: Conn = { ws, memberId, paperId: null };
    this.conns.add(conn);
    if (this.conns.size === 1) this.store.markRoomOccupied(this.id);
    return conn;
  }

  detach(conn: Conn): void {
    this.conns.delete(conn);
    if (this.conns.size === 0) this.store.markRoomEmpty(this.id);
  }

  /**
   * Ends the room for everyone. Tells the connected sockets *before* the rows
   * go, so the UI can explain what happened rather than leaving people on a
   * room that fails at the next action with a confusing ROOM_NOT_FOUND.
   */
  closeAndDelete(reason: "deleted" | "expired"): void {
    const message: ServerMessage = { type: "room.closed", payload: { reason } };
    for (const conn of this.conns) send(conn.ws, message);
    this.conns.clear();
    this.store.deleteRoom(this.id);
    this.onDestroyed();
  }

  /** The paper a fresh arrival lands on: the only one, or the oldest of several. */
  firstPaperId(): string {
    return this.store.listPaperSummaries(this.id)[0]!.id;
  }

  /* ------------------------------ broadcasting ----------------------------- */

  publicState(): PublicRoomState {
    const online = new Set([...this.conns].map((c) => c.memberId));
    return {
      code: this.code,
      papers: this.store.listPaperSummaries(this.id),
      members: this.store.listMembers(this.id).map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        connected: online.has(m.id),
      })),
    };
  }

  notifyRoom(): void {
    const message: ServerMessage = { type: "room.state", payload: this.publicState() };
    for (const conn of this.conns) send(conn.ws, message);
  }

  /** Deltas reach only the sockets actually looking at that paper. */
  private toPaper(paperId: string, message: ServerMessage): void {
    for (const conn of this.conns) {
      if (conn.paperId === paperId) send(conn.ws, message);
    }
  }

  private sendPaperState(conn: Conn, paperId: string): IntentResult {
    const paper = this.store.paper(paperId);
    if (!paper || paper.room_id !== this.id) return fail("PAPER_NOT_FOUND", "no such paper in this room");
    send(conn.ws, {
      type: "paper.state",
      payload: {
        paperId: paper.id,
        title: paper.title,
        rev: paper.rev,
        blocks: this.store.listBlocks(paper.id),
      },
    });
    return OK;
  }

  /* -------------------------------- intents -------------------------------- */

  handleIntent(conn: Conn, intent: ClientIntent): IntentResult {
    switch (intent.type) {
      case "room.delete": {
        // Any member may do this, like paper management — there is no host tier
        // here and inventing one for a single button would be a bigger change
        // than the button. The confirmation is the UI's job.
        this.closeAndDelete("deleted");
        return OK;
      }

      case "member.rename": {
        // Forward only: blocks already posted keep the name they were posted
        // under, because that is what the snapshot on the block row is for.
        this.store.renameMember(conn.memberId, intent.payload.name);
        this.store.touchRoom(this.id);
        this.notifyRoom();
        return OK;
      }

      case "paper.open": {
        const result = this.sendPaperState(conn, intent.payload.paperId);
        if (result.ok) conn.paperId = intent.payload.paperId;
        return result;
      }

      case "paper.close": {
        conn.paperId = null;
        return OK;
      }

      case "paper.create": {
        if (this.store.countPapers(this.id) >= MAX_PAPERS_PER_ROOM) {
          return fail("TOO_MANY_PAPERS", `a room holds at most ${MAX_PAPERS_PER_ROOM} papers`);
        }
        this.store.createPaper(this.id, intent.payload.title, intent.payload.kind ?? "text");
        this.store.touchRoom(this.id);
        this.notifyRoom();
        return OK;
      }

      case "paper.rename": {
        const paper = this.store.paper(intent.payload.paperId);
        if (!paper || paper.room_id !== this.id) return fail("PAPER_NOT_FOUND", "no such paper in this room");
        this.store.renamePaper(paper.id, intent.payload.title);
        this.store.touchRoom(this.id);
        this.notifyRoom();
        return OK;
      }

      case "paper.delete": {
        const paper = this.store.paper(intent.payload.paperId);
        if (!paper || paper.room_id !== this.id) return fail("PAPER_NOT_FOUND", "no such paper in this room");
        // A room always has somewhere to paste. Without this the picker could be
        // entered with nothing in it and no way back to a working state.
        if (this.store.countPapers(this.id) <= 1) {
          return fail("LAST_PAPER", "a room needs at least one paper");
        }
        this.store.deletePaper(paper.id);
        this.store.touchRoom(this.id);
        // Anyone watching it is now watching nothing. Clearing this server-side
        // means their next delta can't be routed to a paper that no longer
        // exists; the fresh room.state below is what moves them to the picker.
        for (const c of this.conns) {
          if (c.paperId === paper.id) c.paperId = null;
        }
        this.notifyRoom();
        return OK;
      }

      case "paper.refresh": {
        // The client saw a rev gap. Only answer for the paper it is watching,
        // so a refresh can't be used to read a paper without opening it.
        if (conn.paperId !== intent.payload.paperId) {
          return fail("PAPER_NOT_FOUND", "that paper is not open on this socket");
        }
        return this.sendPaperState(conn, intent.payload.paperId);
      }

      case "block.post": {
        const { paperId, text, filename } = intent.payload;
        if (text.length > MAX_BLOCK_CHARS) {
          return fail("TOO_LARGE", `a paste is capped at ${MAX_BLOCK_CHARS.toLocaleString()} characters`);
        }
        const found = this.paperOfKind(paperId, "text");
        if (!found.ok) return found;
        if (this.store.countBlocks(paperId) >= MAX_BLOCKS_PER_PAPER) {
          return fail("PAPER_FULL", `this paper is full (${MAX_BLOCKS_PER_PAPER} pastes)`);
        }
        const author = this.store.member(this.id, conn.memberId);
        if (!author) return fail("SESSION_INVALID", "your membership is gone");

        const { block, rev } = this.store.addBlock(paperId, author, text, filename ?? null);
        this.store.touchRoom(this.id);
        this.toPaper(paperId, { type: "block.added", payload: { paperId, rev, block } });
        this.notifyRoom(); // the paper's summary (count, preview, activity) moved
        return OK;
      }

      case "block.postImage": {
        const { paperId, mediaId } = intent.payload;
        const found = this.paperOfKind(paperId, "text");
        if (!found.ok) return found;
        if (this.store.countBlocks(paperId) >= MAX_BLOCKS_PER_PAPER) {
          return fail("PAPER_FULL", `this paper is full (${MAX_BLOCKS_PER_PAPER} pastes)`);
        }
        // The upload is already stored and already scoped to a room; this check
        // stops a media id from one room being attached inside another.
        const media = this.store.mediaMeta(mediaId);
        if (!media || media.room_id !== this.id) return fail("MEDIA_NOT_FOUND", "that upload is gone");

        const author = this.store.member(this.id, conn.memberId);
        if (!author) return fail("SESSION_INVALID", "your membership is gone");

        const { block, rev } = this.store.addImageBlock(paperId, author, mediaId);
        this.store.touchRoom(this.id);
        this.toPaper(paperId, { type: "block.added", payload: { paperId, rev, block } });
        this.notifyRoom();
        return OK;
      }

      case "block.postStroke": {
        const { paperId, stroke } = intent.payload;
        const found = this.paperOfKind(paperId, "draw");
        if (!found.ok) return found;
        // A board's own cap: MAX_BLOCKS_PER_PAPER was sized for pastes, and a
        // sketch would spend it in a sitting.
        if (this.store.countBlocks(paperId) >= MAX_STROKES_PER_PAPER) {
          return fail("PAPER_FULL", `this board is full (${MAX_STROKES_PER_PAPER} strokes)`);
        }
        const author = this.store.member(this.id, conn.memberId);
        if (!author) return fail("SESSION_INVALID", "your membership is gone");

        // Already validated by StrokeSchema — width, bounds and point count —
        // so this only has to be stored.
        const { block, rev } = this.store.addStrokeBlock(paperId, author, JSON.stringify(stroke));
        this.store.touchRoom(this.id);
        this.toPaper(paperId, { type: "block.added", payload: { paperId, rev, block } });
        this.notifyRoom();
        return OK;
      }

      /**
       * Everything the caller drew, gone. Open to any member because it can only
       * ever reach their own rows — `clearBlocksByAuthor` is scoped by member
       * id, so there is no authorship check to get wrong here.
       */
      case "paper.clearMine": {
        const { paperId } = intent.payload;
        const paper = this.store.paper(paperId);
        if (!paper || paper.room_id !== this.id) return fail("PAPER_NOT_FOUND", "no such paper in this room");

        const { rev, removed } = this.store.clearBlocksByAuthor(paperId, conn.memberId);
        // Still broadcast when nothing went: the rev moved, and a client that
        // skipped it would refresh forever chasing a gap.
        this.store.touchRoom(this.id);
        this.toPaper(paperId, {
          type: "blocks.cleared",
          payload: { paperId, rev, authorId: conn.memberId },
        });
        if (removed > 0) this.notifyRoom();
        return OK;
      }

      case "block.edit": {
        const { blockId, text } = intent.payload;
        if (text.length > MAX_BLOCK_CHARS) {
          return fail("TOO_LARGE", `a paste is capped at ${MAX_BLOCK_CHARS.toLocaleString()} characters`);
        }
        const owned = this.ownedBlock(conn, blockId);
        if (!owned.ok) return owned;
        // Neither an image nor a stroke has text to edit. A stroke's text is
        // JSON geometry, and letting `block.edit` through would be a way to
        // write an arbitrary string into a field the board parses.
        if (owned.kind !== "text") return fail("BAD_MESSAGE", "that block has no text to edit");

        const { block, rev } = this.store.editBlock(blockId, owned.paperId, text);
        this.store.touchRoom(this.id);
        this.toPaper(owned.paperId, { type: "block.updated", payload: { paperId: owned.paperId, rev, block } });
        this.notifyRoom();
        return OK;
      }

      case "block.delete": {
        const owned = this.ownedBlock(conn, intent.payload.blockId);
        if (!owned.ok) return owned;

        const rev = this.store.deleteBlock(intent.payload.blockId, owned.paperId);
        this.store.touchRoom(this.id);
        this.toPaper(owned.paperId, {
          type: "block.removed",
          payload: { paperId: owned.paperId, rev, blockId: intent.payload.blockId },
        });
        this.notifyRoom();
        return OK;
      }

      default:
        // Binding intents (room.create/join, session.resume) never reach here.
        return fail("BAD_MESSAGE", "intent not handled by a bound socket");
    }
  }

  /**
   * The single paper gate: in this room, exists, and is the kind the intent is
   * for. Kind is checked here rather than at each call site because "a paste
   * cannot land on a whiteboard" and "a stroke cannot land on a text paper" are
   * the same rule read from two directions.
   */
  private paperOfKind(
    paperId: string,
    kind: PaperKind,
  ): { ok: true; paper: PaperRow } | { ok: false; code: ErrorCode; message: string } {
    const paper = this.store.paper(paperId);
    if (!paper || paper.room_id !== this.id) {
      return { ok: false, code: "PAPER_NOT_FOUND", message: "no such paper in this room" };
    }
    if (paper.kind !== kind) {
      return {
        ok: false,
        code: "WRONG_PAPER_KIND",
        message: kind === "draw" ? "that paper is not a whiteboard" : "that paper is a whiteboard",
      };
    }
    return { ok: true, paper };
  }

  /**
   * The single authorship gate. Both mutating intents route through it, so
   * "only the author may edit or delete" is one check in one place rather than
   * a rule two call sites have to remember — and it is server-side, because a
   * client-side check would only be a suggestion.
   */
  private ownedBlock(
    conn: Conn,
    blockId: string,
  ):
    | { ok: true; paperId: string; kind: "text" | "image" | "stroke" }
    | { ok: false; code: ErrorCode; message: string } {
    const block = this.store.block(blockId);
    if (!block) return { ok: false, code: "BLOCK_NOT_FOUND", message: "that paste is gone" };
    const paper = this.store.paper(block.paperId);
    if (!paper || paper.room_id !== this.id) {
      return { ok: false, code: "BLOCK_NOT_FOUND", message: "that paste is not in this room" };
    }
    if (block.authorId !== conn.memberId) {
      return { ok: false, code: "NOT_AUTHOR", message: "you can only change your own pastes" };
    }
    return { ok: true, paperId: block.paperId, kind: block.kind };
  }
}
