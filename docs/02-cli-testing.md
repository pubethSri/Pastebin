# Testing the command-line client across machines

A scenario for exercising `apps/cli` the way students will: an Ubuntu box and a
second Windows PC as clients, this PC as the host. Everything the in-process
test suite cannot cover is here — real downloads, real shells, real firewalls.

Fill in the results table at the bottom as you go.

## What you need

| Role | Machine | What it runs |
|---|---|---|
| Host | this Windows PC | `bun run serve`, plus a browser tab as "the teacher" |
| Client A | Ubuntu (server, headless is fine) | `curl`, the Linux binary |
| Client B | the other Windows PC | PowerShell, the Windows binary |

All three must be on the same network, or Client A must be a VM on this host.

---

## Phase 0 — host setup

### 0.1 Build everything

```bash
bun run build:cli && bun run serve
```

`serve` does not build the CLI, so `build:cli` has to come first, and again
after any change to `PROTOCOL_VERSION`. Confirm four files exist:

```bash
ls -la apps/cli/dist
```

### 0.2 Pick the right address — this is the one that wastes an afternoon

This PC has **nine** IPv4 addresses and only one of them is reachable from
another machine. The share panel lists several and defaults to the wrong one.

| Address | Adapter | Reachable from another machine? |
|---|---|---|
| **172.16.10.13** | Wi-Fi | **yes — use this one** |
| 172.19.16.1 | vEthernet (WSL) | no, and the panel offers it first |
| 192.168.100.1 | VMware VMnet8 (NAT) | only from a VM on this host |
| 192.168.190.1 | VMware VMnet1 (host-only) | only from a VM on this host |

Re-check it each session, because Wi-Fi addresses move:

```bash
powershell -c "(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -ne $null}).IPv4Address.IPAddress"
```

The adapter with a default gateway is the real one. For the rest of this
document `$HOST` means `http://172.16.10.13:3000`.

**If Client A is a VMware VM on this host**, that changes: a NAT guest reaches
the host at `192.168.100.1`, not at the Wi-Fi address. Either use
`http://192.168.100.1:3000` from the guest, or switch the VM to bridged
networking so it lands on `172.16.10.x` and behaves like a real separate
machine. Bridged is the more honest test.

### 0.3 Let it through the firewall

Bun binding `0.0.0.0:3000` prompts Windows Firewall on first run. If you missed
the prompt or clicked no, clients get a silent timeout. As administrator:

```bash
powershell -c "New-NetFirewallRule -DisplayName 'Pastebin 3000' -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow"
```

Also check the Wi-Fi network profile is **Private**, not Public — Windows
blocks far more inbound on a Public profile.

```bash
powershell -c "Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory"
```

### 0.4 Open the room

In a browser on the host, create a room and note the four-letter code. Leave
this tab open for the whole session — it is "the teacher", and it is what keeps
the room alive between one-shot CLI commands. `$CODE` means that code below.

Verify the server is reachable before touching any client:

```bash
curl -s http://172.16.10.13:3000/api/cli
```

Expect all four filenames. If this fails from the host itself, it is the
address; if it works here but not from a client, it is the firewall.

---

## Phase 1 — Ubuntu (Client A)

### 1.1 Check the machine can run the binary at all

Three things break a cross-compiled Bun binary, all worth ruling out in ten
seconds rather than debugging later:

```bash
uname -m; ldd --version | head -1; grep -c avx2 /proc/cpuinfo
```

- `uname -m` must be **x86_64**. If it says `aarch64`, this is an ARM machine
  and no build in `CLI_BUILDS` fits it — add `bun-linux-arm64` to
  `packages/protocol/src/cli.ts` and rebuild.
- glibc must be **2.31 or newer** (Ubuntu 20.04+). Alpine and other musl
  distributions will not run this binary at all.
- If the AVX2 count is **0**, the standard build dies with `Illegal
  instruction`. Rebuild that target as `bun-linux-x64-baseline`.

### 1.2 Download and run

```bash
curl -o pastebin http://172.16.10.13:3000/cli/pastebin-linux-x64 && chmod +x pastebin
```

```bash
./pastebin --version
```

Expect `pastebin 0.1.0 (protocol v6)`. A permission error means the `chmod`
was skipped; `Illegal instruction` means see 1.1.

### 1.3 Join

```bash
./pastebin join $CODE --server http://172.16.10.13:3000
```

Expect two lines on stderr naming you and the paper. Check the browser tab: a
new member chip appears. Then confirm the identity file and its permissions:

```bash
cat ~/.config/pastebin/sessions.json; stat -c '%a %n' ~/.config/pastebin/sessions.json
```

Expect mode **600**, and a room entry holding a server, member id and token.

### 1.4 Post — the actual use case

```bash
cat /var/log/syslog | tail -40 | ./pastebin post
```

```bash
./pastebin post /etc/hostname
```

```bash
echo "SELECT * FROM users WHERE id = 1;" | ./pastebin post --as query.sql
```

