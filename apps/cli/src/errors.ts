import type { ErrorCode } from "@pastebin/protocol";

/** Wrong invocation. Exit 2, and the message says what to type instead. */
export class UsageError extends Error {}

/** Something went wrong that wasn't the typing: unreachable server, refused paste, dead room. Exit 1. */
export class CliError extends Error {}

/**
 * The server answered with an `error` frame. `server` rides along so the
 * version-mismatch hint can print the exact download line for the server that
 * refused us.
 */
export class ServerRefused extends CliError {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly server: string,
  ) {
    super(message);
  }
}

/**
 * The stored identity no longer exists on the server (the room was deleted or
 * expired). Its own class so `tail` can tell "give up" from "retry": a lost
 * connection is worth another go, a vanished room is not.
 */
export class IdentityGone extends CliError {}
