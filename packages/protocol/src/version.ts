/**
 * Bumped whenever an intent or message changes shape. The client sends it on
 * every binding intent and the server refuses a mismatch, so a stale tab gets
 * told to reload instead of failing in some confusing way later.
 *
 * `protocol.test.ts` asserts this as a literal on purpose: bumping it should
 * fail that test and make you look at the client.
 */
export const PROTOCOL_VERSION = 6;
