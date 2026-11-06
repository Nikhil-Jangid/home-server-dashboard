// Static checks of the responsive layout. The visual checks (no overflow, real target sizes) happen in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const css = read('www/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const html = read('www/index.html');

/** Bodies of every @media block whose condition matches re (one level of nesting, as styles.css uses). */
function media(re) {
  const out = [];
  for (const m of css.matchAll(/@media\s*([^{]+)\{/g)) {
    if (!re.test(m[1])) continue;
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    out.push(css.slice(start, i - 1));
  }
  return out.join('\n');
}
/** Declarations of the rules in `body` whose selector list mentions `sel`. */
const rulesFor = (body, sel) => [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, s]) => s.split(',').some(x => x.includes(sel))).map(([, , d]) => d).join(';');

test('the viewport covers the notch and the page pads for the safe areas', () => {
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(css, new RegExp('env\\(safe-area-inset-' + side));
});

test('coarse pointers get 44 px targets on every control', () => {
  const coarse = media(/pointer:\s*coarse/);
  for (const sel of ['.btn', '.icon-btn', '.ghost-btn', '.link-btn', '.filter', '.err-badge', '.term-key', '.ct th', '#ev-chips .chip', '.ql-handle']) {
    const d = rulesFor(coarse, sel);
    assert.match(d, /(min-)?height:\s*44px/, sel + ' height');
    assert.match(d, /(min-)?width:\s*44px/, sel + ' width');
  }
});

test('the key bar exists only for coarse pointers', () => {
  assert.match(html, /id="term-keys"[^>]*role="toolbar"/);
  assert.match(rulesFor(css.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ''), '.term-keys'), /display:\s*none/);
  assert.match(rulesFor(media(/pointer:\s*coarse/), '.term-keys'), /display:\s*flex/);
});

test('the hidden terminal input is 16 px, so iOS does not zoom when it takes focus', () => {
  assert.match(rulesFor(css, '.term-input'), /font-size:\s*16px/);
});

test('header: actions get their own row and the host text ellipsizes on phones', () => {
  const phone = media(/max-width:\s*479/);
  assert.match(rulesFor(phone, '.head-actions'), /flex:\s*1 1 100%|width:\s*100%|grid-column/);
  assert.match(rulesFor(css, '.sub'), /text-overflow:\s*ellipsis/);
});

test('metric cards: 1 column on phones, 2 from 480 px', () => {
  assert.match(rulesFor(media(/max-width:\s*479/), '.vitals'), /grid-template-columns:\s*(1fr|minmax\(0,\s*1fr\))/);
  assert.match(rulesFor(media(/min-width:\s*480px\)\s*and\s*\(max-width/), '.vitals'), /grid-template-columns:\s*repeat\(2,/);
});

test('containers: rows become labelled cards below 640 px, sortable through a select', () => {
  const narrow = media(/max-width:\s*639/);
  assert.match(rulesFor(narrow, '.ct thead'), /display:\s*none/);
  assert.match(rulesFor(narrow, '.ct tbody tr'), /display:\s*grid/);
  assert.match(narrow, /content:\s*attr\(data-label\)/);
  assert.match(rulesFor(narrow, '.ct-sort'), /display:\s*(block|inline-block|flex)/);
  assert.match(rulesFor(css.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ''), '.ct-sort'), /display:\s*none/);
  assert.match(html, /<select id="ct-sort"[^>]*aria-label=/);
});

test('quick launch tiles are at least 150 px on phones, descriptions clamp', () => {
  assert.match(media(/max-width:\s*479/), /minmax\(min\(150px,\s*100%\)/);
  const d = rulesFor(css, '.svc-desc');
  assert.match(d, /-webkit-line-clamp:\s*2/);
  assert.match(d, /overflow-wrap:\s*anywhere|word-break:\s*break-all/);
});

test('the whole quick launch tile shows the focus ring of its stretched link', () => {
  assert.match(css, /\.svc:has\(\.open-btn:focus-visible\)\s*\{[^}]*outline:\s*2px solid/);
});

test('terminal: 60dvh on phones, never below 12 px text', () => {
  assert.match(rulesFor(media(/max-width:\s*(479|560|639)/), '.term-panel'), /height:\s*60dvh/);
  for (const [, px] of css.matchAll(/\.term-out[^{]*\{[^}]*font-size:\s*(\d+)px/g)) assert.ok(Number(px) >= 12, px);
});

test('dim terminal text dims the glyphs, not the span background', () => {
  const d = rulesFor(css, '.t-d');
  assert.doesNotMatch(d, /opacity/);
  assert.match(d, /color-mix\(in srgb, currentColor/);
});
