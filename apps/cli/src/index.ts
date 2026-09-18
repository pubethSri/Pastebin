import { run, type Io } from "./commands";

let interrupted: Promise<void> | null = null;

const io: Io = {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
  readStdin: async () => new Uint8Array(await Bun.stdin.arrayBuffer()),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  env: process.env,
  platform: process.platform,
  arch: process.arch,
  // Registered only when asked for. A SIGINT listener changes Ctrl+C from
  // "kill the process" to "run the listener", and only `tail` wants that;
  // `post` in the middle of a paste should still just die.
  interrupted: () => (interrupted ??= new Promise((resolve) => process.once("SIGINT", () => resolve()))),
};

const code = await run(process.argv.slice(2), io);
process.exitCode = code;
// Every socket is closed by now, so the loop drains and the process ends on
// its own with stdout flushed. The timer is a backstop for a leaked handle:
// unref'd, it only ever fires if something else is still keeping us alive.
setTimeout(() => process.exit(code), 2000).unref();
