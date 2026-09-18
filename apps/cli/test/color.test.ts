import { describe, expect, test } from "bun:test";
import { PALETTE } from "../../server/src/identity";
import { parseHex, shouldColor, styleFor } from "../src/color";

const on = styleFor({}, true);
const off = styleFor({}, false);

describe("when colour is used at all", () => {
  test("a terminal gets it, a pipe or a file does not", () => {
    expect(shouldColor({}, true)).toBe(true);
    expect(shouldColor({}, false)).toBe(false);
  });

  test("NO_COLOR turns it off at any non-empty value, per no-color.org", () => {
    expect(shouldColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldColor({ NO_COLOR: "anything" }, true)).toBe(false);
    // Empty means unset, which is the part of that spec people get wrong.
    expect(shouldColor({ NO_COLOR: "" }, true)).toBe(true);
  });

  test("FORCE_COLOR turns it on without a terminal, and 0 is an explicit no", () => {
    expect(shouldColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(shouldColor({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(shouldColor({ FORCE_COLOR: "false" }, true)).toBe(false);
  });

  test("with both set, off wins", () => {
    expect(shouldColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });

  test("TERM=dumb is honoured, and FORCE_COLOR still overrides it", () => {
    expect(shouldColor({ TERM: "dumb" }, true)).toBe(false);
    expect(shouldColor({ TERM: "dumb", FORCE_COLOR: "1" }, true)).toBe(true);
  });
});

describe("parseHex", () => {
  test("reads every colour the server can assign", () => {
    for (const entry of PALETTE) {
      const rgb = parseHex(entry.hex);
      expect(rgb).not.toBeNull();
      for (const channel of [rgb!.r, rgb!.g, rgb!.b]) {
        expect(Number.isInteger(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
    expect(parseHex("#0f766e")).toEqual({ r: 15, g: 118, b: 110 });
  });

  test("anything else is null rather than a guess", () => {
    for (const bad of ["", "0f766e", "#0f766", "#gggggg", "red", null, undefined]) {
      expect(parseHex(bad)).toBeNull();
    }
  });
});

describe("what gets printed", () => {
  test("a name carries the colour it was handed and restores the default after", () => {
    expect(on.name("Ada", "#0f766e")).toBe("[38;2;15;118;110mAda[39m");
  });

  test("a colour the server never sent leaves the name plain rather than breaking the line", () => {
    expect(on.name("Ada", "not-a-colour")).toBe("Ada");
    expect(on.name("Ada", null)).toBe("Ada");
  });

  test("with colour off, every helper is the identity function", () => {
    expect(off.name("Ada", "#0f766e")).toBe("Ada");
    expect(off.link("text", "http://x")).toBe("text");
    expect(off.dim("text")).toBe("text");
    expect(off.enabled).toBe(false);
  });

  test("a link is OSC 8 around text that is still readable if stripped", () => {
    const url = "http://10.0.0.1:3000/media/abc";
    const linked = on.link(url, url);
    expect(linked).toBe(`]8;;${url}\\${url}]8;;\\`);
    // A terminal that ignores OSC 8 shows the URL itself, so nothing is lost.
    expect(linked.replaceAll(/]8;;[^]*\\/g, "")).toBe(url);
  });

  test("nothing emitted contains a bare reset, which would clobber the caller's styling", () => {
    expect(on.name("Ada", "#be123c")).not.toContain("[0m");
    expect(on.dim("x")).not.toContain("[0m");
  });
});
