# Pastebin

A LAN-hosted room where people drop text for each other to copy. One Bun
process on your PC; everyone else opens `http://<your-IP>:3000`.

Design and decisions: [`docs/01-design.md`](docs/01-design.md).

## Run it (the actual use case)

```bash
bun install && bun run serve
```

`serve` builds the client and starts the server, which serves the built page
*and* the WebSocket on one port, bound to `0.0.0.0`. On boot it prints your LAN
addresses — hand one to anyone on the same Wi-Fi.

Environment: `PORT` (3000), `DB_PATH` (`pastebin.sqlite`, relative to
`apps/server`), `ROOM_EMPTY_GRACE_MINUTES` (5), `ROOM_TTL_DAYS` (30, a backstop
only — see below).

To also hand out the command-line client, run this once (and again whenever
`PROTOCOL_VERSION` moves) — see *Command line* below:

```bash
bun run build:cli
```

## Room lifetime

Rooms are meant to last a session. **A room and everything in it is deleted
5 minutes after the last person disconnects**, and the picker screen states the
real figure so it can't drift from the server's. Anyone in a room can also end
it immediately with **Delete room now** on the picker.

Two things worth knowing:

- **Locking your phone counts as leaving** — phones close WebSockets when the
  screen sleeps. If every device is away for longer than the grace period, the
  room goes. Raise `ROOM_EMPTY_GRACE_MINUTES` if that bites.
- **Restarting the server does not destroy rooms.** At boot every room is empty
  by definition, so the server stamps them rather than sweeping them, handing
  everyone a full grace period to reconnect.

`ROOM_TTL_DAYS` is a separate backstop that catches a room whose socket leaked
and which therefore looks permanently occupied. It should never fire in normal
use.

## Develop

```bash
bun run dev:server
```

```bash
bun run dev:client
```

Two processes: Bun on `:3000`, Vite on `:5173` proxying `/ws` to it. Vite runs
with `--host`, so the dev build is reachable from a phone too — which matters,
see below.

```bash
bun test
```

```bash
bun run check
```

## What it does

- Create a room, get a 4-letter code. Share the code, the `/r/CODE` link, or the
  QR — which offers your LAN address even when you're looking at it on
  localhost.
- A room holds papers; a paper holds **blocks**. One block = one paste = one
  author. No shared cursor and no merge conflicts, by construction.
- One paper goes straight through; two or more show a card picker. Anyone can
  add, rename or delete a paper — except the last one.
- Every text block has a copy button; the paper has a copy-all.
- **Links are clickable**, and each has an opt-in `preview` that fetches the
  page's title and description. Nothing is fetched just because a link was
  pasted.
- **Whiteboards**: a paper can be a shared drawing surface instead of a feed —
  brush, eraser, and a **Clear mine**. See *Whiteboards* below.
- **Images and GIFs**: Ctrl+V a screenshot, drop a file, or use the picker.
- **Text and code files**: drop a `.ts`, a `.csv`, a bare `Dockerfile` — it
  becomes an ordinary text block, labelled with the filename it came from. See
  *Dropping a file* below for what's accepted and how big it can be.
- You can edit and delete your own blocks. Nobody else's — enforced server-side.
- Rooms are session-scoped: gone 5 minutes after the last person leaves, or
  immediately via **Delete room now**. See *Room lifetime* below.
- **A command-line client**, for anyone who lives in a terminal: `cat error.log
  | pastebin post`. Downloaded from the server itself. See *Command line*.

## Command line

`apps/cli` is a second client for the same WebSocket protocol, compiled into
one file per platform and **served by the server itself** at `/cli/<file>`.
The share panel shows the exact two lines for the address you picked, with a
copy button that hands over both:

```bash
curl.exe -o pastebin.exe http://192.168.1.5:3000/cli/pastebin-windows-x64.exe
.\pastebin join ABCD --server http://192.168.1.5:3000
```

On macOS and Linux it is `curl -o pastebin … && chmod +x pastebin`, then
`./pastebin join …`. After that:

```bash
cat error.log | pastebin post
```

```bash
pastebin post main.ts
```

```bash
pastebin get > snippet.txt
```

```bash
pastebin tail
```

