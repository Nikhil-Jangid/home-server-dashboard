import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { THEMES, THEME_KEY, parseTheme, nextTheme, applyTheme, contrast, themeName, themeLabel, themeTitle } from '../www/js/themes.js';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const css = read('www/styles.css');
const html = read('www/index.html');
const init = read('www/js/theme-init.js');

const BLOCK_RE = /:root(?:,\s*:root)?\[data-theme="([a-z-]+)"\]\s*\{([^}]*)\}/g;
const blocks = {};
for (const [, id, body] of css.matchAll(BLOCK_RE)) {
  blocks[id] = {};
  for (const [, k, v] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) blocks[id][k] = v.trim();
}
const pick = (o, ks) => Object.fromEntries(ks.map(k => [k, o[k]]));
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

const REQUIRED = ['bg', 'card', 'border', 'term-head', 'term-bg', 'th-bg', 'input-bg', 'track', 'fs-track', 'deco', 'btn-bg',
  'spark-grid', 'healthy', 'healthy-hover', 'healthy-dim', 'warn', 'crit', 'unknown', 'muted', 'notice', 'violet',
  't-primary', 't-default', 't-secondary', 't-subdued', 't-muted', 't-dim', 't-faint', 't-vfaint', 't-ghost', 't-placeholder',
  't-row', 't-term', 'shadow', 'shadow-term', 'sans', 'mono', ...Array.from({ length: 16 }, (_, i) => 'ansi-' + i)];
const TEXT = ['t-primary', 't-default', 't-secondary', 't-subdued', 't-muted', 't-dim', 't-faint', 't-vfaint', 't-row',
  'healthy', 'healthy-hover', 'warn', 'crit', 'notice'];
const HEX = /^#[0-9a-f]{6}$/;

test('there are 4 themes, Midnight first, exactly one light', () => {
  assert.equal(THEMES.length, 4);
  assert.deepEqual(THEMES[0], { id: 'midnight', name: 'Midnight', scheme: 'dark' });
  assert.equal(THEMES.filter(t => t.scheme === 'light').length, 1);
  for (const t of THEMES) assert.match(t.id, /^[a-z-]+$/);
  assert.deepEqual(Object.keys(blocks).sort(), THEMES.map(t => t.id).sort());
  assert.match(css, /:root,\s*:root\[data-theme="midnight"\]\s*\{/, 'Midnight is also the un-themed default');
  assert.equal(THEME_KEY, 'dash.theme');
});

test('every theme defines every required token', () => {
  for (const [id, t] of Object.entries(blocks)) {
    for (const k of REQUIRED) assert.ok(k in t, `${id} is missing --${k}`);
    const scheme = /color-scheme:\s*(dark|light)/.exec(css.slice(css.indexOf(`[data-theme="${id}"]`)))?.[1];
    assert.equal(scheme, THEMES.find(x => x.id === id).scheme, id + ' color-scheme');
  }
});

test('severity and tested tokens are #rrggbb', () => {
  const tested = [...TEXT, 'bg', 'card', 'term-bg', 't-term', 'unknown', 'muted', ...Array.from({ length: 16 }, (_, i) => 'ansi-' + i)];
  for (const [id, t] of Object.entries(blocks)) for (const k of tested) assert.match(t[k], HEX, `${id} --${k}`);
});

test('Midnight keeps the exact severity colours', () => {
  assert.deepEqual(pick(blocks.midnight, ['healthy', 'warn', 'crit', 'unknown', 'muted']),
    { healthy: '#22d3ee', warn: '#f0b429', crit: '#ef4444', unknown: '#6b7688', muted: '#55606f' });
});

test('text, severity and chip colours meet WCAG AA in every theme', () => {
  for (const [id, t] of Object.entries(blocks)) {
    for (const k of TEXT) for (const bg of ['bg', 'card']) assert.ok(contrast(t[k], t[bg]) >= 4.5, `${id} --${k} on --${bg}`);
    assert.ok(contrast(t['t-term'], t['term-bg']) >= 4.5, id + ' terminal text');
    assert.ok(contrast(t.unknown, t.card) >= 3, id + ' unknown (non-text state, WCAG 1.4.11)');
    for (const n of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]) assert.ok(contrast(t['ansi-' + n], t['term-bg']) >= 3, `${id} ansi-${n}`);
  }
});

test('severity colours stay distinguishable', () => {
  const sev = ['healthy', 'warn', 'crit', 'notice'];
  for (const [id, t] of Object.entries(blocks)) {
    for (let i = 0; i < sev.length; i++) for (let j = i + 1; j < sev.length; j++) {
      assert.ok(dist(t[sev[i]], t[sev[j]]) >= 64, `${id} --${sev[i]} vs --${sev[j]}`);
    }
  }
});

