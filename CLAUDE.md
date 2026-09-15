# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Parental-control software: a Windows PC (the "kid's PC") runs a local DNS resolver and dynamic Windows Firewall rules that block a configured list of sites by default. A parent grants temporary access (e.g. 15 minutes) from a cloud-hosted dashboard, reachable from anywhere. There is no test suite in this repo.

## Two independent projects in one repo

- **Root (`src/`, `install/`, `installer/`)** — the local Windows agent. Runs as a Windows Service on the kid's PC. Node, CommonJS-free ESM (`"type": "module"`).
- **`cloud/`** — a separate Node/npm project: a Cloudflare Worker + D1 database. This is the source of truth for sites/grants/parent auth, and serves the parent dashboard itself. Has its own `package.json`, its own `node_modules`, deployed independently. See `cloud/README.md` for one-time Cloudflare account setup (D1 creation, secrets, device provisioning) — those steps require interactive Cloudflare login and can't be scripted end-to-end.

Root dependencies were deliberately kept minimal after the cloud migration: `better-sqlite3`, `dns2`, `node-windows`. No `express`/`bcryptjs`/session libraries locally — those only exist inside `cloud/` (see Architecture below for why).

## Commands

Root (local agent):
```
npm install                 # add --ignore-scripts if testing on a machine without a C++ toolchain — see gotcha below
npm start                   # node src/index.js — binds DNS on :53 (needs admin/root) and a status page on :8080
```
There's no root test/lint script (`npm test` is a stub). Verify changes by actually running the agent — on macOS this runs in "dry-run" mode for Windows-only operations (see `src/firewall.js`'s `isWindows` check) so local iteration doesn't require a Windows box for most of the loop.

`cloud/` (Cloudflare Worker):
```
cd cloud
npm install
npm run dev                 # wrangler dev --local, http://localhost:8787, uses a local D1 simulation
npm run deploy               # wrangler deploy — publishes to the real Worker
npm run db:migrate:local     # apply migrations/0001_init.sql to the local D1 sim
npm run db:migrate:remote    # apply to the real D1 database
npm run device:create -- "some-name" [--local]   # provision a device bearer token (see Architecture)
npm run migrate:from-local-db -- /path/to/app.db # one-off: port an existing local site catalog into D1
```
`wrangler dev --test-scheduled` plus `curl "http://localhost:PORT/cdn-cgi/handler/scheduled?cron=..."` is how the daily log-cleanup cron (`scheduled()` in `cloud/src/index.js`) is exercised without waiting for the real schedule.

Windows installer (`installer/`): never built locally — always via CI (`.github/workflows/build-installer.yml`) on `windows-latest`, because there's no Windows machine in this dev environment. It downloads a portable Node runtime, runs `npm install --ignore-scripts` (see gotcha below), and compiles `installer/setup.iss` with Inno Setup (`choco install innosetup`). The compiled `.exe` is published to a rolling GitHub Release tag `installer-latest`. Push to `main` touching `installer/**`, `src/**`, or `install/**` triggers a rebuild; `cloud/**` changes instead trigger `.github/workflows/deploy-worker.yml` (needs a `CLOUDFLARE_API_TOKEN` repo secret to actually deploy — without it that workflow fails harmlessly on every `cloud/` push).

## Architecture

### Why a cloud backend exists at all

The original design ran everything (DNS resolver, Firewall control, web dashboard, SQLite DB) on the kid's PC, with Cloudflare Tunnel (`cloudflared`) exposing the dashboard for remote access. That was abandoned: `cloudflared` requires outbound port 7844 (UDP for QUIC, TCP for HTTP/2 fallback — both, no way around it), and that port was blocked somewhere in the home network path (confirmed via `cloudflared`'s own connectivity precheck; plain HTTPS/443 worked fine from the same machine). Rather than depend on a port that might be blocked on any given home network/ISP/router, the whole remote-access problem was moved onto a transport already known to work: plain HTTPS. If you're tempted to reintroduce Cloudflare Tunnel or any port-7844-dependent transport, that's why it isn't there.

### The split: source of truth vs. enforcement

- **`cloud/`** (Worker + D1) owns `sites`, `grants`, `parent_users`, `devices`, and the historical `dns_log`. It serves the parent dashboard (`cloud/dashboard/`, static assets via the Worker's `[assets]` binding) directly — the parent's browser talks to the Worker, never to the kid's PC.
- **The kid's PC** (`src/`) never lets DNS/Firewall decisions depend on a live network call. `src/db.js` keeps a local SQLite `site_cache` (populated by `src/cloudSync.js` pulling `GET /api/device/sync` every ~15s) and `dns_log` (pushed to the cloud, then locally pruned — see below). `src/dnsServer.js` and `src/firewall.js` only ever read from this local cache via `getSiteByDomain()`/`isGrantActive()` — **these two function signatures are deliberately unchanged from the pre-cloud version**, so `dnsServer.js`/`firewall.js` needed zero edits when the backend moved to the cloud. Keep it that way: any future change to the sync model should preserve this boundary rather than teaching the DNS-answering hot path about the network.
- **Offline resilience is a hard requirement, not a nice-to-have**: if `cloudSync.js` can't reach the Worker, enforcement keeps using the last-known cache (persisted to disk, not memory-only, so a service restart mid-outage doesn't lose it) with exponential backoff (capped at 5 minutes). `isGrantActive()` in `src/db.js` re-derives expiry from the cached absolute `expires_at` against the local clock on every call — it does not simply trust the cached `blocked` boolean — specifically so a grant that should have expired stays correctly blocked through an extended cloud outage, not just whenever the next sync happens to land. Don't "simplify" this back to trusting the cached boolean alone.

