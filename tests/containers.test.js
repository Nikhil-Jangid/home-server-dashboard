import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusColor, containerRows, matchesIgnore } from '../www/js/containers.js';
import { COLORS } from '../www/js/format.js';

const C = (name, status, over = {}) => ({ name, status, image: 'img/' + name, cpu: 1, mem: 1024 ** 2, uptime: '1 hour', ...over });

test('statusColor rules are shared by table and tiles', () => {
  assert.equal(statusColor('running'), COLORS.healthy);
  assert.equal(statusColor('paused'), COLORS.warn);
  assert.equal(statusColor('restarting'), COLORS.warn);
  assert.equal(statusColor('exited'), COLORS.crit);
  assert.equal(statusColor('dead'), COLORS.crit);
  assert.equal(statusColor('unknown'), COLORS.unknown);
  assert.equal(statusColor('healthy'), COLORS.healthy);
  assert.equal(statusColor('starting'), COLORS.warn);
  assert.equal(statusColor('unhealthy'), COLORS.crit);
});

test('filter matches name or image, case-insensitive', () => {
  const cs = [C('nginx', 'running'), C('whoami', 'running', { image: 'Demo/app' })];
  assert.deepEqual(containerRows(cs, { filter: 'NGI', sortKey: 'name', sortDir: 1 }).map(r => r.name), ['nginx']);
  assert.deepEqual(containerRows(cs, { filter: 'demo/', sortKey: 'name', sortDir: 1 }).map(r => r.name), ['whoami']);
  assert.deepEqual(containerRows(cs, { filter: '  ', sortKey: 'name', sortDir: 1 }).length, 2);
});

test('uptime sorts by real duration, unknown last', () => {
  const cs = [C('a', 'running', { uptime: '2 days' }), C('b', 'running', { uptime: '10 hours' }), C('c', 'exited', { uptime: '—' }), C('d', 'running', { uptime: 'an hour' })];
  assert.deepEqual(containerRows(cs, { filter: '', sortKey: 'uptime', sortDir: 1 }).map(r => r.name), ['d', 'b', 'a', 'c']);
  assert.deepEqual(containerRows(cs, { filter: '', sortKey: 'uptime', sortDir: -1 }).map(r => r.name), ['a', 'b', 'd', 'c']);
});

test('numeric sort for cpu and mem', () => {
  const cs = [C('a', 'running', { cpu: 9 }), C('b', 'running', { cpu: 80 }), C('c', 'running', { cpu: 0.5 })];
  assert.deepEqual(containerRows(cs, { filter: '', sortKey: 'cpu', sortDir: -1 }).map(r => r.name), ['b', 'a', 'c']);
});

test('row formatting: stopped containers show dashes, hot cpu is amber', () => {
  const [hot, stopped] = containerRows([C('a', 'running', { cpu: 75.25 }), C('b', 'exited')], { filter: '', sortKey: 'name', sortDir: 1 });
  assert.equal(hot.cpu, '75.3');
  assert.equal(hot.cpuColor, COLORS.warn);
  assert.equal(hot.mem, '1.0 MiB');
  assert.equal(stopped.cpu, '—');
  assert.equal(stopped.mem, '—');
  assert.equal(stopped.dot, COLORS.muted);
});

test('a healthy container row shows cpu and memory', () => {
  const [r] = containerRows([C('a', 'healthy', { cpu: 1.5, mem: 1048576 })], { filter: '', sortKey: 'name', sortDir: 1 });
  assert.equal(r.cpu, '1.5');
  assert.notEqual(r.mem, '—');
});

const KEYS = ['name', 'image', 'status', 'cpu', 'mem', 'uptime'];
test('stopped containers sort after up ones in every sort mode', () => {
  const cs = [C('a', 'exited', { cpu: 0 }), C('b', 'running', { cpu: 5 }), C('c', 'created'), C('d', 'healthy', { cpu: 1 }), C('e', 'paused')];
  for (const sortKey of KEYS) for (const sortDir of [1, -1]) {
    const rows = containerRows(cs, { filter: '', sortKey, sortDir });
    assert.deepEqual(rows.map(r => r.stopped), [false, false, true, true, true], sortKey + sortDir);
  }
});
test('stopped rows have no cpu colour even with stale cpu', () => {
  const [r] = containerRows([C('old', 'exited', { cpu: 90 })], { filter: '', sortKey: 'name', sortDir: 1 });
  assert.equal(r.cpuColor, null);
});
test('stopped rows are muted with dashes; filter still matches them', () => {
  const [r] = containerRows([C('old', 'exited')], { filter: 'OLD', sortKey: 'name', sortDir: 1 });
  assert.deepEqual([r.dot, r.statusColor, r.cpu, r.mem, r.stopped], [COLORS.muted, null, '—', '—', true]);
});

test('matchesIgnore: exact name, compose base or an ID prefix of 4+ characters, case-insensitive', () => {
  const c = { name: 'Stack-web-1', id: 'ABCDEF1234567890' };
  for (const list of [['stack-web-1'], ['WEB'], ['abcd'], ['abcdef1234567890']]) assert.equal(matchesIgnore(c, list), true, String(list));
  for (const list of [['abc'], ['stack'], ['zzzz'], [], null, undefined, 'web', [null, 5, {}]]) assert.equal(matchesIgnore(c, list), false, String(list));
});

test('ignored containers are left out of the table', () => {
  const cs = [C('nginx', 'running'), C('whoami', 'running')];
  assert.deepEqual(containerRows(cs, { filter: '', sortKey: 'name', sortDir: 1, ignore: ['whoami'] }).map(r => r.name), ['nginx']);
});
