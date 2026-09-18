import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MAX_PAPERS_PER_ROOM } from "@pastebin/protocol";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { sniffImageMime } from "../src/imageType";
import { type Conn, Room, type Socket } from "../src/Room";
import { RoomManager } from "../src/RoomManager";
import { Store } from "../src/Store";

class FakeSocket implements Socket {
  sent: any[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  /** Most recent message of a type, which is what a client would be showing. */
  last(type: string): any {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].type === type) return this.sent[i];
    return undefined;
  }
  count(type: string): number {
    return this.sent.filter((m) => m.type === type).length;
  }
}

const openTemp = () => {
  const path = join(tmpdir(), `pastebin-test-${crypto.randomUUID()}.sqlite`);
  return { path, db: openDb(path) };
};

const removeTemp = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* never existed */
    }
  }
};

/** A room with `n` connected members, on a fresh in-memory database. */
function scenario(n = 2) {
  const db = openDb(":memory:");
  const store = new Store(db);
  const manager = new RoomManager(store);
  const room = manager.create();
  const paperId = room.firstPaperId();

  const members = Array.from({ length: n }, (_, i) => {
    const ws = new FakeSocket();
    const member = room.addMember(`Member ${i + 1}`);
    const conn = room.attach(ws, member.id);
    room.handleIntent(conn, { type: "paper.open", payload: { paperId } });
    return { ws, conn, id: member.id };
  });

  return { db, store, manager, room, paperId, members };
}

const post = (room: Room, conn: Conn, paperId: string, text: string) =>
  room.handleIntent(conn, { type: "block.post", payload: { paperId, text } });

describe("authorship", () => {
  test("the author can edit and delete their own paste", () => {
    const { room, paperId, members } = scenario(1);
    const [alice] = members;
    expect(post(room, alice!.conn, paperId, "bun install").ok).toBe(true);

    const blockId = alice!.ws.last("block.added").payload.block.id;
    expect(room.handleIntent(alice!.conn, { type: "block.edit", payload: { blockId, text: "bun install --frozen-lockfile" } }).ok).toBe(true);
    expect(alice!.ws.last("block.updated").payload.block.text).toBe("bun install --frozen-lockfile");
    expect(alice!.ws.last("block.updated").payload.block.editedAt).not.toBeNull();

    expect(room.handleIntent(alice!.conn, { type: "block.delete", payload: { blockId } }).ok).toBe(true);
    expect(alice!.ws.last("block.removed").payload.blockId).toBe(blockId);
  });

  // The rule the whole ownership model rests on. A client-side check would only
  // be a suggestion, so this asserts the server refuses.
  test("a non-author cannot edit or delete someone else's paste", () => {
    const { room, paperId, members } = scenario(2);
    const [alice, bob] = members;
    post(room, alice!.conn, paperId, "secret");
    const blockId = alice!.ws.last("block.added").payload.block.id;

    const edit = room.handleIntent(bob!.conn, { type: "block.edit", payload: { blockId, text: "vandalised" } });
    expect(edit).toEqual({ ok: false, code: "NOT_AUTHOR", message: "you can only change your own pastes" });

    const remove = room.handleIntent(bob!.conn, { type: "block.delete", payload: { blockId } });
    expect(remove.ok).toBe(false);

    // And nothing actually changed.
    expect(alice!.ws.last("block.added").payload.block.text).toBe("secret");
    expect(bob!.ws.count("block.updated")).toBe(0);
    expect(bob!.ws.count("block.removed")).toBe(0);
  });

  test("a paste from another room is not editable, even by its author", () => {
    const db = openDb(":memory:");
    const store = new Store(db);
    const manager = new RoomManager(store);

    const roomA = manager.create();
    const roomB = manager.create();
    const wsA = new FakeSocket();
    const alice = roomA.addMember("Alice");
    const connA = roomA.attach(wsA, alice.id);
    roomA.handleIntent(connA, { type: "paper.open", payload: { paperId: roomA.firstPaperId() } });
    post(roomA, connA, roomA.firstPaperId(), "mine");
    const blockId = wsA.last("block.added").payload.block.id;

    // Same member id, but reaching in through room B.
    const connB = roomB.attach(new FakeSocket(), alice.id);
    const result = roomB.handleIntent(connB, { type: "block.edit", payload: { blockId, text: "x" } });
    expect(result).toMatchObject({ ok: false, code: "BLOCK_NOT_FOUND" });
  });
});

