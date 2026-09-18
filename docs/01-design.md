# Pastebin — design

A LAN-hosted room where people drop text for each other to copy. Runs as one
Bun process on the developer's PC; everyone else reaches it at
`http://<PC-LAN-IP>:3000`.

Not a chat, not a document editor. The unit of work is **a block of text with
one owner that anyone can copy in one tap.**

## 1. Decisions (interview, 2026-08-04)

| # | Question | Decision |
|---|---|---|
| 1 | How text lives on a paper | **Stack of paste blocks.** Each paste is its own block, one author, own copy button. No shared cursor, no merge, no CRDT. |
| 2 | Persistence | **SQLite is the source of truth.** Rooms, papers and blocks survive a server restart. ~~Swept after a 30-day TTL.~~ **Revised in M7 (§9): rooms are deleted 5 minutes after the last person leaves.** |
| 3 | Who can edit/delete a block | **Author only.** Everyone else's blocks are read-only. Server-enforced against the session token, not the client. |
| 4 | Who manages papers | **Anyone.** Room is born with one paper. Add/rename freely; delete asks first. |
| 5 | Composer | **Fixed at the bottom** of the paper, chat-style. `Ctrl/⌘+Enter` posts. |
| 6 | Content rendering | **Monospace, whitespace preserved, no markdown.** Nothing ever mangles a command. Long lines scroll inside their block. |
| 7 | Tech shape | **YAWBG's monorepo shape** — `apps/server` (Elysia + WS + bun:sqlite), `apps/client` (Svelte 5 + Vite + Tailwind 4), `packages/protocol` (zod wire contract). |
| 8 | Joining | QR code in the room **and** shareable `/r/CODE` URL. |
| 9 | Identity | Name field on the landing page, **pre-filled** with an auto identity (`Teal Fox`), editable, remembered. |

### Where this deliberately diverges from YAWBG

- **No phases, no host, no lobby.** A room is a container, not a game. There is
  no `Phase`, no `★ host-only` intent tier, no start button.
- **SQLite holds live state, not just records.** In YAWBG, SQLite holds decks
  and finished-game logs while live state stays in RAM and a restart dropping
  in-progress games is accepted. Here that trade is inverted: the *whole point*
  is that text you pasted is still there tomorrow. Every mutation writes through
  to SQLite before it broadcasts.
- ~~**Rooms are not deleted when empty.**~~ **Reversed in M7 — see §9.** This
  originally read that YAWBG's `onEmpty: () => rooms.delete(code)` was "exactly
  the wrong behaviour for a paste bin". That was wrong about the product: the
  user wants rooms to last a session, not a month. The mechanism still differs —
  emptiness starts a timer rather than deleting outright, so a phone locking its
  screen doesn't destroy the room — but the *intent* is now YAWBG's.
- **Session lives in `localStorage`, not `sessionStorage`.** YAWBG scopes a seat
  to a tab on purpose. Here, closing the tab must not cost you ownership of what
  you pasted.

## 2. Model

```
Room 1 ──── * Paper 1 ──── * Block
 │
 └──── * Member (identity + presence)
```

### Room
- `code` — 4 uppercase letters, same alphabet and collision-retry loop as
  `RoomManager.generateCode()`.
- Created with exactly one paper, titled `Paper 1`.
- No password. On a home LAN, a 4-letter code is the whole access control. Said
  plainly here so it is a decision and not an oversight.

### Member
- `id`, `token` (bearer secret, never broadcast), `name`, `color`, `joinedAt`.
- Colors are assigned **round-robin from a fixed palette by join order**, not
  hashed from the name — a hash collides and hands two people in the same room
  the same chip. Palette is 12 long; member 13 wraps and reuses.
- The auto name is `<ColorName> <Animal>` (`Teal Fox`, `Amber Otter`) so the
  chip color and the name agree on first sight. Renaming keeps the color.
- Membership is persistent (the row is how you still own your blocks tomorrow);
  *presence* (`connected`) is live socket state and is not persisted.

### Block
- `id`, `paperId`, `authorId`, `authorName`, `authorColor`, `text`, `createdAt`,
  `editedAt | null`.
- **Author name and color are snapshotted onto the block**, not joined at read
  time — the same lesson as YAWBG's `ProposalRecord.playerName`: an author who
  never comes back still has to render.
- Immutable to everyone but the author. `block.edit` and `block.delete` check
  `authorId === session.memberId` in the room handler.

