import { linkify, type Segment } from "./linkify";

/**
 * A deliberately small syntax highlighter.
 *
 * Three constraints shaped this, and each one ruled out reaching for a library:
 *
 * 1. **No `{@html}`, ever.** Block text is whatever anyone on the Wi-Fi pasted.
 *    Prism, highlight.js and Shiki all lead with an API that hands back an HTML
 *    string, and rendering that would put untrusted input straight into the DOM
 *    — exactly what `BlockText.svelte` refuses to do. So this emits *tokens*,
 *    and Svelte interpolates them like any other text. There is no path from a
 *    paste to markup.
 * 2. **Weight.** The whole client is ~56 kB gzipped and ships one runtime
 *    dependency. A highlighter that cost more than the app to decorate text
 *    people mostly copy rather than read would be a bad trade.
 * 3. **Never change a character.** Tokens must reassemble into the exact input
 *    — same property `linkify` holds, and for the same reason: this is code,
 *    and a highlighter that drops a character has corrupted a command.
 *    `highlight.test.ts` asserts it across every grammar.
 *
 * The cost of being small is that grammars are *families*, not languages: one
 * C-like mode covers TypeScript, Go, Rust and Java with a shared keyword set,
 * so `type` colours in Go where it isn't really a keyword. On a board where you
 * glance at a block and copy it, that trade is invisible.
 */

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword" | "key";
export interface Token {
  kind: TokenKind;
  value: string;
}

/** Grammars are syntax families, not languages — see the note above. */
export type Language = "clike" | "hash" | "json" | "sql" | "css" | "markup";

/**
 * Past this, a block renders plain.
 *
 * Blocks collapse at 20 lines, so the usual cost is a few hundred characters
 * and the cutoff never comes up. It exists for the moment someone hits "Show
 * all 2,500 lines" on a dropped file: tokenising 100k characters mid-tap is
 * how you jank a phone. Judged on the whole block rather than the visible
 * slice, so colour doesn't vanish when a block is expanded.
 */
export const MAX_HIGHLIGHT_CHARS = 50_000;

/**
 * One rule, one token kind.
 *
 * Every source **must** use non-capturing groups only: the scanner joins them
 * into a single alternation and reads back which group matched to recover the
 * kind, so a stray `(` would silently shift every kind after it. A test counts
 * the groups to keep that honest.
 */
interface Rule {
  kind: TokenKind;
  source: string;
}

interface Grammar {
  flags: string;
  rules: Rule[];
}

/* Shared fragments. `\x60` is a backtick — written as an escape so the pattern
   can live in a template literal without a puzzle of its own. */
const LINE_STRINGS = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;
const NUMBER = String.raw`\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b`;

const CLIKE_KEYWORDS = [
  // The union of several C-family languages on purpose: one mode covering
  // TypeScript, Go, Rust, Java, C#, C++, Swift and PHP beats six near-identical
  // ones, and a keyword that belongs to a neighbouring language is a colour, not
  // a bug.
  "abstract", "as", "async", "await", "base", "bool", "boolean", "break", "byte", "case", "catch",
  "char", "class", "const", "constexpr", "continue", "crate", "decimal", "default", "defer",
  "delegate", "delete", "do", "double", "dyn", "else", "enum", "event", "explicit", "extends",
  "extern", "false", "final", "finally", "float", "fn", "for", "foreach", "friend", "from", "func",
  "function", "go", "goto", "if", "impl", "implements", "import", "in", "inline", "instanceof",
  "int", "interface", "internal", "is", "let", "lock", "long", "loop", "match", "mod", "module",
  "move", "mut", "namespace", "new", "nil", "noexcept", "null", "nullptr", "object", "of",
  "operator", "out", "override", "package", "params", "private", "protected", "pub", "public",
  "readonly", "ref", "register", "return", "sealed", "self", "short", "signed", "sizeof", "static",
  "string", "struct", "super", "switch", "template", "this", "throw", "throws", "trait", "true",
  "try", "type", "typedef", "typename", "typeof", "uint", "union", "unsafe", "unsigned", "use",
  "using", "val", "var", "virtual", "void", "volatile", "when", "where", "while", "with", "yield",
].join("|");