describe("revisions and delivery", () => {
  test("every mutation bumps rev by exactly one", () => {
    const { room, paperId, members } = scenario(1);
    const [alice] = members;

    post(room, alice!.conn, paperId, "one");
    expect(alice!.ws.last("block.added").payload.rev).toBe(1);
    const blockId = alice!.ws.last("block.added").payload.block.id;

    post(room, alice!.conn, paperId, "two");
    expect(alice!.ws.last("block.added").payload.rev).toBe(2);

    room.handleIntent(alice!.conn, { type: "block.edit", payload: { blockId, text: "one!" } });
    expect(alice!.ws.last("block.updated").payload.rev).toBe(3);

    room.handleIntent(alice!.conn, { type: "block.delete", payload: { blockId } });
    expect(alice!.ws.last("block.removed").payload.rev).toBe(4);
  });

  test("a snapshot carries the paper's current rev, so deltas line up", () => {
    const { room, paperId, members } = scenario(2);
    const [alice, bob] = members;
    post(room, alice!.conn, paperId, "before bob looked");

    const ws = new FakeSocket();
    const late = room.addMember("Late");
    const conn = room.attach(ws, late.id);
    room.handleIntent(conn, { type: "paper.open", payload: { paperId } });

    const snapshot = ws.last("paper.state").payload;
    expect(snapshot.rev).toBe(1);
    expect(snapshot.blocks).toHaveLength(1);

    // The next delta is rev 2 — exactly one more than the snapshot, which is
    // what the client's gap check requires.
    post(room, bob!.conn, paperId, "after");
    expect(ws.last("block.added").payload.rev).toBe(2);
  });

  test("deltas only reach sockets that opened that paper", () => {
    const { store, room, paperId, members } = scenario(1);
    const [alice] = members;
    const other = store.createPaper(room.id, "Paper 2");

    const ws = new FakeSocket();
    const bob = room.addMember("Bob");
    const conn = room.attach(ws, bob.id);
    room.handleIntent(conn, { type: "paper.open", payload: { paperId: other.id } });

    post(room, alice!.conn, paperId, "only on paper 1");
    expect(ws.count("block.added")).toBe(0);
    // ...but the room summary still reaches everyone, so the picker stays live.
    expect(ws.last("room.state").payload.papers.find((p: any) => p.id === paperId).blockCount).toBe(1);
  });

  test("refresh is refused for a paper this socket has not opened", () => {
    const { store, room, members } = scenario(1);
    const other = store.createPaper(room.id, "Paper 2");
    const result = members[0]!.conn && room.handleIntent(members[0]!.conn, {
      type: "paper.refresh",
      payload: { paperId: other.id },
    });
    expect(result).toMatchObject({ ok: false, code: "PAPER_NOT_FOUND" });
  });
});

