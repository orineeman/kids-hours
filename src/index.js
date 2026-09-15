import { startDnsServer } from './dnsServer.js';
import { startScheduler } from './scheduler.js';
import { startCloudSync } from './cloudSync.js';
import { startStatusServer } from './status.js';

const DNS_PORT = Number(process.env.DNS_PORT) || 53;
const STATUS_PORT = Number(process.env.STATUS_PORT) || 8080;
// אותו דומיין ש-Cloudflare Tunnel שירת בעבר — עכשיו מצביע ישירות ל-Worker
// (ראו cloud/README.md), אין תלות ב-cloudflared/Tunnel יותר.
const CLOUD_API_BASE = process.env.CLOUD_API_BASE || 'https://kids.musagim-bamaharal.org';

startDnsServer(DNS_PORT);
startScheduler();
startCloudSync(CLOUD_API_BASE);
startStatusServer(STATUS_PORT);
