import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  -- מטמון מקומי של האתרים/גרנטים, ממולא ע"י cloudSync.js מהענן (מקור
  -- האמת האמיתי מאז המעבר ל-Cloudflare Worker+D1). dnsServer.js/firewall.js
  -- קוראים אך ורק מהטבלה הזו — תשובת DNS לעולם לא מחכה לרשת. מוחלף
  -- בשלמותו (מחיקה+הכנסה בטרנזקציה אחת) בכל סנכרון מוצלח.
  CREATE TABLE IF NOT EXISTS site_cache (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    domains TEXT NOT NULL, -- JSON array of hostnames
    blocked INTEGER NOT NULL,
    expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_success_at INTEGER,
    last_attempt_at INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    log_push_watermark INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS dns_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    ts INTEGER NOT NULL,
    blocked INTEGER NOT NULL,
    client_ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dns_log_ts ON dns_log(ts);

  CREATE TABLE IF NOT EXISTS known_ips (
    site_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (site_id, ip)
  );
`);

db.prepare('INSERT OR IGNORE INTO sync_state (id) VALUES (1)').run();

// --- site_cache: written by cloudSync.js, read by dnsServer.js/firewall.js ---

// `sites`: [{id, name, domains, blocked, expiresAt}] — exactly the shape the
// cloud's GET /api/device/sync (and the old local siteToJson) already return.
export function replaceSiteCache(sites) {
  const del = db.prepare('DELETE FROM site_cache');
  const insert = db.prepare(
    'INSERT INTO site_cache (id, name, domains, blocked, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    del.run();
    for (const site of sites) {
      insert.run(
        site.id,
        site.name,
        JSON.stringify(site.domains),
        site.blocked ? 1 : 0,
        site.expiresAt,
      );
    }
  })();
}

export function listSites() {
  return db
    .prepare('SELECT * FROM site_cache ORDER BY id')
    .all()
    .map((s) => ({ ...s, domains: JSON.parse(s.domains) }));
}

// Matches a queried DNS name (already lowercased) against the cached
// catalog. Exact match or subdomain match (e.g. "x.web.whatsapp.com"
// matches "web.whatsapp.com") — same semantics as before the cloud move,
// just reading a cache instead of an owned table.
export function getSiteByDomain(name) {
  for (const site of listSites()) {
    for (const domain of site.domains) {
      if (name === domain || name.endsWith('.' + domain)) return site;
    }
  }
  return null;
}

export function isGrantActive(siteId) {
  const row = db.prepare('SELECT blocked, expires_at FROM site_cache WHERE id = ?').get(siteId);
  // A site missing from the cache (never synced yet, or cloud deleted it)
  // is not "active" — stays on the safe/blocked-by-default side.
  if (!row || row.blocked) return false;
  // Re-check expiry against the local clock rather than trusting the
  // cached "blocked" snapshot as-is: expires_at is an absolute timestamp,
  // so a grant that has since expired is correctly treated as inactive
  // even through an extended cloud outage, with no network needed — the
  // cache only needs to have seen the grant once before the outage started.
  return !!row.expires_at && row.expires_at > Date.now();
}

// --- sync_state: read/written by cloudSync.js ---

export function getSyncState() {
  return db.prepare('SELECT * FROM sync_state WHERE id = 1').get();
}

export function recordSyncSuccess() {
  db.prepare(
    'UPDATE sync_state SET last_success_at = ?, last_attempt_at = ?, consecutive_failures = 0 WHERE id = 1',
  ).run(Date.now(), Date.now());
}

export function recordSyncFailure() {
  db.prepare(
    'UPDATE sync_state SET last_attempt_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = 1',
  ).run(Date.now());
}

export function getLogPushWatermark() {
  return getSyncState().log_push_watermark;
}

export function setLogPushWatermark(id) {
  db.prepare('UPDATE sync_state SET log_push_watermark = ? WHERE id = 1').run(id);
}

// --- dns_log / known_ips: fully local, unrelated to the cloud move ---

export function logDns(domain, blocked, clientIp) {
  db.prepare(
    'INSERT INTO dns_log (domain, ts, blocked, client_ip) VALUES (?, ?, ?, ?)',
  ).run(domain, Date.now(), blocked ? 1 : 0, clientIp || null);
}

export function getDnsLogSince(id, limit = 500) {
  return db.prepare('SELECT * FROM dns_log WHERE id > ? ORDER BY id ASC LIMIT ?').all(id, limit);
}

export function getRecentLog(limit = 200) {
  return db.prepare('SELECT * FROM dns_log ORDER BY ts DESC LIMIT ?').all(limit);
}

export function recordKnownIp(siteId, ip) {
  db.prepare(
    `INSERT INTO known_ips (site_id, ip, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(site_id, ip) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(siteId, ip, Date.now());
}

export function getKnownIps(siteId) {
  return db.prepare('SELECT ip FROM known_ips WHERE site_id = ?').all(siteId).map((r) => r.ip);
}