### Paper
- `id`, `roomId`, `title`, `createdAt`, `rev`.
- `rev` increments on every block mutation in that paper. It is how a client
  knows it missed a delta (§4).

## 3. Screens

### Landing — `/`
Name field (pre-filled, editable) → `Create room`; divider; 4-letter code field
→ `Join room`. Structurally YAWBG's `Home.svelte`, minus the ready-gating on an
empty name since the name is never empty. If a prior session exists, a "rejoin
ROOM" line sits above, as YAWBG does.

### Room — `/r/CODE`
- **One paper (the default):** redirect straight into it. You never see a picker
  you didn't ask for.
- **Two or more:** card grid — title, block count, last-activity, a 2-line text
  preview, plus a `+ New paper` card.

### Paper — `/r/CODE/p/PAPER_ID`
```
┌────────────────────────────────────────────┐
│ ← Papers   Paper 1        (R)(A)(T)   [QR] │  header: back, title, presence, QR
├────────────────────────────────────────────┤
│  (R) Ryu                 14:02        [⧉]  │
│  npm install -g bun                        │
│                                            │
│  (A) Ann                 14:05  edited [⧉] │
│  ssh root@192.168.1.40                     │
│                                     ⋮ scroll│
├────────────────────────────────────────────┤
│  Paste here…                               │
│                          Ctrl+Enter  [Post]│
└────────────────────────────────────────────┘
```
- Author chip = colored circle, first letter of the name, at the **start** of the
  block's meta row.
- Every block has a copy button; the header carries a **Copy all** that
  concatenates the paper's blocks separated by blank lines.
- Your own blocks get an `⋯` menu (Edit / Delete). Nobody else's does.
- Blocks over ~20 lines collapse to a preview with `Show more`. Copy always
  copies the **full** text, collapsed or not.
- Feed auto-scrolls to the bottom on a new block **only when you are already at
  the bottom** — otherwise a "↓ new paste" pill appears, so a long block you are
  reading is never yanked away.

## 4. Protocol

Same shape as `@yawbg/protocol`: zod schemas, discriminated union on `type`,
`PROTOCOL_VERSION` asserted as a literal in a test so bumping it fails by design.

**Intents (client → server)**

| Intent | Payload | Notes |
|---|---|---|
| `room.create` | `memberName` | Creates room + `Paper 1` |
| `room.join` | `code, memberName` | |
| `session.resume` | `code, memberId, token` | Reclaims identity, not a seat |
| `member.rename` | `name` | Renames forward only; existing blocks keep their snapshot |
| `paper.open` | `paperId` | Subscribes this socket to one paper's stream |
| `paper.create` | `title` | |
| `paper.rename` | `paperId, title` | |
| `paper.delete` | `paperId` | Refused if it is the room's last paper |
| `block.post` | `paperId, text` | |
| `block.edit` | `blockId, text` | Author only |
| `block.delete` | `blockId` | Author only |

All carry `protocolVersion`.

**Messages (server → client)**

| Message | Payload |
|---|---|
| `session.created` | `code, memberId, token, name, color` |
| `room.state` | `code, papers[] (id,title,blockCount,lastActivity,preview), members[] (id,name,color,connected)` |
| `paper.state` | `paperId, rev, blocks[]` — full snapshot, on open/resume |
| `block.added` / `block.updated` / `block.removed` | `paperId, rev, block \| blockId` |
| `error` | `code, message` |

**Why deltas and not YAWBG's whole-state-every-frame.** A room state frame is
tiny; a paper full of 100 KB code pastes is not, and rebroadcasting all of it on
every keystroke-sized change would be absurd on a phone over Wi-Fi. So: a full
`paper.state` on open, deltas after, each stamped with the paper's new `rev`. A
client that receives `rev` ≠ `lastRev + 1` knows it missed one and re-requests a
snapshot. That check is the entire cost of the optimization.

**Error codes:** `BAD_MESSAGE`, `ROOM_NOT_FOUND`, `SESSION_INVALID`,
`VERSION_MISMATCH`, `NOT_AUTHOR`, `PAPER_NOT_FOUND`, `LAST_PAPER`,
`TOO_LARGE`, `ROOM_FULL`.

## 5. Limits

