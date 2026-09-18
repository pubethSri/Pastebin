import { describe, expect, test } from "bun:test";
import { CLI_BUILDS, cliBuildFor, cliDownloadCommand, cliJoinCommand, cliSetupCommands } from "../src";

/*
 * These strings are pasted into a shell by someone who did not write them, so
 * they are pinned character for character. The Windows join line in
 * particular once lost its backslash to a shell heredoc on the way into the
 * source file, which no type checker will ever catch.
 */
const windows = cliBuildFor("win32", "x64")!;
const mac = cliBuildFor("darwin", "arm64")!;
const server = "http://192.168.1.5:3000";

describe("CLI build list", () => {
  test("covers the four platforms and every file name is unique", () => {
    expect(CLI_BUILDS.map((b) => `${b.platform}/${b.arch}`)).toEqual([
      "win32/x64",
      "darwin/arm64",
      "darwin/x64",
      "linux/x64",
    ]);
    expect(new Set(CLI_BUILDS.map((b) => b.file)).size).toBe(CLI_BUILDS.length);
    expect(cliBuildFor("freebsd", "x64")).toBeUndefined();
  });
});

describe("the lines a student pastes", () => {
  test("Windows: curl.exe, a .exe name, and a .\\ prefix to run it", () => {
    expect(cliDownloadCommand(server, windows)).toBe(
      "curl.exe -o pastebin.exe http://192.168.1.5:3000/cli/pastebin-windows-x64.exe",
    );
    expect(cliJoinCommand(server, "ABCD", windows)).toBe(".\\pastebin join ABCD --server http://192.168.1.5:3000");
  });

  test("Unix: chmod after the download, and ./ to run it", () => {
    expect(cliDownloadCommand(server, mac)).toBe(
      "curl -o pastebin http://192.168.1.5:3000/cli/pastebin-darwin-arm64 && chmod +x pastebin",
    );
    expect(cliJoinCommand(server, "ABCD", mac)).toBe("./pastebin join ABCD --server http://192.168.1.5:3000");
  });

  test("a trailing slash on the server address does not double up", () => {
    expect(cliDownloadCommand("http://h:3000/", windows)).toContain("http://h:3000/cli/");
    expect(cliJoinCommand("http://h:3000/", "ABCD", mac)).toEndWith("--server http://h:3000");
  });

  test("both lines together, newline-separated, for one copy button", () => {
    expect(cliSetupCommands(server, "ABCD", windows)).toBe(
      `${cliDownloadCommand(server, windows)}\n${cliJoinCommand(server, "ABCD", windows)}`,
    );
  });
});
