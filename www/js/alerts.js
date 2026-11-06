// Alerts derived purely from the latest Glances view. No DOM access.
import { bytesText } from './format.js';
import { isUp } from './containers.js';

export function createAlertTracker() {
  return { since: {}, cpuHotSince: null };
}

export function trackCpu(tracker, cpu, now) {
  if (cpu > 80) { if (tracker.cpuHotSince == null) tracker.cpuHotSince = now; }
  else tracker.cpuHotSince = null;
}

export function buildAlerts(v, tracker, now = Date.now()) {
  const list = [];
  const active = new Set();
  const add = (key, severity, title, detail) => {
    active.add(key);
    if (tracker.since[key] == null) tracker.since[key] = now;
    list.push({ key, severity, title, detail, since: tracker.since[key] });
  };

  for (const c of v.containers) {
    if (c.status === 'unhealthy') add('u:' + c.name, 'warning', 'Container unhealthy — ' + c.name, 'health check failing · ' + c.image);
    else if (!isUp(c.status) && c.status !== 'exited' && c.status !== 'created') add('c:' + c.name, 'warning', 'Container not running — ' + c.name, 'status ' + c.status + ' · ' + c.image);
  }
  for (const f of v.fsList) {
    if (f.pct > 85) {
      const crit = f.pct > 95;
      add('fs:' + f.mnt, crit ? 'critical' : 'warning', 'Filesystem above ' + (crit ? '95' : '85') + '% — ' + f.mnt,
        f.pct.toFixed(1) + '% used · ' + bytesText(f.free) + ' free');
    }
  }
  if (tracker.cpuHotSince != null && now - tracker.cpuHotSince >= 60_000) {
    add('cpu', 'critical', 'CPU sustained above 80% for over 60s',
      'now ' + v.cpu.toFixed(1) + '% · load ' + (v.load ? v.load[0].toFixed(2) : '—'));
  }
  if (v.maxTemp != null && v.maxTemp > 80) {
    add('temp', 'critical', 'Temperature above 80 °C', v.maxTemp.toFixed(0) + ' °C on ' + v.maxTempLabel);
  }

  for (const k of Object.keys(tracker.since)) if (!active.has(k)) delete tracker.since[k];
  const rank = { critical: 0, warning: 1 };
  return list.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
