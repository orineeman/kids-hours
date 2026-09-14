import { startDnsServer } from './dnsServer.js';
import { createWebServer } from './webServer.js';
import { startScheduler } from './scheduler.js';

const DNS_PORT = Number(process.env.DNS_PORT) || 53;
const WEB_PORT = Number(process.env.WEB_PORT) || 8080;

startDnsServer(DNS_PORT);
startScheduler();

const app = createWebServer();
app.listen(WEB_PORT, () => {
  console.log(`Dashboard listening on http://127.0.0.1:${WEB_PORT}`);
});
