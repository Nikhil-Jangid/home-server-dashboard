import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STALE_KEYS, clearStaleSettings } from '../www/js/settings.js';
import { ORDER_KEY } from '../www/js/quicklaunch.js';

const fakeStorage = init => {
  const mem = { ...init };
  return {
    getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }, keys: () => Object.keys(mem)
  };
};

test('the stale keys are the theme, the error filters and the local mutes', () => {
  assert.deepEqual(STALE_KEYS, ['dash.theme', 'dash.events.filters', 'dash.events.mutes']);
  assert.ok(!STALE_KEYS.includes(ORDER_KEY));
});

test('old keys removed and ignored; the tile order survives', () => {
  const s = fakeStorage({ 'dash.theme': 'phosphor', 'dash.events.filters': '{"severities":[]}', 'dash.events.mutes': '["x"]', [ORDER_KEY]: '["a"]' });
  clearStaleSettings(s);
  assert.deepEqual(s.keys(), [ORDER_KEY]);
});

test('blocked or missing storage is not fatal', () => {
  clearStaleSettings(null);
  clearStaleSettings({ removeItem: () => { throw new Error('SecurityError'); } });
});

test('main.js clears stale settings before mounting the errors panel', () => {
  const main = readFileSync(new URL('../www/js/main.js', import.meta.url), 'utf8');
  const clear = main.indexOf('clearStaleSettings(');
  assert.ok(clear > 0, 'main.js calls clearStaleSettings');
  assert.ok(clear < main.indexOf('mountEvents('), 'before mountEvents');
});

test('ORDER_KEY is the only key the frontend writes', () => {
  const dir = new URL('../www/js/', import.meta.url);
  for (const f of ['main.js', 'themes.js', 'events.js', 'quicklaunch.js', 'quicklaunch-view.js', 'terminal.js']) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const writes = [...src.matchAll(/setItem\(([^,]+),/g)].map(m => m[1].trim());
    assert.ok(writes.every(k => k === 'ORDER_KEY'), `${f}: ${writes}`);
  }
});