test('styles.css and index.html hold no colour literals outside theme blocks', () => {
  const rest = css.replace(BLOCK_RE, '');
  const lit = /#[0-9a-f]{3,8}\b|rgba?\(/i;
  assert.equal(lit.exec(rest)?.[0], undefined, 'styles.css: ' + rest.slice(Math.max(0, (lit.exec(rest)?.index ?? 0) - 60), (lit.exec(rest)?.index ?? 0) + 20));
  assert.equal(lit.exec(html)?.[0], undefined, 'index.html');
});

function runInit(getItem) {
  let set = null;
  const ctx = { localStorage: { getItem }, document: { documentElement: { setAttribute(k, v) { set = [k, v]; } } } };
  vm.runInNewContext(init, ctx);
  return set;
}

test('theme-init.js always starts in Midnight and never reads storage', () => {
  assert.doesNotMatch(init, /localStorage|getItem/);
  assert.deepEqual(runInit(() => THEMES[2].id), ['data-theme', 'midnight']);
  assert.deepEqual(runInit(() => { throw new Error('blocked'); }), ['data-theme', 'midnight']);
});

test('index.html loads theme-init.js in <head> before the stylesheets, with a theme button', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const at = head.indexOf('<script src="js/theme-init.js"></script>');
  assert.ok(at > 0, 'classic theme-init script in head');
  assert.ok(at < head.indexOf('rel="stylesheet"'), 'before the stylesheet links');
  assert.match(html, /<button id="theme-btn" class="btn mono theme-btn" type="button" aria-label="Theme: Midnight — switch[^"]*"[^>]*>/);
  assert.match(html, /<meta name="theme-color"/);
});

test('parseTheme, nextTheme and contrast', () => {
  assert.equal(parseTheme(null), 'midnight'); assert.equal(parseTheme('<x>'), 'midnight');
  assert.equal(parseTheme(THEMES[1].id), THEMES[1].id);
  assert.equal(nextTheme(THEMES[3].id, 1), 'midnight'); assert.equal(nextTheme('midnight', -1), THEMES[3].id);
  assert.equal(nextTheme('midnight', 1), THEMES[1].id); assert.equal(nextTheme('bogus', 1), THEMES[1].id);
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 10) / 10, 21);
  assert.equal(contrast('#ffffff', '#000000'), contrast('#000000', '#ffffff'));
  assert.equal(contrast('#777777', '#777777'), 1);
});

test('applyTheme sets data-theme for this visit only and never touches storage', () => {
  const attrs = {};
  const root = { setAttribute: (k, v) => { attrs[k] = v; } };
  const before = globalThis.localStorage;
  let wrote = false;
  globalThis.localStorage = { setItem: () => { wrote = true; }, getItem: () => null, removeItem: () => {} };
  try {
    applyTheme(THEMES[2].id, root);
    assert.equal(attrs['data-theme'], THEMES[2].id);
    applyTheme('<script>', root);
    assert.equal(attrs['data-theme'], 'midnight');
  } finally {
    globalThis.localStorage = before;
  }
  assert.equal(wrote, false);
  assert.doesNotMatch(String(applyTheme), /storage|setItem/);   // no storage parameter or write
});

test('the button label names the current and the next theme', () => {
  assert.equal(themeName('midnight'), 'Midnight');
  assert.equal(themeName('nope'), 'Midnight');
  assert.equal(themeLabel('midnight'), 'Theme: Midnight — switch to ' + THEMES[1].name);
});

test('the button tooltip makes Shift+click (and long-press) discoverable', () => {
  assert.equal(themeTitle('midnight'), 'Click: next theme (Survey) · Shift+click or long-press: previous (Phosphor)');
  assert.equal(themeTitle('survey'), 'Click: next theme (Sodium) · Shift+click or long-press: previous (Midnight)');
  assert.equal(themeTitle('junk'), themeTitle('midnight'));
});

test('index.html gives the theme button a tooltip from the start', () => {
  assert.match(html, /id="theme-btn"[^>]*title="Click: next theme/);
});

// ── font subset ──
// UNICODES in scripts/make-font-subset.sh is the single source of truth for the subset, the @font-face
// unicode-range and (via term/test_dashboard_bashrc.py) the prompt's glyphs.
const fontScript = read('scripts/make-font-subset.sh');
const UNICODES = /^UNICODES="([^"]+)"$/m.exec(fontScript)?.[1];
const parseRanges = spec => spec.split(',').map(p => p.trim().toUpperCase().replace(/^U\+/, '')).filter(Boolean)
  .map(p => { const [lo, hi] = p.split('-'); return [parseInt(lo, 16), parseInt(hi ?? lo, 16)]; });
const codepoints = ranges => ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));