| Thing | Cap | On breach |
|---|---|---|
| Block text | 100 KB | `TOO_LARGE`, composer warns before you post |
| Blocks per paper | 1000 | Refuse; oldest are never silently dropped |
| Papers per room | 24 | Refuse |
| Members per room | 32 | `ROOM_FULL` |
| Room TTL | 30 days idle | Swept on startup and daily |

TTL and port are env-configurable (`ROOM_TTL_DAYS`, `PORT`, `DB_PATH`), matching
YAWBG's `index.ts` convention.

## 6. Running it on the LAN

**Production / the actual use case — one process, one port:**
the Bun server serves `apps/client/dist` as static files *and* the `/ws`
endpoint, listening on `0.0.0.0:3000`. Build once, then `bun start`, then
everyone opens `http://<PC-IP>:3000`. No Vite in the loop.

**Dev:** unchanged from YAWBG — `bun --watch` on the server, `vite --host` for
the client with the `/ws` proxy pointed at `127.0.0.1:3000` (not `localhost`;
Windows resolves it to `::1` while Bun listens on IPv4 — YAWBG's `vite.config.ts`
already carries this note).

### ⚠ The clipboard problem — the one real technical risk

`navigator.clipboard` is **only available in a secure context**. `http://localhost`
counts as secure; **`http://192.168.1.x` does not.** So on every device that is
not the host PC — i.e. every device this app exists for — `navigator.clipboard`
is `undefined` and the copy button, the entire point of the app, does nothing.

Plan: copy goes through one `copyText()` helper that tries
`navigator.clipboard.writeText` and falls back to a hidden `<textarea>` +
`document.execCommand("copy")`. `execCommand` is deprecated but is implemented
everywhere and works over plain HTTP, and the fallback path must be tested from
a phone on the LAN, not from `localhost` — on `localhost` the bug is invisible.

If the fallback ever proves flaky on a target device, the escape hatch is HTTPS
with a self-signed cert (every device then eats a certificate warning once). Not
building that unless it's needed.

## 7. Build order

| M | Scope | Done when | Status |
|---|---|---|---|
| **M0** | Monorepo, protocol skeleton, WS connect, SQLite schema, `/healthz` | Client shows "connected" | **built** |
| **M1** | Create/join/resume, identity + colors, landing page, presence row | Two browsers see each other in a room | **built** |
| **M2** | The paper: post/edit/delete, feed, composer, copy, monospace | A phone on the LAN copies text pasted from the PC | **built**, phone test outstanding |
| **M3** | Multi-paper: create/rename/delete, card grid, routing, one-paper redirect | Two papers, switching, deep links work | **built** |
| **M4** | QR, single-process static serve, TTL sweep, limits, mobile responsive | Restart the PC, room code still works | **built** |
| **M5** | Hyperlinks, on-demand link previews, name pool moved to a file | A pasted URL is clickable; preview shows the page's title | **built** |
| **M6** | Images and GIFs: upload, paste/drop/pick, thumbnails | Ctrl+V a screenshot on the PC, see it on the phone | **built** |
| **M7** | Session-scoped rooms, explicit room deletion | An empty room is gone 5 minutes later; Delete room ends it now | **built** |

M2 is the milestone that proves the product; the clipboard fallback is tested
there, from a real phone, not later.

### Notes from the M0–M2 build (2026-08-04)

- **The clipboard risk is confirmed, not hypothetical.** Measured in a browser
  at `http://10.110.193.173:3000`: `isSecureContext === false` and
  `navigator.clipboard === undefined`. The `execCommand` fallback returns `true`
  and selects the right text — *but only under a real user gesture*; called from
  an injected script with no gesture it returns `false`. So never put an `await`
  ahead of it, and never conclude anything about copy from a localhost test.
- **`M3` will bump `PROTOCOL_VERSION` to 2.** The paper CRUD intents were left
  out deliberately rather than shipped as intents that error — `paper.open` and
  `paper.refresh` are the only paper intents that exist today.
- **Don't take `.changes` from a cascading DELETE as a row count.** SQLite counts
  the cascade's own deletions in it, so sweeping one room that held one paper
  reported two. `sweepIdleRooms` counts with a SELECT first.
- **`resumeRoom` must only narrow the wanted paper, never clear it.** `/r/CODE`
  carries no paper id and the create/join flow lands there just after
  `session.created` already asked for the default paper; assigning `null` there
  orphaned the in-flight `paper.state` and the room hung on "Opening paper…"
  forever. *Superseded in M3*: `session.created` no longer opens anything, and
  the route decides after `room.state` arrives, so the race is gone by
  construction rather than by guard.