Each should print a character count on stderr and appear in the browser within
a second. The second and third should be **labelled with a filename and
syntax-coloured** in the browser; the first should not be.

### 1.5 Get — check stdout is clean

```bash
./pastebin get > out.txt && wc -c out.txt && cat out.txt
```

The file must contain the block and nothing else: no status line, no added
final newline. Compare against posting a known file:

```bash
./pastebin post /etc/hostname && ./pastebin get | sha256sum && sha256sum /etc/hostname
```

Hashes should match, because `/etc/hostname` is already LF. See 3.3 for what
happens when the source has CRLF.

```bash
./pastebin get --last 3
```

### 1.6 Tail

```bash
./pastebin tail
```

Post something from the browser and confirm it appears. Confirm the header line
goes to stderr and the text to stdout:

```bash
./pastebin tail 2>/dev/null
```

Only pasted text should appear. Leave a tail running for Phase 3.

### 1.7 Multiple papers

Add a second paper in the browser, then:

```bash
./pastebin papers
```

```bash
./pastebin post
```

Expect a refusal naming both papers, then:

```bash
./pastebin use notes && ./pastebin papers
```

Expect the `*` to have moved. Add a whiteboard in the browser and confirm
`./pastebin use <board>` is refused by name.

---

## Phase 2 — Windows PowerShell (Client B)

Note which PowerShell you are in, because 2.5 depends on it:

```bash
$PSVersionTable.PSVersion
```

### 2.1 The curl alias

Deliberately run the wrong one first, so you know what the failure looks like
when a student hits it:

```bash
curl -o pastebin.exe http://172.16.10.13:3000/cli/pastebin-windows-x64.exe
```

In **Windows PowerShell 5.1** this is `Invoke-WebRequest` wearing a `curl`
mask, and `-o` is not its flag — expect a parameter error. In **PowerShell 7+**
the alias is gone and it may simply work. Then the correct line:

```bash
curl.exe -o pastebin.exe http://172.16.10.13:3000/cli/pastebin-windows-x64.exe
```

### 2.2 SmartScreen and Defender

Run it and watch for any block:

```bash
.\pastebin.exe --version
```

A curl download carries no Mark-of-the-Web, so SmartScreen should stay quiet —
confirm that is actually true here. Defender has been known to flag
Bun-compiled executables. If it does, note the detection name; that decides
whether this is distributable to a class at all. Check what, if anything, was
quarantined:

```bash
powershell -c "Get-MpThreatDetection | Select-Object -Last 3 | Format-List ThreatID, Resources"
```

