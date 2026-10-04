# Handoff: kids' PC DNS-blocking bug + current emergency-disabled state

Read this first, before touching anything on this machine. This file exists because
debugging was happening over chat (parent relaying PowerShell output by hand, no
clipboard sync), which was slow and error-prone — the whole point of running an agent
directly on this machine is to stop doing that. Once you've read this and oriented
yourself, delete this file (or leave it, your call) — it's a one-time briefing, not a
permanent project doc.

## What this machine is

This is "the kids' PC" for a parental-control system. See `CLAUDE.md` at the repo root
for the full architecture. Short version: this machine runs a Windows Service
(`KidsNetControl`) that's supposed to run a local DNS resolver (port 53) + manage
Windows Firewall rules, enforcing a site blocklist with parent-granted temporary access
windows. The source of truth (sites/grants) lives in a Cloudflare Worker + D1 at
`https://kids.musagim-bamaharal.org`; this machine just polls it and enforces locally.

Install directory (default): `C:\Program Files\KidsNetControl`
- `data\device-token` — bearer token for cloud sync (see "Known-good credentials" below)
- `data\app.db` — local SQLite cache (site_cache, dns_log, known_ips, sync_state)
- `install.log` — postinstall script's own log
- `daemon\` — node-windows service wrapper; stdout/stderr logs should be here, exact
  filenames not yet confirmed from this debugging session — check there for the actual
  Node process's console output (console.error lines from firewall.js / cloudSync.js /
  dnsServer.js all go here, not anywhere else).

## Current state: protection is INTENTIONALLY, FULLY DISABLED right now

This machine lost all internet access during debugging (see timeline below). As an
emergency fix, the parent and I disabled everything that enforces blocking. **Do not
assume blocking is active.** Right now:

- The network adapter's DNS is set to **Automatic** (not 127.0.0.1) — confirm with
  `Get-DnsClientServerAddress -AddressFamily IPv4`.
- Three Windows Firewall outbound rules are **disabled** (not deleted — just disabled,
  via `wf.msc` → Outbound Rules):
  - `KidsNetControl-Block-External-DNS-UDP`
  - `KidsNetControl-Block-External-DNS-TCP`
  - `KidsNetControl-Block-DoH-IPs`

This means no site is currently blocked at all, regardless of what the cloud dashboard
says. Do not re-enable these / re-lock DNS to 127.0.0.1 until you've confirmed the local
DNS resolver is actually listening on port 53 (see Bug #2 below) — re-enabling them
while the resolver isn't listening reproduces the full outage (DNS blocked both ways:
local resolver silent, external DNS blocked by firewall → zero DNS resolution → "no
internet" for the whole house, not just the blocked sites).

## Known-good credentials / state (verified from the cloud D1 directly, not guessed)

- Device bearer token (already registered, confirmed syncing successfully as of
  2026-09-15): `dev_61d53f9524e9.pe8ndODrFcMlnglK_InnZtxI8Aye793W`
  — lives at `C:\Program Files\KidsNetControl\data\device-token`, should already be
  correct from the last reinstall. Don't regenerate unless you have a specific reason;
  regenerating requires `node scripts/create-device.js` run from a machine with
  `wrangler` logged in to the Cloudflare account (not this machine).
- An older device id `dev_5d949eaff776` was created earlier, never worked, and was
  revoked — ignore it if you see it in `/api/devices`.
- Cloud Worker: `https://kids.musagim-bamaharal.org`. This domain had to be whitelisted
  by the family's ISP-level content filter ("Rimon internet") because Rimon does HTTPS
  interception (re-signs certs with its own CA, which Windows trusts but Node doesn't by
  default) — that's already been whitelisted and confirmed fixed. If you see
  `SELF_SIGNED_CERT_IN_CHAIN` / `self-signed certificate in certificate chain` errors
  again from Node's `fetch()`, that's this same Rimon interception reappearing (e.g. for
  some other domain), not a new bug — the fix is either getting Rimon to whitelist the
  domain, or relying on `NODE_OPTIONS=--use-system-ca` (already set as a machine
  environment variable, and baked into `install/service-install.js` for future
  installs) to make Node trust the Windows cert store like the OS itself does.

## Bug #1 (unsolved): the actual block doesn't apply to Chrome, even when the DNS layer is provably working

Timeline of what was ruled out, in order — **don't re-test these, they're confirmed not
the cause**:

1. `nslookup github.com` (while github.com was configured as blocked, no active grant)
   correctly returned `Non-existent domain` — i.e. the local resolver, when queried
   directly via a tool that talks straight to the configured DNS server, blocks
   correctly. This proves `src/dnsServer.js`'s blocking logic itself is not the bug.
2. Despite that, Chrome could still load github.com / web.whatsapp.com, even after a
   full computer restart (ruling out "stale open tab/connection from earlier testing" —
   that was the first theory, disproven by testing after a clean reboot).
3. Checked `chrome://policy` — `DnsOverHttpsMode` policy shows value `off`, and
   `chrome://settings/security` shows the Secure DNS toggle greyed out / "managed by
   your organization". So Chrome's own DoH is confirmed OFF and locked. Not the cause.
