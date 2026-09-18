import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { isPrivateAddress, LinkPreviewStore } from "../src/linkPreview";

describe("private address guard", () => {
  test("refuses loopback, private, link-local and CGNAT ranges", () => {
    for (const ip of [
      "127.0.0.1", "127.1.2.3", "0.0.0.0",
      "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.254",
      "192.168.1.1",
      "169.254.83.107", // the link-local address this very machine reports
      "100.64.0.1", // CGNAT
      "224.0.0.1", // multicast
      "::1", "::",
      "fe80::1", // IPv6 link-local
      "fc00::1", "fd12:3456::1", // IPv6 unique local
      "::ffff:192.168.0.1", // IPv4-mapped private address
    ]) {
      expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: true });
    }
  });

  test("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
      expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: false });
    }
  });

  test("garbage is refused rather than allowed through", () => {
    for (const ip of ["", "not-an-ip", "999.999.999.999", "1.2.3", "1.2.3.4.5"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });
});

describe("preview fetching", () => {
  const store = () => new LinkPreviewStore(openDb(":memory:"));

  // None of these touch the network: they are refused before any fetch.
  test("a loopback URL is refused", async () => {
    const result = await store().get("http://127.0.0.1:9/");
    expect(result.preview).toBeNull();
    expect(result.error).toMatch(/private network/);
  });

  test("an IPv6 loopback literal is refused as private, not as unresolvable", async () => {
    const result = await store().get("http://[::1]:9/");
    expect(result.error).toMatch(/private network/);
  });

  test("localhost is refused", async () => {
    const result = await store().get("http://localhost:9/");
    expect(result.error).toMatch(/private network/);
  });

  test("a LAN address is refused — this is the one that matters here", async () => {
    const result = await store().get("http://192.168.1.1/admin");
    expect(result.error).toMatch(/private network/);
  });

  test("non-http schemes are refused", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"]) {
      const result = await store().get(url);
      expect(result.error).toMatch(/only http and https/);
    }
  });

  test("nonsense input is refused without a fetch", async () => {
    expect((await store().get("not a url")).error).toBe("that isn't a URL");
  });

  // A dead link shouldn't cost a network round-trip every time someone clicks.
  test("failures are cached", async () => {
    const db = openDb(":memory:");
    const previews = new LinkPreviewStore(db);
    await previews.get("http://127.0.0.1:9/");

    const row = db
      .query<{ error: string | null }, [string]>("SELECT error FROM link_previews WHERE url = ?")
      .get("http://127.0.0.1:9/");
    expect(row?.error).toMatch(/private network/);

    // Second call comes back identically, from the row above.
    expect((await previews.get("http://127.0.0.1:9/")).error).toMatch(/private network/);
  });
});