const HASH_KEYWORDS = [
  // Python, Ruby and shell share this mode because they share `#` comments.
  // Dockerfile's uppercase instructions are here too, which is why the list is
  // case-sensitive rather than folded.
  "and", "as", "assert", "async", "await", "begin", "break", "case", "class", "continue", "def",
  "del", "do", "done", "elif", "else", "elsif", "end", "esac", "except", "exit", "export", "fi",
  "finally", "for", "from", "function", "global", "if", "import", "in", "is", "lambda", "local",
  "module", "nil", "none", "nonlocal", "not", "or", "pass", "raise", "require", "return", "select",
  "self", "set", "shift", "source", "then", "try", "unless", "unset", "until", "while", "with",
  "yield", "False", "None", "True", "sudo", "echo", "cd", "alias", "declare", "read", "unalias",
  "ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "FROM", "HEALTHCHECK", "LABEL",
  "MAINTAINER", "RUN", "SHELL", "STOPSIGNAL", "USER", "VOLUME", "WORKDIR",
].join("|");

const SQL_KEYWORDS = [
  "add", "all", "alter", "and", "as", "asc", "begin", "between", "by", "case", "cascade", "column",
  "commit", "constraint", "create", "cross", "default", "delete", "desc", "distinct", "drop",
  "else", "end", "exists", "foreign", "from", "full", "group", "having", "if", "in", "index",
  "inner", "insert", "into", "is", "join", "key", "left", "like", "limit", "not", "null", "offset",
  "on", "or", "order", "outer", "primary", "references", "returning", "right", "rollback",
  "select", "set", "table", "then", "transaction", "union", "unique", "update", "values", "view",
  "when", "where", "with",
].join("|");

/** Every family, so callers and tests can iterate without a hardcoded list. */
export const LANGUAGES = ["clike", "hash", "json", "sql", "css", "markup"] as const;

/**
 * Exported only so `highlight.test.ts` can count capture groups and hold the
 * non-capturing-group rule above. Nothing else should read it.
 */
export const GRAMMARS: Record<Language, Grammar> = {
  clike: {
    flags: "gm",
    rules: [
      { kind: "comment", source: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/` },
      { kind: "string", source: `${LINE_STRINGS}|` + String.raw`\x60(?:\\.|[^\x60\\])*\x60` },
      // Preprocessor lines read as keywords; they are the closest thing C has.
      { kind: "keyword", source: String.raw`#[ \t]*(?:include|define|ifdef|ifndef|endif|pragma|undef|elif|if|else)\b` },
      { kind: "number", source: NUMBER },
      { kind: "keyword", source: String.raw`\b(?:${CLIKE_KEYWORDS})\b` },
    ],
  },
  hash: {
    flags: "gm",
    rules: [
      { kind: "comment", source: String.raw`#[^\n]*` },
      { kind: "string", source: String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|` + LINE_STRINGS },
      // A TOML/INI section header. Tight enough not to catch a Python list that
      // happens to start a line.
      { kind: "keyword", source: String.raw`^[ \t]*\[[A-Za-z_][\w.\- ]*\][ \t]*$` },
      { kind: "number", source: NUMBER },
      { kind: "keyword", source: String.raw`\b(?:${HASH_KEYWORDS})\b` },
    ],
  },
  json: {
    flags: "gm",
    rules: [
      { kind: "comment", source: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/` },
      // Property names before plain strings, so a key and its value differ.
      { kind: "key", source: String.raw`"(?:\\.|[^"\\])*"(?=[ \t]*:)` },
      { kind: "string", source: String.raw`"(?:\\.|[^"\\])*"` },
      { kind: "number", source: String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b` },
      { kind: "keyword", source: String.raw`\b(?:true|false|null)\b` },
    ],
  },
  sql: {
    flags: "gmi",
    rules: [
      { kind: "comment", source: String.raw`--[^\n]*|\/\*[\s\S]*?\*\/` },
      // SQL escapes a quote by doubling it, not with a backslash.
      { kind: "string", source: String.raw`'(?:''|[^'])*'` },
      { kind: "number", source: NUMBER },
      { kind: "keyword", source: String.raw`\b(?:${SQL_KEYWORDS})\b` },
    ],
  },
  css: {
    flags: "gm",
    rules: [
      { kind: "comment", source: String.raw`\/\*[\s\S]*?\*\/` },
      { kind: "string", source: LINE_STRINGS },
      { kind: "keyword", source: String.raw`@[\w-]+` },
      // Properties are matched at line start rather than after `{` or `;`,
      // which would need a variable-length lookbehind — still absent from
      // enough phone browsers to be worth avoiding. Formatted CSS puts one
      // declaration per line, so this catches them; the cost is that `a` in
      // `a:hover` colours too.
      { kind: "key", source: String.raw`^[ \t]*[-\w]+(?=[ \t]*:)` },
      { kind: "number", source: String.raw`#[0-9a-fA-F]{3,8}\b|\b\d[\d.]*(?:px|rem|em|ex|ch|%|vh|vw|vmin|vmax|s|ms|deg|turn|fr|pt)?\b` },
    ],
  },
  markup: {
    flags: "gm",
    rules: [
      { kind: "comment", source: String.raw`<!--[\s\S]*?-->` },
      { kind: "keyword", source: String.raw`<!DOCTYPE[^>]*>|<\/?[A-Za-z][\w:.-]*` },
      { kind: "string", source: String.raw`"[^"]*"|'[^']*'` },
      { kind: "key", source: String.raw`[\w:.-]+(?=[ \t]*=)` },
    ],
  },
};

