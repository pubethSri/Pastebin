import type { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** Absolute og:image URL, if any. Served to clients only through our proxy. */
  imageUrl: string | null;
}

const FETCH_TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * Everything below exists because previews are the one feature that makes this
 * server issue outbound requests at a stranger's request.
 *
 * A room is a 4-letter code on a home LAN, so "a stranger" is generous — but
 * the server sits *inside* the network, which is exactly the position that
 * makes SSRF worth anything. Pasting `http://192.168.1.1/…` and pressing
 * preview would otherwise have the router fetched by something that can reach
 * it, and the response summarised back to the room.
 *
 * So: only http(s), resolve the hostname and require *every* resolved address
 * to be public, and follow redirects by hand so hop two gets the same check as
 * hop one. `redirect: "follow"` would check the first URL and then obediently
 * walk to 127.0.0.1.
 */

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Fails closed: anything this function cannot positively identify as a public
 * address is treated as private. Today the input always comes from
 * `dns.lookup`, so it is always a well-formed address — but a guard whose
 * default branch is "allow" is one refactor away from being no guard at all.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (!addr) return true;

  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is still that IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPrivateIPv4(mapped[1]!);

  // No colon means it is IPv4 or it is nonsense; isPrivateIPv4 refuses nonsense.
  if (!addr.includes(":")) return isPrivateIPv4(addr);

  if (!/^[0-9a-f:]+$/.test(addr)) return true; // not even IPv6-shaped
  if (addr === "::1" || addr === "::") return true;
  if (addr.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(addr)) return true; // unique local
  return false;
}

/** Refuses unless the URL is http(s) and every address it resolves to is public. */
async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http and https links can be previewed");
  }
  // `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`), which no
  // resolver accepts — without stripping them `http://[::1]/` failed as
  // "could not resolve", which is the right answer for the wrong reason and
  // would stop being the right answer the moment resolution behaviour changed.
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error("could not resolve that host");
  }
  if (addresses.length === 0) throw new Error("could not resolve that host");
  // *Every* address, not just the first: a host with one public and one private
  // record must not be a way through.
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("that address is on a private network — refusing to fetch it");
  }
}

/** Fetches with the guard applied at every redirect hop. */
async function guardedFetch(target: string, accept: string): Promise<{ response: Response; finalUrl: URL }> {
  let current = new URL(target);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(current);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept,
        // Some sites serve a stub to unknown agents; say what we are anyway.
        "user-agent": "Mozilla/5.0 (compatible; PastebinLAN/1.0; +link-preview)",
        "accept-language": "en",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { response, finalUrl: current };
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("too many redirects");
}