4. Checked Windows proxy settings (`Settings > Network > Proxy`) — no manual proxy, no
   manual PAC script. "Automatically detect settings" (WPAD) was ON; disabled it,
   restarted Chrome, re-tested — **github.com still loaded**. Also, Rimon's own content
   filtering (e.g. blocking porn sites) kept working fine throughout, which means
   Rimon's filtering does NOT depend on any Windows-side proxy setting — it must operate
   at the router/gateway level (probably SNI-based filtering on the TLS ClientHello, or
   similar — something that doesn't care what DNS resolver or proxy this specific PC
   uses). So WPAD/proxy is ruled out as the cause of github.com being reachable.
5. **Not yet checked**: `C:\Windows\System32\drivers\etc\hosts`. This is the next thing
   to check — a manual hosts-file entry for github.com (or whatsapp domains) to a real
   IP would make Chrome (and most normal apps, via the OS's standard `getaddrinfo`-based
   resolution, which checks the hosts file *before* ever sending a DNS query) resolve the
   domain without ever querying our local DNS server at all — which would also explain
   why the local `dns_log` had zero entries for these domains despite real browsing
   happening. `nslookup` specifically bypasses the hosts file (queries the DNS server
   directly), which is why it alone showed correct blocking while every normal app did
   not. **Start here.** If you find entries, that's very likely the actual root cause of
   Bug #1 — figure out why they're there (possibly something Rimon's own client software
   added, possibly leftover from unrelated troubleshooting) before just deleting them.

## Bug #2 (suspected, not confirmed): the KidsNetControl service shows "Running" but may not actually be listening on port 53

This is what caused the full outage. Sequence of events: after a fresh reinstall +
various debugging, `Get-Service -Name KidsNetControl` reported `Running`, but DNS
resolution stopped working for everything (not just blocked sites) once the firewall
rules (which block all non-loopback DNS) were active. A Node process can report as
"Running" to Windows (i.e. hasn't crashed) while having failed to actually bind UDP port
53 — `src/dnsServer.js` registers `server.on('error', ...)` which just
`console.error`s and does **not** crash the process on a bind failure (e.g.
`EADDRINUSE`). So "Running" does not prove the resolver is actually listening.

**This was never actually confirmed** — the `netstat`/`Get-NetUDPEndpoint` check was
asked for but the conversation moved to the emergency fix before getting an answer.
**Do this first, now that you're running directly on the machine:**

```powershell
Get-NetUDPEndpoint -LocalPort 53
netstat -ano | findstr ":53"
```

If nothing is listening on 53, check the daemon logs (`C:\Program Files\KidsNetControl\daemon\`)
for a `DNS server error:` line (that's the exact string `dnsServer.js` logs) to see the
underlying error (most likely `EADDRINUSE` — something else already bound to port 53,
possibly a leftover previous instance of the same service that didn't release the port
cleanly on restart/reinstall, or Windows' own "Internet Connection Sharing"/ICS service,
which sometimes binds DNS on some configurations).

## Other context, not urgent but useful

- `src/firewall.js` was recently changed to force-close already-established TCP
  connections to a newly-blocked site's IPs (via `SetTcpEntry`, a Windows API call
  invoked through an inline PowerShell script shelled out from Node) — the whole reason
  being that a plain new Firewall block rule only stops *new* connections, not ones
  already open (e.g. WhatsApp Web's long-lived WebSocket), which was letting access
  continue for 1-2+ minutes past grant expiry. **This has never actually been verified
  working on real hardware** — it was written, shipped via a new installer build, but
  then debugging got derailed into Bug #1/#2 above before it could be tested. Once Bug
  #1 and #2 are resolved and blocking works again end-to-end, specifically re-test grant
  expiry (grant 1-2 min access to a site, let it expire, time how fast it actually cuts
  off — should be within ~5 seconds, the scheduler tick interval, not minutes).
- Repo: `/Users/gocode/dev/whatsapp-kids-hours` on the Mac this was debugged from so far;
  GitHub remote `orineeman/kids-hours`, branch `main`. Pushing to `main` with changes
  under `src/**`/`install/**`/`installer/**` triggers a GitHub Actions build of a new
  installer `.exe`, published to the rolling release tag `installer-latest`. Changes
  under `cloud/**` instead trigger a Cloudflare Worker deploy via a separate workflow.
  There is no way to hot-patch this machine's installed agent code directly — any fix to
  `src/`, `install/`, etc. requires pushing to GitHub, waiting for the installer build,
  downloading the new `.exe`, and re-running it on this machine (it's safe to re-run,
  it detects the existing service and updates it in place; you'll be asked for the
  device token again — use the one above — and the child account username, which was
  left blank in the most recent install, meaning **the child's Windows account was never
  demoted from Administrator** — worth revisiting once the DNS bugs are sorted, since an
  admin-level child account can trivially undo any of this hardening itself).
- `CLAUDE.md` at the repo root has the full project context (architecture, known
  gotchas, commands) — read it if anything here is unclear or you need background this
  file didn't cover.