/** Compiled alternations, built once per family and reused for every block. */
const scanners = new Map<Language, RegExp>();

function scanner(language: Language): RegExp {
  let re = scanners.get(language);
  if (!re) {
    const { flags, rules } = GRAMMARS[language];
    re = new RegExp(rules.map((r) => `(${r.source})`).join("|"), flags);
    scanners.set(language, re);
  }
  return re;
}

/**
 * Splits text into coloured runs and plain runs, preserving every character.
 *
 * Leftmost-match does the hard part: a `#` inside a string and a quote inside a
 * comment both resolve correctly without any ordering rules, because whichever
 * construct *starts* first wins the position.
 */
export function tokenize(text: string, language: Language | null): Token[] {
  if (!text) return [];
  if (!language) return [{ kind: "plain", value: text }];

  const { rules } = GRAMMARS[language];
  const re = scanner(language);
  re.lastIndex = 0;

  const tokens: Token[] = [];
  let last = 0;

  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      // A rule that can match nothing would spin here forever.
      re.lastIndex++;
      continue;
    }
    if (m.index > last) tokens.push({ kind: "plain", value: text.slice(last, m.index) });

    let kind: TokenKind = "plain";
    for (let g = 1; g <= rules.length; g++) {
      if (m[g] !== undefined) {
        kind = rules[g - 1]!.kind;
        break;
      }
    }
    tokens.push({ kind, value: m[0] });
    last = m.index + m[0].length;
  }

  if (last < text.length) tokens.push({ kind: "plain", value: text.slice(last) });
  return tokens;
}

/* ------------------------------ which language ----------------------------- */

const BY_EXTENSION: Record<string, Language> = {
  ts: "clike", tsx: "clike", js: "clike", jsx: "clike", mjs: "clike", cjs: "clike", mts: "clike",
  java: "clike", c: "clike", h: "clike", cpp: "clike", cc: "clike", cxx: "clike", hpp: "clike",
  cs: "clike", go: "clike", rs: "clike", swift: "clike", kt: "clike", kts: "clike", php: "clike",
  scala: "clike", dart: "clike", proto: "clike", gradle: "clike", groovy: "clike", zig: "clike",
  m: "clike", mm: "clike", glsl: "clike",

  py: "hash", pyw: "hash", rb: "hash", sh: "hash", bash: "hash", zsh: "hash", fish: "hash",
  yaml: "hash", yml: "hash", toml: "hash", ini: "hash", cfg: "hash", conf: "hash", env: "hash",
  mk: "hash", pl: "hash", r: "hash", ex: "hash", exs: "hash", nim: "hash", jl: "hash", tf: "hash",

  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  sql: "sql", psql: "sql", mysql: "sql",
  css: "css", scss: "css", sass: "css", less: "css", styl: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", xhtml: "markup", plist: "markup",
  vue: "markup", svelte: "markup",
};

/** Extensionless files people actually drop. Compared lower-cased. */
const BY_FILENAME: Record<string, Language> = {
  dockerfile: "hash", makefile: "hash", gemfile: "hash", rakefile: "hash", procfile: "hash",
  brewfile: "hash", vagrantfile: "hash", justfile: "hash", cmakelists: "hash",
  ".env": "hash", ".gitignore": "hash", ".dockerignore": "hash", ".bashrc": "hash",
  ".zshrc": "hash", ".profile": "hash", ".editorconfig": "hash", ".npmrc": "hash",
  ".gitconfig": "hash", ".gitattributes": "hash",
};

/**
 * Extensions that are known *and* known to be prose. Listed so they stop at the
 * filename and never reach the sniffer — a `.md` full of `import` lines in
 * prose has no business being coloured like code.
 */
