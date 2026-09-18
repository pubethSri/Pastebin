import { networkInterfaces } from "node:os";

/**
 * The machine's LAN addresses, best effort.
 *
 * Used twice: printed at boot so you don't have to go find it with ipconfig,
 * and served to the client so the QR panel can offer a *reachable* address even
 * when the browser showing it is sitting on localhost. A QR encoding
 * `http://localhost:3000` is worse than no QR — it scans fine and then fails on
 * the phone, which looks like the app is broken.
 *
 * Link-local (169.254.x) is filtered out: it appears on adapters with no DHCP
 * lease and never routes to a phone.
 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("169.254.")) continue;
      out.push(addr.address);
    }
  }
  return out;
}

export const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
