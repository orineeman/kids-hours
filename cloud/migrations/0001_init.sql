CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  domains TEXT NOT NULL, -- JSON array of hostnames
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  minutes INTEGER NOT NULL
);
CREATE INDEX idx_grants_site ON grants(site_id, expires_at);

CREATE TABLE dns_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  ts INTEGER NOT NULL,
  blocked INTEGER NOT NULL,
  client_ip TEXT
);
CREATE INDEX idx_dns_log_ts ON dns_log(ts);

CREATE TABLE parent_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL -- pbkdf2:<iterations>:<saltHex>:<hashHex>, see cloud/src/auth.js
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY, -- e.g. "dev_ab12cd34"
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL, -- sha256 hex of the secret half of the bearer token
  created_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  last_ip TEXT,
  revoked_at INTEGER
);

-- Seed the same default catalog entry the local app used to seed, so a
-- fresh cloud deployment behaves the same on day one.
INSERT INTO sites (name, domains, created_at, updated_at)
VALUES ('WhatsApp Web', '["web.whatsapp.com","static.whatsapp.net"]', unixepoch() * 1000, unixepoch() * 1000);
