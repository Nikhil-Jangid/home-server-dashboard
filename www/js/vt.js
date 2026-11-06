// Line-mode terminal model + ttyd wire protocol. No DOM access.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /^\x1b\[([0-9;:?>=]*)([ -\/]*)([@-~])/;
const MAX_PENDING = 4096;
const MAX_COLS = 4096;
const MAX_COUNT = 1000;
const MAX_SGR_PARAMS = 64;
const MAX_STYLES = 1024;

// ── SGR styles ──
// A style is null (all defaults) or a frozen, interned object, so equal styles are the same object (compare with ===).
const styleCache = new Map();
function internStyle(f) {
  if (f.fg === null && f.bg === null && !f.bold && !f.dim && !f.italic && !f.underline && !f.inverse) return null;
  const key = JSON.stringify([f.fg, f.bg, f.bold, f.dim, f.italic, f.underline, f.inverse]);
  let st = styleCache.get(key);
  if (!st) {
    if (styleCache.size >= MAX_STYLES) styleCache.clear();
    st = Object.freeze({ fg: f.fg, bg: f.bg, bold: f.bold, dim: f.dim, italic: f.italic, underline: f.underline, inverse: f.inverse });
    styleCache.set(key, st);
  }
  return st;
}
const defaultFlags = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
const byte = v => (v !== undefined && /^\d{0,4}$/.test(v) && Number(v) <= 255 ? Number(v || 0) : -1);

/** Applies SGR parameters (already split on ';', at most MAX_SGR_PARAMS) to the mutable flags. */
function applySgr(f, parts) {
  if (parts.length === 0) parts = [''];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!/^\d{0,4}$/.test(p)) continue; // junk or oversized: ignore
    const c = Number(p || 0);
    if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg';
      const mode = parts[i + 1];
      if (mode === '5') {
        const n = byte(parts[i + 2]);
        i += parts[i + 2] === undefined ? 1 : 2;
        if (n >= 0) f[key] = n;
      } else if (mode === '2') {
        const have = Math.min(3, Math.max(0, parts.length - (i + 2)));
        const [r, g, b] = [byte(parts[i + 2]), byte(parts[i + 3]), byte(parts[i + 4])];
        i += 1 + have;
        if (have === 3 && r >= 0 && g >= 0 && b >= 0) f[key] = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      }
      continue;
    }
    if (c === 0) Object.assign(f, defaultFlags());
    else if (c === 1) f.bold = true;
    else if (c === 2) f.dim = true;
    else if (c === 3) f.italic = true;
    else if (c === 4) f.underline = true;
    else if (c === 7) f.inverse = true;
    else if (c === 22) { f.bold = false; f.dim = false; }
    else if (c === 23) f.italic = false;
    else if (c === 24) f.underline = false;
    else if (c === 27) f.inverse = false;
    else if (c >= 30 && c <= 37) f.fg = c - 30;
    else if (c === 39) f.fg = null;
    else if (c >= 40 && c <= 47) f.bg = c - 40;
    else if (c === 49) f.bg = null;
    else if (c >= 90 && c <= 97) f.fg = c - 90 + 8;
    else if (c >= 100 && c <= 107) f.bg = c - 100 + 8;
  }
}

/** xterm 256-colour palette entry 16-255 as '#rrggbb'. */
export function xterm256(n) {
  n = Math.max(0, Math.min(255, Math.trunc(n) || 0));
  const h = x => x.toString(16).padStart(2, '0');
  if (n >= 232) { const v = 8 + 10 * (n - 232); return '#' + h(v) + h(v) + h(v); }
  const L = [0, 95, 135, 175, 215, 255], c = n - 16;
  return '#' + h(L[Math.floor(c / 36) % 6]) + h(L[Math.floor(c / 6) % 6]) + h(L[c % 6]);
}