/** Code points mapped by a WOFF2 font's cmap (formats 4 and 12). Only enough of WOFF2 to reach cmap. */
function woff2Cmap(buf) {
  const numTables = buf.readUInt16BE(12), compressed = buf.readUInt32BE(20);
  let off = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buf[off++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error('bad UIntBase128'); };
  const dir = [];
  for (let t = 0; t < numTables; t++) {
    const flags = buf[off++];
    const known = flags & 0x3f, version = flags >> 6;
    if (known === 0x3f) off += 4;
    const origLength = base128();
    const transformed = known === 10 || known === 11 ? version === 0 : version !== 0;  // glyf/loca: version 0 means transformed
    dir.push({ known, length: transformed ? base128() : origLength });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(off, off + compressed));
  let at = 0, cmap = null;
  for (const t of dir) { if (t.known === 0) cmap = data.subarray(at, at + t.length); at += t.length; }
  assert.ok(cmap, 'cmap table present');
  const cps = new Set();
  for (let i = 0, n = cmap.readUInt16BE(2); i < n; i++) {
    const sub = cmap.subarray(cmap.readUInt32BE(4 + i * 8 + 4));
    const format = sub.readUInt16BE(0);
    if (format === 4) {
      const segs = sub.readUInt16BE(6) / 2, ends = 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ros = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = sub.readUInt16BE(ends + s * 2), start = sub.readUInt16BE(starts + s * 2);
        const delta = sub.readInt16BE(deltas + s * 2), ro = sub.readUInt16BE(ros + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const g = ro === 0 ? (c + delta) & 0xffff : sub.readUInt16BE(ros + s * 2 + ro + (c - start) * 2);
          if (g && (ro === 0 || ((g + delta) & 0xffff))) cps.add(c);
        }
      }
    } else if (format === 12) {
      for (let g = 0, groups = sub.readUInt32BE(12); g < groups; g++) {
        const start = sub.readUInt32BE(16 + g * 12), end = sub.readUInt32BE(20 + g * 12);
        for (let c = start; c <= end; c++) cps.add(c);
      }
    }
  }
  return cps;
}

test('font subset is a woff2 under 100 KiB with its licence', () => {
  const font = fs.readFileSync(new URL('../www/fonts/jbm-nerd-subset.woff2', import.meta.url));
  assert.equal(font.subarray(0, 4).toString('latin1'), 'wOF2');
  assert.ok(font.length < 102400, 'subset is ' + font.length + ' bytes');
  assert.match(read('www/fonts/OFL.txt'), /SIL OPEN FONT LICENSE/);
  assert.match(css, /\.term-out\s*\{[^}]*font-family:\s*'JBM Nerd', var\(--mono\)/);
  for (let i = 0; i < 16; i++) {
    assert.match(css, new RegExp(`\\.fg-${i}\\s*\\{\\s*color:\\s*var\\(--ansi-${i}\\)`), 'fg-' + i);
    assert.match(css, new RegExp(`\\.bg-${i}\\s*\\{\\s*background:\\s*var\\(--ansi-${i}\\)`), 'bg-' + i);
  }
});

test('the font holds every UNICODES code point, so no prompt glyph falls back to a system font', () => {
  assert.ok(UNICODES, 'UNICODES= line in make-font-subset.sh');
  const have = woff2Cmap(fs.readFileSync(new URL('../www/fonts/jbm-nerd-subset.woff2', import.meta.url)));
  const missing = codepoints(parseRanges(UNICODES)).filter(c => !have.has(c)).map(c => 'U+' + c.toString(16).toUpperCase());
  assert.deepEqual(missing, []);
  for (const c of [0xf00c, 0xf00d, 0xe0b0, 0xf126]) assert.ok(have.has(c), c.toString(16));
});

test('the subset is glyph-only and its unicode-range equals UNICODES, so text keeps each theme\'s mono', () => {
  const ranges = parseRanges(UNICODES);
  const hits = c => ranges.some(([lo, hi]) => lo <= c && c <= hi);
  for (const c of [0x20, 0x41, 0x7e, 0xa0, 0xe9, 0xff]) assert.ok(!hits(c), 'U+' + c.toString(16) + ' must stay with --mono');
  const face = /@font-face\s*\{([^}]*font-family:\s*'JBM Nerd';[^}]*)\}/.exec(css)?.[1];
  assert.ok(face, "@font-face for 'JBM Nerd'");
  assert.match(face, /src:\s*url\('fonts\/jbm-nerd-subset\.woff2'\) format\('woff2'\)/);
  const range = /unicode-range:\s*([^;]+);/.exec(face)?.[1];
  assert.ok(range, 'unicode-range on the subset');
  assert.deepEqual(parseRanges(range), ranges);
});