## 8. M3–M6 (2026-08-04)

### M3 — multi-paper

`PROTOCOL_VERSION` **2**. Adds `paper.create/rename/delete/close`; drops
`defaultPaperId` from `session.created`, because *which* paper you land on needs
the whole list and that list is already on `room.state`.

- **`paper.close` exists for bandwidth, not tidiness.** A socket that backed out
  to the picker kept its `conn.paperId`, so it went on receiving every delta for
  the paper it last viewed — and a delta carries a whole block, up to 100 KB.
  That is precisely the traffic the snapshot-plus-delta design exists to avoid.
- **The pass-through must fire on arrival only.** `/r/CODE` forwards into the
  paper when a room has exactly one. Doing that on *every* visit made the picker
  unreachable in a one-paper room — and since "+ New paper" lives on the picker,
  such a room could never gain a second paper at all. `forwardedFor` in
  `Room.svelte` is what makes an explicit request for the picker stick.
- Deleting a paper clears `conn.paperId` for everyone watching it, so no delta
  can be routed at a paper that no longer exists. Clients notice it left
  `room.state.papers` and fall back to the picker.

### M4 — QR and mobile

- **A QR of `location.origin` is a trap on the host PC.** There it encodes
  `http://localhost:3000`, which scans perfectly and then fails on the phone —
  worse than no QR. `GET /api/host` reports the server's LAN addresses so the
  panel can offer one that actually routes; link-local `169.254.x` is filtered
  out because it never does.
- QR is `qrcode-generator` (~15 KB, zero deps) rendered as one inline SVG path
  in module coordinates, ink-on-white with a 4-module quiet zone. Never invert
  it for a dark theme — an inverted QR does not scan.

### M5 — links, previews, name pool

- **Only `http(s)` is ever linkified.** Block text is untrusted by construction,
  so the set of schemes that can reach an `href` *is* the security surface.
  Matching nothing else means `javascript:` and `data:` can't get there and no
  sanitiser is needed. Rendering is plain interpolation — never `{@html}`.
- **`BlockText.svelte`'s `{#each}` is one line on purpose.** It renders inside a
  `<pre>`, so template indentation becomes real whitespace in someone's command.
  A formatter that "tidies" it corrupts pastes.
- **Previews are opt-in per link**, and everything in `linkPreview.ts` follows
  from the server sitting *inside* the LAN — the position that makes SSRF worth
  anything. Only http(s); the hostname is resolved and **every** address must be
  public; redirects are followed by hand so hop two is checked like hop one
  (`redirect: "follow"` would validate the first URL and then walk to
  127.0.0.1). The address check **fails closed** — anything it cannot identify
  as public is refused.
- **og:image is proxied, never hot-linked.** `<img src="{remote}">` would leak
  every viewer's IP to the site *and* route around the guard entirely, since the
  browser doing the fetching is the one inside the LAN.
- No `loading="lazy"` on preview thumbnails: they only exist after a click, so
  they are already lazy, and deferring a 56 px image in a scroll container is a
  reliable way to get one that silently never loads.
- Word lists live in `data/names.json`, re-read **per request** — "edit the file
  and restart" would have been a worse loop than the hardcoded array it replaced.
  A malformed file falls back to a built-in pool rather than yielding an empty
  name field, which would block both Create and Join.

### M6 — images

`PROTOCOL_VERSION` **3**. Blocks gain `kind: "text" | "image"` and a nullable
`media`; `block.postImage` is a separate intent from `block.post`.

- **Bytes go over HTTP, ids go over the socket.** Base64 in a JSON frame costs a
  third more bytes and would stall every other message behind a 10 MB payload.
  `/media/:id` also lets the browser cache the picture like any other image.
- **Two intents, not one with optional fields.** A payload where each half is
  `.optional()` can express "both" and "neither", which mean nothing, and then
  has to reject them at runtime.
- **The MIME comes from magic bytes, never from the client.** `File.type` is a
  claim. Storing arbitrary bytes and serving them back under an attacker-chosen
  content type from our own origin is stored XSS; sniffing is what makes serving
  uploads safe, together with `X-Content-Type-Options: nosniff`.
- **Upload is authenticated** with the same member id + token the socket uses.
  An open upload endpoint on a machine anyone on the Wi-Fi can reach is a free
  file host.