Also confirm the bare name fails and `.\` works, since that is why the share
panel prints the prefix:

```bash
pastebin --version
```

Expect "not recognized". This is expected, not a bug.

### 2.3 Join and post

```bash
.\pastebin.exe join $CODE --server http://172.16.10.13:3000
```

```bash
.\pastebin.exe post C:\Windows\System32\drivers\etc\hosts
```

```bash
type C:\Windows\System32\drivers\etc\hosts | .\pastebin.exe post
```

Confirm the identity file is under `%APPDATA%`:

```bash
type $env:APPDATA\pastebin\sessions.json
```

### 2.4 Get into the clipboard — the point of the whole exercise

```bash
.\pastebin.exe get | clip
```

Paste into Notepad. This is what the browser **cannot** do over plain HTTP on a
LAN address, so it is the clearest demonstration of why the CLI exists.

```bash
.\pastebin.exe get > out.txt
```

### 2.5 Non-ASCII through a pipe — expect this one to fail on 5.1

```bash
"héllo wörld — ünïcode" | .\pastebin.exe post
```

In **Windows PowerShell 5.1**, `$OutputEncoding` defaults to ASCII for native
commands, so the text most likely arrives in the room as `h?llo w?rld`. In
**PowerShell 7+** it defaults to UTF-8 and should be intact. Record which you
saw. If it mangles, both of these should fix it:

```bash
$OutputEncoding = [System.Text.UTF8Encoding]::new(); "héllo wörld" | .\pastebin.exe post
```

```bash
.\pastebin.exe post notes.txt
```

The file form bypasses the pipe entirely and is the advice to give students who
paste anything but plain ASCII. Confirm it is intact in the browser.

Also compare the two ways of piping a file, since they are not equivalent:

```bash
Get-Content notes.txt | .\pastebin.exe post
```

`Get-Content` emits lines as objects and the pipe rejoins them, so trailing
whitespace and the final newline may differ from `post notes.txt`. Check
against the browser which one round-trips exactly.

---

## Phase 3 — the three machines together

### 3.1 Interop

With a `tail` running on Ubuntu and the browser open on the host, post from
Windows. It should land in both within a second. Then post from Ubuntu and
confirm it appears in the browser with the right author name and colour.

### 3.2 Ownership is enforced, not suggested

In the browser, try to edit a block posted by a CLI client. There should be no
Edit or Delete button on it — those belong to its author. This is the rule the
whole model rests on, so it is worth seeing across machines.

### 3.3 Line endings across platforms

Post a CRLF file from Windows, then read it on Ubuntu:

```bash
.\pastebin.exe post crlf-file.txt
```

```bash
./pastebin get | file -; ./pastebin get | od -c | grep -c '\\r'
```

Expect **zero** carriage returns. The CLI normalises CRLF to LF on the way in,
exactly as the browser does for dropped files, so the hash will not match the
original Windows file. That is by design, not a bug — a stray CR is invisible
on screen and then rides into everyone's clipboard.

### 3.4 Joining twice does not multiply members

On Ubuntu, run join five times:

```bash
for i in 1 2 3 4 5; do ./pastebin join $CODE; done
```

The browser's presence row must still show **one** member for that machine. Then
confirm the deliberate opt-out does add one:

```bash
./pastebin join $CODE --fresh --name "Second Identity"
```

This matters because rooms cap at 32 members and a class re-runs the line they
were given.

### 3.5 Room lifetime

The documented decision is that a one-shot command counts as leaving, and a
running `tail` counts as present. Test both.

1. Stop the tail, close every browser tab, run nothing for six minutes.
2. Then from Ubuntu: `./pastebin post` — expect a refusal saying your identity
   is gone and telling you to join again, and the session file to have dropped
   that room.
3. Make a new room, start `./pastebin tail`, close every browser tab, wait six
   minutes, and post from Windows. The room should still be alive.

To make this faster, restart the host with a short grace:

```bash
powershell -c "$env:ROOM_EMPTY_GRACE_MINUTES=1; bun run serve"
```

---

## Phase 4 — failure modes

Each of these is a message a student will eventually see, so each should read
like a sentence and not a stack trace.

| Test | Command | Expect |
|---|---|---|
| Server down | stop the host, then `./pastebin post` | "could not reach … same Wi-Fi?", exit 1 |
| Wrong address | `./pastebin join ABCD --server http://172.19.16.1:3000` | same, and this is the WSL address trap from 0.2 |
| No such room | `./pastebin join ZZZZ` | "no room ZZZZ (ROOM_NOT_FOUND)", exit 1 |
| Binary file | `./pastebin post /bin/ls` | "isn't a text file", exit 1, nothing posted |
| Too large | `head -c 500000 /dev/urandom \| base64 \| ./pastebin post` | names the real character count against the 100,000 cap |
| Empty input | `echo -n "" \| ./pastebin post` | "stdin is empty", exit 1 |
| Deleted room | delete the room in the browser while a tail runs | "The room was deleted.", exit 1, identity forgotten |
| Bad flag | `./pastebin post --bogus` | usage error, exit **2** |

Check exit codes explicitly, since scripts depend on them:

```bash
./pastebin post /bin/ls; echo "exit=$?"
```

### 4.9 Stale binary

This validates the one message the CLI rewrites rather than passing through.
Keep the Ubuntu binary as-is, then on the host bump `PROTOCOL_VERSION` in
`packages/protocol/src/version.ts`, restart the server **without** running
`build:cli`, and from Ubuntu:

```bash
./pastebin post
```

Expect it to say the build is out of date and print the exact `curl` line for
this server — not the browser's "reload the page". Then run `bun run build:cli`
on the host, re-download, and confirm it works again. Put the version back
afterwards, and note that `protocol.test.ts` asserts it as a literal, so
`bun test` will fail until you do.

---

## Results

| # | Test | Ubuntu | Windows | Notes |
|---|---|---|---|---|
| 1.1 | Machine can run the binary | | n/a | |
| 1.2 | Download and `--version` | | | |
| 2.1 | `curl` alias fails, `curl.exe` works | n/a | | |
| 2.2 | SmartScreen / Defender quiet | n/a | | |
| 1.3 | Join, identity file, 0600 | | | |
| 1.4 | Post from stdin | | | |
| 1.4 | Post a file, labelled and coloured | | | |
| 1.5 | `get` is byte-exact through a pipe | | | |
| 2.4 | `get \| clip` | n/a | | |
| 2.5 | Non-ASCII through a pipe | n/a | | PS version: |
| 1.6 | `tail` prints live, streams split | | | |
| 1.7 | Paper selection and whiteboard refusal | | | |
| 3.1 | Three-way interop | | | |
| 3.3 | CRLF normalised to LF | | | |
| 3.4 | Join is idempotent | | | |
| 3.5 | Room dies empty, survives a tail | | | |
| 4.x | Failure messages and exit codes | | | |
| 4.9 | Stale binary tells you to re-download | | | |

## Things most likely to go wrong

1. **The address.** Three of this host's four offered addresses are virtual
   adapters. Start at 0.2 and confirm with `curl` before blaming anything else.
2. **The firewall**, and the Public network profile behind it.
3. **PowerShell 5.1 mangling non-ASCII through a pipe** — a CLI problem only in
   the sense that students will hit it. The answer is to post the file.
4. **Defender flagging the exe**, which is the one result that would change how
   this gets distributed.
5. **An ARM or musl Ubuntu**, which needs a build target that does not exist in
   `CLI_BUILDS` yet.
