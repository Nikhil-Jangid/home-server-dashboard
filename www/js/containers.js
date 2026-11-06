// Container table rows and shared container status rules. No DOM access.
import { COLORS, bytesText, parseDuration } from './format.js';

// Glances reports Docker health state as the status, so these all mean "up".
export const UP_STATES = new Set(['running', 'healthy', 'starting', 'unhealthy']);
export const isUp = status => UP_STATES.has(status);

export function statusColor(status) {
  if (status === 'running' || status === 'healthy') return COLORS.healthy;
  if (status === 'starting' || status === 'paused' || status === 'restarting') return COLORS.warn;
  if (status === 'unhealthy') return COLORS.crit;
  if (status === 'unknown') return COLORS.unknown;
  return COLORS.crit;
}

/** Strip a compose "-<n>" suffix and, for project-service-n names, the project prefix. */
export function autoName(name) {
  const m = /^(.+)-\d+$/.exec(name);
  if (!m) return name;
  const parts = m[1].split('-');
  return parts.length >= 2 ? parts[parts.length - 1] : m[1];
}

/** True when the ignore list names this container: exact name, compose base name, or an ID prefix of 4+ chars. */
export function matchesIgnore(c, list) {
  if (!Array.isArray(list) || !c) return false;
  const name = String(c.name || '').toLowerCase();
  const base = autoName(String(c.name || '')).toLowerCase();
  const id = String(c.id || '').toLowerCase();
  return list.some(x => {
    if (typeof x !== 'string') return false;
    const q = x.trim().toLowerCase();
    if (!q) return false;
    return q === name || q === base || (q.length >= 4 && id !== '' && id.startsWith(q));
  });
}

function sortValue(c, key) {
  if (key === 'cpu') return c.cpu;
  if (key === 'mem') return c.mem;
  if (key === 'uptime') return parseDuration(c.uptime);
  return String(c[key] ?? '').toLowerCase();
}

export function containerRows(containers, { filter, sortKey, sortDir, ignore }) {
  const q = String(filter || '').trim().toLowerCase();
  return containers
    .filter(c => !matchesIgnore(c, ignore))
    .filter(c => !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q))
    .sort((a, b) => {
      const down = !isUp(a.status) - !isUp(b.status); // stopped always last, whatever the sort
      if (down) return down;
      const A = sortValue(a, sortKey), B = sortValue(b, sortKey);
      if (sortKey === 'uptime' && (A < 0 || B < 0)) return (A < 0) - (B < 0); // unknown always last
      return (A < B ? -1 : A > B ? 1 : 0) * sortDir;
    })
    .map(c => {
      const stopped = !isUp(c.status);
      const dot = stopped ? COLORS.muted : statusColor(c.status);
      return {
        name: c.name, image: c.image, status: c.status, uptime: c.uptime,
        dot, stopped, statusColor: stopped ? null : dot,
        cpu: !stopped ? c.cpu.toFixed(1) : '—',
        cpuColor: stopped ? null : c.cpu >= 70 ? COLORS.warn : 'var(--t-row)',
        mem: !stopped ? bytesText(c.mem) : '—'
      };
    });
}
