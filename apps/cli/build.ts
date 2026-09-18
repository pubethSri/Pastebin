import { CLI_BUILDS, cliBuildFor, type CliBuild } from "@pastebin/protocol";
import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-compiles the CLI for every platform in `CLI_BUILDS` into `dist/`, which
 * is where the server's `/cli/<file>` route reads from. Bun downloads each
 * foreign target's runtime the first time, so the first run needs internet;
 * after that it is offline and takes a few seconds per target.
 *
 * `--host` builds only this machine's target, for a quick local check.
 */
const hostOnly = process.argv.includes("--host");
const host = cliBuildFor(process.platform, process.arch);
const builds: readonly CliBuild[] = hostOnly ? (host ? [host] : []) : CLI_BUILDS;

if (builds.length === 0) {
  console.error(`no CLI build is defined for ${process.platform}/${process.arch}`);
  process.exit(1);
}

const dist = join(import.meta.dir, "dist");
mkdirSync(dist, { recursive: true });
const entry = join(import.meta.dir, "src", "index.ts");

for (const build of builds) {
  console.log(`building ${build.file} (${build.target})`);
  await $`bun build --compile --target=${build.target} --minify --outfile=${join(dist, build.file)} ${entry}`.cwd(
    import.meta.dir,
  );
}
console.log(`done -- ${builds.length} file(s) in ${dist}`);
