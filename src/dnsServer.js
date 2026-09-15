import dns2 from 'dns2';
import { Resolver } from 'node:dns';
import {
  getSiteByDomain,
  isGrantActive,
  logDns,
  recordKnownIp,
} from './db.js';
import { syncSiteFirewall } from './firewall.js';

const { Packet } = dns2;

// A resolver pointed at public upstream servers, kept separate from Node's
// default resolver — the machine's own network DNS is set to 127.0.0.1
// (this server), so using the default resolver here would just call ourselves.
const upstream = new Resolver();
upstream.setServers(['1.1.1.1', '8.8.8.8']);

function resolveUpstreamA(name) {
  return new Promise((resolve) => {
    upstream.resolve4(name, (err, addresses) => {
      resolve(err || !addresses ? [] : addresses);
    });
  });
}

export function startDnsServer(port = 53) {
  const server = dns2.createServer({
    udp: true,
    handle: async (request, send, rinfo) => {
      const response = Packet.createResponseFromRequest(request);
      const [question] = request.questions;
      const name = (question?.name || '').toLowerCase();

      if (!name) {
        response.header.rcode = Packet.RCODE.FORMERR;
        return send(response);
      }

      const site = getSiteByDomain(name);
      const blocked = !!site && !isGrantActive(site.id);

      // רק דומיינים ששייכים לאתר מנוהל — לא כל שאילתת DNS שהמחשב שולח
      // (רוב מהן רעש: מודעות, CDN-ים, טלמטריה של כל אתר אחר). מספיק לדעת
      // באילו אתרים מנוהלים הילדים באמת נמצאים.
      if (site) logDns(name, blocked, rinfo?.address);

      if (blocked) {
        response.header.rcode = Packet.RCODE.NXDOMAIN;
        return send(response);
      }

      // We only resolve A records ourselves. Answering a non-A question
      // (e.g. AAAA) with A-type records would mismatch the question and
      // most resolvers would just discard it — so for anything else, return
      // an empty NOERROR instead, which correctly and harmlessly means "no
      // record of this type" (the client falls back to the A result we do
      // provide, e.g. under normal IPv4/IPv6 happy-eyeballs behavior).
      const addresses =
        question?.type === Packet.TYPE.A ? await resolveUpstreamA(name) : [];
      for (const address of addresses) {
        response.answers.push({
          name,
          type: Packet.TYPE.A,
          class: Packet.CLASS.IN,
          ttl: 30, // short TTL so a revoked grant is re-checked soon
          address,
        });
      }

      if (site && addresses.length) {
        for (const ip of addresses) recordKnownIp(site.id, ip);
        // A managed site's real IPs just changed — make sure the firewall
        // rule (used to enforce direct-IP access and cut active sessions)
        // covers them.
        syncSiteFirewall(site).catch((err) =>
          console.error('firewall sync failed', err),
        );
      }

      send(response);
    },
  });

  server.on('requestError', (err) => console.error('DNS request error:', err));
  server.on('error', (err) => console.error('DNS server error:', err));
  server.on('listening', () => console.log(`DNS resolver listening on :${port}`));

  server.listen({ udp: { port, address: '0.0.0.0', type: 'udp4' } });
  return server;
}
