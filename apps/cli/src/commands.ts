import {
  cliBuildFor,
  cliDownloadCommand,
  MemberNameSchema,
  PROTOCOL_VERSION,
  RoomCodeSchema,
  type Block,
  type PaperState,
  type PaperSummary,
  type PublicRoomState,
} from "@pastebin/protocol";
import { basename } from "node:path";
import { parseInvocation, type Flags } from "./args";
import { Sessions, type RoomSession } from "./config";
import { Connection, normalizeServer } from "./connection";
import { CliError, IdentityGone, ServerRefused, UsageError } from "./errors";
import { suggestName } from "./names";
import { formatPapers, resolvePaper } from "./papers";
import { joinRoom, resumeSession, type Bound } from "./session";
import { fmt, readFileText, shortName, textFromBytes } from "./text";

export const CLI_VERSION = "0.1.0";

/**
 * Everything a command touches outside its arguments, so the whole CLI can run
 * in-process under test with strings for streams and a promise for Ctrl+C.
 */
export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  readStdin(): Promise<Uint8Array>;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  /** Resolves when the user asks to stop. Only `tail` asks for it, so only `tail` swallows Ctrl+C. */
  interrupted(): Promise<void>;
}

export const USAGE = `pastebin -- paste text into a Pastebin room from the command line

Usage:
  pastebin join <CODE> [--server <URL>] [--name <NAME>] [--fresh]
  pastebin post [FILE] [--paper <TITLE>] [--as <FILENAME>]
  pastebin get [--last <N>] [--paper <TITLE>]
  pastebin tail [--paper <TITLE>]
  pastebin papers
  pastebin use <TITLE>
  pastebin leave [CODE]
  pastebin status

Commands:
  join     Enter a room. Needs --server the first time, e.g. http://192.168.1.5:3000.
           Joining a room you are already in resumes your identity; --fresh makes a new one.
  post     Post FILE, or stdin when there is no FILE:   cat error.log | pastebin post
  get      Print the newest text block to stdout. --last 3 prints the newest three.
  tail     Print new blocks as they arrive, until Ctrl+C.
  papers   List the room's papers. * marks where post, get and tail go.
  use      Make that paper the one post, get and tail go to.
  leave    Forget your identity in a room. The room itself is untouched.
  status   Show the current room and where identities are stored.

Options:
  --room <CODE>   Act on a saved room other than the current one.
  --version, --help

Text goes to stdout and everything else to stderr, so "pastebin get > file"
and "pastebin get | clip" stay clean. Exit codes: 0 ok, 1 refused or
unreachable, 2 usage.
`;

/* ------------------------------ entry point ------------------------------ */

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const inv = parseInvocation(argv);
    if (inv.flags.version) {
      io.stdout(`pastebin ${CLI_VERSION} (protocol v${PROTOCOL_VERSION})\n`);
      return 0;
    }
    if (inv.flags.help || inv.command === "help") {
      io.stdout(USAGE);
      return 0;
    }
    if (inv.command === null) {
      io.stderr(USAGE);
      return 2;
    }
    switch (inv.command) {
      case "join":
        return await join(io, inv.positional, inv.flags);
      case "post":
        return await post(io, inv.positional, inv.flags);
      case "get":
        return await get(io, inv.flags);
      case "tail":
        return await tail(io, inv.flags);
      case "papers":
        return await papers(io, inv.flags);
      case "use":
        return await use(io, inv.positional, inv.flags);
      case "leave":
        return await leave(io, inv.positional);
      case "status":
        return await status(io);
      default:
        throw new UsageError(`unknown command "${inv.command}"`);
    }
  } catch (e) {
    return report(e, io);
  }
}

