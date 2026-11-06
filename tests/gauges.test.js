import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaugeDash, sparkPoints, drawSpark, easeStep, setGauge } from '../www/js/gauges.js';
import { cssColor, ring, COLORS } from '../www/js/format.js';

test('gaugeDash maps percent onto the 270° arc and clamps', () => {
  assert.equal(gaugeDash(0), '0.0 320.4');
  assert.equal(gaugeDash(50), '120.2 320.4');
  assert.equal(gaugeDash(100), '240.3 320.4');
  assert.equal(gaugeDash(140), '240.3 320.4');
  assert.equal(gaugeDash(-5), '0.0 320.4');
  assert.equal(gaugeDash(NaN), '0.0 320.4');
});

test('sparkPoints spaces 60 slots across the width with 3px padding', () => {
  const pts = sparkPoints([0, 50, 100], 59, 38, 100);
  assert.deepEqual(pts, [[0, 35], [1, 19], [2, 3]]);
});

test('sparkPoints clamps values above max', () => {
  assert.deepEqual(sparkPoints([200], 59, 38, 100), [[0, 3]]);
});

test('sparkPoints never yields NaN for max 0, non-finite max or non-finite values', () => {
  const flat = pts => pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && y === pts[0][1]);
  assert.ok(flat(sparkPoints([0, 0, 0], 59, 38, 0)));
  assert.ok(flat(sparkPoints([5, 9], 59, 38, 0)));
  assert.ok(flat(sparkPoints([5, 9], 59, 38, NaN)));
  assert.ok(flat(sparkPoints([5, 9], 59, 38, Infinity)));
  assert.deepEqual(sparkPoints([0, 50], 59, 38, 100)[1], [1, 19]);
  const odd = sparkPoints([NaN, Infinity, -5, 100], 59, 38, 100);
  assert.ok(odd.every(p => p.every(Number.isFinite)));
  assert.equal(odd[3][1], 3);
});

function fakeCanvas(w, h) {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'calls' ? calls : (...a) => calls.push(k)),
    set: (_, k, v) => { calls.push(k + '=' + v); return true; }
  });
  return { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx, calls };
}

test('drawSpark resizes the backing store on width, height and devicePixelRatio changes', () => {
  const was = globalThis.devicePixelRatio;
  try {
    globalThis.devicePixelRatio = 1;
    const cv = fakeCanvas(100, 40);
    const series = [{ data: [1, 2, 3], color: '#fff' }];
    drawSpark(cv, series, { max: 10 });
    assert.deepEqual([cv.width, cv.height], [100, 40]);
    cv.clientHeight = 60;                      // height only
    drawSpark(cv, series, { max: 10 });
    assert.deepEqual([cv.width, cv.height], [100, 60]);
    globalThis.devicePixelRatio = 2;           // dpr only
    drawSpark(cv, series, { max: 10 });
    assert.deepEqual([cv.width, cv.height], [200, 120]);
  } finally { globalThis.devicePixelRatio = was; }
});

test('drawSpark survives an all-zero or non-finite series without NaN geometry', () => {
  const cv = fakeCanvas(100, 40);
  assert.doesNotThrow(() => drawSpark(cv, [{ data: [0, 0, 0], color: '#fff' }]));
  assert.doesNotThrow(() => drawSpark(cv, [{ data: [Infinity, NaN, 3], color: '#fff' }]));
});

test('easeStep eases toward the target and snaps relative to each range', () => {
  const disp = { a: 0, b: 0, c: 1_000_000 }, tgt = { a: 100, b: 0, c: 1_000_030 };
  const moving = easeStep(disp, tgt, { a: 100, b: 100, c: 1_000_000 });
  assert.equal(moving, true);
  assert.ok(disp.a > 0 && disp.a < 100);
  assert.equal(disp.c, 1_000_030, 'diff of 30 on a 1e6 range snaps');
  const d2 = { a: 99.99 }, t2 = { a: 100 };
  assert.equal(easeStep(d2, t2, { a: 100 }), false);
  assert.equal(d2.a, 100);
  assert.equal(easeStep({ a: 5 }, { a: 5 }, { a: 100 }), false);
  // an absolute threshold would never settle a bytes/s series
  const big = { r: 0 }; let n = 0;
  while (easeStep(big, { r: 5e6 }, { r: 5e6 }) && n < 200) n++;
  assert.ok(n < 100);
});

test('drawSpark resolves var() colours at draw time', () => {
  const cv = fakeCanvas(100, 40);
  const vars = { '--healthy': '#123456', '--spark-grid': '#0a0b0c', '--healthy-dim': '#fedcba' };
  drawSpark(cv, [{ data: [1, 2, 3], color: 'var(--healthy)', fill: 'var(--healthy-dim)' }], { max: 10, readVar: n => vars[n] || '' });
  const strokes = cv.calls.filter(c => c.startsWith('strokeStyle='));
  assert.equal(strokes[0], 'strokeStyle=#0a0b0c', 'grid line uses --spark-grid');
  assert.equal(strokes.at(-1), 'strokeStyle=#123456');
  assert.ok(cv.calls.includes('fillStyle=#fedcba'));
  vars['--healthy'] = '#654321';            // a theme switch: the next draw picks up the new value
  drawSpark(cv, [{ data: [1, 2, 3], color: 'var(--healthy)' }], { max: 10, readVar: n => vars[n] || '' });
  assert.equal(cv.calls.filter(c => c.startsWith('strokeStyle=')).at(-1), 'strokeStyle=#654321');
});

test('cssColor passes plain colours through and falls back for unknown vars', () => {
  assert.equal(cssColor('#abcdef', () => ''), '#abcdef');
  assert.equal(cssColor('var(--x)', () => ''), '#808080');
  assert.equal(cssColor('var(--x)', n => (n === '--x' ? ' #010203 ' : '')), '#010203');
  assert.equal(cssColor('var(--x)'), '#808080', 'no document in node: the default reader falls back');
});

test('COLORS are live CSS variables and ring() mixes a halo from any colour', () => {
  assert.deepEqual(COLORS, { healthy: 'var(--healthy)', healthyHover: 'var(--healthy-hover)', warn: 'var(--warn)',
    crit: 'var(--crit)', unknown: 'var(--unknown)', muted: 'var(--muted)', violet: 'var(--violet)' });
  assert.equal(ring('var(--warn)'), '0 0 0 3px color-mix(in srgb, var(--warn) 14%, transparent)');
});

test('setGauge sets the stroke as a style, since the SVG attribute cannot take var()', () => {
  const attrs = {}, value = { style: {}, setAttribute: (k, v) => { attrs[k] = v; } }, num = { textContent: '' };
  const root = { querySelector: s => (s === '.value' ? value : num) };
  setGauge(root, 50, 'var(--warn)', '50.0');
  assert.equal(value.style.stroke, 'var(--warn)');
  assert.equal(attrs.stroke, undefined);
  assert.equal(attrs['stroke-dasharray'], '120.2 320.4');
  assert.equal(num.textContent, '50.0');
});
