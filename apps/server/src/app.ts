import { existsSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import {
  CLI_BUILDS,
  ClientIntentSchema,
  DEFAULT_EMPTY_ROOM_GRACE_MINUTES,
  MAX_BLOCK_CHARS,
  MAX_MEMBERS,
  MAX_UPLOAD_BYTES,
  PROTOCOL_VERSION,
} from "@pastebin/protocol";
import { sniffImageMime } from "./imageType";
import { openDb } from "./db";
import { LinkPreviewStore } from "./linkPreview";
import { loadNamePool } from "./names";
import { lanAddresses } from "./net";
import { type Conn, Room, send, sendError, type Socket } from "./Room";
import { RoomManager } from "./RoomManager";
import { type MemberRow, Store } from "./Store";

export interface AppOptions {
  /** SQLite file; ":memory:" in tests. */
  dbPath?: string;
  /** Directory of the built SPA; null skips static routes. */
  clientDist?: string | null;
  /** Directory of the compiled command-line binaries, served at `/cli/<file>`; null serves none. */
  cliDist?: string | null;
  /** How long a room survives with nobody connected. */
  emptyGraceMinutes?: number;
  /** Backstop only — see the sweeper comment. */
  ttlDays?: number;
  /** Ping interval; two and a half missed pongs closes the socket. 0 disables. */
  heartbeatMs?: number;
}

interface SocketSession {
  code: string;
  conn: Conn;
}

/**
 * The socket's stable identity, whichever object Elysia hands us.
 *
 * `open`, `message` and `close` get Elysia's `ElysiaWS` wrapper, which carries
 * `.id`; **`pong` gets Bun's raw `ServerWebSocket`**, where the id lives at
 * `.data.id` and `.id` is `undefined`. Reading `ws.id` inside `pong` silently
 * misses every lookup, so `lastPong` never advances and the heartbeat reaps
 * every socket on schedule — a bug that cost YAWBG four milestones of being
 * mistaken for network flakiness. Resolved here so no call site has to know
 * which shape it got.
 */
const socketId = (ws: any): string => ws.id ?? ws.data?.id;

function pingSocket(ws: any): void {
  try {
    if (typeof ws.ping === "function") ws.ping();
    else if (typeof ws.raw?.ping === "function") ws.raw.ping();
  } catch {
    /* already gone; the close handler cleans up */
  }
}

export function createApp(opts: AppOptions = {}) {
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const graceMinutes = opts.emptyGraceMinutes ?? DEFAULT_EMPTY_ROOM_GRACE_MINUTES;
  const graceMs = graceMinutes * 60 * 1000;
  const ttlMs = (opts.ttlDays ?? 30) * 24 * 60 * 60 * 1000;
  const clientDist =
    opts.clientDist === undefined ? join(import.meta.dir, "../../client/dist") : opts.clientDist;
  const cliDist = opts.cliDist === undefined ? join(import.meta.dir, "../../cli/dist") : opts.cliDist;
  const availableCliBuilds = () => (cliDist ? CLI_BUILDS.filter((b) => existsSync(join(cliDist, b.file))) : []);

  const db = openDb(opts.dbPath ?? process.env.DB_PATH ?? "pastebin.sqlite");
  const store = new Store(db);
  const manager = new RoomManager(store);

  /*
   * Room lifetime, in two layers.
   *
   * Primary: a room is deleted once it has been *empty* for `graceMs`. Rooms
   * are meant to last a session.
   *
   * Every room is stamped empty at boot, because a restart means there are no
   * sockets anywhere. Stamping rather than deleting is deliberate — a restart
   * mid-session hands everyone the full grace period to reconnect instead of
   * destroying their room the moment the server comes back. Rooms already
   * marked empty keep their older timestamp and expire on their original
   * schedule.
   */
  store.markAllRoomsEmpty();

  const sweep = () => {
    for (const code of store.sweepExpiredRooms(graceMs)) manager.forget(code);
  };
  sweep();
  /*
   * Tick at half the grace, capped at 30s and floored at 1s.
   *
   * A fixed 30s tick would make a 5-minute grace mean "five to five and a half",
   * which is fine — but it would make a deliberately short grace meaningless,
   * since the room would outlive it by up to 30s regardless. Scaling keeps the
   * overshoot proportional to the promise. It stays cheap either way: one
   * indexed DELETE over a table holding a handful of rows.
   */
  const sweepEvery = Math.max(1000, Math.min(30_000, graceMs / 2));
  const emptyTimer = setInterval(sweep, sweepEvery);
  emptyTimer.unref?.();

  /*
   * Backstop: a room whose socket leaked would look occupied forever and the
   * primary sweep would never see it. `touched_at` only moves on a real join or
   * write, so this catches it. It should never fire in normal use.
   */
  const idleTimer = setInterval(() => store.sweepIdleRooms(ttlMs), 24 * 60 * 60 * 1000);
  idleTimer.unref?.();

  const sockets = new Map<string, SocketSession>();
  const live = new Map<string, { ws: any; lastPong: number }>();

  if (heartbeatMs > 0) {
    const timer = setInterval(() => {
      const deadline = Date.now() - heartbeatMs * 2.5;
      for (const entry of live.values()) {
        if (entry.lastPong < deadline) {
          try {
            entry.ws.close();
          } catch {
            /* already gone */
          }
          continue;
        }
        pingSocket(entry.ws);
      }
    }, heartbeatMs);
    timer.unref?.();
  }

  const previews = new LinkPreviewStore(db);

  const app = new Elysia()
    .get("/healthz", () => ({ ok: true }))
    // Lets the QR panel offer an address a phone can actually reach, even when
    // the browser asking is on localhost. No auth: it reports the addresses of
    // the machine you are already talking to, on a LAN-only tool.
    // Server facts the UI needs: reachable addresses, and the real grace period
    // so the room screen never promises a number the server isn't keeping.
    .get("/api/host", () => ({ addresses: lanAddresses(), emptyRoomGraceMinutes: graceMinutes }))
    // Word pool for the landing page's suggested name, read from disk per
    // request so editing data/names.json needs no restart.
    .get("/api/names", () => loadNamePool())
    // On-demand only: nothing is fetched because a link was pasted, only
    // because someone pressed preview. See linkPreview.ts for the guard.
    .get("/api/preview", async ({ query, set }) => {
      const url = typeof query.url === "string" ? query.url : "";
      if (!url) {
        set.status = 400;
        return { error: "missing url" };
      }
      const result = await previews.get(url);
      if (!result.preview) {
        set.status = 422;
        return { error: result.error ?? "no preview" };
      }
      return result.preview;
    })
    /**
     * Image upload — raw bytes in the request body.
     *
     * Authenticated with the same member id and token the socket uses: an
     * unauthenticated upload endpoint on a machine anyone on the Wi-Fi can
     * reach is just a free file host.
     */
    .post("/api/upload", async ({ query, headers, request, set }) => {
      const code = typeof query.code === "string" ? query.code.toUpperCase() : "";
      const memberId = headers["x-member-id"];
      const token = headers["x-member-token"];
      const room = code ? manager.get(code) : undefined;
      if (!room || !memberId || !token || !room.resume(memberId, token)) {
        set.status = 401;
        return { error: "not a member of that room" };
      }

      // Refuse on the declared length before reading, so an oversized upload
      // isn't pulled into memory just to be rejected afterwards.
      const declared = Number(headers["content-length"] ?? 0);
      if (declared > MAX_UPLOAD_BYTES) {
        set.status = 413;
        return { error: `images are capped at ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` };
      }

      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0) {
        set.status = 400;
        return { error: "empty upload" };
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        set.status = 413;
        return { error: `images are capped at ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` };
      }

      // Sniffed, never taken from the client's content-type — see imageType.ts.
      const mime = sniffImageMime(bytes);
      if (!mime) {
        set.status = 415;
        return { error: "that file isn't a PNG, JPEG, GIF or WebP" };
      }

      const asInt = (v: unknown): number | null => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 && n < 100_000 ? n : null;
      };
      const name = typeof query.name === "string" ? query.name.slice(0, 120) : null;

      const media = store.addMedia(room.id, {
        mime,
        width: asInt(query.w),
        height: asInt(query.h),
        name,
        data: bytes,
      });
      return {
        id: media.id,
        mime: media.mime,
        width: media.width,
        height: media.height,
        byteSize: media.byte_size,
        name: media.name,
      };
    })
    /**
     * Serves an upload. The content type is the one *we* sniffed, and the id is
     * a random uuid, so the bytes are immutable and can be cached hard.
     * `Content-Disposition: inline` with `X-Content-Type-Options: nosniff`
     * keeps the browser from second-guessing the type we established.
     */
    .get("/media/:id", ({ params, set }) => {
      const found = store.mediaBytes(params.id);
      if (!found) {
        set.status = 404;
        return "not found";
      }
      return new Response(found.data, {
        headers: {
          "content-type": found.mime,
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    })
    .get("/api/preview/image", async ({ query, set }) => {
      const url = typeof query.url === "string" ? query.url : "";
      const result = url ? await previews.image(url) : { error: "missing url" };
      if ("error" in result) {
        set.status = 422;
        return result.error;
      }
      return new Response(result.bytes, {
        headers: { "content-type": result.type, "cache-control": "public, max-age=86400" },
      });
    });

  /**
   * The command-line client, served by the same process that speaks its
   * protocol, so rebuilding ships the matching binary. The names come from the
   * shared allowlist in the protocol package, and that list is the entire
   * path-traversal story: a request is one of those fixed names or a 404, and
   * nothing here joins user input onto a path. `no-cache` because the file is
   * rebuilt in place whenever the protocol moves, and a stale cached download
   * would be refused with VERSION_MISMATCH by the very server that served it.
   */
  app
    .get("/api/cli", () => ({ files: availableCliBuilds().map((b) => b.file) }))
    .get("/cli/:file", ({ params, set }) => {
      const build = CLI_BUILDS.find((b) => b.file === params.file);
      const path = build && cliDist ? join(cliDist, build.file) : null;
      if (!build || !path || !existsSync(path)) {
        set.status = 404;
        return "not found";
      }
      return new Response(Bun.file(path), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${build.file}"`,
          "cache-control": "no-cache",
        },
      });
    });

  app.ws("/ws", {
    idleTimeout: 3600,
    // The real ceiling on a hostile frame. The friendly cap is MAX_BLOCK_CHARS,
    // enforced in Room so an oversized paste gets TOO_LARGE and an explanation.
    maxPayloadLength: MAX_BLOCK_CHARS * 4 + 4096,

    open(ws: any) {
      live.set(socketId(ws), { ws, lastPong: Date.now() });
    },

    pong(ws: any) {
      const entry = live.get(socketId(ws));
      if (entry) entry.lastPong = Date.now();
    },

    message(ws: any, raw: unknown) {
      let data: unknown = raw;
      if (typeof raw === "string") {
        try {
          data = JSON.parse(raw);
        } catch {
          return void sendError(ws, "BAD_MESSAGE", "frame is not valid JSON");
        }
      }
      const parsed = ClientIntentSchema.safeParse(data);
      if (!parsed.success) return void sendError(ws, "BAD_MESSAGE", "unknown or malformed intent");

      const intent = parsed.data;
      const id = socketId(ws);
      const session = sockets.get(id);

      const binding =
        intent.type === "room.create" || intent.type === "room.join" || intent.type === "session.resume";

      if (binding) {
        if (session) return void sendError(ws, "BAD_MESSAGE", "socket already bound to a room");
        if (intent.payload.protocolVersion !== PROTOCOL_VERSION) {
          return void sendError(
            ws,
            "VERSION_MISMATCH",
            `server speaks protocol v${PROTOCOL_VERSION} — reload the page`,
          );
        }
      } else if (!session) {
        return; // intent from an unbound socket: drop
      }

      switch (intent.type) {
        case "room.create": {
          const room = manager.create();
          bind(ws, id, room, room.addMember(intent.payload.memberName));
          break;
        }

        case "room.join": {
          const room = manager.get(intent.payload.code);
          if (!room) return void sendError(ws, "ROOM_NOT_FOUND", `no room ${intent.payload.code}`);
          if (room.memberCount >= MAX_MEMBERS) {
            return void sendError(ws, "ROOM_FULL", `room is full (${MAX_MEMBERS} members)`);
          }
          bind(ws, id, room, room.addMember(intent.payload.memberName));
          break;
        }

        case "session.resume": {
          const room = manager.get(intent.payload.code);
          if (!room) return void sendError(ws, "ROOM_NOT_FOUND", `no room ${intent.payload.code}`);
          const member = room.resume(intent.payload.memberId, intent.payload.token);
          if (!member) return void sendError(ws, "SESSION_INVALID", "unknown member or bad token");
          bind(ws, id, room, member);
          break;
        }

        default: {
          const { code, conn } = session!;
          const room = manager.get(code);
          if (!room) return;
          const result = room.handleIntent(conn, intent);
          if (!result.ok) {
            sendError(ws, result.code, result.message);
            break;
          }
          if (intent.type === "room.delete") {
            // The room is gone and every socket that was in it has been told.
            // Unbind them here too, so a stale session can't route a later
            // intent at a room that no longer exists.
            for (const [socket, bound] of sockets) {
              if (bound.code === code) sockets.delete(socket);
            }
          }
          break;
        }
      }
    },

    close(ws: any) {
      const id = socketId(ws);
      live.delete(id);
      const session = sockets.get(id);
      if (!session) return;
      sockets.delete(id);
      const room = manager.get(session.code);
      if (!room) return;
      room.detach(session.conn);
      room.notifyRoom(); // the presence dot goes out
      manager.evictIfEmpty(session.code);
    },
  });

  /**
   * Binding is the same three steps however you arrived — create, join or
   * resume — so they share one path: attach the socket, hand back the identity,
   * and push the room's state.
   */
  function bind(ws: Socket, id: string, room: Room, member: MemberRow): void {
    const conn = room.attach(ws, member.id);
    sockets.set(id, { code: room.code, conn });
    send(ws, {
      type: "session.created",
      payload: {
        code: room.code,
        memberId: member.id,
        token: member.token,
        name: member.name,
        color: member.color,
      },
    });
    room.notifyRoom();
  }

  if (clientDist && existsSync(clientDist)) {
    const index = () => Bun.file(join(clientDist, "index.html"));
    app.get("/", index).get("/*", async ({ params, set }) => {
      const rel = (params as Record<string, string>)["*"] ?? "";
      // Anything that isn't a real file is an SPA route (/r/ABCD, /r/ABCD/p/…),
      // so it gets index.html and the client router sorts it out.
      if (rel && !rel.includes("..")) {
        const file = Bun.file(join(clientDist, rel));
        if (await file.exists()) return file;
      }
      set.headers["cache-control"] = "no-cache";
      return index();
    });
  } else if (clientDist) {
    console.warn(`client dist not found at ${clientDist} — serving /ws and /healthz only`);
  }

  return app;
}
