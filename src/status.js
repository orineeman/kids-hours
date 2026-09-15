// עמוד תצוגה מקומי בלבד — קריאה, בלי login, בלי כתיבה. השליטה בפועל
// (הענקת/ביטול גישה, ניהול אתרים) עברה ללוח הבקרה בענן; זה כלי אבחון
// לכל מי שיושב פיזית מול המחשב הזה. לעולם לא מציג את תוכן device-token.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSyncState, listSites, getRecentLog } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenPath = path.join(__dirname, '..', 'data', 'device-token');

function deviceId() {
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    return token.split('.')[0] || null;
  } catch {
    return null;
  }
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString('he-IL') : 'עדיין לא';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml() {
  const state = getSyncState();
  const sites = listSites();
  const log = getRecentLog(50);
  const hasToken = !!deviceId();

  const syncOk = state.consecutive_failures === 0 && state.last_success_at;
  const syncBadge = !hasToken
    ? '<span class="bad">אין device token מוגדר</span>'
    : syncOk
      ? '<span class="ok">מסונכרן</span>'
      : `<span class="bad">${state.consecutive_failures} כשלים רצופים</span>`;

  const sitesRows = sites
    .map(
      (s) => `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.domains.join(', '))}</td>
        <td>${s.blocked ? 'חסום' : 'פתוח עד ' + fmtTime(s.expires_at)}</td>
      </tr>`,
    )
    .join('') || '<tr><td colspan="3" class="muted">המטמון ריק — עדיין לא היה סנכרון מוצלח.</td></tr>';

  const logRows = log
    .map(
      (r) => `<tr>
        <td>${fmtTime(r.ts)}</td>
        <td>${escapeHtml(r.domain)}</td>
        <td>${r.blocked ? 'נחסם' : 'עבר'}</td>
      </tr>`,
    )
    .join('') || '<tr><td colspan="3" class="muted">אין עדיין רשומות.</td></tr>';

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<title>מצב מקומי — בקרת אינטרנט לילדים</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.3rem; }
  table { width: 100%; border-collapse: collapse; margin: 0.75rem 0 1.5rem; }
  th, td { text-align: right; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; font-size: 0.9rem; }
  .ok { color: #0a7a2f; font-weight: 600; }
  .bad { color: #b3261e; font-weight: 600; }
  .muted { color: #777; }
  .note { color: #555; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>בקרת אינטרנט לילדים — מצב מקומי</h1>
  <p class="note">זה עמוד תצוגה בלבד. הענקת/ביטול גישה וניהול רשימת האתרים נעשים מלוח הבקרה בענן.</p>

  <p><strong>סנכרון עם הענן:</strong> ${syncBadge}<br>
  הצלחה אחרונה: ${fmtTime(state.last_success_at)} · ניסיון אחרון: ${fmtTime(state.last_attempt_at)}</p>

  <h2>מצב אתרים (מטמון מקומי)</h2>
  <table>
    <thead><tr><th>אתר</th><th>דומיינים</th><th>מצב</th></tr></thead>
    <tbody>${sitesRows}</tbody>
  </table>

  <h2>יומן DNS מקומי אחרון</h2>
  <table>
    <thead><tr><th>זמן</th><th>דומיין</th><th>תוצאה</th></tr></thead>
    <tbody>${logRows}</tbody>
  </table>
</body>
</html>`;
}

export function startStatusServer(port = 8080) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHtml());
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local status page listening on http://127.0.0.1:${port}`);
  });
  return server;
}
