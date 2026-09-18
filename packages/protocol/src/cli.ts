/**
 * The command-line client's builds.
 *
 * Three things have to agree on these names: the build script that writes the
 * files, the server that serves them at `/cli/<file>`, and the share panel that
 * shows the download line. This is not wire contract in the strict sense, but a
 * list three packages read is exactly what the shared package is for — and the
 * server's route treats it as an allowlist, so a request is one of these names
 * or a 404, and nothing ever joins user input onto a path.
 */
export interface CliBuild {
  /** File name, both as written by the build script and as served. */
  file: string;
  /** Bun's `--target` for `bun build --compile`. */
  target: string;
  /** What `process.platform` / `process.arch` report on the machine it runs on. */
  platform: "win32" | "darwin" | "linux";
  /** Matches `process.arch`. A binary cannot adapt to the wrong one — it simply will not execute. */
  arch: "x64" | "arm64";
  /** What the share panel calls it. */
  label: string;
}

export const CLI_BUILDS: readonly CliBuild[] = [
  { file: "pastebin-windows-x64.exe", target: "bun-windows-x64", platform: "win32", arch: "x64", label: "Windows" },
  { file: "pastebin-darwin-arm64", target: "bun-darwin-arm64", platform: "darwin", arch: "arm64", label: "macOS (Apple Silicon)" },
  { file: "pastebin-darwin-x64", target: "bun-darwin-x64", platform: "darwin", arch: "x64", label: "macOS (Intel)" },
  { file: "pastebin-linux-x64", target: "bun-linux-x64", platform: "linux", arch: "x64", label: "Linux (x64)" },
  // Cloud Ubuntu is often ARM now — Oracle's free tier, AWS Graviton, Hetzner —
  // as is any Linux VM on an Apple Silicon Mac, and a 64-bit Raspberry Pi. An
  // x64 binary on one of those does not degrade, it fails at exec with "cannot
  // execute binary file", so the only fix is shipping the right architecture.
  { file: "pastebin-linux-arm64", target: "bun-linux-arm64", platform: "linux", arch: "arm64", label: "Linux (ARM64)" },
];

export const cliBuildFor = (platform: string, arch: string): CliBuild | undefined =>
  CLI_BUILDS.find((b) => b.platform === platform && b.arch === arch);

const trimSlash = (server: string): string => server.replace(/\/+$/, "");

/**
 * The line a student runs to fetch the binary from `server`.
 *
 * `curl.exe`, not `curl`, on Windows: Windows PowerShell aliases `curl` to
 * Invoke-WebRequest, whose flags are different, so the bare name fails in the
 * shell most students will paste this into. `-o` rather than `-O` so the file
 * lands as plain `pastebin` whatever the platform-specific name on the server.
 * A curl download carries no quarantine attribute or Mark-of-the-Web, which is
 * why neither Gatekeeper nor SmartScreen gets in the way afterwards.
 */
export function cliDownloadCommand(server: string, build: CliBuild): string {
  const url = `${trimSlash(server)}/cli/${build.file}`;
  return build.platform === "win32"
    ? `curl.exe -o pastebin.exe ${url}`
    : `curl -o pastebin ${url} && chmod +x pastebin`;
}

/** The line that follows it. `.\` on Windows because PowerShell won't run a binary from the current directory by bare name. */
export function cliJoinCommand(server: string, code: string, build: CliBuild): string {
  const bin = build.platform === "win32" ? ".\\pastebin" : "./pastebin";
  return `${bin} join ${code} --server ${trimSlash(server)}`;
}

/** Both lines, so one copy button hands over everything a student needs to type. */
export const cliSetupCommands = (server: string, code: string, build: CliBuild): string =>
  `${cliDownloadCommand(server, build)}\n${cliJoinCommand(server, code, build)}`;
