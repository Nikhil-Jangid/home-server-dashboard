// Client-side store for grouped journal events from dash-events. No DOM access.
import { COLORS } from './format.js';

export const SEVERITIES = ['error', 'warning', 'notice'];
export const SEVERITY_COLORS = { error: COLORS.crit, warning: COLORS.warn, notice: 'var(--notice)' };
export const CATEGORIES = ['disk_io', 'filesystem', 'network', 'service', 'memory', 'hardware', 'other'];
export const CATEGORY_LABELS = {
  disk_io: 'DISK/IO', filesystem: 'MOUNT/FS', network: 'NET', service: 'SERVICE',
  memory: 'MEMORY', hardware: 'HARDWARE', other: 'OTHER'
};

export const severityOf = p => (p <= 3 ? 'error' : p === 4 ? 'warning' : 'notice');

export const MUTES_KEY = 'dash.events.mutes';
const MAX_LOCAL_MUTES = 50;
const MAX_SOURCE = 80;
const MAX_PREFIX = 60;

export const escapeRegex = s => String(s).replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

export function compileMutes(mutes) {
  const out = [];
  for (const m of mutes || []) {
    if (!m || typeof m !== 'object') continue;
    let re = null;
    if (m.pattern) { try { re = new RegExp(m.pattern, 'i'); } catch { continue; } }
    out.push({ source: m.source || null, re, local: false });
  }
  return out;
}

/** User-chosen mutes: the prefix is always escaped, so stored text can never act as a pattern. */
export function compileLocalMutes(list) {
  return (list || []).map(m => ({ source: m.source || null, re: new RegExp('^' + escapeRegex(m.prefix)), local: true }));
}

/** Config mutes never hide priority <= 3 (real errors); local mutes are the user's explicit choice. */
export function isMuted(e, compiled) {
  return compiled.some(m => (m.local || e.priority > 3) && (!m.source || m.source === e.source) && (!m.re || m.re.test(e.message)) && (m.source || m.re));
}

/** Cuts at the last word boundary when the text is longer than the cap. */
function capAtWord(text, cap) {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  if (/\s/.test(text[cap])) return cut.trimEnd();
  const i = cut.search(/\s\S*$/);
  return (i > 0 ? cut.slice(0, i) : cut).trimEnd();
}

/**
 * A mute for "events like this one": the message up to the first token containing a digit (counts, ids, sizes vary).
 * That stem is used only when it is specific (>= 2 words and >= 12 chars); otherwise the first 60 chars at a word boundary.
 */
export function similarMute(e) {
  const msg = String(e.message ?? '');
  const m = /(^|\s)\S*\d/.exec(msg);
  const stem = capAtWord((m ? msg.slice(0, m.index) : msg).trim(), MAX_PREFIX);
  const specific = stem.length >= 12 && stem.split(/\s+/).length >= 2;
  return { source: String(e.source ?? '').slice(0, MAX_SOURCE), prefix: specific ? stem : capAtWord(msg, MAX_PREFIX) };
}

export function parseLocalMutes(raw) {
  let list;
  try { list = JSON.parse(raw || 'null'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const { source, prefix } = m;
    if (typeof source !== 'string' || source.length > MAX_SOURCE) continue;
    if (typeof prefix !== 'string' || prefix.length < 1 || prefix.length > MAX_PREFIX) continue;
    const k = JSON.stringify([source, prefix]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ source, prefix });
    if (out.length >= MAX_LOCAL_MUTES) break;
  }
  return out;
}

export function createEventStore({ max = 1000 } = {}) {
  const byId = new Map();

  function evict() {
    while (byId.size > max) {
      let oldest = null;
      for (const e of byId.values()) if (!oldest || e.last_ts < oldest.last_ts) oldest = e;
      byId.delete(oldest.id);
    }
  }

  return {
    /** Newest wins: an older snapshot (or a tie with a smaller count) never replaces what we have. Returns true if the id is new. */
    upsert(e) {
      if (!e || typeof e !== 'object' || e.id == null) return false;
      const old = byId.get(e.id);
      if (old && (e.last_ts < old.last_ts || (e.last_ts === old.last_ts && !(e.count > old.count)))) return false;
      byId.set(e.id, e);
      evict();
      return !old;
    },
    /** Empties the store (used when the server restarts and replays its history under new ids). */
    clear() { byId.clear(); },
    /** Drops entries whose last_ts is older than the window (24 h), so "in last 24h" stays true. */
    prune(now, windowMs = 86_400_000) {
      let n = 0;
      for (const [id, e] of byId) if (now - e.last_ts > windowMs) { byId.delete(id); n++; }
      return n;
    },
    view({ severities, categories, mutes, reveal = false }) {
      return [...byId.values()]
        .filter(e => severities.has(severityOf(e.priority)))
        .filter(e => categories.has(CATEGORIES.includes(e.category) ? e.category : 'other'))
        .filter(e => reveal || !isMuted(e, mutes))
        .sort((a, b) => b.last_ts - a.last_ts);
    },
    /** Entries that pass the severity/category chips but are hidden by a mute. */
    countMuted({ severities, categories, mutes }) {
      let n = 0;
      for (const e of byId.values()) {
        if (severities.has(severityOf(e.priority)) && categories.has(CATEGORIES.includes(e.category) ? e.category : 'other') && isMuted(e, mutes)) n++;
      }
      return n;
    },
    recentErrorCount(now, windowMs = 3_600_000) {
      let n = 0;
      for (const e of byId.values()) if (e.priority <= 3 && now - e.last_ts <= windowMs) n++;
      return n;
    },
    get size() { return byId.size; }
  };
}
