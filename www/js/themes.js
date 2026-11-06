// Theme registry and switching. Colours live in styles.css as :root[data-theme="…"] token blocks;
// js/theme-init.js sets Midnight before first paint. The theme lasts one visit (never saved);
// THEME_KEY is kept only so js/settings.js can remove what older versions saved.
export const THEMES = [
  { id: 'midnight', name: 'Midnight', scheme: 'dark' },  // the original look: blue-black, cyan signal
  { id: 'survey', name: 'Survey', scheme: 'light' },     // daytime: map-paper surfaces, ink text, IBM Plex
  { id: 'sodium', name: 'Sodium', scheme: 'dark' },      // evening: low-blue lamplight, Atkinson Hyperlegible
  { id: 'phosphor', name: 'Phosphor', scheme: 'dark' }   // high contrast: true black, green phosphor, all mono
];
export const THEME_KEY = 'dash.theme';

/** A known theme id, or 'midnight' for anything else (null, junk, a removed theme). */
export function parseTheme(raw) {
  return THEMES.some(t => t.id === raw) ? raw : 'midnight';
}

/** The id dir (1 forward, -1 back) steps from id, wrapping at both ends. */
export function nextTheme(id, dir) {
  const i = THEMES.findIndex(t => t.id === parseTheme(id));
  return THEMES[(i + (dir < 0 ? -1 : 1) + THEMES.length) % THEMES.length].id;
}

export const themeName = id => THEMES.find(t => t.id === parseTheme(id)).name;

/** Accessible label for the switch button: what is on now and what a click selects. */
export const themeLabel = id => 'Theme: ' + themeName(id) + ' — switch to ' + themeName(nextTheme(id, 1));

/** Tooltip for the switch button: the gestures, which the label alone does not reveal. */
export const themeTitle = id => 'Click: next theme (' + themeName(nextTheme(id, 1)) + ') · Shift+click or long-press: previous ('
  + themeName(nextTheme(id, -1)) + ')';

/** Switches the theme for this visit only. */
export function applyTheme(id, root = globalThis.document.documentElement) {
  root.setAttribute('data-theme', parseTheme(id));
}

/** Points <meta name="theme-color"> (mobile browser chrome) at the active theme's --bg. */
export function syncThemeColor(doc = globalThis.document) {
  const meta = doc.querySelector('meta[name="theme-color"]');
  const bg = globalThis.getComputedStyle(doc.documentElement).getPropertyValue('--bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);
}

const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2.x contrast ratio of two '#rrggbb' colours (1 … 21). */
export function contrast(hexA, hexB) {
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