function report(e: unknown, io: Io): number {
  if (e instanceof UsageError) {
    io.stderr(`pastebin: ${e.message}\nRun "pastebin --help" for usage.\n`);
    return 2;
  }
  if (e instanceof ServerRefused && e.code === "VERSION_MISMATCH") {
    // The server's own wording says "reload the page". Ours says what a
    // terminal can do about it, for the exact server that refused us.
    const build = cliBuildFor(io.platform, io.arch);
    const how = build ? cliDownloadCommand(e.server, build) : `${e.server}/cli/`;
    io.stderr(
      `pastebin: this build is out of date -- it speaks protocol v${PROTOCOL_VERSION} and the server does not.\n` +
        `Download the current one:\n  ${how}\n`,
    );
    return 1;
  }
  if (e instanceof ServerRefused) {
    io.stderr(`pastebin: ${e.message} (${e.code})\n`);
    return 1;
  }
  if (e instanceof CliError) {
    io.stderr(`pastebin: ${e.message}\n`);
    return 1;
  }
  io.stderr(`pastebin: ${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
}

/* -------------------------------- helpers -------------------------------- */

function parseCode(raw: string | undefined): string {
  if (!raw) throw new UsageError("missing room code -- e.g. pastebin join ABCD");
  const result = RoomCodeSchema.safeParse(raw);
  if (!result.success) throw new UsageError(`"${raw}" is not a room code -- codes are four letters, like ABCD`);
  return result.data;
}

/** The room a command acts on: `--room`, else the current one. */
function requireRoom(sessions: Sessions, flags: Flags): { code: string; session: RoomSession } {
  const code = flags.room ? parseCode(flags.room) : sessions.current;
  if (!code) throw new UsageError("not in a room yet -- run: pastebin join <CODE> --server <URL>");
  const session = sessions.room(code);
  if (!session) throw new CliError(`no saved identity for ${code} -- run: pastebin join ${code}`);
  return { code, session };
}

/**
 * Resume, or forget a dead identity and say so. The browser does the same in
 * `socket.svelte.ts`: a stored identity the server no longer knows is dropped
 * rather than retried, and the next `join` starts fresh.
 */
async function resumeOrForget(sessions: Sessions, code: string, session: RoomSession): Promise<Bound> {
  try {
    return await resumeSession(session.server, code, session);
  } catch (e) {
    if (e instanceof ServerRefused && (e.code === "SESSION_INVALID" || e.code === "ROOM_NOT_FOUND")) {
      sessions.drop(code);
      await sessions.save();
      throw new IdentityGone(
        `your identity in ${code} is gone -- the room was deleted or expired. Run "pastebin join ${code}" to enter it again.`,
      );
    }
    throw e;
  }
}

function pickPaper(room: PublicRoomState, preferredId: string | null, wanted: string | undefined): PaperSummary {
  const result = resolvePaper(room.papers, preferredId, wanted);
  if (!result.ok) throw new CliError(result.message);
  return result.paper;
}

/**
 * Subscribes to a paper and returns its snapshot. Every command that touches
 * blocks opens the paper first, even `post`: the server only echoes
 * `block.added` to sockets watching that paper, and that echo is how `post`
 * knows the paste landed before it exits.
 */
async function openPaper(conn: Connection, paperId: string): Promise<PaperState> {
  conn.send({ type: "paper.open", payload: { paperId } });
  const state = await conn.expect("paper.state", (m) => m.payload.paperId === paperId);
  return state.payload;
}

function describePapers(room: PublicRoomState, session: RoomSession): string {
  const texts = room.papers.filter((p) => p.kind === "text");
  const pick = resolvePaper(room.papers, session.paperId, undefined);
  if (pick.ok) {
    const hint = texts.length > 1 ? " -- change it with: pastebin use <title>" : "";
    return `Posting to "${pick.paper.title}"${hint}\n`;
  }
  return `${texts.length} text papers here -- pick one with: pastebin use <title>\n`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------- commands -------------------------------- */

async function join(io: Io, positional: string[], flags: Flags): Promise<number> {
  const code = parseCode(positional[0]);
  const sessions = await Sessions.load(io.env);
  const existing = sessions.room(code);

  // Already in: resume rather than join. Every `room.join` mints a new member,
  // and rooms cap at 32, so a student re-running the line they were given
  // must not leave a trail of ghosts.
  if (existing && !flags.fresh) {
    const server = flags.server ? normalizeServer(flags.server) : existing.server;
    const bound = await resumeOrForget(sessions, code, { ...existing, server });
    try {
      sessions.update(code, { server });
      sessions.setCurrent(code);
      await sessions.save();
      io.stderr(`Back in ${code} as ${bound.name} (${server})\n${describePapers(bound.room, sessions.room(code)!)}`);
    } finally {
      bound.conn.close();
    }
    return 0;
  }

  const rawServer = flags.server ?? sessions.lastServer;
  if (!rawServer) {
    throw new UsageError(`--server is needed the first time: pastebin join ${code} --server http://192.168.1.5:3000`);
  }
  const server = normalizeServer(rawServer);

  let name = flags.name?.trim() ?? "";
  if (name) {
    const parsed = MemberNameSchema.safeParse(name);
    if (!parsed.success) throw new UsageError("a name is 1 to 32 characters");
    name = parsed.data;
  } else {
    name = await suggestName(server);
  }

  const bound = await joinRoom(server, code, name);
  try {
    sessions.set(code, { server, memberId: bound.memberId, token: bound.token, paperId: null });
    await sessions.save();
    const fresh = existing ? " with a fresh identity" : "";
    io.stderr(`Joined ${code} as ${bound.name}${fresh} (${server})\n${describePapers(bound.room, sessions.room(code)!)}`);
  } finally {
    bound.conn.close();
  }
  return 0;
}