describe("papers", () => {
  test("a room is born with exactly one paper", () => {
    const { store, room } = scenario(0);
    expect(store.countPapers(room.id)).toBe(1);
    expect(store.listPaperSummaries(room.id)[0]!.title).toBe("Paper 1");
  });

  test("anyone in the room can add and rename a paper", () => {
    const { room, members, store } = scenario(2);
    expect(room.handleIntent(members[1]!.conn, { type: "paper.create", payload: { title: "Scratch" } }).ok).toBe(true);
    expect(store.countPapers(room.id)).toBe(2);

    const created = store.listPaperSummaries(room.id).find((p) => p.title === "Scratch")!;
    expect(room.handleIntent(members[0]!.conn, { type: "paper.rename", payload: { paperId: created.id, title: "Notes" } }).ok).toBe(true);
    expect(store.paper(created.id)!.title).toBe("Notes");
  });

  // A room always has somewhere to paste; without this the picker could be
  // entered with nothing in it and no way back to a working state.
  test("the last paper cannot be deleted", () => {
    const { room, members, paperId } = scenario(1);
    expect(room.handleIntent(members[0]!.conn, { type: "paper.delete", payload: { paperId } })).toMatchObject({
      ok: false,
      code: "LAST_PAPER",
    });
  });

  test("deleting a paper takes its blocks and unhooks its viewers", () => {
    const { room, store, members, paperId } = scenario(1);
    const [alice] = members;
    post(room, alice!.conn, paperId, "goes away with the paper");
    room.handleIntent(alice!.conn, { type: "paper.create", payload: { title: "Keeper" } });

    expect(alice!.conn.paperId).toBe(paperId);
    expect(room.handleIntent(alice!.conn, { type: "paper.delete", payload: { paperId } }).ok).toBe(true);

    // The socket is no longer watching a paper that doesn't exist, so a later
    // delta can't be routed at it.
    expect(alice!.conn.paperId).toBeNull();
    expect(store.countPapers(room.id)).toBe(1);
    expect(store.listBlocks(paperId)).toHaveLength(0);
  });

  test("paper.close stops the deltas", () => {
    const { room, members, paperId } = scenario(2);
    const [alice, bob] = members;
    expect(room.handleIntent(bob!.conn, { type: "paper.close", payload: {} }).ok).toBe(true);

    const before = bob!.ws.count("block.added");
    post(room, alice!.conn, paperId, "bob is on the picker");
    expect(bob!.ws.count("block.added")).toBe(before);
    // The room summary still reaches them, so the picker stays live.
    expect(bob!.ws.last("room.state").payload.papers[0].blockCount).toBe(1);
  });

  test("a paper from another room cannot be renamed or deleted", () => {
    const db = openDb(":memory:");
    const manager = new RoomManager(new Store(db));
    const roomA = manager.create();
    const roomB = manager.create();
    const conn = roomB.attach(new FakeSocket(), roomB.addMember("Mallory").id);

    expect(roomB.handleIntent(conn, { type: "paper.rename", payload: { paperId: roomA.firstPaperId(), title: "hi" } })).toMatchObject({ ok: false, code: "PAPER_NOT_FOUND" });
    expect(roomB.handleIntent(conn, { type: "paper.delete", payload: { paperId: roomA.firstPaperId() } })).toMatchObject({ ok: false, code: "PAPER_NOT_FOUND" });
  });

  test("the paper cap is enforced", () => {
    const { room, members } = scenario(1);
    const conn = members[0]!.conn;
    for (let i = 1; i < MAX_PAPERS_PER_ROOM; i++) {
      expect(room.handleIntent(conn, { type: "paper.create", payload: { title: `P${i}` } }).ok).toBe(true);
    }
    expect(room.handleIntent(conn, { type: "paper.create", payload: { title: "one too many" } })).toMatchObject({
      ok: false,
      code: "TOO_MANY_PAPERS",
    });
  });
});

