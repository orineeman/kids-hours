import { execFile } from 'node:child_process';
import os from 'node:os';
import { getKnownIps, isGrantActive } from './db.js';

// Real enforcement only happens on Windows (the target machine). On any other
// platform (used for local development on this Mac) we just log what would
// happen, so the rest of the app can be built/tested without netsh.
const isWindows = os.platform() === 'win32';
const RULE_PREFIX = 'KidsControl-Block';

function ruleName(site) {
  return `${RULE_PREFIX}-${site.id}`;
}

function netsh(args) {
  return new Promise((resolve) => {
    execFile('netsh', args, (err, _stdout, stderr) => {
      if (err) console.error('netsh error:', stderr?.trim() || err.message);
      resolve();
    });
  });
}

async function deleteRule(site) {
  if (!isWindows) {
    console.log(`[firewall:dry-run] delete rule ${ruleName(site)}`);
    return;
  }
  await netsh([
    'advfirewall', 'firewall', 'delete', 'rule',
    `name=${ruleName(site)}`,
  ]);
}

async function addRule(site, ips) {
  const remoteip = ips.join(',');
  if (!isWindows) {
    console.log(`[firewall:dry-run] block "${site.name}" -> ${remoteip}`);
    return;
  }
  await netsh([
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${ruleName(site)}`,
    'dir=out',
    'action=block',
    `remoteip=${remoteip}`,
    'enable=yes',
  ]);
}

/**
 * Recomputes the firewall state for one site: if it has an active grant,
 * make sure no block rule exists (open); otherwise block every IP address
 * that has ever been observed for its domains (closes already-open sessions
 * and blocks users who type the IP directly instead of the hostname).
 */
export async function syncSiteFirewall(site) {
  const ips = getKnownIps(site.id);
  // Always clear the old rule first: remoteip lists can only grow, and
  // netsh has no clean "append" verb, so delete+recreate is the simplest
  // idempotent update.
  await deleteRule(site);
  if (!isGrantActive(site.id) && ips.length > 0) {
    await addRule(site, ips);
  }
}

export async function syncAllFirewalls(sites) {
  for (const site of sites) {
    await syncSiteFirewall(site);
  }
}