`post` takes a file or stdin, decoded with the same rules as a dropped file
(BOM, UTF-16, CRLF, the 100,000-character cap) and refused *before* it connects,
so a bad file never costs a round trip and an unreachable server never eats a
paste. A file's name rides along as the block's label, so it gets syntax
colours in the browser; `--as error.log` labels stdin. `get` prints the newest
text block to stdout byte for byte — a pipe or a file gets exactly the text, and
only a terminal gets a final newline added — and `--last 3` prints the newest
three a blank line apart. `tail` prints new blocks as they arrive, headers on
stderr and text on stdout, and reconnects if the server blinks. `papers`,
`use <title>`, `leave` and `status` do what they say; `pastebin --help` has the
rest.

**Building it.** `serve` does not build the CLI. This does:

```bash
bun run build:cli
```

It cross-compiles all four targets into `apps/cli/dist` — Bun downloads each
foreign runtime the first time, so the first run needs internet, and after that
it is a few seconds per target. The share panel only lists builds that exist on
disk, so an unbuilt platform is simply absent rather than a broken link. Each
file is 60–100 MB because it embeds the Bun runtime, which a LAN does not
notice. `bun run build:cli -- --host` builds only your own platform.

Four decisions worth knowing:

- **Joining twice is resuming.** Every `room.join` mints a new member and rooms
  cap at 32, so `pastebin join ABCD` on a room you already hold an identity for
  resumes it instead of adding a ghost. `--fresh` mints a new one on purpose.
  Identities live in `%APPDATA%\pastebin\sessions.json` on Windows and
  `~/.config/pastebin/sessions.json` elsewhere (mode 0600 — it holds tokens),
  keyed by room code exactly like the browser's `localStorage`. `--server` is
  remembered after the first join, so a class types it once.
- **A one-shot command counts as leaving.** `post` connects, opens the paper,
  posts, waits for its own block to come back, and exits — so if the CLI were
  the only member, the 5-minute timer would start when it exits. In practice the
  browser tab that created the room holds it open, and a running `tail` counts
  as present. There is deliberately no daemon.
- **Which paper.** With one text paper there is nothing to choose. With more,
  `use <title>` remembers one, `--paper <title>` overrides for a single command,
  and titles match case-insensitively by unique prefix because the ids are uuids
  nobody will type. Whiteboards are never a target.
- **Stdout is for text only.** Every status line goes to stderr, so
  `pastebin get | clip` and `pastebin tail | tee log` stay clean. Exit codes: 0,
  1 when the server refused or is unreachable, 2 for a usage mistake.

**A stale binary can't drift silently.** The CLI sends the shared
`PROTOCOL_VERSION`, so after a protocol bump an old download is refused with
`VERSION_MISMATCH` — and prints the download line for the server that refused
it, rather than the server's own "reload the page". The download is served with
`cache-control: no-cache` for the same reason.

Platform notes: it is `curl.exe`, not `curl`, in Windows PowerShell, which
aliases the bare name to Invoke-WebRequest. A curl download carries no
Mark-of-the-Web or quarantine attribute, so neither SmartScreen nor Gatekeeper
objects — but Defender has been known to flag Bun-compiled executables, so try
one student machine before the class. The cross-compiled macOS builds are
unsigned; verify one on a real Mac, and if it dies with `Killed: 9`, sign it
there with `codesign -s - pastebin`.

## Dropping a file

A dropped file takes one of two routes, and the two have very different limits.

**Images** (PNG, JPEG, GIF, WebP) go over HTTP to `/api/upload` and are capped at
**10 MB**. **Everything else** has to decode as text, and becomes a normal block
— copyable, editable, part of copy-all — capped at **100,000 characters**, which
is the same ceiling a Ctrl+V paste has always had. That's roughly 100 KB of
ASCII, or ~2,500 lines of code: hand-written source fits easily, but a
`package-lock.json`, a minified bundle or a log file will not. Those are
**refused by name** — `bundle.min.js is 481,203 characters — the cap is
100,000` — rather than posted half-complete. Nothing is ever truncated.

The cap is a character count and not a byte count, so a file of emoji is
measured the same way the server measures it. A file is refused on `size` before
it is read at all when it couldn't possibly fit, so dropping something enormous
costs nothing.

Raising `MAX_BLOCK_CHARS` is tempting and mostly wrong: opening a paper sends
every block's full text (`Room.ts`, `sendPaperState`), so each stored file is
paid for again on every reconnect — and phones reconnect every time the screen
wakes. The cap is a limit on that snapshot more than on any one paste.

