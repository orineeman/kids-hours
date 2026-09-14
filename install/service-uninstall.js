// Run this ON THE WINDOWS MACHINE, as Administrator, to remove the service:
//   node install\service-uninstall.js
import pkg from 'node-windows';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Service } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const svc = new Service({
  name: 'KidsNetControl',
  script: path.join(__dirname, '..', 'src', 'index.js'),
});

svc.on('uninstall', () => console.log('Service uninstalled.'));
svc.uninstall();