### Local agent pieces (`src/`)

- `index.js` — wires everything together: `dnsServer.js`, `scheduler.js`, `cloudSync.js`, `status.js`. Reads `CLOUD_API_BASE` (defaults to the production Worker's custom domain) and `DNS_PORT`/`STATUS_PORT` from env (set by `install/service-install.js` when installed as a service).
- `dnsServer.js` — UDP DNS resolver (`dns2`). Only logs a query to `dns_log` when it matches a managed site (not every domain the resolver ever handles) — most DNS traffic is unrelated background noise (ads, CDNs, telemetry) and logging it would make the cloud's `dns_log` grow far faster for no real benefit, since the point is "which managed sites did the kids visit," not a full network capture.
- `firewall.js` — shells out to `netsh advfirewall`; no-ops with a `[firewall:dry-run]` console log on non-Windows (`os.platform() !== 'win32'`), which is what makes local Mac development of this file possible at all.
- `scheduler.js` — a plain 5s `setInterval` that re-syncs Firewall state per site; this is what notices grant expiry and re-blocks (independent of and faster than `cloudSync.js`'s own interval).
- `cloudSync.js` — the only file that talks to the network. Two independent timers: pull (site cache, ~15s) and push (dns_log batch, ~45s, watermark-based so it's resumable and doesn't double-send). Reads its bearer token from `data/device-token` (a plain file, written by the installer — see below).
- `status.js` — a deliberately tiny read-only `node:http` page on `:8080` (no Express, no auth, no write routes) for troubleshooting from whoever is physically at the machine. It is not a control surface; that's the cloud dashboard's job. Don't add write endpoints here.

### Cloud pieces (`cloud/`)

- `src/index.js` — single-file router (`fetch()` handler with manual `pathname`/`method` matching, no framework) plus a `scheduled()` handler for the daily `dns_log` retention cron (30 days, see `wrangler.toml`'s `[triggers]`). Two auth schemes live side by side: parent routes need a signed session cookie, `/api/device/*` routes need a device bearer token — kept as separate code paths so it's obvious which one applies to a given route.
- `src/auth.js` — all crypto via native `crypto.subtle` (WebCrypto), not `bcryptjs`/`jsonwebtoken`: Workers have no filesystem-based secret store and this keeps the Worker dependency-free. Two unrelated mechanisms live here: PBKDF2 password hashing (**capped at 100,000 iterations — Cloudflare Workers' WebCrypto throws `NotSupportedError` above that**, discovered live in production; don't raise this without re-verifying the platform limit) and HMAC-signed stateless session cookies (no server-side session store, so logout is just overwriting the cookie with an expired one).
- `src/db.js` — D1 access layer mirroring the shape of the old local `src/db.js`, but every function is async (D1's API is Promise-based, unlike `better-sqlite3`'s synchronous one).
- Device provisioning is deliberately not self-serve: there is no public "register a device" endpoint. `cloud/scripts/create-device.js` is a one-off script you run by hand (with your own `wrangler`/Cloudflare credentials) that prints a bearer token once and the exact `wrangler d1 execute` command to register its hash. The installer's wizard has a "Device Token" field that writes it to `data/device-token` on the target machine.

### The Windows installer (`installer/`, `install/`)

`installer/setup.iss` (Inno Setup) drives `installer/postinstall.ps1`, which — in order — installs the Windows service (`install/service-install.js`, via `node-windows`, runs as SYSTEM with `sc failure` auto-restart), runs `install/harden.ps1` (DNS lock to 127.0.0.1, Chrome DoH/extension policy, Firewall rules against external DNS/DoH, ACLs on the install dir and especially `data/` — which holds the device token and local DB, locked to SYSTEM/Administrators only, no child-account read access), writes the device token, and optionally demotes a named child Windows account from Administrators (skipped safely, not an error, if left blank or if no other admin account exists — demoting the only admin account would lock the machine, so that case is deliberately refused rather than attempted).

Both `install/*.ps1` and `installer/*.ps1`/`*.iss` files must keep a **UTF-8 BOM** (they contain Hebrew text): Windows PowerShell without a BOM falls back to the system codepage and silently corrupts non-ASCII text into what looks like a parse error days later — this has bitten this project more than once. If you edit these files with a tool that doesn't preserve the leading BOM bytes (`ef bb bf`), check with `xxd file | head -1` and re-add it.

`Invoke-NativeLogged` in `postinstall.ps1` exists because of a specific PowerShell trap: piping a native program's stderr through `2>&1` while `$ErrorActionPreference = 'Stop'` turns ordinary informational stderr output (which `cloudflared` used to produce constantly) into a terminating error, even when the program succeeded. It temporarily relaxes `$ErrorActionPreference` around the call and checks the real exit code instead.

## Known gotchas worth not re-discovering

- `better-sqlite3` v13 ships a working prebuilt binary in its own npm tarball, but npm's default behavior for any package with a `binding.gyp` and no explicit `install` script is to rebuild it from source via `node-gyp` anyway, discarding the prebuilt one. On Node versions before 22.14 that rebuild produces a binary that *loads* fine but segfaults (`0xC0000005`) the moment it's actually used. Fix, already baked into `.github/workflows/build-installer.yml`: `npm install --ignore-scripts`, plus bundling Node 24.x (not 22.11) so the prebuilt binary's required NAPI version is actually supported. Don't drop `--ignore-scripts` from that workflow without re-verifying this.