There is deliberately **no extension allowlist**. Browsers report no MIME type at
all for `.ts`, `.rs`, `.toml` or an extensionless `Dockerfile`, so a type check
would reject exactly the files worth dropping. `lib/textFile.ts` decodes the
bytes instead: a BOM picks UTF-8 or UTF-16 (so a Notepad "Unicode" save is
readable rather than mojibake), and otherwise the bytes must be valid UTF-8 with
no NUL in them. A `.zip` or a `.pdf` fails that and is refused, which is the
whole reason the check exists — a binary decoded loosely becomes a block of
garbage nobody can tell is garbage until they paste it.

Two smaller things: CRLF is normalised to LF on the way in, because a stray
carriage return is invisible in the feed and then rides along into everyone's
clipboard; and the filename is a **label only** — Copy hands over the file's
contents and nothing else, so what you paste is what was in the file.

## Whiteboards

**+ New whiteboard** on the picker makes a paper that holds strokes instead of
pastes. A paper's kind is fixed at creation — a board half-converted into a feed
is a state nobody asked for.

The design rests on one line: **a stroke is a block**. That single decision hands
the feature its hardest parts already built — author-only deletion enforced at
`Room.ownedBlock`, `block.added`/`block.removed` deltas, `rev` gap detection,
snapshot-on-open, and the palette colour `identity.ts` already assigns each
member, so everyone draws in their own colour with no new column and you can see
at a glance who drew what. A stroke's colour is deliberately **not** stored on
the stroke: it rides on the block as `authorColor`, so the two can never
disagree and nobody can post a stroke claiming a colour that isn't theirs.

**Clear mine** is therefore not the expensive thing it sounds like. It is one
`DELETE … WHERE paper_id = ? AND author_id = ?` with one `rev` bump, and the
`author_id` in that WHERE clause *is* the permission check — there is no way to
call it and touch someone else's row. The broadcast names the author rather than
listing block ids, so it stays about sixty bytes whether five strokes went or
five hundred, and every client drops that author's own. There is no clear-all:
anyone wanting a blank board can add one, and that is already a single tap.

**The eraser is a stroke you own**, drawn `destination-out`. This is why the
canvas is never filled with a background colour — the paper colour is CSS behind
a transparent canvas, so erasing punches through to it. Fill the canvas and you
get a hole through the card instead. Nothing is actually destroyed by erasing:
the strokes underneath are still blocks, so when the erasure's author clears
their strokes, **the work under it comes back** — verified, not assumed.

**One shared coordinate space.** Strokes are integers in a fixed 1600×1200 board
and each viewer letterboxes it to fit, which is the only way a phone and a
desktop see the same drawing rather than different crops of one. Two things in
`DrawView.svelte` look like styling and are not:

- The canvas is positioned absolutely and sized by JavaScript. A canvas laid out
  by its own content box makes writing `canvas.width` change the layout, which
  fires the `ResizeObserver`, which writes it again — the browser throttles that
  loop and strands the backing store at the wrong size. Separately, CSS
  `aspect-ratio` does not shrink a definite width when `max-height` clamps, so
  the letterboxing simply doesn't happen and the board loses its bottom.
- `touch-action: none` on the canvas. Without it a finger drag scrolls the feed
  instead of drawing — and only on touch devices, so a mouse never shows it.

The board is 4:3 landscape, which suits a desktop and leaves a portrait phone
some empty space above and below. It is one constant in `limits.ts` if you would
rather favour the phone.

**Wire cost.** Strokes are simplified with Ramer–Douglas–Peucker before posting:
a 161-point drag stores as 40 points and 351 bytes. That matters because every
stroke is re-sent to every joiner, and phones rejoin whenever the screen wakes.
`MAX_STROKES_PER_PAPER` is 5000, separate from the 1000 that was written for
pastes — a sketch would spend that in a sitting.

## Syntax colours, and why they're hand-written

`lib/highlight.ts` is a ~200-line tokenizer with no dependencies. That is not
frugality for its own sake — **it is the only shape that fits the rule in
`BlockText.svelte`**: block text is untrusted, so it renders through Svelte
interpolation and never `{@html}`. Prism, highlight.js and Shiki all lead with an
API that returns an HTML *string*, and rendering one of those would put whatever
someone on the Wi-Fi pasted straight into the DOM. Their tokenizer APIs would be
safe, but at that point you are paying 12–100 kB for a token stream you can
produce in a fifth of that. It costs **~3 kB gzipped**.

