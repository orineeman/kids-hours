// Run this ON THE WINDOWS MACHINE, as Administrator:
//   node install\service-install.js
//
// Registers this app as a Windows Service that runs as SYSTEM, starts on
// boot (even before any user logs in), and restarts itself automatically
// if it ever crashes — so a Standard User child account can't disable
// protection just by logging out or killing a process.
import pkg from 'node-windows';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { Service } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_NAME = 'KidsNetControl';

const svc = new Service({
  name: SERVICE_NAME,
  description: 'Parental control: default-blocked sites with parent-granted temporary access.',
  script: path.join(__dirname, '..', 'src', 'index.js'),
  env: [
    { name: 'DNS_PORT', value: '53' },
    { name: 'STATUS_PORT', value: '8080' },
    // Many antivirus/parental-control suites (Kaspersky, ESET, Avast/AVG,
    // Bitdefender, ...) do HTTPS inspection: they re-sign every TLS
    // connection with their own locally-installed root CA. Windows trusts
    // that CA (it's in the system store), so PowerShell/browsers work fine,
    // but Node's fetch() only trusts its own bundled CA bundle and fails
    // cloudSync's requests with SELF_SIGNED_CERT_IN_CHAIN. Discovered live
    // on a real install. Safe to also trust the system store here since
    // Windows already does.
    { name: 'NODE_OPTIONS', value: '--use-system-ca' },
  ],
});

// node-windows doesn't set crash-recovery itself; do it with sc.exe:
// restart after 5s on 1st/2nd/subsequent failures, reset the failure
// counter after a day of stable running. Retried because sc.exe can run
// before SCM has fully committed the just-created service.
function configureAutoRestart(attempt = 1) {
  try {
    execFileSync('sc', [
      'failure', SERVICE_NAME,
      'reset=', '86400',
      'actions=', 'restart/5000/restart/5000/restart/5000',
    ]);
    console.log('Auto-restart on failure configured.');
  } catch (err) {
    if (attempt < 5) {
      setTimeout(() => configureAutoRestart(attempt + 1), 2000);
      return;
    }
    console.error('Could not configure auto-restart after retries:', err.stderr?.toString() || err.message);
  }
}

svc.on('install', () => {
  console.log('Service installed. Configuring auto-restart on failure...');
  configureAutoRestart();
  svc.start();
  console.log(`Service "${SERVICE_NAME}" installed and started.`);
});

svc.install();