async function readInput(io: Io, path: string | undefined, as: string | undefined): Promise<{ text: string; filename: string | null }> {
  if (path !== undefined) {
    const text = await readFileText(path);
    return { text, filename: shortName(as?.trim() || basename(path)) };
  }
  if (io.stdinIsTTY) {
    io.stderr("Reading from the terminal -- paste, then press Ctrl+Z and Enter (Windows) or Ctrl+D to finish.\n");
  }
  const bytes = await io.readStdin();
  const filename = as?.trim() ? shortName(as.trim()) : null;
  return { text: textFromBytes(bytes, "stdin"), filename };
}

async function post(io: Io, positional: string[], flags: Flags): Promise<number> {
  const sessions = await Sessions.load(io.env);
  const { code, session } = requireRoom(sessions, flags);
  // Read and check the input before touching the network, so a refused file
  // costs nothing and an unreachable server never eats a paste.
  const input = await readInput(io, positional[0], flags.as);

  const bound = await resumeOrForget(sessions, code, session);
  try {
    const paper = pickPaper(bound.room, session.paperId, flags.paper);
    await openPaper(bound.conn, paper.id);
    bound.conn.send({
      type: "block.post",
      payload: { paperId: paper.id, text: input.text, filename: input.filename },
    });
    await bound.conn.expect(
      "block.added",
      (m) => m.payload.paperId === paper.id && m.payload.block.authorId === bound.memberId && m.payload.block.text === input.text,
    );
    sessions.update(code, { paperId: paper.id });
    await sessions.save();
    const from = input.filename ? ` from ${input.filename}` : "";
    io.stderr(`Posted ${fmt(input.text.length)} characters${from} to "${paper.title}" in ${code} as ${bound.name}\n`);
  } finally {
    bound.conn.close();
  }
  return 0;
}

