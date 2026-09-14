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
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    domains TEXT NOT NULL, -- JSON array of hostnames
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    granted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    minutes INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_grants_site ON grants(site_id, expires_at);

  CREATE TABLE IF NOT EXISTS dns_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    ts INTEGER NOT NULL,
    blocked INTEGER NOT NULL,
    client_ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dns_log_ts ON dns_log(ts);

  CREATE TABLE IF NOT EXISTS known_ips (
    site_id INTEGER NOT NULL REFERENCES sites(id),
    ip TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (site_id, ip)
  );

  CREATE TABLE IF NOT EXISTS parent_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

// Seed a default catalog entry for WhatsApp Web if the catalog is empty.
const siteCount = db.prepare('SELECT COUNT(*) AS n FROM sites').get().n;
if (siteCount === 0) {
  const insert = db.prepare(
    'INSERT INTO sites (name, domains, created_at) VALUES (?, ?, ?)',
  );
  insert.run(
    'WhatsApp Web',
    JSON.stringify(['web.whatsapp.com', 'static.whatsapp.net']),
    Date.now(),
  );
}

// The app has a single parent account, unlocked by password only (no
// username prompt). PARENT_USERNAME is an internal key for the single row
// in parent_users — it is never shown to or entered by the user.
export const PARENT_USERNAME = '__parent__';
const DEFAULT_PARENT_PASSWORD_HASH =
  '$2b$12$3UABbaZm6nmn2Z44uVDUWeSfZa4pmSVKSGl8.xAqhQ/x07fG6g1MW'; // bcrypt hash of "הרב דרוקמן", cost 12

// Seeded once, on the very first run, so a fresh install can log in
// immediately without a setup step. Guarded by a marker file rather than
// just "table is empty", so that a parent who deletes the row later (to
// force the setup screen and pick a real password) doesn't just get the
// same default silently reinserted on the next service restart.
const parentSeededMarker = path.join(dataDir, '.parent-seeded');
if (
  db.prepare('SELECT COUNT(*) AS n FROM parent_users').get().n === 0 &&
  !fs.existsSync(parentSeededMarker)
) {
  db.prepare(
    'INSERT INTO parent_users (username, password_hash) VALUES (?, ?)',
  ).run(PARENT_USERNAME, DEFAULT_PARENT_PASSWORD_HASH);
  fs.writeFileSync(parentSeededMarker, String(Date.now()));
}

export function listSites() {
  return db
    .prepare('SELECT * FROM sites ORDER BY id')
    .all()
    .map((s) => ({ ...s, domains: JSON.parse(s.domains) }));
}

export function getSiteById(id) {
  const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  return s ? { ...s, domains: JSON.parse(s.domains) } : null;
}

export function createSite(name, domains) {
  const info = db
    .prepare('INSERT INTO sites (name, domains, created_at) VALUES (?, ?, ?)')
    .run(name, JSON.stringify(domains), Date.now());
  return getSiteById(info.lastInsertRowid);
}

export function updateSiteDomains(id, domains) {
  db.prepare('UPDATE sites SET domains = ? WHERE id = ?').run(
    JSON.stringify(domains),
    id,
  );
  return getSiteById(id);
}

export function deleteSite(id) {
  db.prepare('DELETE FROM grants WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM known_ips WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
}

// Matches a queried DNS name (already lowercased) against the site catalog.
// Exact match or subdomain match (e.g. "x.web.whatsapp.com" matches "web.whatsapp.com").
export function getSiteByDomain(name) {
  const sites = listSites();
  for (const site of sites) {
    for (const domain of site.domains) {
      if (name === domain || name.endsWith('.' + domain)) {
        return site;
      }
    }
  }
  return null;
}

export function getActiveGrant(siteId) {
  return db
    .prepare(
      'SELECT * FROM grants WHERE site_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1',
    )
    .get(siteId, Date.now());
}

export function isGrantActive(siteId) {
  return !!getActiveGrant(siteId);
}

export function createGrant(siteId, minutes) {
  const now = Date.now();
  const expiresAt = now + minutes * 60 * 1000;
  const info = db
    .prepare(
      'INSERT INTO grants (site_id, granted_at, expires_at, minutes) VALUES (?, ?, ?, ?)',
    )
    .run(siteId, now, expiresAt, minutes);
  return db.prepare('SELECT * FROM grants WHERE id = ?').get(info.lastInsertRowid);
}

export function revokeGrant(siteId) {
  db.prepare('DELETE FROM grants WHERE site_id = ? AND expires_at > ?').run(
    siteId,
    Date.now(),
  );
}

export function logDns(domain, blocked, clientIp) {
  db.prepare(
    'INSERT INTO dns_log (domain, ts, blocked, client_ip) VALUES (?, ?, ?, ?)',
  ).run(domain, Date.now(), blocked ? 1 : 0, clientIp || null);
}

export function recordKnownIp(siteId, ip) {
  db.prepare(
    `INSERT INTO known_ips (site_id, ip, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(site_id, ip) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(siteId, ip, Date.now());
}

export function getKnownIps(siteId) {
  return db
    .prepare('SELECT ip FROM known_ips WHERE site_id = ?')
    .all(siteId)
    .map((r) => r.ip);
}

// Report: domain visit counts/durations grouped by day, most recent first.
export function getReport({ sinceMs } = {}) {
  const since = sinceMs || Date.now() - 7 * 24 * 60 * 60 * 1000;
  return db
    .prepare(
      `SELECT domain,
              COUNT(*) AS queries,
              MIN(ts) AS first_seen,
              MAX(ts) AS last_seen,
              SUM(blocked) AS blocked_count
       FROM dns_log
       WHERE ts >= ?
       GROUP BY domain
       ORDER BY last_seen DESC`,
    )
    .all(since);
}

export function getRecentLog(limit = 200) {
  return db
    .prepare('SELECT * FROM dns_log ORDER BY ts DESC LIMIT ?')
    .all(limit);
}

export function getParentUser(username) {
  return db.prepare('SELECT * FROM parent_users WHERE username = ?').get(username);
}

export function upsertParentUser(username, passwordHash) {
  db.prepare(
    `INSERT INTO parent_users (username, password_hash) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
  ).run(username, passwordHash);
}

export function hasAnyParentUser() {
  return db.prepare('SELECT COUNT(*) AS n FROM parent_users').get().n > 0;
}