/** CSS hooks for a run's style: classes for attributes and the 16 base colours, inline colours for the rest. */
export function runAttrs(style) {
  if (!style) return { className: '', color: null, background: null };
  const cls = [];
  if (style.bold) cls.push('t-b');
  if (style.dim) cls.push('t-d');
  if (style.italic) cls.push('t-i');
  if (style.underline) cls.push('t-u');
  let fg = style.fg, bg = style.bg;
  if (style.inverse) { [fg, bg] = [bg === null ? 'var(--term-bg)' : bg, fg === null ? 'var(--t-term)' : fg]; }
  const one = (v, kind) => {
    if (v === null) return null;
    if (typeof v === 'number') {
      if (v < 16) { cls.push(kind + '-' + v); return null; }
      return xterm256(v);
    }
    return v;
  };
  const color = one(fg, 'fg'), background = one(bg, 'bg');
  return { className: cls.join(' '), color, background };
}

// Display width of one code point: 2 for East-Asian Wide/Fullwidth and emoji, 0 for combining marks.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x2614, 0x2615], [0x2648, 0x2653], [0x26a1, 0x26a1],
  [0x26bd, 0x26be], [0x2705, 0x2705], [0x2728, 0x2728], [0x274c, 0x274c], [0x2b50, 0x2b50],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff01, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd]
];
const ZERO = [[0x300, 0x36f], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f]];
const inRanges = (cp, ranges) => {
  for (const [lo, hi] of ranges) { if (cp < lo) return false; if (cp <= hi) return true; }
  return false;
};
export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

