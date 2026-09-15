// D1 access layer. Mirrors the shape of the local agent's src/db.js
// (better-sqlite3, synchronous) as closely as D1's async API allows, so the
// two stay easy to compare — but every call here returns a Promise.

export const PARENT_USERNAME = '__parent__';

export async function listSites(db) {
  const { results } = await db.prepare('SELECT * FROM sites ORDER BY id').all();
  return results.map((s) => ({ ...s, domains: JSON.parse(s.domains) }));
}

export async function getSiteById(db, id) {
  const s = await db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
  return s ? { ...s, domains: JSON.parse(s.domains) } : null;
}

export async function getSiteByName(db, name) {
  const s = await db.prepare('SELECT * FROM sites WHERE name = ?').bind(name).first();
  return s ? { ...s, domains: JSON.parse(s.domains) } : null;
}

export async function createSite(db, name, domains) {
  const now = Date.now();
  const result = await db
    .prepare('INSERT INTO sites (name, domains, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(name, JSON.stringify(domains), now, now)
    .run();
  return getSiteById(db, result.meta.last_row_id);
}

export async function updateSiteDomains(db, id, domains) {
  await db
    .prepare('UPDATE sites SET domains = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(domains), Date.now(), id)
    .run();
  return getSiteById(db, id);
}

export async function deleteSite(db, id) {
  await db.prepare('DELETE FROM grants WHERE site_id = ?').bind(id).run();
  await db.prepare('DELETE FROM sites WHERE id = ?').bind(id).run();
}

export async function getActiveGrant(db, siteId) {
  return db
    .prepare(
      'SELECT * FROM grants WHERE site_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1',
    )
    .bind(siteId, Date.now())
    .first();
}

export async function isGrantActive(db, siteId) {
  return !!(await getActiveGrant(db, siteId));
}

export async function createGrant(db, siteId, minutes) {
  const now = Date.now();
  const expiresAt = now + minutes * 60 * 1000;
  await db
    .prepare(
      'INSERT INTO grants (site_id, granted_at, expires_at, minutes) VALUES (?, ?, ?, ?)',
    )
    .bind(siteId, now, expiresAt, minutes)
    .run();
}

export async function revokeGrant(db, siteId) {
  await db
    .prepare('DELETE FROM grants WHERE site_id = ? AND expires_at > ?')
    .bind(siteId, Date.now())
    .run();
}

export async function getReport(db, { sinceMs } = {}) {
  const since = sinceMs || Date.now() - 7 * 24 * 60 * 60 * 1000;
  const { results } = await db
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
    .bind(since)
    .all();
  return results;
}

// Called daily by the scheduled() handler in index.js.
export async function deleteOldDnsLogs(db, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await db.prepare('DELETE FROM dns_log WHERE ts < ?').bind(cutoff).run();
  return result.meta.changes;
}

// Also called daily by scheduled() — grants otherwise accumulate forever
// with no ongoing operational meaning once expired (nothing reads old
// grant rows; getActiveGrant only ever looks at expires_at > now).
export async function deleteOldGrants(db, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await db.prepare('DELETE FROM grants WHERE expires_at < ?').bind(cutoff).run();
  return result.meta.changes;
}

export async function getRecentLog(db, limit = 200) {
  const { results } = await db
    .prepare('SELECT * FROM dns_log ORDER BY ts DESC LIMIT ?')
    .bind(limit)
    .all();
  return results;
}

// entries: [{domain, ts, blocked, clientIp}], already capped by the caller.
export async function insertDnsLogBatch(db, deviceId, entries) {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    'INSERT INTO dns_log (device_id, domain, ts, blocked, client_ip) VALUES (?, ?, ?, ?, ?)',
  );
  const batch = entries.map((e) =>
    stmt.bind(deviceId, e.domain, e.ts, e.blocked ? 1 : 0, e.clientIp || null),
  );
  await db.batch(batch);
}

export async function hasAnyParentUser(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM parent_users').first();
  return row.n > 0;
}

export async function getParentUser(db, username) {
  return db.prepare('SELECT * FROM parent_users WHERE username = ?').bind(username).first();
}

export async function upsertParentUser(db, username, passwordHash) {
  await db
    .prepare(
      `INSERT INTO parent_users (username, password_hash) VALUES (?, ?)
       ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash,
         failed_attempts = 0, locked_until = NULL`,
    )
    .bind(username, passwordHash)
    .run();
}

// --- Login brute-force lockout (see /api/login in index.js) ---

export async function recordLoginFailure(db, username, { threshold, lockoutMs }) {
  const user = await getParentUser(db, username);
  if (!user) return;
  const failedAttempts = user.failed_attempts + 1;
  // Once over the threshold, every further attempt re-extends the lock —
  // this throttles an attacker to roughly one guess per lockoutMs instead
  // of letting them resume full-speed the instant a fixed window elapses.
  const lockedUntil = failedAttempts >= threshold ? Date.now() + lockoutMs : null;
  await db
    .prepare('UPDATE parent_users SET failed_attempts = ?, locked_until = ? WHERE username = ?')
    .bind(failedAttempts, lockedUntil, username)
    .run();
}

export async function recordLoginSuccess(db, username) {
  await db
    .prepare('UPDATE parent_users SET failed_attempts = 0, locked_until = NULL WHERE username = ?')
    .bind(username)
    .run();
}

export async function getDeviceById(db, id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first();
}

export async function touchDevice(db, id, ip) {
  await db
    .prepare('UPDATE devices SET last_synced_at = ?, last_ip = ? WHERE id = ?')
    .bind(Date.now(), ip || null, id)
    .run();
}

export async function listDevices(db) {
  const { results } = await db
    .prepare(
      'SELECT id, name, created_at, last_synced_at, last_ip, revoked_at FROM devices ORDER BY created_at',
    )
    .all();
  return results;
}

export async function revokeDevice(db, id) {
  await db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(Date.now(), id).run();
}
