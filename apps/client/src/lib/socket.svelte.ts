import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientIntent,
  type PaperKind,
  type PaperState,
  type PublicRoomState,
  type Stroke,
} from "@pastebin/protocol";

const SESSIONS_KEY = "pastebin_sessions";
const NAME_KEY = "pastebin_name";
const RETRY_MS = 2000;

export interface Session {
  code: string;
  memberId: string;
  token: string;
}

/*
 * localStorage, not sessionStorage.
 *
 * YAWBG scopes a seat to a tab on purpose — a seat is per-person-per-game and
 * shouldn't follow you into a second tab. Here the stored thing is *ownership
 * of text you pasted*, which has to survive closing the tab and coming back
 * tomorrow. Different thing, different storage.
 *
 * Keyed by room code, so being in several rooms doesn't make them fight.
 */
function loadSessions(): Record<string, Session> {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Session>) : {};
  } catch {
    return {};
  }
}

export function sessionFor(code: string): Session | null {
  return loadSessions()[code] ?? null;
}

/** Rooms this browser still has an identity for — the landing page offers them back. */
export const savedRooms = (): string[] => Object.keys(loadSessions()).sort();

function saveSession(session: Session): void {
  const all = loadSessions();
  all[session.code] = session;
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
  } catch {
    /* private mode, quota — the app still works, you just re-join next time */
  }
}