- **Images get Download, not Copy** — and this is not an oversight. Copying image
  bytes needs `navigator.clipboard.write()`, which is secure-context only, and
  unlike text there is no `execCommand` fallback. Over `http://<lan-ip>` it
  cannot work, so the UI doesn't pretend otherwise. Copy-all skips image blocks
  rather than emitting a `[image]` placeholder into something you'll paste into
  a shell.
- GIFs needed no work: animation is a property of the format.
- `blocks` gained columns on an existing database, and SQLite has no
  `ADD COLUMN IF NOT EXISTS` — `addColumnIfMissing` in `db.ts` is what stopped
  this from being "delete your pastebin.sqlite and start over".

## 9. M7 — ephemeral rooms and deletion (2026-08-04)

`PROTOCOL_VERSION` **4**. Adds `room.delete` and the `room.closed` broadcast.
**This reverses decision #2's lifetime**: rooms now last a session, not a month.

- **Emptiness, not idleness, drives the clock.** `rooms.emptied_at` is set when
  the last socket detaches and cleared when one attaches. It lives on the row
  rather than only in `conns`, because the expiry clock has to survive a process
  restart and a live socket set does not. `sweepExpiredRooms` matches only rows
  where it is non-null, so an occupied room is unreachable by the sweeper at any
  grace value, including zero.
- **A restart re-stamps rather than deletes.** At boot there are no sockets
  anywhere, so every room is empty by definition — deleting them all would make
  a mid-session restart catastrophic. `markAllRoomsEmpty()` stamps only rows that
  are still null, so a live room gets a full fresh grace period to reconnect
  while a room that went empty before the restart keeps its original deadline.
- **A new room is born with `emptied_at` set**, cleared a moment later when the
  creator's socket attaches. A create that never attaches therefore expires on
  schedule instead of lingering forever as a phantom occupied room.
- **The sweep tick scales with the grace** (`grace/2`, clamped to 1s–30s). A
  fixed 30s tick would make a deliberately short grace meaningless, since the
  room would outlive it by up to 30s regardless.
- **`room.closed` exists so the UI can explain itself.** Without it, a deleted
  room is only discovered when some later action fails with `ROOM_NOT_FOUND`.
  The client drops the stored session on receipt, so the landing page stops
  offering a dead code back.
- **Any member can delete**, like paper management. There is no host tier here
  and inventing one for a single button would be a bigger change than the
  button; rooms are session-scoped anyway, so the blast radius is a session.
- **The known cost, accepted deliberately:** phones close WebSockets when the
  screen locks, so a locked phone counts as leaving. If everyone's device sleeps
  for longer than the grace, the room goes. This is inherent to emptiness-based
  cleanup; `ROOM_EMPTY_GRACE_MINUTES` is the dial. The picker states the real
  server value — fetched, never hardcoded — so it can't quietly lie after
  someone changes the env var.
- **`MAX_NAME_CHARS` went 24 → 32.** The name pool is user-editable and the
  suggested name is `"<adjective> <name>"`; the shipped pool's longest pairing
  is 27 characters. At 24 the landing page would have pre-filled a name its own
  schema rejected. `compose()` also retries and finally truncates, so a future
  edit to `names.json` can't reintroduce the failure.
- `data/names.json`'s second list is `names`, not `animals` — it holds character
  names now, and a key that lies about its contents is worse than a rename.

## 10. M8 — command-line client (2026-09-18)

`PROTOCOL_VERSION` **unchanged**: nothing on the wire moved. `apps/cli` is a
third client of the existing contract, and the only server change is a route
that hands out the compiled binaries.

**A binary that speaks the socket, not REST for curl.** The alternative was
HTTP endpoints so students could `curl` a paste in with no install. That is a
second API surface to keep in step with the socket one; `Room.handleIntent`
takes a live `Conn`, so posting over HTTP means faking one or going around it;
and there is no live tail without SSE or polling on top. A compiled client
speaks the protocol that already exists, imports the zod schemas and
`PROTOCOL_VERSION` so it cannot drift silently, and gets `tail` for free. The
cost is size — 60–100 MB per platform, the embedded Bun runtime — which a LAN
does not notice.