/** Reads a body up to a byte cap, so a huge page can't be used to exhaust memory. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    out.set(chunk.subarray(0, out.length - offset), offset);
    offset += chunk.length;
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

const decodeEntities = (s: string): string =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key]!;
    const dec = /^#(\d+)$/.exec(name);
    if (dec) return String.fromCodePoint(Number(dec[1]));
    const hex = /^#x([0-9a-f]+)$/i.exec(name);
    if (hex) return String.fromCodePoint(parseInt(hex[1]!, 16));
    return whole;
  });

const clamp = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s);

function metaContent(tags: string[], keys: string[]): string | null {
  for (const key of keys) {
    for (const tag of tags) {
      const prop = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
      if (prop !== key) continue;
      const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
      if (content?.trim()) return decodeEntities(content.trim());
    }
  }
  return null;
}

function parsePreview(html: string, finalUrl: URL): Omit<LinkPreview, "url"> {
  // Only the head matters, and stopping there keeps a 500 KB page's body out of
  // every regex below.
  const head = html.slice(0, html.search(/<\/head>/i) + 1 || 200_000);
  const tags = head.match(/<meta\b[^>]*>/gi) ?? [];

  const title =
    metaContent(tags, ["og:title", "twitter:title"]) ??
    (() => {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
      return m ? decodeEntities(m[1]!.replace(/\s+/g, " ").trim()) : null;
    })();

  const description = metaContent(tags, ["og:description", "twitter:description", "description"]);
  const siteName = metaContent(tags, ["og:site_name"]) ?? finalUrl.hostname.replace(/^www\./, "");
  const rawImage = metaContent(tags, ["og:image", "og:image:url", "twitter:image"]);

  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      // og:image is frequently relative; resolve against the page we landed on.
      imageUrl = new URL(rawImage, finalUrl).toString();
    } catch {
      imageUrl = null;
    }
  }

  return {
    title: title ? clamp(title, 140) : null,
    description: description ? clamp(description.replace(/\s+/g, " "), 300) : null,
    siteName: clamp(siteName, 60),
    imageUrl,
  };
}

export class LinkPreviewStore {
  constructor(private db: Database) {}

  /** Cached result, or null when absent or stale. `error` rows are cached too. */
  private cached(url: string): { preview: LinkPreview | null; error: string | null } | null {
    const row = this.db
      .query<
        { url: string; title: string | null; description: string | null; site_name: string | null; image_url: string | null; error: string | null; fetched_at: number },
        [string]
      >("SELECT * FROM link_previews WHERE url = ?")
      .get(url);
    if (!row) return null;
    if (Date.now() - row.fetched_at > CACHE_TTL_MS) return null;
    if (row.error) return { preview: null, error: row.error };
    return {
      preview: {
        url: row.url,
        title: row.title,
        description: row.description,
        siteName: row.site_name,
        imageUrl: row.image_url,
      },
      error: null,
    };
  }

  private store(url: string, preview: LinkPreview | null, error: string | null): void {
    this.db
      .query(
        `INSERT INTO link_previews (url, title, description, site_name, image_url, error, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title=excluded.title, description=excluded.description, site_name=excluded.site_name,
           image_url=excluded.image_url, error=excluded.error, fetched_at=excluded.fetched_at`,
      )
      .run(
        url,
        preview?.title ?? null,
        preview?.description ?? null,
        preview?.siteName ?? null,
        preview?.imageUrl ?? null,
        error,
        Date.now(),
      );
  }

  async get(rawUrl: string): Promise<{ preview: LinkPreview | null; error: string | null }> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { preview: null, error: "that isn't a URL" };
    }
    const key = url.toString();

    const hit = this.cached(key);
    if (hit) return hit;

    try {
      const { response, finalUrl } = await guardedFetch(key, "text/html,application/xhtml+xml");
      if (!response.ok) throw new Error(`the site answered ${response.status}`);

      const type = response.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml/i.test(type)) {
        throw new Error("that link isn't a web page");
      }
      const bytes = await readCapped(response, MAX_HTML_BYTES);
      const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const preview: LinkPreview = { url: key, ...parsePreview(html, finalUrl) };
      this.store(key, preview, null);
      return { preview, error: null };
    } catch (e) {
      const error = e instanceof Error ? e.message : "could not reach that link";
      // Failures are cached too, so a dead link isn't re-fetched on every click.
      this.store(key, null, error);
      return { preview: null, error };
    }
  }

  /**
   * Fetches an og:image through the server.
   *
   * Rendering `<img src="{remote}">` directly would hand every viewer's browser
   * an arbitrary URL to load — leaking each person's IP to the site, and walking
   * straight around the private-address guard, since the *browser* would be
   * doing the fetching from inside the LAN. Proxying keeps every outbound
   * request on this side of the guard.
   */
  async image(rawUrl: string): Promise<{ bytes: Uint8Array; type: string } | { error: string }> {
    try {
      const { response } = await guardedFetch(new URL(rawUrl).toString(), "image/*");
      if (!response.ok) return { error: `image responded ${response.status}` };
      const type = response.headers.get("content-type") ?? "";
      if (!/^image\//i.test(type)) return { error: "not an image" };
      return { bytes: await readCapped(response, MAX_IMAGE_BYTES), type: type.split(";")[0]!.trim() };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "could not fetch image" };
    }
  }
}
