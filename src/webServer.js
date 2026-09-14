import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  listSites,
  createSite,
  deleteSite,
  getSiteById,
  getActiveGrant,
  createGrant,
  revokeGrant,
  updateSiteDomains,
  getReport,
  getRecentLog,
  getParentUser,
  upsertParentUser,
  hasAnyParentUser,
} from './db.js';
import { syncSiteFirewall } from './firewall.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const secretPath = path.join(dataDir, 'session-secret');

function getOrCreateSessionSecret() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8');
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

function siteToJson(site) {
  const grant = getActiveGrant(site.id);
  return {
    id: site.id,
    name: site.name,
    domains: site.domains,
    blocked: !grant,
    expiresAt: grant ? grant.expires_at : null,
  };
}

function requireAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  res.status(401).json({ error: 'not_authenticated' });
}

export function createWebServer() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: getOrCreateSessionSecret(),
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
    }),
  );

  // --- Auth ---
  app.get('/api/session', (req, res) => {
    res.json({
      loggedIn: !!req.session?.loggedIn,
      needsSetup: !hasAnyParentUser(),
    });
  });

  app.post('/api/setup', async (req, res) => {
    if (hasAnyParentUser()) {
      return res.status(400).json({ error: 'already_configured' });
    }
    const { username, password } = req.body || {};
    if (!username || !password || password.length < 8) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    const hash = await bcrypt.hash(password, 12);
    upsertParentUser(username, hash);
    req.session.loggedIn = true;
    req.session.username = username;
    res.json({ ok: true });
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    const user = getParentUser(username || '');
    const ok = user && (await bcrypt.compare(password || '', user.password_hash));
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    req.session.loggedIn = true;
    req.session.username = username;
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // --- Sites & grants ---
  app.get('/api/sites', requireAuth, (req, res) => {
    res.json(listSites().map(siteToJson));
  });

  app.post('/api/sites', requireAuth, (req, res) => {
    const { name, domains } = req.body || {};
    if (!name || !Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    const cleanDomains = domains
      .map((d) => String(d).trim().toLowerCase())
      .filter(Boolean);
    const site = createSite(name.trim(), cleanDomains);
    res.json(siteToJson(site));
  });

  app.patch('/api/sites/:id', requireAuth, async (req, res) => {
    const site = getSiteById(Number(req.params.id));
    if (!site) return res.status(404).json({ error: 'not_found' });
    const { domains } = req.body || {};
    if (!Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    const cleanDomains = domains
      .map((d) => String(d).trim().toLowerCase())
      .filter(Boolean);
    const updated = updateSiteDomains(site.id, cleanDomains);
    // The old domain set may have been blocked via firewall rules keyed to
    // previously-learned IPs; resync so the new domain list takes effect.
    await syncSiteFirewall(updated);
    res.json(siteToJson(updated));
  });

  app.delete('/api/sites/:id', requireAuth, async (req, res) => {
    const site = getSiteById(Number(req.params.id));
    if (!site) return res.status(404).json({ error: 'not_found' });
    deleteSite(site.id);
    res.json({ ok: true });
  });

  app.post('/api/sites/:id/grant', requireAuth, async (req, res) => {
    const site = getSiteById(Number(req.params.id));
    if (!site) return res.status(404).json({ error: 'not_found' });
    const minutes = Number(req.body?.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
      return res.status(400).json({ error: 'invalid_minutes' });
    }
    createGrant(site.id, minutes);
    await syncSiteFirewall(site); // open it immediately, don't wait for the scheduler tick
    res.json(siteToJson(site));
  });

  app.post('/api/sites/:id/revoke', requireAuth, async (req, res) => {
    const site = getSiteById(Number(req.params.id));
    if (!site) return res.status(404).json({ error: 'not_found' });
    revokeGrant(site.id);
    await syncSiteFirewall(site);
    res.json(siteToJson(site));
  });

  // --- Reporting ---
  app.get('/api/report', requireAuth, (req, res) => {
    const days = Number(req.query.days) || 7;
    res.json(getReport({ sinceMs: Date.now() - days * 24 * 60 * 60 * 1000 }));
  });

  app.get('/api/log', requireAuth, (req, res) => {
    res.json(getRecentLog(Number(req.query.limit) || 200));
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}
