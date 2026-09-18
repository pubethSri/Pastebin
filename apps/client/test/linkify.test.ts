import { describe, expect, test } from "bun:test";
import { linkify, uniqueLinks } from "../src/lib/linkify";

const rebuild = (text: string) => linkify(text).map((s) => s.value).join("");
const links = (text: string) => linkify(text).filter((s) => s.kind === "link").map((s) => s.value);

describe("linkify", () => {
  // The one property that must never break: block text is code, and a linkifier
  // that drops or reorders a character has corrupted a command.
  test("segments always reassemble into the original text", () => {
    const samples = [
      "plain text with no links",
      "curl -fsSL https://bun.sh/install | bash",
      "see https://a.example, then http://b.example.",
      "https://start.example at the very start",
      "trailing https://end.example",
      "  leading and trailing whitespace  ",
      "multi\nline\nhttps://x.example\ntext",
      "",
    ];
    for (const sample of samples) expect(rebuild(sample)).toBe(sample);
  });

  test("finds http and https urls", () => {
    expect(links("curl -fsSL https://bun.sh/install | bash")).toEqual(["https://bun.sh/install"]);
    expect(links("go to http://example.com now")).toEqual(["http://example.com"]);
  });

  // Only http(s) can ever become an href, so no sanitiser is needed downstream.
  test("does not linkify dangerous or unknown schemes", () => {
    for (const text of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "vbscript:msgbox",
    ]) {
      expect(links(text)).toEqual([]);
    }
  });

  test("sentence punctuation stays out of the url", () => {
    expect(links("read https://bun.sh/docs.")).toEqual(["https://bun.sh/docs"]);
    expect(links("read https://bun.sh/docs, then go")).toEqual(["https://bun.sh/docs"]);
    expect(links("wow https://bun.sh!")).toEqual(["https://bun.sh"]);
    expect(links("(https://bun.sh)")).toEqual(["https://bun.sh"]);
  });

  test("balanced brackets inside a url are kept", () => {
    expect(links("https://en.wikipedia.org/wiki/Bun_(software)")).toEqual([
      "https://en.wikipedia.org/wiki/Bun_(software)",
    ]);
  });

  test("urls inside quotes and angle brackets terminate cleanly", () => {
    expect(links(`curl "https://api.example/v1" -H x`)).toEqual(["https://api.example/v1"]);
    expect(links("<https://example.com>")).toEqual(["https://example.com"]);
  });

  test("uniqueLinks dedupes and preserves order", () => {
    const text = "https://b.example then https://a.example then https://b.example again";
    expect(uniqueLinks(linkify(text))).toEqual(["https://b.example/", "https://a.example/"]);
  });

  test("a link segment carries a normalised absolute href", () => {
    const seg = linkify("go https://Example.COM/a?b=1").find((s) => s.kind === "link");
    expect(seg?.kind).toBe("link");
    expect(seg && seg.kind === "link" && seg.href).toBe("https://example.com/a?b=1");
    // ...while the visible text stays exactly as it was typed.
    expect(seg?.value).toBe("https://Example.COM/a?b=1");
  });
});
