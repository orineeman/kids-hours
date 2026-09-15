#!/usr/bin/env node
// One-off, run-by-hand migration: reads the site catalog (name + domains)
// out of the machine's existing local data/app.db and prints INSERT
// statements to run against D1. Deliberately does NOT migrate grants,
// dns_log, or parent_users — see cloud/README.md for why (no ongoing
// operational meaning, and the parent sets a fresh password on cutover).
//
// Usage: node scripts/migrate-local-to-d1.js /path/to/app.db [--local]

import Database from 'better-sqlite3';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node scripts/migrate-local-to-d1.js <path-to-app.db> [--local]');
  process.exit(1);
}
const target = process.argv.includes('--local') ? '--local' : '--remote';

const local = new Database(dbPath, { readonly: true });
const sites = local.prepare('SELECT name, domains, created_at FROM sites ORDER BY id').all();
local.close();

console.log(`-- ${sites.length} site(s) found in ${dbPath}.`);
console.log('-- Run each line below (or pipe this whole file to a shell loop):');
console.log('');
for (const site of sites) {
  const name = site.name.replace(/'/g, "''");
  const domains = site.domains.replace(/'/g, "''"); // already a JSON string
  const now = Date.now();
  console.log(
    `npx wrangler d1 execute kids-hours ${target} --command="INSERT OR IGNORE INTO sites (name, domains, created_at, updated_at) VALUES ('${name}', '${domains}', ${site.created_at}, ${now});"`,
  );
}