describe("images", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  test("magic bytes decide the type, not the client's claim", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]))).toBe("image/gif");
    expect(
      sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
  });

  test("non-images and truncated files are refused", () => {
    // An HTML file renamed to .png is the case that matters: served back with a
    // client-supplied content type it would be a stored XSS on our own origin.
    expect(sniffImageMime(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });

  test("an image block carries its media and no text", () => {
    const { room, store, members, paperId } = scenario(1);
    const [alice] = members;
    const media = store.addMedia(room.id, { mime: "image/png", width: 800, height: 600, name: "shot.png", data: PNG });

    expect(room.handleIntent(alice!.conn, { type: "block.postImage", payload: { paperId, mediaId: media.id } }).ok).toBe(true);

    const block = alice!.ws.last("block.added").payload.block;
    expect(block.kind).toBe("image");
    expect(block.text).toBe("");
    expect(block.media).toMatchObject({ id: media.id, mime: "image/png", width: 800, height: 600, byteSize: PNG.length });
  });

  test("media from another room cannot be attached", () => {
    const db = openDb(":memory:");
    const store = new Store(db);
    const manager = new RoomManager(store);
    const roomA = manager.create();
    const roomB = manager.create();
    const stolen = store.addMedia(roomA.id, { mime: "image/png", width: null, height: null, name: null, data: PNG });

    const conn = roomB.attach(new FakeSocket(), roomB.addMember("Mallory").id);
    expect(
      roomB.handleIntent(conn, { type: "block.postImage", payload: { paperId: roomB.firstPaperId(), mediaId: stolen.id } }),
    ).toMatchObject({ ok: false, code: "MEDIA_NOT_FOUND" });
  });

  test("an unknown media id is refused", () => {
    const { room, members, paperId } = scenario(1);
    expect(
      room.handleIntent(members[0]!.conn, { type: "block.postImage", payload: { paperId, mediaId: "nope" } }),
    ).toMatchObject({ ok: false, code: "MEDIA_NOT_FOUND" });
  });

  test("an image block has no text to edit", () => {
    const { room, store, members, paperId } = scenario(1);
    const [alice] = members;
    const media = store.addMedia(room.id, { mime: "image/gif", width: null, height: null, name: null, data: PNG });
    room.handleIntent(alice!.conn, { type: "block.postImage", payload: { paperId, mediaId: media.id } });
    const blockId = alice!.ws.last("block.added").payload.block.id;

    expect(room.handleIntent(alice!.conn, { type: "block.edit", payload: { blockId, text: "nope" } }).ok).toBe(false);
    // ...but the author can still delete it.
    expect(room.handleIntent(alice!.conn, { type: "block.delete", payload: { blockId } }).ok).toBe(true);
  });

  test("the picker preview says [image] rather than going blank", () => {
    const { room, store, members, paperId } = scenario(1);
    const media = store.addMedia(room.id, { mime: "image/png", width: null, height: null, name: null, data: PNG });
    room.handleIntent(members[0]!.conn, { type: "block.postImage", payload: { paperId, mediaId: media.id } });
    expect(store.listPaperSummaries(room.id)[0]!.preview).toBe("[image]");
  });

  test("deleting a room reclaims its uploads", () => {
    const db = openDb(":memory:");
    const store = new Store(db);
    const manager = new RoomManager(store);
    const room = manager.create();
    store.addMedia(room.id, { mime: "image/png", width: null, height: null, name: null, data: PNG });

    db.query("UPDATE rooms SET touched_at = ? WHERE code = ?").run(Date.now() - 40 * 86_400_000, room.code);
    store.sweepIdleRooms(30 * 86_400_000);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media").get()!.n).toBe(0);
  });
});

describe("dropped files", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  test("a filename reaches the broadcast and survives into a later snapshot", () => {
    const { room, paperId, members } = scenario(2);
    const [alice, bob] = members;
    room.handleIntent(alice!.conn, {
      type: "block.post",
      payload: { paperId, text: "export const x = 1;\n", filename: "constants.ts" },
    });

    // The delta everyone in the paper gets…
    expect(bob!.ws.last("block.added").payload.block.filename).toBe("constants.ts");

    // …and the snapshot a phone gets when it wakes up and reopens the paper.
    room.handleIntent(bob!.conn, { type: "paper.refresh", payload: { paperId } });
    const [block] = bob!.ws.last("paper.state").payload.blocks;
    expect(block.filename).toBe("constants.ts");
    expect(block.text).toBe("export const x = 1;\n");
  });

  test("a typed paste has no filename", () => {
    const { room, paperId, members } = scenario(1);
    post(room, members[0]!.conn, paperId, "bun install");
    expect(members[0]!.ws.last("block.added").payload.block.filename).toBeNull();
  });

  test("an image block carries no filename — the media row already holds its name", () => {
    const { room, store, paperId, members } = scenario(1);
    const media = store.addMedia(room.id, {
      mime: "image/png",
      width: null,
      height: null,
      name: "shot.png",
      data: PNG,
    });
    room.handleIntent(members[0]!.conn, { type: "block.postImage", payload: { paperId, mediaId: media.id } });

    const block = members[0]!.ws.last("block.added").payload.block;
    expect(block.filename).toBeNull();
    expect(block.media.name).toBe("shot.png");
  });

  test("editing a dropped file keeps its label — it is still that file", () => {
    const { room, paperId, members } = scenario(1);
    const [alice] = members;
    room.handleIntent(alice!.conn, {
      type: "block.post",
      payload: { paperId, text: "old", filename: "notes.md" },
    });
    const blockId = alice!.ws.last("block.added").payload.block.id;

    room.handleIntent(alice!.conn, { type: "block.edit", payload: { blockId, text: "new" } });
    expect(alice!.ws.last("block.updated").payload.block.filename).toBe("notes.md");
  });
});

