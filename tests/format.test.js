import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tone, level, COLORS, bytes, bytesText, rate, gib, tib, ago, parseDuration } from '../www/js/format.js';

test('tone thresholds', () => {
  assert.equal(tone(69.9), COLORS.healthy);
  assert.equal(tone(70), COLORS.warn);
  assert.equal(tone(84.9), COLORS.warn);
  assert.equal(tone(85), COLORS.crit);
});

test('bytes uses 1024 and IEC labels', () => {
  assert.deepEqual(bytes(0), { n: '0', u: 'B' });
  assert.deepEqual(bytes(1023), { n: '1023', u: 'B' });
  assert.deepEqual(bytes(1536), { n: '1.5', u: 'KiB' });
  assert.deepEqual(bytes(200 * 1024 ** 2), { n: '200', u: 'MiB' });
  assert.deepEqual(bytes(3 * 1024 ** 5), { n: '3072', u: 'TiB' });
  assert.deepEqual(bytes(undefined), { n: '0', u: 'B' });
  assert.equal(bytesText(1.5 * 1024 ** 3), '1.5 GiB');
});

test('rate appends /s', () => {
  assert.deepEqual(rate(2048), { n: '2.0', u: 'KiB/s' });
});

test('gib and tib', () => {
  assert.equal(gib(8 * 1024 ** 3), '8.0');
  assert.equal(tib(1.5 * 1024 ** 4), '1.50');
});

test('ago buckets', () => {
  const now = 10_000_000;
  assert.equal(ago(null, now), '—');
  assert.equal(ago(now - 5_000, now), '5s ago');
  assert.equal(ago(now - 125_000, now), '2m ago');
  assert.equal(ago(now - 2 * 3600_000, now), '2h ago');
  assert.equal(ago(now - 3 * 86400_000, now), '3d ago');
  assert.equal(ago(now + 5_000, now), '0s ago');
});

test('parseDuration understands Glances and docker phrasing', () => {
  assert.equal(parseDuration('just now'), 0);
  assert.equal(parseDuration('45 secs'), 45);
  assert.equal(parseDuration('a min'), 60);
  assert.equal(parseDuration('12 mins'), 720);
  assert.equal(parseDuration('an hour'), 3600);
  assert.equal(parseDuration('3 hours'), 10800);
  assert.equal(parseDuration('yesterday'), 86400);
  assert.equal(parseDuration('2 days'), 172800);
  assert.equal(parseDuration('Up 2 weeks'), 1209600);
  assert.equal(parseDuration('4 months'), 4 * 2592000);
  assert.equal(parseDuration('1 year'), 31536000);
  assert.equal(parseDuration('—'), -1);
  assert.equal(parseDuration(''), -1);
  assert.equal(parseDuration(undefined), -1);
});

test('parseDuration orders "10 hours" before "2 days"', () => {
  assert.ok(parseDuration('10 hours') < parseDuration('2 days'));
});

test('bytes never shows 1024 in a unit that has a larger one', () => {
  assert.deepEqual(bytes(1023.6), { n: '1.0', u: 'KiB' });
  assert.deepEqual(bytes(1024 ** 2 - 1), { n: '1.0', u: 'MiB' });
  assert.deepEqual(bytes(1024 ** 3 - 1), { n: '1.0', u: 'GiB' });
  assert.deepEqual(bytes(1023.4), { n: '1023', u: 'B' });
  assert.deepEqual(bytes(1024 ** 2 - 100), { n: '1.0', u: 'MiB' });
  assert.deepEqual(bytes(1023.96 * 1024), { n: '1.0', u: 'MiB' });
});

test('parseDuration is anchored: surrounding junk is not a duration', () => {
  assert.equal(parseDuration('exited 3 days ago at noon'), -1);
  assert.equal(parseDuration('x3 hours'), -1);
  assert.equal(parseDuration('3 hours later maybe'), -1);
  assert.equal(parseDuration('Up 2 weeks (healthy)'), 1209600);
  assert.equal(parseDuration('3 days ago'), 259200);
});

test('level maps percentages onto the global thresholds exactly', () => {
  assert.equal(level(69.99), null);
  assert.equal(level(70), 'warn');
  assert.equal(level(84.99), 'warn');
  assert.equal(level(85), 'crit');
  assert.equal(level(100), 'crit');
  assert.equal(level(NaN), null);
});
