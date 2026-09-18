import { parseArgs } from "node:util";
import { UsageError } from "./errors";

export interface Flags {
  server?: string;
  name?: string;
  paper?: string;
  room?: string;
  last?: string;
  as?: string;
  fresh: boolean;
  help: boolean;
  version: boolean;
}

export interface Invocation {
  command: string | null;
  positional: string[];
  flags: Flags;
}

/**
 * One option table for every command rather than one per command. The set is
 * small enough that an irrelevant flag on a command is harmless, and a single
 * table means `--paper` parses the same way everywhere it appears.
 */
const options = {
  server: { type: "string" },
  name: { type: "string" },
  paper: { type: "string" },
  room: { type: "string" },
  last: { type: "string" },
  as: { type: "string" },
  fresh: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

export function parseInvocation(argv: string[]): Invocation {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    // Node's message is fine; it names the unknown option. Only the exit code
    // and the "see --help" line are ours.
    throw new UsageError((e as Error).message);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const text = (key: string): string | undefined => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  const [command = null, ...positional] = parsed.positionals;
  return {
    command,
    positional,
    flags: {
      server: text("server"),
      name: text("name"),
      paper: text("paper"),
      room: text("room"),
      last: text("last"),
      as: text("as"),
      fresh: values.fresh === true,
      help: values.help === true,
      version: values.version === true,
    },
  };
}
