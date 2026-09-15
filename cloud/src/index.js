import * as db from './db.js';
import * as auth from './auth.js';

// After this many consecutive wrong passwords, the account locks for
// LOCKOUT_MS (re-extended on every further attempt) — see
// db.recordLoginFailure. Keeps a single internet-facing password from
// being brute-forceable at network speed.
const LOGIN_FAILURE_THRESHOLD = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// A parent pasting a full URL (e.g. from the browser's address bar) instead
// of a bare hostname would otherwise silently create a site that can never
// match a DNS query name — dnsServer.js on the kid's PC only ever compares
// against plain hostnames. Strip scheme/path/port so "https://github.com/"
// becomes "github.com", and reject anything that still isn't a hostname.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function normalizeDomain(raw) {
  let d = String(raw).trim().toLowerCase();
  if (!d) return null;
  if (d.includes('://')) {
    try {
      d = new URL(d).hostname;
    } catch {
      return null;
    }
  } else {
    d = d.split('/')[0];
  }
  d = d.replace(/:\d+$/, '').replace(/\.$/, '');
  return HOSTNAME_RE.test(d) ? d : null;
}

// Returns null (instead of a possibly-shorter array) if any entry fails to
// normalize, so the caller can 400 rather than silently dropping a domain
// the parent thought they added.
function normalizeDomains(rawList) {
  if (!Array.isArray(rawList)) return null;
  const out = [];
  for (const raw of rawList) {
    const d = normalizeDomain(raw);
    if (!d) return null;
    out.push(d);
  }
  return out;
}

function siteToJson(site, grant) {
  return {
    id: site.id,
    name: site.name,
    domains: site.domains,
    blocked: !grant,
    expiresAt: grant ? grant.expires_at : null,
  };
}

async function allSitesJson(env) {
  const sites = await db.listSites(env.DB);
  return Promise.all(
    sites.map(async (site) => siteToJson(site, await db.getActiveGrant(env.DB, site.id))),
  );
}

async function requireParentSession(request, env) {
  const session = await auth.readSession(request, env.SESSION_SECRET);
  return session?.loggedIn ? session : null;
}