// Lines are arrays of cells: one code point per cell, with '' as the right half of a wide character.
export function createVt({ maxLines = 2000 } = {}) {
  // each line is an array of cells with a parallel per-cell style array on `.s` (null = default)
  const mk = () => { const l = []; l.s = []; return l; };
  let lines = [mk()];
  let flags = defaultFlags();
  let style = null;  // interned style written by put()
  let row = 0;   // cursor line (normally the last; cursor up/down move it)
  let col = 0;   // cursor cell
  let pending = '';

  const cur = () => lines[row];
  const text = l => l.join('');
  const last = () => row === lines.length - 1;

  // Overwriting half of a wide character blanks the other half so nothing is left dangling.
  function unsplit(line, i) {
    if (i >= line.length) return;
    if (line[i] === '' && i > 0) { line[i - 1] = ' '; line.s[i - 1] = null; }
    else if (line[i + 1] === '') { line[i + 1] = ' '; line.s[i + 1] = null; }
  }
  const cut = (line, at) => { unsplit(line, at); line.length = Math.min(line.length, at); line.s.length = line.length; };

  function put(ch) {
    const w = charWidth(ch);
    const line = cur();
    if (w === 0) { // combining mark: attach to the previous visible cell
      let k = Math.min(col, line.length) - 1;
      while (k > 0 && line[k] === '') k--;
      if (k >= 0) line[k] += ch;
      return;
    }
    if (col + w > MAX_COLS) return; // never grow a line past MAX_COLS
    while (line.length < col) { line.push(' '); line.s.push(null); }
    unsplit(line, col);
    if (w === 2) { unsplit(line, col + 1); line[col + 1] = ''; line.s[col + 1] = style; }
    line[col] = ch;
    line.s[col] = style;
    col += w;
  }

  function csi(params, final) {
    const n = Math.min(MAX_COUNT, Math.max(1, parseInt(params, 10) || 1));
    const line = cur();
    switch (final) {
      case 'J':
        if (params === '2' || params === '3') { lines = [mk()]; row = 0; col = 0; }
        else if (params === '' || params === '0') { cut(line, col); lines.length = row + 1; }
        break;
      case 'K':
        if (params === '' || params === '0') cut(line, col);
        else if (params === '1') {
          const end = Math.min(col + 1, line.length);
          unsplit(line, end);
          for (let i = 0; i < end; i++) { line[i] = ' '; line.s[i] = null; }
        } else if (params === '2') { line.length = 0; line.s.length = 0; }
        break;
      case 'A': row = Math.max(0, row - n); break;
      case 'B': row = Math.min(lines.length - 1, row + n); break;
      case 'C': col = Math.min(MAX_COLS, col + n); break;
      case 'D': col = Math.max(0, col - n); break;
      case 'G': col = Math.min(MAX_COLS, n - 1); break;
      case 'P': unsplit(line, col); unsplit(line, col + n); line.splice(col, n); line.s.splice(col, n); break;
      case '@': if (col < line.length) { unsplit(line, col); line.splice(col, 0, ...Array(n).fill(' ')); line.s.splice(col, 0, ...Array(n).fill(null)); line.length = Math.min(line.length, MAX_COLS); line.s.length = line.length; } break;
      case 'm':
        if (!params.includes(':') && !/[?>=]/.test(params)) { applySgr(flags, params.split(';', MAX_SGR_PARAMS)); style = internStyle(flags); }
        break;
      default: break; // cursor addressing, modes: ignored in line mode
    }
  }

  function write(txt) {
    txt = (pending + txt).replace(OSC, '');
    pending = '';
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      if (ch === '\x1b') {
        const rest = txt.slice(i);
        const m = CSI.exec(rest);
        if (m) { csi(m[1], m[3]); i += m[0].length - 1; continue; }
        const incomplete = rest.length === 1 || rest.startsWith('\x1b]') || /^\x1b\[[0-9;:?>=]*[ -\/]*$/.test(rest) || /^\x1b[()*+]$/.test(rest);
        if (incomplete) { pending = rest.length <= MAX_PENDING ? rest : ''; break; }
        i += '()*+'.includes(rest[1]) ? 2 : 1; // ESC ( B  /  ESC =
        continue;
      }
      if (ch === '\r') { col = 0; continue; }
      if (ch === '\n') { if (last()) lines.push(mk()); row++; col = 0; continue; }
      if (ch === '\b') { col = Math.max(0, col - 1); continue; }
      if (ch < ' ' && ch !== '\t') continue;
      // astral code points arrive as surrogate pairs: take both halves as one character
      if (ch >= '\ud800' && ch <= '\udbff' && i + 1 < txt.length && txt[i + 1] >= '\udc00' && txt[i + 1] <= '\udfff') { put(ch + txt[i + 1]); i++; continue; }
      if (ch >= '\ud800' && ch <= '\udbff' && i + 1 === txt.length) { pending = ch; break; } // pair split across frames
      put(ch);
    }
    if (lines.length > maxLines) { const drop = lines.length - maxLines; lines = lines.slice(drop); row = Math.max(0, row - drop); }
  }

  function snapshot() {
    const line = cur();
    const head = lines.slice(0, row).map(text).join('\n') + (row > 0 ? '\n' : '');
    const tail = lines.slice(row + 1).map(text).join('\n');
    return { before: head + text(line.slice(0, col)), after: text(line.slice(col)) + (last() ? '' : '\n' + tail) };
  }

  /** Styled runs split at the cursor; only the newest `styledLines` lines carry styles. */
  function runs({ styledLines = 500 } = {}) {
    const firstStyled = lines.length - Math.max(0, styledLines);
    const add = (out, t, st) => {
      if (t === '') return;
      const lastRun = out[out.length - 1];
      if (lastRun && lastRun.style === st) lastRun.text += t; else out.push({ text: t, style: st });
    };
    const nl = out => { if (out.length) out[out.length - 1].text += '\n'; else out.push({ text: '\n', style: null }); };
    const cells = (out, li, from, to) => {
      const l = lines[li], styled = li >= firstStyled;
      for (let i = from; i < Math.min(to, l.length); i++) add(out, l[i], styled ? l.s[i] || null : null);
    };
    const before = [], after = [];
    for (let li = 0; li < row; li++) { cells(before, li, 0, Infinity); nl(before); }
    cells(before, row, 0, col);
    cells(after, row, col, Infinity);
    for (let li = row + 1; li < lines.length; li++) { nl(after); cells(after, li, 0, Infinity); }
    return { before, after };
  }

  return {
    write,
    runs,
    clear() { lines = [mk()]; row = 0; col = 0; pending = ''; flags = defaultFlags(); style = null; },
    text: () => lines.map(text).join('\n'),
    snapshot
  };
}

// ── terminal geometry (pure) ──
export const DEFAULT_CELL = { w: 7.8, h: 19.5 }; // 13px mono at line-height 1.5, used until the DOM can be measured