describe("whiteboards", () => {
  const stroke = (x = 10, y = 20) => ({ w: 3, e: 0 as const, p: [x, y, x + 40, y + 40] });

  /** A room with a draw paper open on every member's socket. */
  function board(n = 2) {
    const s = scenario(n);
    s.room.handleIntent(s.members[0]!.conn, { type: "paper.create", payload: { title: "Board", kind: "draw" } });
    const drawId = s.store.listPaperSummaries(s.room.id).find((p) => p.kind === "draw")!.id;
    for (const m of s.members) s.room.handleIntent(m.conn, { type: "paper.open", payload: { paperId: drawId } });
    return { ...s, drawId };
  }

  const draw = (room: Room, conn: Conn, paperId: string, s = stroke()) =>
    room.handleIntent(conn, { type: "block.postStroke", payload: { paperId, stroke: s } });

  test("a stroke reaches everyone and survives into a later snapshot", () => {
    const { room, drawId, members } = board(2);
    const [alice, bob] = members;
    expect(draw(room, alice!.conn, drawId).ok).toBe(true);

    const block = bob!.ws.last("block.added").payload.block;
    expect(block.kind).toBe("stroke");
    // Colour is never stored on the stroke — it rides on the block, so a board
    // shows who drew what without anyone being able to claim a colour.
    expect(block.authorColor).toBeTruthy();
    expect(JSON.parse(block.text)).toEqual(stroke());

    room.handleIntent(bob!.conn, { type: "paper.refresh", payload: { paperId: drawId } });
    expect(bob!.ws.last("paper.state").payload.blocks).toHaveLength(1);
  });

  /*
   * The rule the whole "clear mine" design rests on. The query is scoped by
   * member id, so this is structural rather than a check that could be skipped.
   */
  test("clearing takes only your own strokes", () => {
    const { room, drawId, members, store } = board(2);
    const [alice, bob] = members;
    draw(room, alice!.conn, drawId);
    draw(room, alice!.conn, drawId, stroke(100, 100));
    draw(room, bob!.conn, drawId, stroke(200, 200));
    expect(store.countBlocks(drawId)).toBe(3);

    expect(room.handleIntent(alice!.conn, { type: "paper.clearMine", payload: { paperId: drawId } }).ok).toBe(true);

    const left = store.listBlocks(drawId);
    expect(left).toHaveLength(1);
    expect(left[0]!.authorId).toBe(bob!.id);
  });

  test("the clear is announced by author, not by listing every block", () => {
    const { room, drawId, members } = board(2);
    const [alice, bob] = members;
    for (let i = 0; i < 5; i++) draw(room, alice!.conn, drawId, stroke(i * 10, i * 10));

    room.handleIntent(alice!.conn, { type: "paper.clearMine", payload: { paperId: drawId } });
    expect(bob!.ws.last("blocks.cleared").payload.authorId).toBe(alice!.id);
  });

  test("rev moves exactly once however many strokes went", () => {
    const { room, drawId, members, store } = board(1);
    const [alice] = members;
    for (let i = 0; i < 8; i++) draw(room, alice!.conn, drawId, stroke(i * 10, i * 10));
    const before = store.paper(drawId)!.rev;

    room.handleIntent(alice!.conn, { type: "paper.clearMine", payload: { paperId: drawId } });
    expect(store.paper(drawId)!.rev).toBe(before + 1);
  });

  /*
   * Clearing nothing still moves the rev, so the delta still has to go out —
   * a client that never saw it would spend the rest of the session chasing a
   * gap it can't close.
   */
  test("clearing nothing still tells everyone, so no client is left chasing a gap", () => {
    const { room, drawId, members, store } = board(2);
    const [alice, bob] = members;
    draw(room, bob!.conn, drawId);

    room.handleIntent(alice!.conn, { type: "paper.clearMine", payload: { paperId: drawId } });
    const cleared = alice!.ws.last("blocks.cleared");
    expect(cleared.payload.rev).toBe(store.paper(drawId)!.rev);
    expect(store.countBlocks(drawId)).toBe(1);
  });

  test("a paste cannot land on a whiteboard, and a stroke cannot land on a paper", () => {
    const { room, drawId, paperId, members } = board(1);
    const conn = members[0]!.conn;

    expect(room.handleIntent(conn, { type: "block.post", payload: { paperId: drawId, text: "hi" } })).toMatchObject({
      ok: false,
      code: "WRONG_PAPER_KIND",
    });
    expect(draw(room, conn, paperId)).toMatchObject({ ok: false, code: "WRONG_PAPER_KIND" });
  });

  test("a stroke has no text to edit", () => {
    const { room, drawId, members } = board(1);
    const [alice] = members;
    draw(room, alice!.conn, drawId);
    const blockId = alice!.ws.last("block.added").payload.block.id;

    expect(
      room.handleIntent(alice!.conn, { type: "block.edit", payload: { blockId, text: "vandalised" } }),
    ).toMatchObject({ ok: false, code: "BAD_MESSAGE" });
  });

  test("a single stroke is still author-owned, so nobody else can delete it", () => {
    const { room, drawId, members } = board(2);
    const [alice, bob] = members;
    draw(room, alice!.conn, drawId);
    const blockId = alice!.ws.last("block.added").payload.block.id;

    expect(room.handleIntent(bob!.conn, { type: "block.delete", payload: { blockId } })).toMatchObject({
      ok: false,
      code: "NOT_AUTHOR",
    });
  });

  test("papers default to text, so nothing that existed before becomes a board", () => {
    const { room, store, members } = scenario(1);
    room.handleIntent(members[0]!.conn, { type: "paper.create", payload: { title: "Plain" } });
    expect(store.listPaperSummaries(room.id).every((p) => p.kind === "text")).toBe(true);
  });
});

