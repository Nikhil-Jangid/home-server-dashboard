// Pure formatting helpers. No DOM access (cssColor's default reader aside, which reads computed CSS variables).
// Theme tokens (styles.css). DOM styles take these as-is and follow a theme switch live;
// canvas code resolves them with cssColor() at draw time.
export const COLORS = {
  healthy: 'var(--healthy)',
  healthyHover: 'var(--healthy-hover)',
  warn: 'var(--warn)',
  crit: 'var(--crit)',
  unknown: 'var(--unknown)',
  muted: 'var(--muted)',
  violet: 'var(--violet)'
};

const defaultReadVar = name => {
  const d = globalThis.document;
  return d && globalThis.getComputedStyle ? globalThis.getComputedStyle(d.documentElement).getPropertyValue(name) : '';
};

/** A canvas-usable colour: 'var(--x)' resolved through readVar, anything else as given, '#808080' if unresolvable. */
export function cssColor(value, readVar = defaultReadVar) {
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(String(value ?? '').trim());
  if (!m) return value;
  return String(readVar(m[1]) ?? '').trim() || '#808080';
}

/** Status-dot halo: a 3 px ring of the dot's own colour at 14%. */
export const ring = color => '0 0 0 3px color-mix(in srgb, ' + color + ' 14%, transparent)';

export function tone(pct) {
  const l = level(pct);
  return l === 'crit' ? COLORS.crit : l === 'warn' ? COLORS.warn : COLORS.healthy;
}

/** 'crit' at >=85, 'warn' at >=70, otherwise null: the one source of the global severity thresholds. */
export function level(pct) {
  return pct >= 85 ? 'crit' : pct >= 70 ? 'warn' : null;
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function bytes(value) {
  let n = Number(value) || 0;
  let i = 0;
  const fmt = () => n.toFixed(n >= 100 || i === 0 ? 0 : 1);
  while (i < UNITS.length - 1 && (n >= 1024 || Number(fmt()) >= 1024)) { n /= 1024; i++; } // round first, never show "1024 KiB"
  return { n: fmt(), u: UNITS[i] };
}

export const bytesText = value => { const b = bytes(value); return b.n + ' ' + b.u; };
export const rate = value => { const b = bytes(value); return { n: b.n, u: b.u + '/s' }; };
export const gib = value => ((Number(value) || 0) / 1024 ** 3).toFixed(1);
export const tib = value => ((Number(value) || 0) / 1024 ** 4).toFixed(2);

export function ago(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

const UNIT_SECONDS = { sec: 1, min: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };

// Parses Glances pretty_date output ("an hour", "3 days", "yesterday") and docker
// "Up 2 weeks" style strings into seconds. Returns -1 when the text is not a duration.
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return -1;
  if (t === 'just now') return 0;
  if (t === 'yesterday') return 86400;
  const m = /^(?:up\s+|about\s+)?(\d+|an?|one)\s*(sec|min|hour|day|week|month|year)[a-z]*(?:\s+ago)?(?:\s*\(.*\))?$/.exec(t);
  if (!m) return -1;
  const qty = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  return qty * UNIT_SECONDS[m[2]];
}