function parseLast(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--last wants a whole number of blocks, not "${raw}"`);
  return n;
}

async function get(io: Io, flags: Flags): Promise<number> {
  const last = parseLast(flags.last);
  const sessions = await Sessions.load(io.env);
  const { code, session } = requireRoom(sessions, flags);

  const bound = await resumeOrForget(sessions, code, session);
  try {
    const paper = pickPaper(bound.room, session.paperId, flags.paper);
    const state = await openPaper(bound.conn, paper.id);
    const texts = state.blocks.filter((b) => b.kind === "text");
    if (texts.length === 0) {
      io.stderr(`"${paper.title}" has no text blocks yet\n`);
      return 1;
    }
    const chosen = texts.slice(-last);
    // One block is handed over byte for byte, like the copy button. Several
    // are separated by a blank line, with each one's trailing newlines
    // trimmed so the separator is always exactly one blank line.
    let out = chosen.length === 1 ? chosen[0]!.text : chosen.map((b) => b.text.replace(/\n+$/, "")).join("\n\n");
    // A terminal wants the prompt on its own line; a pipe or a file wants the text and nothing else.
    if (io.stdoutIsTTY && !out.endsWith("\n")) out += "\n";
    io.stdout(out);
    sessions.update(code, { paperId: paper.id });
    await sessions.save();
  } finally {
    bound.conn.close();
  }
  return 0;
}

async function tail(io: Io, flags: Flags): Promise<number> {
  const sessions = await Sessions.load(io.env);
  const { code, session } = requireRoom(sessions, flags);

  const seen = new Set<string>();
  let paperId: string | null = null;
  let first = true;
  let stop = false;
  let current: Connection | null = null;
  const interrupted = io.interrupted().then(() => {
    stop = true;
    current?.close();
  });

  const printBlock = (b: Block, edited: boolean): void => {
    if (seen.has(b.id) && !edited) return;
    seen.add(b.id);
    const when = new Date((edited ? b.editedAt : null) ?? b.createdAt).toLocaleTimeString();
    if (b.kind === "image") {
      io.stderr(`-- ${b.authorName} posted an image at ${when}: ${session.server}/media/${b.media?.id ?? ""} --\n`);
      return;
    }
    if (b.kind !== "text") return;
    io.stderr(`-- ${b.authorName} at ${when}${edited ? " (edited)" : ""} --\n`);
    io.stdout(b.text.endsWith("\n") ? b.text : `${b.text}\n`);
  };

  while (!stop) {
    let bound: Bound;
    try {
      bound = await resumeOrForget(sessions, code, session);
    } catch (e) {
      // A refusal is final, and so is failing to connect at all on the first
      // try. A server that went away mid-session is worth waiting for.
      if (first || e instanceof ServerRefused || e instanceof IdentityGone) throw e;
      await Promise.race([sleep(2000), interrupted]);
      continue;
    }
    current = bound.conn;

    try {
      const paper = pickPaper(bound.room, session.paperId, flags.paper);
      paperId = paper.id;
      const snapshot = await openPaper(bound.conn, paper.id);
      let rev = snapshot.rev;

      if (first) {
        // What is already there is not replayed: tail is for what happens next.
        for (const b of snapshot.blocks) seen.add(b.id);
        sessions.update(code, { paperId: paper.id });
        await sessions.save();
        io.stderr(`Watching "${paper.title}" in ${code} -- Ctrl+C to stop\n`);
        first = false;
      } else {
        for (const b of snapshot.blocks) printBlock(b, false);
        io.stderr("Reconnected\n");
      }

      let roomGone: string | null = null;
      const refresh = () => bound.conn.send({ type: "paper.refresh", payload: { paperId: paper.id } });
      const off = bound.conn.onMessage((m) => {
        switch (m.type) {
          case "block.added":
          case "block.updated":
            if (m.payload.paperId !== paperId) return;
            // A rev that is not the next one means a frame went missing, and
            // printing on top of a hole would leave the terminal quietly
            // wrong. Ask for the snapshot and print whatever it holds that
            // has not been seen.
            if (m.payload.rev !== rev + 1) return refresh();
            rev = m.payload.rev;
            printBlock(m.payload.block, m.type === "block.updated");
            return;
          case "block.removed":
          case "blocks.cleared":
            if (m.payload.paperId !== paperId) return;
            if (m.payload.rev !== rev + 1) return refresh();
            rev = m.payload.rev;
            return;
          case "paper.state":
            if (m.payload.paperId !== paperId) return;
            rev = m.payload.rev;
            for (const b of m.payload.blocks) printBlock(b, false);
            return;
          case "room.closed":
            // The server unbinds the socket but leaves it open, so closing is
            // ours to do, as it is the browser's in socket.svelte.ts.
            roomGone = m.payload.reason === "deleted" ? "The room was deleted." : "The room expired after being empty.";
            bound.conn.close();
            return;
          case "error":
            io.stderr(`pastebin: ${m.payload.message} (${m.payload.code})\n`);
            return;
        }
      });

      await bound.conn.whenClosed();
      off();
      if (roomGone) {
        io.stderr(`${roomGone}\n`);
        sessions.drop(code);
        await sessions.save();
        return 1;
      }
    } finally {
      bound.conn.close();
    }

    if (stop) break;
    io.stderr(`Lost the connection to ${session.server} -- retrying\n`);
    await Promise.race([sleep(2000), interrupted]);
  }
  return 0;
}

async function papers(io: Io, flags: Flags): Promise<number> {
  const sessions = await Sessions.load(io.env);
  const { code, session } = requireRoom(sessions, flags);
  const bound = await resumeOrForget(sessions, code, session);
  try {
    const pick = resolvePaper(bound.room.papers, session.paperId, undefined);
    io.stdout(`${formatPapers(bound.room.papers, pick.ok ? pick.paper.id : null)}\n`);
    if (bound.room.papers.length > 1) {
      io.stderr("* = where post, get and tail go. Change it with: pastebin use <title>\n");
    }
  } finally {
    bound.conn.close();
  }
  return 0;
}

async function use(io: Io, positional: string[], flags: Flags): Promise<number> {
  const wanted = positional[0];
  if (!wanted) throw new UsageError('missing paper -- e.g. pastebin use "Paper 2"');
  const sessions = await Sessions.load(io.env);
  const { code, session } = requireRoom(sessions, flags);
  const bound = await resumeOrForget(sessions, code, session);
  try {
    const paper = pickPaper(bound.room, null, wanted);
    sessions.update(code, { paperId: paper.id });
    await sessions.save();
    io.stderr(`post, get and tail now go to "${paper.title}" in ${code}\n`);
  } finally {
    bound.conn.close();
  }
  return 0;
}

async function leave(io: Io, positional: string[]): Promise<number> {
  const sessions = await Sessions.load(io.env);
  const code = positional[0] ? parseCode(positional[0]) : sessions.current;
  if (!code) throw new UsageError("not in a room");
  if (!sessions.room(code)) throw new CliError(`no saved identity for ${code}`);
  sessions.drop(code);
  await sessions.save();
  io.stderr(`Forgot ${code}. Joining it again will give you a fresh identity.\n`);
  return 0;
}

async function status(io: Io): Promise<number> {
  const sessions = await Sessions.load(io.env);
  const lines: string[] = [];
  const current = sessions.current;
  if (!current) {
    lines.push("Not in a room. Run: pastebin join <CODE> --server <URL>");
  } else {
    const session = sessions.room(current)!;
    lines.push(`Room ${current} on ${session.server}`);
    lines.push(`Default paper: ${session.paperId ? "chosen -- see: pastebin papers" : "automatic"}`);
  }
  const others = sessions.codes().filter((c) => c !== current);
  if (others.length > 0) lines.push(`Other saved rooms: ${others.join(", ")}`);
  lines.push(`Identities file: ${sessions.file}`);
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}