- **Served by the same process** at `/cli/<file>`. `CLI_BUILDS` in the protocol
  package is the one list the build script, the route and the share panel all
  read, and the route treats it as an allowlist: a request is one of four
  names or a 404, nothing joins user input onto a path. `no-cache`, because a
  cached download after a protocol bump would be refused by the very server
  that served it. `/api/cli` reports what exists on disk so the panel never
  offers a 404, and stays hidden entirely until someone has run `build:cli`.
- **`join` is idempotent.** `room.join` mints a member and `MAX_MEMBERS` is 32;
  a student re-running the line they were handed must resume, not multiply.
  `--fresh` is the explicit opt-out.
- **Identities are the browser's `localStorage`, on disk.** The same three
  fields keyed by code, plus the server address and a `current` room so
  commands need no `--room`. 0600, written via rename, and a malformed file
  reads as empty rather than fatal — it is a cache of identities, not the
  source of truth.
- **`post` opens the paper first.** `toPaper` only echoes `block.added` to
  sockets watching that paper, and that echo is the only acknowledgement the
  protocol has, so `post` subscribes, posts, waits for its own block and exits.
  The snapshot that comes with opening is the price; at classroom sizes it is
  nothing, and `get` needs it anyway.
- **Room lifetime is unchanged.** A one-shot command counts as leaving. The
  teacher's tab holds the room open; a running `tail` is present. No daemon,
  no special-casing of CLI members on the server.
- **Paper choice:** the only text paper, else the remembered one, else refuse
  and list. Titles match by unique case-insensitive prefix; whiteboards never.
- **Input policy is the browser's**, duplicated by hand in `text.ts` rather
  than shared: `textFile.ts` takes a `File`, and moving thirty lines of decoder
  into the protocol package would put a non-wire concern there.
- **stdout is content, stderr is everything else.** Exit 0; 1 for refused or
  unreachable; 2 for usage. `get` adds a final newline only on a TTY.
- **`VERSION_MISMATCH` is re-worded by the client.** The server says "reload
  the page"; the CLI matches on the code and prints the download line for the
  server that refused it.
- **`tail` closes its own socket on `room.closed`.** The server unbinds the
  socket but leaves it open (the browser closes its own too), so a tail that
  only waited for the close would hang forever on a deleted room — caught by
  the test that deletes the room under it.

### M8.1 — colour, images, and a fifth build

- **The CLI renders a colour, it never chooses one.** `identity.ts` assigns the
  palette round-robin by join order and it already rides on every block as
  `authorColor`, so terminal colour is a rendering of a fact the protocol
  already carried. Nothing hashes a name locally: two clients that each picked
  their own colour would disagree about the same person, which is precisely
  what the chip exists to prevent.
- **24-bit escapes, not the 16-colour palette.** Twelve palette entries mapped
  onto sixteen ANSI colours would collide, and telling people apart is the only
  job the colour has. The hex is used exactly as sent, so the terminal matches
  the browser chip rather than approximating it.
- **Colour is a property of the stream, not of the run.** It is decided from
  `stderr.isTTY`, because names ride on the status lines; stdout is content and
  never coloured at all. `NO_COLOR` (any non-empty value, per no-color.org) and
  `TERM=dumb` disable it, `FORCE_COLOR` forces it, and with both set off wins.
  A `tail` redirected to a file therefore contains no escapes, which matters
  because that file is usually about to be pasted somewhere.
- **`[39m`, never `[0m`.** Restoring the default foreground cannot clobber an
  attribute the surrounding line set; a full reset can. Asserted in a test.
- **An image block is described, not drawn.** Terminal image protocols do exist
  — kitty and iTerm2 will even take the encoded bytes directly — but not in
  Windows Terminal, which is what this room's students have. The portable
  alternative is half-block characters, and that needs a PNG *and* JPEG decoder
  bundled into a paste tool to turn bytes into pixels. So the line carries the
  filename, dimensions, size and an OSC 8 hyperlink instead, and a terminal
  that ignores OSC 8 still shows a URL worth copying. It goes to stderr: an
  image is not text anyone is going to paste.
- **A fifth target, `bun-linux-arm64`.** Architecture is the one thing a binary
  cannot adapt to — the wrong one fails at exec with "cannot execute binary
  file" rather than misbehaving — and a cheap cloud Ubuntu box is as likely to
  be Ampere or Graviton as x64. `cli.test.ts` pins the platform/arch pairs
  rather than counting them, because an architecture that is merely missing
  shows up as a student with no download offered.