describe("limits and identity", () => {
  test("an oversized paste is TOO_LARGE, not a parse failure", () => {
    const { room, paperId, members } = scenario(1);
    const result = post(room, members[0]!.conn, paperId, "x".repeat(100_001));
    expect(result).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  test("members get distinct colours in join order", () => {
    const { room } = scenario(0);
    const colors = Array.from({ length: 5 }, (_, i) => room.addMember(`M${i}`).color);
    expect(new Set(colors).size).toBe(5);
  });

  test("presence is live, membership is not", () => {
    const { room, members } = scenario(2);
    const [alice, bob] = members;
    expect(room.publicState().members.every((m) => m.connected)).toBe(true);

    room.detach(bob!.conn);
    const state = room.publicState();
    expect(state.members).toHaveLength(2); // still a member
    expect(state.members.find((m) => m.id === bob!.id)!.connected).toBe(false);
    expect(state.members.find((m) => m.id === alice!.id)!.connected).toBe(true);
  });

  test("resume needs the right token", () => {
    const { room } = scenario(0);
    const member = room.addMember("Alice");
    expect(room.resume(member.id, member.token)?.id).toBe(member.id);
    expect(room.resume(member.id, "guessed")).toBeNull();
    expect(room.resume("nobody", member.token)).toBeNull();
  });

  test("renaming does not rewrite pastes already posted", () => {
    const { room, paperId, members } = scenario(1);
    const [alice] = members;
    post(room, alice!.conn, paperId, "posted as Member 1");

    room.handleIntent(alice!.conn, { type: "member.rename", payload: { name: "Ryu" } });
    expect(room.publicState().members[0]!.name).toBe("Ryu");
    // The block keeps the name it was posted under — that is what the snapshot
    // on the block row is for.
    expect(alice!.ws.last("block.added").payload.block.authorName).toBe("Member 1");
  });
});

describe("room lifetime", () => {
  const GRACE = 5 * 60 * 1000;
  const backdate = (db: Database, code: string, ms: number) =>
    db.query("UPDATE rooms SET emptied_at = ? WHERE code = ?").run(Date.now() - ms, code);

  test("a room with anyone connected is never swept, however short the grace", () => {
    const { store, room } = scenario(1); // one attached socket
    expect(store.roomByCode(room.code)!.emptied_at).toBeNull();
    // Even a zero grace cannot reach it: the sweep matches only rooms that have
    // a recorded empty time, and occupancy is what clears that.
    expect(store.sweepExpiredRooms(0)).toEqual([]);
    expect(store.roomByCode(room.code)).not.toBeNull();
  });

  test("the clock starts when the last socket leaves and stops when one returns", () => {
    const { db, store, room, members } = scenario(2);
    const [alice, bob] = members;

    room.detach(alice!.conn);
    // Bob is still in, so the room is not empty yet.
    expect(store.roomByCode(room.code)!.emptied_at).toBeNull();

    room.detach(bob!.conn);
    expect(store.roomByCode(room.code)!.emptied_at).not.toBeNull();

    // Someone comes back before the grace runs out.
    backdate(db, room.code, GRACE - 1000);
    room.attach(new FakeSocket(), alice!.id);
    expect(store.roomByCode(room.code)!.emptied_at).toBeNull();
    expect(store.sweepExpiredRooms(GRACE)).toEqual([]);
  });

  test("an empty room is deleted once the grace has passed", () => {
    const { db, store, room, members, paperId } = scenario(1);
    post(room, members[0]!.conn, paperId, "gone in five minutes");
    room.detach(members[0]!.conn);

    // Still inside the grace period.
    expect(store.sweepExpiredRooms(GRACE)).toEqual([]);
    expect(store.roomByCode(room.code)).not.toBeNull();

    backdate(db, room.code, GRACE + 1000);
    expect(store.sweepExpiredRooms(GRACE)).toEqual([room.code]);
    expect(store.roomByCode(room.code)).toBeNull();
    expect(store.listBlocks(paperId)).toHaveLength(0);
  });

  test("a fresh room is born empty, so an abandoned create still expires", () => {
    const db = openDb(":memory:");
    const store = new Store(db);
    const room = new RoomManager(store).create(); // nobody ever attaches
    expect(store.roomByCode(room.code)!.emptied_at).not.toBeNull();
    backdate(db, room.code, GRACE + 1000);
    expect(store.sweepExpiredRooms(GRACE)).toEqual([room.code]);
  });

  /*
   * The restart case. Every socket is gone when the process comes back, so
   * every room is empty — but stamping *now* hands everyone the full grace
   * period to reconnect, rather than deleting rooms the instant the server
   * restarts mid-session.
   */
  test("a restart re-stamps occupied rooms instead of destroying them", () => {
    const { db, store, room } = scenario(1);
    expect(store.roomByCode(room.code)!.emptied_at).toBeNull();

    store.markAllRoomsEmpty(); // what boot does
    expect(store.roomByCode(room.code)!.emptied_at).not.toBeNull();
    // Not swept — the clock only just started.
    expect(store.sweepExpiredRooms(GRACE)).toEqual([]);
    expect(store.roomByCode(room.code)).not.toBeNull();
  });

  test("a room already empty before the restart keeps its original deadline", () => {
    const { db, store, room, members } = scenario(1);
    room.detach(members[0]!.conn);
    backdate(db, room.code, GRACE + 1000);
    const before = store.roomByCode(room.code)!.emptied_at;

    store.markAllRoomsEmpty();
    // Untouched, because it was not NULL — so it expires on its own schedule
    // rather than being handed a fresh grace period by the restart.
    expect(store.roomByCode(room.code)!.emptied_at).toBe(before);
    expect(store.sweepExpiredRooms(GRACE)).toEqual([room.code]);
  });
});

describe("deleting a room", () => {
  test("everyone is told before the rows go", () => {
    const { room, members } = scenario(2);
    const [alice, bob] = members;
    expect(room.handleIntent(alice!.conn, { type: "room.delete", payload: {} }).ok).toBe(true);

    for (const m of [alice, bob]) {
      expect(m!.ws.last("room.closed")).toEqual({ type: "room.closed", payload: { reason: "deleted" } });
    }
  });

  test("it takes the papers, blocks and uploads with it", () => {
    const { db, store, room, members, paperId } = scenario(1);
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    post(room, members[0]!.conn, paperId, "bye");
    store.addMedia(room.id, { mime: "image/png", width: null, height: null, name: null, data: PNG });

    room.handleIntent(members[0]!.conn, { type: "room.delete", payload: {} });

    expect(store.roomByCode(room.code)).toBeNull();
    expect(store.listBlocks(paperId)).toHaveLength(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM papers").get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM members").get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media").get()!.n).toBe(0);
  });

  test("the manager stops handing out the deleted room", () => {
    const db = openDb(":memory:");
    const manager = new RoomManager(new Store(db));
    const room = manager.create();
    const conn = room.attach(new FakeSocket(), room.addMember("Alice").id);

    room.handleIntent(conn, { type: "room.delete", payload: {} });
    // Not from the cache, and not rebuilt from the database either.
    expect(manager.get(room.code)).toBeUndefined();
  });

  test("any member can delete — there is no host tier here", () => {
    const { room, members } = scenario(3);
    // The third to join, not the creator.
    expect(room.handleIntent(members[2]!.conn, { type: "room.delete", payload: {} }).ok).toBe(true);
  });
});

describe("persistence", () => {
  let cleanup: string | null = null;
  afterEach(() => {
    if (cleanup) removeTemp(cleanup);
    cleanup = null;
  });

  // The inversion of YAWBG's trade-off, asserted: live state is on disk, so a
  // restart costs you the sockets and nothing else.
  test("a room, its members and its pastes survive reopening the database", () => {
    const { path, db } = openTemp();
    cleanup = path;

    let code: string;
    let memberId: string;
    let token: string;
    {
      const room = new RoomManager(new Store(db)).create();
      code = room.code;
      const alice = room.addMember("Alice");
      memberId = alice.id;
      token = alice.token;
      const conn = room.attach(new FakeSocket(), alice.id);
      const paperId = room.firstPaperId();
      room.handleIntent(conn, { type: "paper.open", payload: { paperId } });
      post(room, conn, paperId, "ssh root@192.168.1.40");
      db.close();
    }

    // A completely new process's worth of state.
    const reopened: Database = openDb(path);
    const store = new Store(reopened);
    const room = new RoomManager(store).get(code);
    expect(room).toBeDefined();

    const member = room!.resume(memberId, token);
    expect(member?.name).toBe("Alice");

    const blocks = store.listBlocks(room!.firstPaperId());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe("ssh root@192.168.1.40");
    expect(blocks[0]!.authorId).toBe(memberId);
    reopened.close();
  });

  test("an empty room is evicted from memory but keeps its data", () => {
    const db = openDb(":memory:");
    const store = new Store(db);
    const manager = new RoomManager(store);
    const room = manager.create();
    const alice = room.addMember("Alice");
    const conn = room.attach(new FakeSocket(), alice.id);
    room.handleIntent(conn, { type: "paper.open", payload: { paperId: room.firstPaperId() } });
    post(room, conn, room.firstPaperId(), "still here");

    room.detach(conn);
    manager.evictIfEmpty(room.code);

    // A brand-new Room object over the same rows — the eviction freed sockets,
    // not content. This is exactly where YAWBG deletes the room instead.
    const again = manager.get(room.code)!;
    expect(store.listBlocks(again.firstPaperId())[0]!.text).toBe("still here");
  });

  test("the sweeper takes idle rooms and leaves fresh ones", () => {
    const db = openDb(":memory:");
    const store = new Store(db);
    const manager = new RoomManager(store);
    const stale = manager.create();
    const fresh = manager.create();

    // Backdate one room past the TTL.
    db.query("UPDATE rooms SET touched_at = ? WHERE code = ?").run(Date.now() - 40 * 86_400_000, stale.code);
    expect(store.sweepIdleRooms(30 * 86_400_000)).toBe(1);

    expect(store.roomByCode(stale.code)).toBeNull();
    expect(store.roomByCode(fresh.code)).not.toBeNull();
  });
});