function dropSession(code: string): void {
  const all = loadSessions();
  delete all[code];
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/**
 * Names are not remembered. The landing page suggests a fresh one every visit.
 *
 * Only the *room session* (`pastebin_sessions`) is persisted, and it has to be:
 * the member id and token are what still make a paste yours after a reload.
 * Your name inside a room lives on the server's member row, so a resume brings
 * it back — this is purely about not carrying a name between visits.
 *
 * The old key is cleared once, so switching this off actually removes the name
 * already sitting on people's devices rather than just ignoring it.
 */
try {
  localStorage.removeItem(NAME_KEY);
} catch {
  /* private mode — nothing was stored in the first place */
}

type Target =
  | { kind: "create"; name: string }
  | { kind: "join"; code: string; name: string }
  | { kind: "resume"; code: string };

class RoomSocket {
  status = $state<"idle" | "connecting" | "open" | "closed">("idle");
  code = $state<string | null>(null);
  identity = $state<{ memberId: string; name: string; color: string } | null>(null);
  roomState = $state<PublicRoomState | null>(null);
  paper = $state<PaperState | null>(null);
  lastError = $state<{ code: string; message: string } | null>(null);
  /** Set when a stored identity turned out to be dead — the room route sends you home. */
  needsJoin = $state(false);
  /** Set when the room itself ended, so the landing page can say why. */
  closedNotice = $state<string | null>(null);

  private ws: WebSocket | null = null;
  private target: Target | null = null;
  private wantPaperId: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /* -------------------------------- lifecycle ------------------------------- */

  createRoom(name: string): void {
    this.start({ kind: "create", name });
  }

  joinRoom(code: string, name: string): void {
    this.start({ kind: "join", code, name });
  }

  /**
   * Re-enter a room this browser already has an identity for. A null `paperId`
   * means the route is the picker, not a paper.
   *
   * Nothing here opens a paper speculatively. An earlier version had
   * `session.created` auto-open the room's first paper, which raced the
   * navigation that immediately followed it — the route arrived with no paper
   * id, cleared the pending one, and the `paper.state` that landed a moment
   * later matched nothing and was dropped, leaving the room stuck on
   * "Opening paper…". Now the route is the only thing that decides, and it
   * decides after `room.state` has told it how many papers there are.
   */
  resumeRoom(code: string, paperId: string | null): void {
    if (this.code === code && this.status === "open" && this.identity) {
      if (paperId) {
        if (paperId !== this.paper?.paperId) this.openPaper(paperId);
      } else {
        this.closePaper();
      }
      return;
    }
    this.wantPaperId = paperId;
    this.start({ kind: "resume", code });
  }

  leave(): void {
    this.target = null;
    this.wantPaperId = null;
    this.teardown();
    this.status = "idle";
    this.code = null;
    this.identity = null;
    this.roomState = null;
    this.paper = null;
  }

  private start(target: Target): void {
    this.teardown();
    this.target = target;
    this.lastError = null;
    this.needsJoin = false;
    this.closedNotice = null;
    this.roomState = null;
    this.paper = null;
    this.identity = null;
    this.open();
  }

  private teardown(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null; // this close is ours, not a drop — don't retry it
      ws.close();
    }
  }

  private open(): void {
    this.status = "connecting";
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.status = "open";
      this.sendTarget();
    };
    ws.onmessage = (e) => this.handle(String(e.data));
    ws.onclose = () => {
      this.status = "closed";
      this.ws = null;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.target) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.status !== "open") this.open();
    }, RETRY_MS);
  }

  /**
   * A socket binds exactly once, so a reconnect has to re-announce who we are.
   * After a successful create or join the target becomes a *resume* — otherwise
   * a dropped connection would cheerfully create a second room.
   */
  private sendTarget(): void {
    const target = this.target;
    if (!target) return;

    if (target.kind === "create") {
      this.send({
        type: "room.create",
        payload: { memberName: target.name, protocolVersion: PROTOCOL_VERSION },
      });
      return;
    }
    if (target.kind === "join") {
      this.send({
        type: "room.join",
        payload: { code: target.code, memberName: target.name, protocolVersion: PROTOCOL_VERSION },
      });
      return;
    }
    const session = sessionFor(target.code);
    if (!session) {
      this.needsJoin = true;
      return;
    }
    this.send({
      type: "session.resume",
      payload: {
        code: session.code,
        memberId: session.memberId,
        token: session.token,
        protocolVersion: PROTOCOL_VERSION,
      },
    });
  }

  /* --------------------------------- intents -------------------------------- */

  send(intent: ClientIntent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(intent));
  }

  openPaper(paperId: string): void {
    this.wantPaperId = paperId;
    if (this.paper?.paperId !== paperId) this.paper = null;
    this.send({ type: "paper.open", payload: { paperId } });
  }

  /** Back out to the picker: stop rendering *and* stop receiving that paper. */
  closePaper(): void {
    this.wantPaperId = null;
    this.paper = null;
    this.send({ type: "paper.close", payload: {} });
  }

  /** Ends the room for everyone. The server answers with `room.closed`. */
  deleteRoom(): void {
    this.send({ type: "room.delete", payload: {} });
  }

  createPaper(title: string, kind: PaperKind = "text"): void {
    this.send({ type: "paper.create", payload: { title, kind } });
  }

  renamePaper(paperId: string, title: string): void {
    this.send({ type: "paper.rename", payload: { paperId, title } });
  }

  deletePaper(paperId: string): void {
    this.send({ type: "paper.delete", payload: { paperId } });
  }

  /** `filename` is set only when the text came from a dropped file. */
  post(text: string, filename: string | null = null): void {
    const paperId = this.paper?.paperId;
    if (paperId) this.send({ type: "block.post", payload: { paperId, text, filename } });
  }

  /** The bytes already went over HTTP; this only attaches the id to a block. */
  postImage(mediaId: string): void {
    const paperId = this.paper?.paperId;
    if (paperId) this.send({ type: "block.postImage", payload: { paperId, mediaId } });
  }

  /** One finished stroke. Sent on pointer-up, never while the pointer moves. */
  postStroke(stroke: Stroke): void {
    const paperId = this.paper?.paperId;
    if (paperId) this.send({ type: "block.postStroke", payload: { paperId, stroke } });
  }

  /** Removes everything you drew on the open paper, and nothing else. */
  clearMine(): void {
    const paperId = this.paper?.paperId;
    if (paperId) this.send({ type: "paper.clearMine", payload: { paperId } });
  }

  /** Credentials for the upload endpoint, which authenticates the same way. */
  get sessionForUpload(): Session | null {
    return this.code ? sessionFor(this.code) : null;
  }

  edit(blockId: string, text: string): void {
    this.send({ type: "block.edit", payload: { blockId, text } });
  }

  remove(blockId: string): void {
    this.send({ type: "block.delete", payload: { blockId } });
  }

  rename(name: string): void {
    this.send({ type: "member.rename", payload: { name } });
  }

  /* -------------------------------- messages -------------------------------- */

  private handle(data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;

    switch (message.type) {
      case "session.created": {
        const { code, memberId, token, name, color } = message.payload;
        saveSession({ code, memberId, token });
        this.code = code;
        this.identity = { memberId, name, color };
        this.target = { kind: "resume", code }; // never create/join twice
        this.lastError = null;
        this.needsJoin = false;
        // Re-open whatever this tab was looking at. On a first arrival that is
        // null and the route picks, once room.state says how many papers exist.
        if (this.wantPaperId) this.openPaper(this.wantPaperId);
        break;
      }

      case "room.state": {
        this.roomState = message.payload;
        // Our own name can change from another tab; keep the chip honest.
        const me = message.payload.members.find((m) => m.id === this.identity?.memberId);
        if (me && this.identity) this.identity = { ...this.identity, name: me.name, color: me.color };
        break;
      }

      case "paper.state": {
        if (message.payload.paperId === this.wantPaperId) this.paper = message.payload;
        break;
      }

      case "block.added":
        this.applyDelta(message.payload.paperId, message.payload.rev, (p) => ({
          ...p,
          // The server orders blocks oldest-first and this one is the newest,
          // so appending is the same order a snapshot would arrive in.
          blocks: [...p.blocks, message.payload.block],
        }));
        break;

      case "block.updated":
        this.applyDelta(message.payload.paperId, message.payload.rev, (p) => ({
          ...p,
          blocks: p.blocks.map((b) => (b.id === message.payload.block.id ? message.payload.block : b)),
        }));
        break;

      case "block.removed":
        this.applyDelta(message.payload.paperId, message.payload.rev, (p) => ({
          ...p,
          blocks: p.blocks.filter((b) => b.id !== message.payload.blockId),
        }));
        break;

      // The frame names an author rather than listing ids, so the filtering
      // happens here — which is why it stays one small message whether five
      // strokes went or five hundred.
      case "blocks.cleared":
        this.applyDelta(message.payload.paperId, message.payload.rev, (p) => ({
          ...p,
          blocks: p.blocks.filter((b) => b.authorId !== message.payload.authorId),
        }));
        break;

      case "room.closed": {
        // The room is already gone server-side. Drop the stored identity so the
        // landing page doesn't offer a dead code back, and stop the socket from
        // trying to resume into nothing.
        const code = this.code ?? (this.target?.kind === "resume" ? this.target.code : null);
        if (code) dropSession(code);
        this.target = null;
        this.closedNotice =
          message.payload.reason === "deleted"
            ? "That room was deleted."
            : "That room expired after being empty.";
        this.leave();
        break;
      }

      case "error": {
        this.lastError = message.payload;
        const target = this.target;
        const dead = message.payload.code === "SESSION_INVALID" || message.payload.code === "ROOM_NOT_FOUND";
        if (target?.kind === "resume" && dead) {
          // The stored identity is gone — the room was swept, or this is not the
          // database we joined. Forget it and let the user join afresh rather
          // than retry a resume that will never succeed.
          dropSession(target.code);
          this.target = null;
          this.needsJoin = true;
        }
        break;
      }
    }
  }

  /**
   * Deltas carry the paper's new `rev`. Anything other than exactly one more
   * than we hold means a frame went missing, and patching on top of a hole
   * would leave the paper quietly wrong — so we ask for a whole snapshot
   * instead. This check is the entire price of not resending the paper on
   * every keystroke-sized change.
   */
  private applyDelta(paperId: string, rev: number, apply: (p: PaperState) => PaperState): void {
    const current = this.paper;
    if (!current || current.paperId !== paperId) return;
    if (rev !== current.rev + 1) {
      this.send({ type: "paper.refresh", payload: { paperId } });
      return;
    }
    this.paper = { ...apply(current), rev };
  }
}

export const socket = new RoomSocket();
