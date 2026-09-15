// הסוכן המקומי: שולף כל כמה שניות את מצב האתרים/הגרנטים מהענן (מקור
// האמת) לתוך site_cache, ודוחף באצווה יומן DNS שנצפה. תשובת DNS עצמה
// (dnsServer.js) לעולם לא מחכה לקריאה הזו — היא קוראת רק מהמטמון שכתוב
// כאן. חוסן חובה: כשל סנכרון לא "פותח" שום דבר, רק מרחיב את הפרש הזמן עד
// לניסיון הבא (backoff עם תקרה).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  replaceSiteCache,
  recordSyncSuccess,
  recordSyncFailure,
  getSyncState,
  getLogPushWatermark,
  setLogPushWatermark,
  getDnsLogSince,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenPath = path.join(__dirname, '..', 'data', 'device-token');

const SYNC_INTERVAL_MS = Number(process.env.CLOUD_SYNC_INTERVAL_MS) || 15_000;
const LOG_PUSH_INTERVAL_MS = Number(process.env.CLOUD_LOG_PUSH_INTERVAL_MS) || 45_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

function readDeviceToken() {
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function backoffDelay(baseMs, failures) {
  return Math.min(baseMs * 2 ** failures, MAX_BACKOFF_MS) + Math.random() * 1000;
}

async function pullSites(apiBase, token) {
  const res = await fetch(`${apiBase}/api/device/sync`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sync pull failed: HTTP ${res.status}`);
  const body = await res.json();
  replaceSiteCache(body.sites || []);
}

async function pushLogs(apiBase, token) {
  const watermark = getLogPushWatermark();
  const rows = getDnsLogSince(watermark, 500);
  if (rows.length === 0) return;
  const entries = rows.map((r) => ({
    domain: r.domain,
    ts: r.ts,
    blocked: !!r.blocked,
    clientIp: r.client_ip,
  }));
  const res = await fetch(`${apiBase}/api/device/log`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) throw new Error(`log push failed: HTTP ${res.status}`);
  setLogPushWatermark(rows[rows.length - 1].id);
}

export function startCloudSync(apiBase) {
  if (!apiBase) {
    console.error('cloudSync: no API base configured — sync disabled, enforcing from last-known cache only.');
    return () => {};
  }

  let syncTimer = null;
  let logTimer = null;

  const scheduleNextSync = (ok) => {
    const delay = ok ? SYNC_INTERVAL_MS : backoffDelay(SYNC_INTERVAL_MS, getSyncState().consecutive_failures);
    syncTimer = setTimeout(syncTick, delay);
  };

  const syncTick = async () => {
    const token = readDeviceToken();
    if (!token) {
      console.error(`cloudSync: no device token at ${tokenPath} — cannot sync.`);
      recordSyncFailure();
      scheduleNextSync(false);
      return;
    }
    try {
      await pullSites(apiBase, token);
      recordSyncSuccess();
      scheduleNextSync(true);
    } catch (err) {
      console.error('cloudSync: pull failed:', err.message);
      recordSyncFailure();
      scheduleNextSync(false);
    }
  };

  const logTick = async () => {
    const token = readDeviceToken();
    if (token) {
      try {
        await pushLogs(apiBase, token);
      } catch (err) {
        console.error('cloudSync: log push failed:', err.message);
      }
    }
    logTimer = setTimeout(logTick, LOG_PUSH_INTERVAL_MS);
  };

  syncTick(); // immediate first sync, mirrors the old scheduler's immediate tick()
  logTick();

  return () => {
    clearTimeout(syncTimer);
    clearTimeout(logTimer);
  };
}
