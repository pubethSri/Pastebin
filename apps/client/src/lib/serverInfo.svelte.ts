import { DEFAULT_EMPTY_ROOM_GRACE_MINUTES } from "@pastebin/protocol";

export interface ServerInfo {
  addresses: string[];
  emptyRoomGraceMinutes: number;
}

/**
 * Facts about the server this page is talking to, fetched once per page load
 * and shared by everything that needs them.
 *
 * The grace period is read from the server rather than from the shared constant
 * because it is env-overridable: a UI that hardcodes "5 minutes" would quietly
 * start lying the moment someone sets ROOM_EMPTY_GRACE_MINUTES. The constant is
 * only the value shown before the fetch lands.
 */
const fallback: ServerInfo = {
  addresses: [],
  emptyRoomGraceMinutes: DEFAULT_EMPTY_ROOM_GRACE_MINUTES,
};

let cached: Promise<ServerInfo> | null = null;

export function serverInfo(): Promise<ServerInfo> {
  cached ??= fetch("/api/host")
    .then((r) => (r.ok ? r.json() : fallback))
    .then((data: Partial<ServerInfo>) => ({
      addresses: Array.isArray(data.addresses) ? data.addresses : [],
      emptyRoomGraceMinutes:
        typeof data.emptyRoomGraceMinutes === "number" && data.emptyRoomGraceMinutes > 0
          ? data.emptyRoomGraceMinutes
          : DEFAULT_EMPTY_ROOM_GRACE_MINUTES,
    }))
    .catch(() => fallback);
  return cached;
}