/** Character cell from the bounding box of a block of `chars` columns by `lines` lines; null if it is not usable. */
export function cellFromRect(rect, chars, lines) {
  if (!rect || !(chars > 0) || !(lines > 0)) return null;
  const w = rect.width / chars, h = rect.height / lines;
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

/** Columns/rows that fit a client box once padding is removed (never fewer than 20x6). */
export function gridSize(width, height, cell, pad = { x: 40, y: 30 }) {
  const c = cell || DEFAULT_CELL;
  const cols = Math.floor((width - pad.x) / c.w), rows = Math.floor((height - pad.y) / c.h);
  return { cols: Math.max(20, Number.isFinite(cols) ? cols : 0), rows: Math.max(6, Number.isFinite(rows) ? rows : 0) };
}

const KEYS = {
  Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b',
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~'
};

// xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4)
const modParam = e => 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
const MODIFIABLE = {
  ArrowUp: ['1', 'A'], ArrowDown: ['1', 'B'], ArrowRight: ['1', 'C'], ArrowLeft: ['1', 'D'],
  Home: ['1', 'H'], End: ['1', 'F'], Delete: ['3', '~'], PageUp: ['5', '~'], PageDown: ['6', '~']
};

export function keyToSeq(e, { hasSelection = false, fullscreen = false } = {}) {
  const k = e.key;
  const lower = k.length === 1 ? k.toLowerCase() : k;
  if (e.metaKey) return null;                                   // Cmd shortcuts belong to the browser
  if (e.ctrlKey && lower === 'c' && hasSelection) return null;  // copy
  if (e.ctrlKey && lower === 'v') return null;                  // paste → handled by paste event
  if (k === 'Escape' && fullscreen) return null;                // exits fullscreen instead
  const m = modParam(e);
  if (m > 1 && Object.hasOwn(MODIFIABLE, k)) {
    const [num, fin] = MODIFIABLE[k];
    return '\x1b[' + num + ';' + m + fin;
  }
  if (KEYS[k]) return KEYS[k];
  if (e.altKey) return null;
  if (e.ctrlKey && k.length === 1) {
    const c = k.toUpperCase().charCodeAt(0);
    return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : null;
  }
  return [...k].length === 1 ? k : null; // one code point (astral emoji have length 2)
}

export const encodeInput = (s, tty) => (tty ? '0' + s : s);
export const resizeMessage = (cols, rows) => '1' + JSON.stringify({ columns: cols, rows });
export const handshake = (token, cols, rows) => JSON.stringify({ AuthToken: token, columns: cols, rows });

export function decodeFrame(data, tty, decoder) {
  if (typeof data === 'string') return data;
  const buf = new Uint8Array(data);
  if (!tty) return decoder.decode(buf, { stream: true });
  if (buf[0] !== 0x30) return null; // '0' = output; '1' title, '2' prefs → ignored
  return decoder.decode(buf.subarray(1), { stream: true });
}

// ── on-screen key bar (touch screens have no Esc, Tab, Ctrl or arrows) ──
export const KEYBAR = [
  { key: 'Escape', label: 'Esc', name: 'Escape' },
  { key: 'Tab', label: 'Tab', name: 'Tab' },
  { key: 'Control', label: 'Ctrl', name: 'Control (applies to the next key)' },
  { key: 'ArrowLeft', label: '←', name: 'Left arrow' },
  { key: 'ArrowUp', label: '↑', name: 'Up arrow' },
  { key: 'ArrowDown', label: '↓', name: 'Down arrow' },
  { key: 'ArrowRight', label: '→', name: 'Right arrow' },
  { key: 'Backspace', label: '⌫', name: 'Backspace' }
];

/** Bytes a key-bar key sends: the physical key's sequence (Esc too, even in fullscreen). Control latches instead → null. */
export const keyBarSeq = key => (key !== 'Control' && KEYBAR.some(k => k.key === key) ? KEYS[key] : null);

/** What a latched Ctrl makes of the next input: a control code, or the xterm Ctrl form of a cursor/edit key. */
export function ctrlSeq(seq) {
  const s = String(seq);
  let m = /^\x1b\[([A-DHF])$/.exec(s);
  if (m) return '\x1b[1;5' + m[1];
  m = /^\x1b\[(\d+)~$/.exec(s);
  if (m) return '\x1b[' + m[1] + ';5~';
  if (!s) return s;
  const ch = s[0], rest = s.slice(1);
  if (ch === ' ') return '\x00' + rest;
  if (ch === '?') return '\x7f' + rest;
  const c = ch.toUpperCase().charCodeAt(0);
  return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) + rest : s;
}
