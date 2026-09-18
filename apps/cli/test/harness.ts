import { PROTOCOL_VERSION } from "@pastebin/protocol";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The real server, in-process on a random port, so these tests exercise the
// real wire and the real route table rather than a fake of either. A relative
// import rather than a workspace dependency: the CLI never needs the server at
// runtime, only its tests do.
import { createApp } from "../../server/src/app";
import { run, type Io } from "../src/commands";
import type { SessionsFile } from "../src/config";
import { Connection } from "../src/connection";
import { bind, type Bound } from "../src/session";

export interface TestServer {
  server: string;
  stop: () => Promise<void>;
}

export function startServer(): TestServer {
  const app = createApp({ dbPath: ":memory:", clientDist: null, cliDist: null, heartbeatMs: 0 });
  app.listen({ port: 0, hostname: "127.0.0.1" });
  const port = app.server!.port;
  return {
    server: `http://127.0.0.1:${port}`,
    stop: async () => {
      await app.stop(true);
    },
  };
}

/** Students never create rooms; the teacher's browser does. This stands in for that browser. */
export async function createRoom(server: string, memberName = "Teacher"): Promise<Bound> {
  const conn = await Connection.open(server);
  return bind(conn, { type: "room.create", payload: { memberName, protocolVersion: PROTOCOL_VERSION } });
}

export interface Result {
  code: number;
  out: string;
  err: string;
}

export interface Running {
  done: Promise<Result>;
  out: () => string;
  err: () => string;
  /** What Ctrl+C would do. */
  interrupt: () => void;
}

/**
 * One student: a private identities directory, and the CLI run in-process
 * against it with strings for streams. Each `run` captures its own output,
 * so a test reads exactly what that command printed.
 */
export function student(opts: { tty?: boolean; stderrTty?: boolean; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pastebin-cli-"));

  const start = (argv: string[], stdin?: string | Uint8Array): Running => {
    let out = "";
    let err = "";
    let interrupt: () => void = () => {};
    const interrupted = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    const io: Io = {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      readStdin: async () => (typeof stdin === "string" ? new TextEncoder().encode(stdin) : (stdin ?? new Uint8Array())),
      stdinIsTTY: false,
      stdoutIsTTY: opts.tty ?? false,
      stderrIsTTY: opts.stderrTty ?? false,
      env: { PASTEBIN_CONFIG_DIR: dir, ...opts.env },
      platform: process.platform,
      arch: process.arch,
      interrupted: () => interrupted,
    };
    const done = run(argv, io).then((code) => ({ code, out, err }));
    return { done, out: () => out, err: () => err, interrupt: () => interrupt() };
  };

  return {
    dir,
    start,
    run: (argv: string[], stdin?: string | Uint8Array): Promise<Result> => start(argv, stdin).done,
    sessions: (): SessionsFile => JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type Student = ReturnType<typeof student>;

/** Polls until `pred` holds, for things that arrive over a socket. */
export async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
