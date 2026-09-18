import { ServerMessageSchema, type ClientIntent, type ServerMessage } from "@pastebin/protocol";
import { CliError, ServerRefused, UsageError } from "./errors";

export type MessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export const DEFAULT_TIMEOUT_MS = 10_000;

interface Waiter {
  match: (m: ServerMessage) => boolean;
  resolve: (m: ServerMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const looksLike = "it looks like http://192.168.1.5:3000";

/** Accepts `host:port` as well as a full URL, and hands back a clean origin. */
export function normalizeServer(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`"${input}" is not a server address -- ${looksLike}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`"${input}" is not a server address -- ${looksLike}`);
  }
  return url.origin;
}

const unreachable = (server: string): CliError =>
  new CliError(`could not reach ${server} -- is the server running, and are you on the same Wi-Fi?`);

/**
 * One socket to the server, with the two things a command needs from it: send
 * an intent, and wait for the frame that answers it.
 *
 * The CLI only ever has one request in flight, which is what makes `expect`
 * safe: an `error` frame that arrives while something is pending *is* the
 * answer to it. Frames nobody is waiting for are buffered, because the server
 * pushes `room.state` right behind `session.created` and a command that awaits
 * them one after the other must not lose the second one in between.
 */
export class Connection {
  private buffer: ServerMessage[] = [];
  private waiters: Waiter[] = [];
  private listeners = new Set<(m: ServerMessage) => void>();
  private closeWaiters: Array<() => void> = [];
  private closedByUs = false;
  closed = false;

  private constructor(
    readonly server: string,
    private readonly ws: WebSocket,
  ) {}

  static open(server: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Connection> {
    const url = new URL(server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    return new Promise((resolve, reject) => {
      let conn: Connection | null = null;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url.toString());
      } catch {
        reject(unreachable(server));
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        reject(unreachable(server));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        conn = new Connection(server, ws);
        conn.wire();
        resolve(conn);
      };
      ws.onerror = () => {
        /* onclose follows and carries the verdict */
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!conn) reject(unreachable(server));
      };
    });
  }

  private wire(): void {
    this.ws.onmessage = (e) => this.receive(String(e.data));
    this.ws.onclose = () => {
      this.closed = true;
      this.failAll(new CliError(this.closedByUs ? "connection closed" : `lost the connection to ${this.server}`));
      const waiting = this.closeWaiters;
      this.closeWaiters = [];
      for (const fn of waiting) fn();
    };
  }

  private receive(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const m = parsed.data;

    for (const fn of this.listeners) fn(m);

    const hit = this.waiters.findIndex((w) => w.match(m));
    if (hit >= 0) {
      const [w] = this.waiters.splice(hit, 1);
      clearTimeout(w!.timer);
      w!.resolve(m);
      return;
    }
    if ((m.type === "error" || m.type === "room.closed") && this.waiters.length > 0) {
      this.failAll(this.toError(m));
      return;
    }
    // A listener (tail) sees everything live, so nothing is kept for later.
    if (this.listeners.size === 0) {
      this.buffer.push(m);
      if (this.buffer.length > 500) this.buffer.shift();
    }
  }

  private failAll(err: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private toError(m: ServerMessage): Error {
    if (m.type === "error") return new ServerRefused(m.payload.code, m.payload.message, this.server);
    if (m.type === "room.closed") {
      return new CliError(m.payload.reason === "deleted" ? "the room was deleted" : "the room expired after being empty");
    }
    return new CliError(`unexpected ${m.type} from the server`);
  }

  /** The next frame of `type` that satisfies `match`, or the refusal that came instead. */
  expect<T extends ServerMessage["type"]>(
    type: T,
    match: (m: MessageOf<T>) => boolean = () => true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<MessageOf<T>> {
    const test = (m: ServerMessage): boolean => m.type === type && match(m as MessageOf<T>);

    const hit = this.buffer.findIndex(test);
    if (hit >= 0) {
      const [m] = this.buffer.splice(hit, 1);
      return Promise.resolve(m as MessageOf<T>);
    }
    // A refusal that landed before anyone was waiting is still the answer to the last thing sent.
    const bad = this.buffer.findIndex((m) => m.type === "error" || m.type === "room.closed");
    if (bad >= 0) {
      const [m] = this.buffer.splice(bad, 1);
      return Promise.reject(this.toError(m!));
    }
    if (this.closed) return Promise.reject(new CliError(`lost the connection to ${this.server}`));

    return new Promise<MessageOf<T>>((resolve, reject) => {
      const waiter: Waiter = {
        match: test,
        resolve: (m) => resolve(m as MessageOf<T>),
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new CliError(`no answer from ${this.server} within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  send(intent: ClientIntent): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(intent));
  }

  /** Every frame as it arrives. While a listener is registered, nothing is buffered for `expect`. */
  onMessage(fn: (m: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  whenClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  close(): void {
    this.closedByUs = true;
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}
