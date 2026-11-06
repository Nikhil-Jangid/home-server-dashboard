import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostLabels } from '../www/js/host.js';

test('host labels come from the server\'s own settings', () => {
  const l = hostLabels({ version: '1.0.0', host: { name: 'box', user: 'ann', cpu: 'Demo CPU · 4 threads' }, problems: [] });
  assert.deepEqual(l, { hostName: 'box', cpu: 'Demo CPU · 4 threads', session: 'ann@box', version: 'v1.0.0', problems: '' });
});

test('problems are joined as plain text', () => {
  const l = hostLabels({ host: {}, problems: ['quicklaunch: [Bad] port must be a number', 'mutes: [m] needs a source'] });
  assert.equal(l.problems, 'quicklaunch: [Bad] port must be a number · mutes: [m] needs a source');
});

test('missing or hostile settings give dashes, never throw', () => {
  for (const s of [null, undefined, {}, { host: 5, problems: 'x', version: {} }]) {
    assert.deepEqual(hostLabels(s), { hostName: '—', cpu: '—', session: '—', version: '', problems: '' });
  }
});

import { readFileSync } from 'node:fs';
const src = f => readFileSync(new URL('../www/' + f, import.meta.url), 'utf8');

test('main.js reads the machine from /api/settings and /api/ports, nothing host-specific', () => {
  const main = src('js/main.js');
  for (const s of ['CONFIG.settingsPath', 'CONFIG.portsPath', 'hostLabels(', 'setMutes(', 'setSession(', "'ql-problems'", 'storPct', 'gpus'])
    assert.ok(main.includes(s), s);
  assert.doesNotMatch(main, /api\/units|Tailscale|CONFIG\.(services|mutes|hostLabel|cpuLabel|fsOrder|pool|quickLaunchIgnore)|\.pool\b|poolPct/);
});

test('index.html has a Quick Launch problems line and no pool wording', () => {
  const html = src('index.html');
  assert.match(html, /id="ql-problems"[^>]*hidden/);
  assert.doesNotMatch(html, /merged pool/i);
});

test('the page loads nothing from other sites and has its own icon', () => {
  const html = src('index.html');
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
  assert.match(html, /<link rel="icon" href="data:,">/);
});
