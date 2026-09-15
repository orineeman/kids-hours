#!/usr/bin/env node
// One-off, run-by-hand script — there is intentionally no self-serve device
// registration endpoint on the Worker (see cloud/README.md). Prints a bearer
// token once (never stored anywhere except your terminal scrollback) and the
// exact `wrangler d1 execute` command to register its hash.
//
// Usage: node scripts/create-device.js "kids-pc" [--remote|--local]

import crypto from 'node:crypto';

const name = process.argv[2] || 'kids-pc';
const target = process.argv.includes('--local') ? '--local' : '--remote';

const id = `dev_${crypto.randomBytes(6).toString('hex')}`;
const secret = crypto.randomBytes(24).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(secret).digest('hex');
const now = Date.now();
const escapedName = name.replace(/'/g, "''");

console.log('Device bearer token — copy this now, it will not be shown again:');
console.log('');
console.log(`  ${id}.${secret}`);
console.log('');
console.log('Paste that into the installer\'s "Device Token" field.');
console.log('');
console.log('Run this to register the device in D1 (only the hash below is stored):');
console.log('');
console.log(
  `npx wrangler d1 execute kids-hours ${target} --command="INSERT INTO devices (id, name, token_hash, created_at) VALUES ('${id}', '${escapedName}', '${tokenHash}', ${now});"`,
);
