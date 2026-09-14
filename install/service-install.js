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
    { name: 'WEB_PORT', value: '8080' },
  ],
});

svc.on('install', () => {
  console.log('Service installed. Configuring auto-restart on failure...');
  try {
    // node-windows doesn't set crash-recovery itself; do it with sc.exe:
    // restart after 5s on 1st/2nd/subsequent failures, reset the failure
    // counter after a day of stable running.
    execFileSync('sc', [
      'failure', SERVICE_NAME,
      'reset=', '86400',
      'actions=', 'restart/5000/restart/5000/restart/5000',
    ]);
  } catch (err) {
    console.error('Could not configure auto-restart (run as Administrator):', err.message);
  }
  svc.start();
  console.log(`Service "${SERVICE_NAME}" installed and started.`);
});

svc.install();
