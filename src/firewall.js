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

const TCP_STATE_DELETE_TCB = 12;

function isIPv4(ip) {
  return (
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) &&
    ip.split('.').every((octet) => Number(octet) <= 255)
  );
}

// A new Windows Firewall block rule only stops *new* outbound connections —
// WFP evaluates rules when a connection is established and then lets an
// already-open TCP session keep flowing regardless of rules added later. A
// browser tab (or WhatsApp Web's long-lived WebSocket) that connected during
// the grant window would otherwise keep working for however long it happens
// to stay open past expiry — anywhere from seconds to many minutes — instead
// of being cut the moment access is revoked. SetTcpEntry (iphlpapi.dll) is
// the actual Windows mechanism to force-close a specific established TCP
// connection from outside the process that owns it; this builds one
// MIB_TCPROW per currently-established connection to a newly-blocked IP and
// asks the OS to delete it (MIB_TCP_STATE_DELETE_TCB), same mechanism tools
// like TCPView use to end a connection. Only covers TCP — a QUIC/HTTP3
// session over UDP has no equivalent "kill" call, though new UDP packets to
// the IP are still stopped by the netsh rule itself.
function killExistingConnectionsScript(ips) {
  const targets = ips.filter(isIPv4).map((ip) => `'${ip}'`).join(',');
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace KidsNetControl -Name TcpKiller -MemberDefinition '
[System.Runtime.InteropServices.DllImport("iphlpapi.dll", SetLastError=true)]
public static extern int SetTcpEntry(byte[] tcpRow);
'
$targets = @(${targets})
if ($targets.Count -eq 0) { exit 0 }
Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
  Where-Object { $targets -contains $_.RemoteAddress } |
  ForEach-Object {
    $row = New-Object byte[] 20
    [BitConverter]::GetBytes([int]${TCP_STATE_DELETE_TCB}).CopyTo($row, 0)
    ([System.Net.IPAddress]$_.LocalAddress).GetAddressBytes().CopyTo($row, 4)
    $lp = [BitConverter]::GetBytes([UInt16]$_.LocalPort)
    $row[8] = $lp[1]; $row[9] = $lp[0]
    ([System.Net.IPAddress]$_.RemoteAddress).GetAddressBytes().CopyTo($row, 12)
    $rp = [BitConverter]::GetBytes([UInt16]$_.RemotePort)
    $row[16] = $rp[1]; $row[17] = $rp[0]
    [KidsNetControl.TcpKiller]::SetTcpEntry($row) | Out-Null
  }
`;
}

function killExistingConnections(ips) {
  if (!isWindows) {
    console.log(`[firewall:dry-run] would force-close existing connections to ${ips.join(',')}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', killExistingConnectionsScript(ips)],
      (err, _stdout, stderr) => {
        if (err) console.error('killExistingConnections error:', stderr?.trim() || err.message);
        resolve();
      },
    );
  });
}

// Signature of the last state actually applied to netsh, per site.id — lets
// syncSiteFirewall skip the delete+recreate when nothing changed, instead of
// redoing it on every scheduler tick. Redoing it unconditionally briefly
// removes an already-blocked site's rule (delete, then re-add) on every
// single tick, which is both wasted work and a recurring, if narrow, window
// where the block is momentarily absent.
const lastApplied = new Map();

function desiredSignature(site, ips) {
  return isGrantActive(site.id) || ips.length === 0
    ? 'open'
    : `block:${[...ips].sort().join(',')}`;
}

/**
 * Recomputes the firewall state for one site: if it has an active grant,
 * make sure no block rule exists (open); otherwise block every IP address
 * that has ever been observed for its domains, and force-close any
 * connection to one of those IPs that's already open (see
 * killExistingConnections) — blocks users who type the IP directly instead
 * of the hostname either way.
 */
export async function syncSiteFirewall(site) {
  const ips = getKnownIps(site.id);
  const signature = desiredSignature(site, ips);
  if (lastApplied.get(site.id) === signature) return; // already in this state
  // Clear the old rule first: remoteip lists can only grow, and netsh has no
  // clean "append" verb, so delete+recreate is the simplest idempotent
  // update for an actual state transition.
  await deleteRule(site);
  if (signature.startsWith('block:')) {
    await addRule(site, ips);
    await killExistingConnections(ips);
  }
  lastApplied.set(site.id, signature);
}

export async function syncAllFirewalls(sites) {
  for (const site of sites) {
    await syncSiteFirewall(site);
  }
}

// Called when a site is removed from the catalog entirely, so its block
// rule (if any) doesn't stay in the Windows Firewall forever with no more
// UI to remove it from.
export async function removeSiteFirewallRule(site) {
  await deleteRule(site);
  lastApplied.delete(site.id);
}
