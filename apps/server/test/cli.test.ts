import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";

/*
 * The download route is an allowlist, not a file server: only the four names
 * in CLI_BUILDS are ever served, and only when the file exists. Both halves of
 * that are asserted here because either one failing turns "download the CLI"
 * into "read anything in that directory".
 */
const dir = mkdtempSync(join(tmpdir(), "pastebin-cli-dist-"));
writeFileSync(join(dir, "pastebin-linux-x64"), "not really a binary");
writeFileSync(join(dir, "evil.exe"), "must never be served");

const app = createApp({ dbPath: ":memory:", clientDist: null, cliDist: dir, heartbeatMs: 0 });
const bare = createApp({ dbPath: ":memory:", clientDist: null, cliDist: null, heartbeatMs: 0 });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const get = (a: typeof app, path: string) => a.handle(new Request(`http://localhost${path}`));

describe("/cli downloads", () => {
  test("/api/cli lists only the builds that exist on disk", async () => {
    const res = await get(app, "/api/cli");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: ["pastebin-linux-x64"] });
  });

  test("a build is served as an attachment that is never cached", async () => {
    const res = await get(app, "/cli/pastebin-linux-x64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="pastebin-linux-x64"');
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe("not really a binary");
  });

  test("a file in the directory that is not a known build is not served", async () => {
    expect((await get(app, "/cli/evil.exe")).status).toBe(404);
  });

  test("a known build that has not been compiled is a 404, not a crash", async () => {
    expect((await get(app, "/cli/pastebin-windows-x64.exe")).status).toBe(404);
  });

  test("with no dist directory the list is empty and every download is a 404", async () => {
    expect(await (await get(bare, "/api/cli")).json()).toEqual({ files: [] });
    expect((await get(bare, "/cli/pastebin-linux-x64")).status).toBe(404);
  });
});
