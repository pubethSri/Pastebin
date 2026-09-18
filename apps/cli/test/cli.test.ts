import { afterAll, describe, expect, test } from "bun:test";
import { MAX_BLOCK_CHARS, PROTOCOL_VERSION } from "@pastebin/protocol";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bound } from "../src/session";
import { createRoom, startServer, student, until, type Student } from "./harness";

const srv = startServer();
afterAll(() => srv.stop());

/** A teacher's browser, watching the room's first paper the way an open tab would. */
async function teacherWatching(): Promise<Bound & { paperId: string }> {
  const teacher = await createRoom(srv.server);
  const paperId = teacher.room.papers[0]!.id;
  teacher.conn.send({ type: "paper.open", payload: { paperId } });
  await teacher.conn.expect("paper.state");
  return { ...teacher, paperId };
}

const enter = (s: Student, code: string, ...extra: string[]) => s.run(["join", code, "--server", srv.server, ...extra]);

describe("join", () => {
  test("join, post from stdin, get: the round trip a student makes", async () => {
    const teacher = await teacherWatching();
    const s = student();
    try {
      const joined = await enter(s, teacher.code, "--name", "Ada");
      expect(joined.code).toBe(0);
      expect(joined.err).toContain(`Joined ${teacher.code} as Ada`);
      expect(joined.err).toContain('Posting to "Paper 1"');
      expect(joined.out).toBe("");

      const posted = await s.run(["post"], "bun install\n");
      expect(posted.code).toBe(0);
      expect(posted.err).toContain('Posted 12 characters to "Paper 1"');
      expect(posted.out).toBe("");

      // The paste is Ada's, as the browser sees it.
      const added = await teacher.conn.expect("block.added");
      expect(added.payload.block.authorName).toBe("Ada");
      expect(added.payload.block.text).toBe("bun install\n");
      expect(added.payload.block.filename).toBeNull();

      const got = await s.run(["get"]);
      expect(got.code).toBe(0);
      expect(got.out).toBe("bun install\n");
      expect(got.err).toBe("");
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });

  test("joining a room you are in resumes the same identity; --fresh mints a new one", async () => {
    const teacher = await createRoom(srv.server);
    const s = student();
    try {
      await enter(s, teacher.code, "--name", "Ada");
      const first = s.sessions().rooms[teacher.code]!.memberId;
      await teacher.conn.expect("room.state", (m) => m.payload.members.length === 2);

      // No --server this time: it is remembered.
      const again = await s.run(["join", teacher.code]);
      expect(again.code).toBe(0);
      expect(again.err).toContain(`Back in ${teacher.code} as Ada`);
      expect(s.sessions().rooms[teacher.code]!.memberId).toBe(first);
      // And the room never saw a third member.
      await expect(
        teacher.conn.expect("room.state", (m) => m.payload.members.length >= 3, 300),
      ).rejects.toThrow("no answer");

      const fresh = await s.run(["join", teacher.code, "--fresh", "--name", "Ada again"]);
      expect(fresh.code).toBe(0);
      expect(fresh.err).toContain("with a fresh identity");
      expect(s.sessions().rooms[teacher.code]!.memberId).not.toBe(first);
      await teacher.conn.expect("room.state", (m) => m.payload.members.length === 3);
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });

  test("the first join needs --server, and later rooms reuse it", async () => {
    const a = await createRoom(srv.server);
    const b = await createRoom(srv.server);
    const s = student();
    try {
      const bare = await s.run(["join", a.code]);
      expect(bare.code).toBe(2);
      expect(bare.err).toContain("--server is needed the first time");

      expect((await enter(s, a.code)).code).toBe(0);
      const second = await s.run(["join", b.code]);
      expect(second.code).toBe(0);
      expect(second.err).toContain(`Joined ${b.code}`);
      expect(s.sessions().current).toBe(b.code);
      expect(Object.keys(s.sessions().rooms).sort()).toEqual([a.code, b.code].sort());
    } finally {
      a.conn.close();
      b.conn.close();
      s.cleanup();
    }
  });

  test("a room that does not exist is a refusal that names the code", async () => {
    const s = student();
    try {
      const res = await enter(s, "zzzz");
      expect(res.code).toBe(1);
      expect(res.err).toContain("no room ZZZZ");
      expect(res.err).toContain("ROOM_NOT_FOUND");
    } finally {
      s.cleanup();
    }
  });

  test("an unreachable server is a sentence, not a stack trace", async () => {
    const s = student();
    try {
      const res = await s.run(["join", "ABCD", "--server", "http://127.0.0.1:9"]);
      expect(res.code).toBe(1);
      expect(res.err).toContain("could not reach http://127.0.0.1:9");
    } finally {
      s.cleanup();
    }
  });

  test("a bad code or a bad address is a usage error", async () => {
    const s = student();
    try {
      expect((await s.run(["join", "toolong"])).code).toBe(2);
      expect((await s.run(["join"])).code).toBe(2);
      const addr = await s.run(["join", "ABCD", "--server", "not a url"]);
      expect(addr.code).toBe(2);
      expect(addr.err).toContain("is not a server address");
    } finally {
      s.cleanup();
    }
  });
});

describe("post", () => {
  test("a file posts with its name as the label, decoded like a dropped file", async () => {
    const teacher = await teacherWatching();
    const s = student();
    const dir = mkdtempSync(join(tmpdir(), "pastebin-post-"));
    try {
      await enter(s, teacher.code);
      const path = join(dir, "hello.ts");
      // UTF-8 BOM and CRLF, as a Windows editor would save it.
      writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const a = 1;\r\nconst b = 2;\r\n")]));

      const res = await s.run(["post", path]);
      expect(res.code).toBe(0);
      expect(res.err).toContain("from hello.ts");

      const added = await teacher.conn.expect("block.added");
      expect(added.payload.block.filename).toBe("hello.ts");
      expect(added.payload.block.text).toBe("const a = 1;\nconst b = 2;\n");
    } finally {
      teacher.conn.close();
      s.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--as labels stdin, so a piped log still gets a filename", async () => {
    const teacher = await teacherWatching();
    const s = student();
    try {
      await enter(s, teacher.code);
      expect((await s.run(["post", "--as", "error.log"], "boom\n")).code).toBe(0);
      const added = await teacher.conn.expect("block.added");
      expect(added.payload.block.filename).toBe("error.log");
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });

  test("what the browser refuses, the CLI refuses, before it connects", async () => {
    const teacher = await createRoom(srv.server);
    const s = student();
    const dir = mkdtempSync(join(tmpdir(), "pastebin-post-"));
    try {
      await enter(s, teacher.code);

      const big = await s.run(["post"], "x".repeat(MAX_BLOCK_CHARS + 1));
      expect(big.code).toBe(1);
      expect(big.err).toContain("the cap is 100,000");

      const empty = await s.run(["post"], "");
      expect(empty.code).toBe(1);
      expect(empty.err).toContain("stdin is empty");

      const blank = await s.run(["post"], "  \n\n");
      expect(blank.code).toBe(1);
      expect(blank.err).toContain("nothing in it");

      const bin = join(dir, "photo.png");
      writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      const binary = await s.run(["post", bin]);
      expect(binary.code).toBe(1);
      expect(binary.err).toContain("isn't a text file");

      const missing = await s.run(["post", join(dir, "nope.txt")]);
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("no such file");
    } finally {
      teacher.conn.close();
      s.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--room posts somewhere other than the current room", async () => {
    const a = await teacherWatching();
    const b = await createRoom(srv.server);
    const s = student();
    try {
      await enter(s, a.code);
      await enter(s, b.code);
      expect(s.sessions().current).toBe(b.code);
      expect((await s.run(["post", "--room", a.code], "to a\n")).code).toBe(0);
      const added = await a.conn.expect("block.added");
      expect(added.payload.block.text).toBe("to a\n");
      expect(s.sessions().current).toBe(b.code);
    } finally {
      a.conn.close();
      b.conn.close();
      s.cleanup();
    }
  });
});

describe("get", () => {
  test("an empty paper is exit 1 with nothing on stdout", async () => {
    const teacher = await createRoom(srv.server);
    const s = student();
    try {
      await enter(s, teacher.code);
      const res = await s.run(["get"]);
      expect(res.code).toBe(1);
      expect(res.out).toBe("");
      expect(res.err).toContain("no text blocks yet");
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });

  test("a pipe gets the bytes exactly; a terminal gets a final newline", async () => {
    const teacher = await createRoom(srv.server);
    const piped = student();
    const tty = student({ tty: true });
    try {
      await enter(piped, teacher.code);
      await enter(tty, teacher.code);
      await piped.run(["post"], "no newline");
      expect((await piped.run(["get"])).out).toBe("no newline");
      expect((await tty.run(["get"])).out).toBe("no newline\n");
    } finally {
      teacher.conn.close();
      piped.cleanup();
      tty.cleanup();
    }
  });

  test("--last N prints the newest N, oldest first, one blank line apart", async () => {
    const teacher = await createRoom(srv.server);
    const s = student();
    try {
      await enter(s, teacher.code);
      for (const text of ["one\n\n\n", "two", "three\n"]) await s.run(["post"], text);
      expect((await s.run(["get", "--last", "2"])).out).toBe("two\n\nthree");
      expect((await s.run(["get", "--last", "9"])).out).toBe("one\n\ntwo\n\nthree");
      expect((await s.run(["get"])).out).toBe("three\n");
      const bad = await s.run(["get", "--last", "zero"]);
      expect(bad.code).toBe(2);
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });
});

describe("papers and use", () => {
  test("with two text papers a command has to be told, and use remembers", async () => {
    const teacher = await createRoom(srv.server);
    const s = student();
    try {
      await enter(s, teacher.code);
      teacher.conn.send({ type: "paper.create", payload: { title: "Notes" } });
      await teacher.conn.expect("room.state", (m) => m.payload.papers.length === 2);

      const undecided = await s.run(["post"], "where?\n");
      expect(undecided.code).toBe(1);
      expect(undecided.err).toContain("which paper?");
      expect(undecided.err).toContain("Notes");

      const list = await s.run(["papers"]);
      expect(list.code).toBe(0);
      expect(list.out).toBe("  Paper 1  text        0 blocks\n  Notes    text        0 blocks\n");

      const chosen = await s.run(["use", "notes"]);
      expect(chosen.code).toBe(0);
      expect(chosen.err).toContain('now go to "Notes"');
      expect((await s.run(["papers"])).out).toContain("* Notes");

      expect((await s.run(["post"], "here\n")).code).toBe(0);
      await teacher.conn.expect("room.state", (m) =>
        m.payload.papers.some((p) => p.title === "Notes" && p.blockCount === 1),
      );

      // --paper for one command only: a unique prefix is enough.
      expect((await s.run(["post", "--paper", "pap"], "and here\n")).code).toBe(0);
      await teacher.conn.expect("room.state", (m) =>
        m.payload.papers.some((p) => p.title === "Paper 1" && p.blockCount === 1),
      );
      expect(s.sessions().rooms[teacher.code]!.paperId).toBe(
        teacher.room.papers[0]!.id,
      );

      const nope = await s.run(["post", "--paper", "nope"], "x\n");
      expect(nope.code).toBe(1);
      expect(nope.err).toContain('no paper called "nope"');
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });

  test("a whiteboard is never a target", async () => {
    const teacher = await createRoom(srv.server);
    const s = student();
    try {
      await enter(s, teacher.code);
      teacher.conn.send({ type: "paper.create", payload: { title: "Sketch", kind: "draw" } });
      await teacher.conn.expect("room.state", (m) => m.payload.papers.length === 2);

      // Still exactly one text paper, so no --paper is needed.
      expect((await s.run(["post"], "text\n")).code).toBe(0);

      const board = await s.run(["use", "Sketch"]);
      expect(board.code).toBe(1);
      expect(board.err).toContain("is a whiteboard");
      expect((await s.run(["papers"])).out).toContain("Sketch   whiteboard  0 strokes");
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });
});

describe("tail", () => {
  test("prints what arrives after it started, headers on stderr, text on stdout", async () => {
    const teacher = await teacherWatching();
    const s = student();
    try {
      await enter(s, teacher.code);
      await s.run(["post"], "already here\n");

      const running = s.start(["tail"]);
      await until(() => running.err().includes("Watching"));
      expect(running.out()).toBe("");

      teacher.conn.send({ type: "block.post", payload: { paperId: teacher.paperId, text: "hello from the browser" } });
      await until(() => running.out().includes("hello from the browser"));
      expect(running.err()).toContain("-- Teacher at ");

      const added = await teacher.conn.expect("block.added", (m) => m.payload.block.text === "hello from the browser");
      teacher.conn.send({ type: "block.edit", payload: { blockId: added.payload.block.id, text: "hello again" } });
      await until(() => running.out().includes("hello again"));
      expect(running.err()).toContain("(edited)");

      running.interrupt();
      const res = await running.done;
      expect(res.code).toBe(0);
      expect(res.out).toBe("hello from the browser\nhello again\n");
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });

  test("ends, and forgets the identity, when the room is deleted", async () => {
    const teacher = await createRoom(srv.server);
    const s = student();
    try {
      await enter(s, teacher.code);
      const running = s.start(["tail"]);
      await until(() => running.err().includes("Watching"));

      teacher.conn.send({ type: "room.delete", payload: {} });
      const res = await running.done;
      expect(res.code).toBe(1);
      expect(res.err).toContain("The room was deleted.");
      expect(s.sessions().rooms[teacher.code]).toBeUndefined();
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });
});

describe("colour", () => {
  /*
   * The palette belongs to the server and rides on every block, so the only
   * thing worth asserting is that the CLI renders the colour it was handed and
   * never invents one — and, more importantly, that a redirect or a pipe gets
   * none of it. A log full of escape codes is worse than no colour at all.
   */
  const ESC = "\u001b";

  test("a terminal gets the member's own colour; a pipe gets plain text", async () => {
    const teacher = await createRoom(srv.server);
    const piped = student();
    const terminal = student({ stderrTty: true });
    try {
      const plain = await enter(piped, teacher.code, "--name", "Ada");
      expect(plain.err).toContain("as Ada (");
      expect(plain.err).not.toContain(ESC);

      const colored = await enter(terminal, teacher.code, "--name", "Ada");
      // Whatever colour this member was assigned, the name is wrapped in it.
      expect(colored.err).toMatch(/as \u001b\[38;2;\d+;\d+;\d+mAda\u001b\[39m /);
    } finally {
      teacher.conn.close();
      piped.cleanup();
      terminal.cleanup();
    }
  });

  test("NO_COLOR is honoured even on a terminal", async () => {
    const teacher = await createRoom(srv.server);
    const s = student({ stderrTty: true, env: { NO_COLOR: "1" } });
    try {
      const res = await enter(s, teacher.code, "--name", "Ada");
      expect(res.err).toContain("as Ada (");
      expect(res.err).not.toContain(ESC);
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });

  test("two people in a tail are two different colours, and stdout stays clean", async () => {
    const teacher = await teacherWatching();
    const watcher = student({ stderrTty: true });
    const poster = student();
    try {
      await enter(watcher, teacher.code, "--name", "Watcher");
      await enter(poster, teacher.code, "--name", "Poster");

      const running = watcher.start(["tail"]);
      await until(() => running.err().includes("Watching"));

      teacher.conn.send({ type: "block.post", payload: { paperId: teacher.paperId, text: "from the teacher" } });
      await until(() => running.out().includes("from the teacher"));
      await poster.run(["post"], "from the poster\n");
      await until(() => running.out().includes("from the poster"));

      running.interrupt();
      const res = await running.done;

      const colors = new Set(Array.from(res.err.matchAll(/\u001b\[38;2;(\d+;\d+;\d+)m/g), (m) => m[1]));
      expect(colors.size).toBe(2);
      // The whole point of splitting the streams: the text is still pasteable.
      expect(res.out).toBe("from the teacher\nfrom the poster\n");
      expect(res.out).not.toContain(ESC);
    } finally {
      teacher.conn.close();
      watcher.cleanup();
      poster.cleanup();
    }
  });
});

describe("an image in a tail", () => {
  /** The bytes go over HTTP exactly as the browser sends them; this only attaches the id. */
  async function postImage(teacher: Bound, paperId: string): Promise<void> {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0x20)]);
    const res = await fetch(`${srv.server}/api/upload?code=${teacher.code}&name=screenshot.png&w=1920&h=1080`, {
      method: "POST",
      headers: { "x-member-id": teacher.memberId, "x-member-token": teacher.token },
      body: png,
    });
    const media = (await res.json()) as { id: string };
    teacher.conn.send({ type: "block.postImage", payload: { paperId, mediaId: media.id } });
  }

  test("is described rather than rendered, with a link the terminal can open", async () => {
    const teacher = await teacherWatching();
    const s = student({ stderrTty: true });
    try {
      await enter(s, teacher.code);
      const running = s.start(["tail"]);
      await until(() => running.err().includes("Watching"));

      await postImage(teacher, teacher.paperId);
      await until(() => running.err().includes("posted an image"));

      running.interrupt();
      const res = await running.done;
      expect(res.err).toContain("screenshot.png");
      expect(res.err).toContain("1920x1080");
      expect(res.err).toContain("72 B");
      expect(res.err).toContain(`${srv.server}/media/`);
      // OSC 8, so Ctrl+Click opens it in a real browser.
      expect(res.err).toContain("\u001b]8;;");
      // An image is not pasteable text, so nothing about it reaches stdout.
      expect(res.out).toBe("");
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });

  test("piped, the URL is plain so it can be copied out of a log", async () => {
    const teacher = await teacherWatching();
    const s = student();
    try {
      await enter(s, teacher.code);
      const running = s.start(["tail"]);
      await until(() => running.err().includes("Watching"));

      await postImage(teacher, teacher.paperId);
      await until(() => running.err().includes("posted an image"));

      running.interrupt();
      const res = await running.done;
      expect(res.err).not.toContain("\u001b");
      expect(res.err).toMatch(new RegExp(`${srv.server.replace(/[.]/g, "\\.")}/media/[0-9a-f-]+`));
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });
});

describe("a dead identity", () => {
  test("is forgotten and the message says to join again", async () => {
    const teacher = await createRoom(srv.server);
    const s = student();
    try {
      await enter(s, teacher.code);
      teacher.conn.send({ type: "room.delete", payload: {} });
      await teacher.conn.expect("room.closed");

      const res = await s.run(["post"], "into the void\n");
      expect(res.code).toBe(1);
      expect(res.err).toContain(`your identity in ${teacher.code} is gone`);
      expect(res.err).toContain(`pastebin join ${teacher.code}`);
      expect(s.sessions().rooms[teacher.code]).toBeUndefined();
      expect((await s.run(["status"])).out).toContain("Not in a room");
    } finally {
      teacher.conn.close();
      s.cleanup();
    }
  });
});

describe("leave and status", () => {
  test("status reads the file; leave forgets one room and promotes another", async () => {
    const a = await createRoom(srv.server);
    const b = await createRoom(srv.server);
    const s = student();
    try {
      expect((await s.run(["status"])).out).toContain("Not in a room");
      await enter(s, a.code);
      await enter(s, b.code);

      const status = await s.run(["status"]);
      expect(status.out).toContain(`Room ${b.code} on ${srv.server}`);
      expect(status.out).toContain(`Other saved rooms: ${a.code}`);
      expect(status.out).toContain("Identities file:");

      const left = await s.run(["leave"]);
      expect(left.code).toBe(0);
      expect(left.err).toContain(`Forgot ${b.code}`);
      expect(s.sessions().current).toBe(a.code);

      const again = await s.run(["leave", b.code]);
      expect(again.code).toBe(1);
      expect(again.err).toContain("no saved identity");
    } finally {
      a.conn.close();
      b.conn.close();
      s.cleanup();
    }
  });
});

describe("usage", () => {
  test("help, version and mistakes", async () => {
    const s = student();
    try {
      const none = await s.run([]);
      expect(none.code).toBe(2);
      expect(none.err).toContain("Usage:");
      expect(none.out).toBe("");

      const help = await s.run(["--help"]);
      expect(help.code).toBe(0);
      expect(help.out).toContain("Usage:");

      const version = await s.run(["--version"]);
      expect(version.code).toBe(0);
      expect(version.out).toContain(`protocol v${PROTOCOL_VERSION}`);

      expect((await s.run(["frobnicate"])).code).toBe(2);
      const bogus = await s.run(["post", "--bogus"]);
      expect(bogus.code).toBe(2);
      expect(bogus.err).toContain("--help");

      const early = await s.run(["post"], "x");
      expect(early.code).toBe(2);
      expect(early.err).toContain("not in a room yet");
    } finally {
      s.cleanup();
    }
  });
});
