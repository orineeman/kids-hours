import { listSites } from './db.js';
import { syncSiteFirewall } from './firewall.js';

// Grants expire passively (just a timestamp in the DB) — this loop is what
// actually notices an expiry and re-blocks the site, so a parent-granted
// window closes on its own with no extra action needed.
export function startScheduler(intervalMs = 5000) {
  const tick = async () => {
    for (const site of listSites()) {
      try {
        await syncSiteFirewall(site);
      } catch (err) {
        console.error(`scheduler: failed to sync ${site.name}`, err);
      }
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}