Grammars are syntax *families*, not languages: one C-like mode covers
TypeScript, Go, Rust, Java, C# and Swift on a shared keyword set, alongside
`hash` (Python, Ruby, shell, YAML, TOML, Dockerfile), `json`, `sql`, `css` and
`markup`. So `type` colours in Go where it isn't quite a keyword. On a board
where you glance at a block and copy it, nobody has ever noticed.

**Two invariants hold it together.** Tokens must reassemble into the exact input
— this is code, and a highlighter that drops a character has corrupted a command
someone is about to run — and colour never changes metrics: no bold, no resize,
nothing that shifts a column in a `white-space: pre` block. Both are tested, the
first across every grammar and a corpus of deliberately broken input.

**Which language** comes from the filename when there is one, and a filename can
also say *"this is prose, leave it alone"* — a `README.md` full of examples is
not a code file. A typed paste has no filename, so it is sniffed, and every
signal there is **structural** (an arrow, a trailing semicolon, a shebang, a real
`JSON.parse`) rather than a keyword. English is full of "if", "for" and "return",
and a paragraph wearing syntax colours looks broken in a way plain text never
does — so the sniffer is built to guess nothing rather than guess wrong.

Blocks over **50,000 characters render plain** (`MAX_HIGHLIGHT_CHARS`). Since
blocks collapse at 20 lines the usual cost is nothing; the cutoff exists for the
moment someone expands a dropped file. For reference, expanding a 33k-character
block costs ~80 ms on a desktop — the constant is one line if you want it lower.

## Editing the name pool

The suggested name on the landing page comes from
[`data/names.json`](data/names.json) — two lists, `adjectives` and `names`, one
of each per suggestion. The server re-reads the file **per request**, so edit it
and refresh the page; no rebuild, no restart. A malformed file falls back to a
built-in list rather than leaving the name field empty.

Keep pairings under `MAX_NAME_CHARS` (32). The generator retries and finally
truncates rather than suggesting a name the server would reject, but a pool of
consistently over-long pairings will produce cut-off names.

## Two things that fetch, and why they're careful

**Link previews** make *your PC* fetch a URL someone pasted. Since the server
sits inside your LAN, `linkPreview.ts` only allows http(s), resolves the
hostname and requires every resolved address to be public, and follows redirects
by hand so hop two gets the same check as hop one. og:image thumbnails are
proxied through the server rather than hot-linked, so no viewer's browser is
handed an arbitrary URL. Previews are opt-in per link.

**Image uploads** are authenticated with the same member token the socket uses,
capped at 10 MB, and typed by **magic bytes** rather than by the browser's
claimed content type — that check plus `X-Content-Type-Options: nosniff` is what
makes serving user uploads from your own origin safe.

## The one trap worth knowing about

`navigator.clipboard` only exists in a **secure context**. `http://localhost`
qualifies; **`http://192.168.1.x` does not** — over the LAN the API is literally
`undefined`, which is verified, not theoretical.

So `src/lib/clipboard.ts` checks `isSecureContext` synchronously and falls back
to a hidden textarea plus `document.execCommand("copy")`. Two consequences for
anyone changing that file:

- The bug is **invisible on localhost**. Test copy from a phone, or from the LAN
  IP in a desktop browser — never only from `localhost`.
- The fallback needs a real user gesture. Don't put an `await` in front of it.

The same limit is why **images offer Download rather than Copy**: copying image
bytes needs `navigator.clipboard.write()`, which is also secure-context only,
and unlike text there is no `execCommand` fallback for it.

## Layout

```
apps/server        Elysia + WebSocket + bun:sqlite. Store.ts holds every query;
                   linkPreview.ts holds the outbound-fetch guard.
apps/client        Svelte 5 + Vite + Tailwind 4.
apps/cli           The command-line client: the same protocol, compiled into one
                   file per platform (build.ts) and served at /cli/<file>.
packages/protocol  zod wire contract, shared by all three. PROTOCOL_VERSION and
                   the CLI build list live here.
data/names.json    Editable word pool for suggested names.
```