const PLAIN_EXTENSIONS = new Set(["txt", "md", "markdown", "rst", "log", "csv", "tsv", "text"]);

/** `undefined` means "no opinion, go and sniff"; `null` means "leave it plain". */
function fromFilename(filename: string): Language | null | undefined {
  const base = filename.toLowerCase().split(/[\\/]/).pop() ?? "";
  if (base in BY_FILENAME) return BY_FILENAME[base];

  const dot = base.lastIndexOf(".");
  // A leading dot is the whole name (`.env`), not an extension.
  if (dot <= 0) return undefined;

  const ext = base.slice(dot + 1);
  if (PLAIN_EXTENSIONS.has(ext)) return null;
  return BY_EXTENSION[ext];
}

/** Cheap enough to run before `JSON.parse`, and rules out almost everything. */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  const opens = trimmed.startsWith("{") || trimmed.startsWith("[");
  const closes = trimmed.endsWith("}") || trimmed.endsWith("]");
  if (!opens || !closes) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * What an unlabelled paste is, guessed from its opening.
 *
 * Every test here demands a *structural* signal — an arrow, a trailing
 * semicolon, a shebang, a real `JSON.parse` — never a bare keyword. Prose is
 * full of "if", "for" and "return", and a paragraph of English wearing syntax
 * colours would look broken in a way plain text never does. Guessing nothing is
 * the safe failure, so the sniffer is built to reach it.
 */
function sniff(text: string): Language | null {
  const head = text.slice(0, 2000);

  if (/^#!/.test(head)) return /\b(?:node|deno|bun)\b/.test(head.slice(0, 200)) ? "clike" : "hash";
  if (/^\s*<\?php/.test(head)) return "clike";
  if (/^\s*<(?:!DOCTYPE|!--|[a-zA-Z][\w:.-]*[\s>/])/.test(head)) return "markup";
  if (looksLikeJson(text)) return "json";
  if (/^\s*(?:SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW|DATABASE)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX)|WITH\s+\w+\s+AS)/i.test(head)) return "sql";
  if (/^[ \t]*(?:def|class)\s+\w+[\s(:]|^[ \t]*(?:import|from)\s+[\w.]+|if\s+__name__\s*==/m.test(head)) return "hash";
  if (/^[ \t]*(?:FROM|RUN|COPY|CMD|ENTRYPOINT|WORKDIR|EXPOSE)\s+\S/m.test(head)) return "hash";
  // `export` is deliberately narrowed to its shell shape (`export KEY=value`).
  // Bare `export ` at a line start is far more often the JavaScript keyword,
  // and matching it here would send every ES module to the shell grammar.
  if (/^[ \t]*(?:\$ |sudo |npm |bun |yarn |pnpm |git |docker |cd |curl |ssh |apt |brew |systemctl |export[ \t]+[A-Za-z_]\w*=)/m.test(head)) return "hash";
  // CSS before C-like: a rule block also ends its lines with semicolons.
  if (/\{[^{}]*[-\w]+[ \t]*:[^{}]+;/.test(head)) return "css";
  if (/=>|;[ \t]*$|^[ \t]*(?:const|function|import|export|class|interface|enum|package|fn|func|impl|struct|public\s+class|#include)\s/m.test(head)) return "clike";
  return null;
}

/**
 * The language a block should render as, or null for plain.
 *
 * A filename wins outright — it is a fact, where a sniff is a guess — and that
 * includes its right to say "this is prose, leave it alone".
 */
export function languageFor(filename: string | null, text: string): Language | null {
  if (text.length > MAX_HIGHLIGHT_CHARS) return null;
  if (filename) {
    const named = fromFilename(filename);
    if (named !== undefined) return named;
  }
  return sniff(text);
}

/* -------------------------------- rendering -------------------------------- */

/** A coloured run, already split into link and non-link pieces. */
export interface RichToken {
  kind: TokenKind;
  segments: Segment[];
}

/**
 * Composes the two passes. Highlighting runs first and linking runs *inside*
 * each token, which puts links exactly where they belong in code — comments and
 * string literals — without either pass having to know about the other.
 *
 * `linkify` can only ever produce a link from `http://` or `https://`, so the
 * cheap `includes` skips it for the thousands of one-word tokens a code block
 * is mostly made of.
 */
export function richTokens(text: string, language: Language | null): RichToken[] {
  return tokenize(text, language).map((token) => ({
    kind: token.kind,
    segments: token.value.includes("://")
      ? linkify(token.value)
      : [{ kind: "text" as const, value: token.value }],
  }));
}
