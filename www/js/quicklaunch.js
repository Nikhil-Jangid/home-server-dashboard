// Quick Launch tile model: auto tiles for running containers, tiles from the user's quicklaunch file,
// and order helpers. No DOM access.
import { COLORS } from './format.js';
import { isUp, statusColor, autoName, matchesIgnore } from './containers.js';

export { autoName };
export const ORDER_KEY = 'dash.quicklaunch.order';

export function tileUrl(hostname, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = hostname.includes(':') && !hostname.startsWith('[') ? '[' + hostname + ']' : hostname;
  return 'http://' + host + (port === 80 ? '' : ':' + port);
}

function findContainer(containers, ref) {
  const q = ref.trim().toLowerCase();
  if (!q) return null;
  const byName = containers.find(c => c.name.toLowerCase() === q);
  if (byName) return byName;
  if (q.length < 4) return null;
  return containers.find(c => typeof c.id === 'string' && c.id.toLowerCase().startsWith(q)) || null;
}

function portStatus(ports, port) {
  const v = ports && typeof ports === 'object' ? ports[port] : undefined;
  if (v === 'up') return { dot: COLORS.healthy, statusText: 'up' };
  if (v === 'down') return { dot: COLORS.crit, statusText: 'not answering' };
  return { dot: COLORS.unknown, statusText: 'unknown' };
}

const validPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;

/**
 * entries: [{name, container, port, desc}] from /api/settings; containers: parseGlances().containers.
 * A container entry replaces that container's auto tile; a port-only entry is a host service.
 */
export function buildTiles(entries, containers, { live, hostname, ports, ignore }) {
  const claimed = new Set();
  const tiles = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string') continue;
    const port = validPort(e.port) ? e.port : null;
    const desc = typeof e.desc === 'string' ? e.desc : '';
    if (typeof e.container === 'string' && e.container.trim()) {
      const c = findContainer(containers, e.container);
      if (c) claimed.add(c);
      const p = port ?? c?.ports?.[0] ?? null;
      let dot = COLORS.unknown, statusText = 'unknown';
      if (live && !c) statusText = 'no container';
      else if (live) { dot = statusColor(c.status); statusText = c.status; }
      tiles.push({
        id: c ? 'ct:' + c.name : 'cfg:' + e.name, kind: 'config', name: e.name,
        desc: desc || c?.image || '', port: p, url: tileUrl(hostname, p), note: null, dot, statusText
      });
    } else if (port !== null) {
      tiles.push({ id: 'port:' + port, kind: 'port', name: e.name, desc, port, url: tileUrl(hostname, port), note: null, ...portStatus(ports, port) });
    }
  }
  const autos = containers.filter(c => isUp(c.status) && !claimed.has(c) && !matchesIgnore(c, ignore))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => {
      const port = c.ports?.[0] ?? null;
      const url = tileUrl(hostname, port);
      return {
        id: 'ct:' + c.name, kind: 'auto', name: autoName(c.name), desc: c.image, port: url ? port : null,
        url, note: url == null ? 'no web port' : null,
        dot: live ? statusColor(c.status) : COLORS.unknown, statusText: live ? c.status : 'unknown'
      };
    });
  const seen = new Set();
  return tiles.concat(autos).filter(t => !seen.has(t.id) && seen.add(t.id));
}

export function parseOrder(raw) {
  let v;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter(x => typeof x === 'string' && x.length <= 300))].slice(0, 500);
}

export function applyOrder(tiles, order) {
  const byId = new Map(tiles.map(t => [t.id, t]));
  const out = [];
  for (const id of order) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
  for (const t of tiles) if (byId.get(t.id) === t) { out.push(t); byId.delete(t.id); }
  return out;
}

export function moveId(ids, from, to) {
  const out = ids.slice();
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= out.length) return out;
  const t = Math.max(0, Math.min(out.length - 1, to));
  out.splice(t, 0, out.splice(from, 1)[0]);
  return out;
}

export function keyboardMove(index, key, total, columns) {
  const cols = Number.isFinite(columns) && columns >= 1 ? Math.floor(columns) : 1;
  let n;
  switch (key) {
    case 'ArrowLeft': n = index - 1; break;
    case 'ArrowRight': n = index + 1; break;
    case 'ArrowUp': n = index - cols; break;
    case 'ArrowDown': n = index + cols; break;
    case 'Home': return 0;
    case 'End': return total - 1;
    default: return index;
  }
  return n < 0 || n >= total ? index : n;
}

export function moveMessage(name, index, total) {
  return `Moved ${name} to position ${index + 1} of ${total}`;
}
