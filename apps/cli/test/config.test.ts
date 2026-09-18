import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, Sessions, sessionsPath } from "../src/config";

const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "pastebin-config-"));
  dirs.push(dir);
  return { PASTEBIN_CONFIG_DIR: dir };
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const session = (server = "http://10.0.0.2:3000") => ({ server, memberId: "m1", token: "t1", paperId: null });

describe("where the file lives", () => {
  test("the override wins, then the platform's usual place", () => {
    expect(configDir({ PASTEBIN_CONFIG_DIR: "/x" }, "linux")).toBe("/x");
    expect(configDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\a\\AppData\\Roaming", "pastebin"),
    );
    expect(configDir({ XDG_CONFIG_HOME: "/home/a/.cfg" }, "linux")).toBe(join("/home/a/.cfg", "pastebin"));
    expect(configDir({}, "darwin").endsWith(join(".config", "pastebin"))).toBe(true);
    expect(sessionsPath({ PASTEBIN_CONFIG_DIR: "/x" }, "linux")).toBe(join("/x", "sessions.json"));
  });
});

describe("sessions", () => {
  test("starts empty when there is no file", async () => {
    const s = await Sessions.load(fresh());
    expect(s.current).toBeNull();
    expect(s.codes()).toEqual([]);
  });

  test("round-trips, and the current room follows the last join", async () => {
    const env = fresh();
    const s = await Sessions.load(env);
    s.set("ABCD", session());
    s.set("WXYZ", session("http://10.0.0.3:3000"));
    s.update("ABCD", { paperId: "p9" });
    await s.save();

    const back = await Sessions.load(env);
    expect(back.current).toBe("WXYZ");
    expect(back.lastServer).toBe("http://10.0.0.3:3000");
    expect(back.codes()).toEqual(["ABCD", "WXYZ"]);
    expect(back.room("ABCD")).toEqual({ ...session(), paperId: "p9" });
  });

  test("dropping the current room promotes another saved one", async () => {
    const s = await Sessions.load(fresh());
    s.set("ABCD", session());
    s.set("WXYZ", session());
    s.drop("WXYZ");
    expect(s.current).toBe("ABCD");
    s.drop("ABCD");
    expect(s.current).toBeNull();
    expect(s.codes()).toEqual([]);
  });

  test("setCurrent switches rooms and the default server with it", async () => {
    const s = await Sessions.load(fresh());
    s.set("ABCD", session("http://a:3000"));
    s.set("WXYZ", session("http://b:3000"));
    s.setCurrent("ABCD");
    expect(s.current).toBe("ABCD");
    expect(s.lastServer).toBe("http://a:3000");
    s.setCurrent("NOPE");
    expect(s.current).toBe("ABCD");
  });

  test("a malformed file is treated as empty rather than fatal", async () => {
    const env = fresh();
    writeFileSync(sessionsPath(env), "{ this is not json");
    const s = await Sessions.load(env);
    expect(s.codes()).toEqual([]);
  });

  test("a room missing its token is dropped and the rest kept", async () => {
    const env = fresh();
    writeFileSync(
      sessionsPath(env),
      JSON.stringify({
        current: "BAD1",
        rooms: { BAD1: { server: "http://x", memberId: "m" }, GOOD: session(), ALSO: "nonsense" },
      }),
    );
    const s = await Sessions.load(env);
    expect(s.codes()).toEqual(["GOOD"]);
    // `current` pointed at the dropped room, so it is cleared rather than dangling.
    expect(s.current).toBeNull();
  });

  test("the file is private on unix", async () => {
    if (process.platform === "win32") return;
    const env = fresh();
    const s = await Sessions.load(env);
    s.set("ABCD", session());
    await s.save();
    expect(statSync(sessionsPath(env)).mode & 0o777).toBe(0o600);
  });
});