// Bearer "<deviceId>.<secret>" — see cloud/scripts/create-device.js for how
// a device row is created; there is no self-serve registration endpoint.
async function requireDevice(request, env) {
  const parsed = auth.parseDeviceToken(request.headers.get('Authorization'));
  if (!parsed) return null;
  const device = await db.getDeviceById(env.DB, parsed.id);
  if (!device || device.revoked_at) return null;
  const secretHash = await auth.sha256Hex(parsed.secret);
  if (secretHash !== device.token_hash) return null;
  return device;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    try {
      // --- Device-facing (bearer token, no cookie) ---
      if (pathname === '/api/device/sync' && method === 'GET') {
        const device = await requireDevice(request, env);
        if (!device) return json({ error: 'unauthorized' }, 401);
        await db.touchDevice(env.DB, device.id, request.headers.get('CF-Connecting-IP'));
        return json({ sites: await allSitesJson(env), serverTime: Date.now() });
      }

      if (pathname === '/api/device/log' && method === 'POST') {
        const device = await requireDevice(request, env);
        if (!device) return json({ error: 'unauthorized' }, 401);
        const body = await request.json().catch(() => null);
        const entries = Array.isArray(body?.entries) ? body.entries.slice(0, 500) : [];
        await db.insertDnsLogBatch(env.DB, device.id, entries);
        return json({ ok: true, accepted: entries.length });
      }

      // --- Parent-facing auth (no session required yet) ---
      if (pathname === '/api/session' && method === 'GET') {
        const session = await requireParentSession(request, env);
        return json({ loggedIn: !!session, needsSetup: !(await db.hasAnyParentUser(env.DB)) });
      }

      if (pathname === '/api/setup' && method === 'POST') {
        if (await db.hasAnyParentUser(env.DB)) return json({ error: 'already_configured' }, 400);
        const body = await request.json().catch(() => null);
        const password = body?.password;
        if (!password || password.length < 8) return json({ error: 'invalid_input' }, 400);
        await db.upsertParentUser(env.DB, db.PARENT_USERNAME, await auth.hashPassword(password));
        return json({ ok: true }, 200, { 'Set-Cookie': await auth.createSessionCookie(env.SESSION_SECRET) });
      }

      if (pathname === '/api/login' && method === 'POST') {
        const body = await request.json().catch(() => null);
        const user = await db.getParentUser(env.DB, db.PARENT_USERNAME);
        if (user?.locked_until && user.locked_until > Date.now()) {
          const retryAfter = Math.ceil((user.locked_until - Date.now()) / 1000);
          return json({ error: 'locked_out', retryAfterSeconds: retryAfter }, 429, {
            'Retry-After': String(retryAfter),
          });
        }
        const ok = user && (await auth.verifyPassword(body?.password || '', user.password_hash));
        if (!ok) {
          if (user) {
            await db.recordLoginFailure(env.DB, db.PARENT_USERNAME, {
              threshold: LOGIN_FAILURE_THRESHOLD,
              lockoutMs: LOGIN_LOCKOUT_MS,
            });
          }
          return json({ error: 'invalid_credentials' }, 401);
        }
        await db.recordLoginSuccess(env.DB, db.PARENT_USERNAME);
        return json({ ok: true }, 200, { 'Set-Cookie': await auth.createSessionCookie(env.SESSION_SECRET) });
      }

      if (pathname === '/api/logout' && method === 'POST') {
        return json({ ok: true }, 200, { 'Set-Cookie': auth.expiredSessionCookie() });
      }

      // --- Everything else under /api/ requires a parent session ---
      if (pathname.startsWith('/api/')) {
        const session = await requireParentSession(request, env);
        if (!session) return json({ error: 'not_authenticated' }, 401);

        if (pathname === '/api/sites' && method === 'GET') {
          return json(await allSitesJson(env));
        }

        if (pathname === '/api/sites' && method === 'POST') {
          const body = await request.json().catch(() => null);
          const name = String(body?.name || '').trim();
          const domains = normalizeDomains(body?.domains);
          if (!name || !domains || domains.length === 0) return json({ error: 'invalid_input' }, 400);
          if (await db.getSiteByName(env.DB, name)) return json({ error: 'duplicate_name' }, 400);
          const site = await db.createSite(env.DB, name, domains);
          return json(siteToJson(site, null));
        }

        if (pathname === '/api/password' && method === 'PATCH') {
          const body = await request.json().catch(() => null);
          const currentPassword = body?.currentPassword || '';
          const newPassword = body?.newPassword || '';
          if (!newPassword || newPassword.length < 8) return json({ error: 'invalid_input' }, 400);
          const user = await db.getParentUser(env.DB, db.PARENT_USERNAME);
          const ok = user && (await auth.verifyPassword(currentPassword, user.password_hash));
          if (!ok) return json({ error: 'invalid_credentials' }, 401);
          await db.upsertParentUser(env.DB, db.PARENT_USERNAME, await auth.hashPassword(newPassword));
          return json({ ok: true });
        }

        const siteIdMatch = pathname.match(/^\/api\/sites\/(\d+)$/);
        if (siteIdMatch && method === 'PATCH') {
          const site = await db.getSiteById(env.DB, Number(siteIdMatch[1]));
          if (!site) return json({ error: 'not_found' }, 404);
          const body = await request.json().catch(() => null);
          const domains = normalizeDomains(body?.domains);
          if (!domains || domains.length === 0) return json({ error: 'invalid_input' }, 400);
          const updated = await db.updateSiteDomains(env.DB, site.id, domains);
          return json(siteToJson(updated, await db.getActiveGrant(env.DB, updated.id)));
        }

        if (siteIdMatch && method === 'DELETE') {
          const site = await db.getSiteById(env.DB, Number(siteIdMatch[1]));
          if (!site) return json({ error: 'not_found' }, 404);
          await db.deleteSite(env.DB, site.id);
          return json({ ok: true });
        }

        const grantMatch = pathname.match(/^\/api\/sites\/(\d+)\/grant$/);
        if (grantMatch && method === 'POST') {
          const site = await db.getSiteById(env.DB, Number(grantMatch[1]));
          if (!site) return json({ error: 'not_found' }, 404);
          const body = await request.json().catch(() => null);
          const minutes = Number(body?.minutes);
          if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
            return json({ error: 'invalid_minutes' }, 400);
          }
          await db.createGrant(env.DB, site.id, minutes);
          return json(siteToJson(site, await db.getActiveGrant(env.DB, site.id)));
        }

        const revokeMatch = pathname.match(/^\/api\/sites\/(\d+)\/revoke$/);
        if (revokeMatch && method === 'POST') {
          const site = await db.getSiteById(env.DB, Number(revokeMatch[1]));
          if (!site) return json({ error: 'not_found' }, 404);
          await db.revokeGrant(env.DB, site.id);
          return json(siteToJson(site, null));
        }

        if (pathname === '/api/report' && method === 'GET') {
          const days = Number(url.searchParams.get('days')) || 7;
          return json(await db.getReport(env.DB, { sinceMs: Date.now() - days * 24 * 60 * 60 * 1000 }));
        }

        if (pathname === '/api/log' && method === 'GET') {
          return json(await db.getRecentLog(env.DB, Number(url.searchParams.get('limit')) || 200));
        }

        if (pathname === '/api/devices' && method === 'GET') {
          return json(await db.listDevices(env.DB));
        }

        const deviceIdMatch = pathname.match(/^\/api\/devices\/([\w-]+)$/);
        if (deviceIdMatch && method === 'DELETE') {
          await db.revokeDevice(env.DB, deviceIdMatch[1]);
          return json({ ok: true });
        }

        return json({ error: 'not_found' }, 404);
      }

      // --- Static dashboard (cloud/dashboard/, via the [assets] binding) ---
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('worker error', err);
      return json({ error: 'internal_error' }, 500);
    }
  },

  // Daily cron (see [triggers] in wrangler.toml) — dns_log and expired
  // grants have no other retention, so this is what keeps them from
  // growing forever.
  async scheduled(event, env) {
    const deletedLogs = await db.deleteOldDnsLogs(env.DB, 30);
    console.log(`scheduled cleanup: deleted ${deletedLogs} dns_log row(s) older than 30 days`);
    const deletedGrants = await db.deleteOldGrants(env.DB, 30);
    console.log(`scheduled cleanup: deleted ${deletedGrants} expired grant row(s) older than 30 days`);
  },
};
