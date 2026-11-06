import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityOf, createEventStore, compileMutes, compileLocalMutes, isMuted, escapeRegex, similarMute, parseLocalMutes, CATEGORIES, SEVERITIES } from '../www/js/events-model.js';

// The shipped mutes template, read the way dash-events reads it (sections of source/pattern).
import { readFileSync } from 'node:fs';
function exampleMutes() {
  const out = [];
  for (const line of readFileSync(new URL('../config/mutes.example', import.meta.url), 'utf8').split('\n')) {
    if (/^\[.+\]$/.test(line.trim())) out.push({});
    const m = /^(source|pattern)\s*=\s*(.*)$/.exec(line);
    if (m && out.length) out[out.length - 1][m[1]] = m[2].trim();
  }
  return out;
}

const E = (id, over = {}) => ({ id, source: 'kernel', message: 'm' + id, category: 'other', priority: 3, first_ts: 1, last_ts: 1, count: 1, ...over });
const ALL = { severities: new Set(SEVERITIES), categories: new Set(CATEGORIES), mutes: [] };

test('severityOf maps journal priorities', () => {
  assert.equal(severityOf(0), 'error');
  assert.equal(severityOf(3), 'error');
  assert.equal(severityOf(4), 'warning');
  assert.equal(severityOf(5), 'notice');
});

test('upsert adds then replaces by id', () => {
  const s = createEventStore();
  assert.equal(s.upsert(E('a', { count: 1 })), true);
  assert.equal(s.upsert(E('a', { count: 5, last_ts: 9 })), false);
  assert.equal(s.size, 1);
  assert.equal(s.view(ALL)[0].count, 5);
});

test('view is newest first and filtered by severity and category', () => {
  const s = createEventStore();
  s.upsert(E('a', { last_ts: 1, priority: 3, category: 'disk_io' }));
  s.upsert(E('b', { last_ts: 3, priority: 5, category: 'network' }));
  s.upsert(E('c', { last_ts: 2, priority: 4, category: 'disk_io' }));
  assert.deepEqual(s.view(ALL).map(e => e.id), ['b', 'c', 'a']);
  assert.deepEqual(s.view({ ...ALL, severities: new Set(['error', 'warning']) }).map(e => e.id), ['c', 'a']);
  assert.deepEqual(s.view({ ...ALL, categories: new Set(['network']) }).map(e => e.id), ['b']);
});

test('store evicts oldest beyond max', () => {
  const s = createEventStore({ max: 3 });
  for (let i = 0; i < 5; i++) s.upsert(E('e' + i, { last_ts: i }));
  assert.equal(s.size, 3);
  assert.deepEqual(s.view(ALL).map(e => e.id), ['e4', 'e3', 'e2']);
});

test('recentErrorCount counts err-or-worse within the window', () => {
  const s = createEventStore();
  s.upsert(E('a', { priority: 2, last_ts: 10_000 }));
  s.upsert(E('b', { priority: 4, last_ts: 10_000 }));
  s.upsert(E('c', { priority: 3, last_ts: 1 }));
  assert.equal(s.recentErrorCount(10_000 + 1000, 5000), 1);
});

test('compileMutes skips null and non-object rules; empty rule mutes nothing', () => {
  const m = compileMutes([null, { source: 'x' }]);
  assert.equal(m.length, 1);
  assert.equal(isMuted(E('a', { source: 'x', priority: 5 }), m), true);
  assert.equal(isMuted(E('b', { source: 'y' }), compileMutes([{}])), false);
});

test('mutes by exact source or regex pattern; bad regex ignored', () => {
  const m = compileMutes([{ source: 'smartd' }, { pattern: 'link (up|down) on veth' }, { pattern: '([' }]);
  assert.equal(isMuted(E('a', { source: 'smartd', priority: 5 }), m), true);
  assert.equal(isMuted(E('b', { message: 'Link DOWN on veth12', priority: 5 }), m), true);
  assert.equal(isMuted(E('c', { message: 'I/O error', priority: 5 }), m), false);
  const s = createEventStore();
  s.upsert(E('a', { source: 'smartd', priority: 5 }));
  s.upsert(E('b'));
  assert.deepEqual(s.view({ ...ALL, mutes: m }).map(e => e.id), ['b']);
});

test('the shipped mutes template quiets routine noise and keeps real problems', () => {
  const m = compileMutes(exampleMutes());
  const muted = [
    { source: 'systemd', priority: 5, message: 'session-3.scope: Consumed 1.234s CPU time.' },
    { source: 'systemd-resolved', priority: 4, message: 'Using degraded feature set UDP instead of UDP+EDNS0 for DNS server 1.1.1.1.' },
    { source: 'sudo', priority: 5, message: 'pam_unix(sudo:session): session opened for user root(uid=0) by demo(uid=1000)' },
    { source: 'cron', priority: 5, message: 'pam_unix(cron:session): session closed for user root' },
    { source: 'sudo', priority: 5, message: 'demo : TTY=pts/0 ; PWD=/home ; USER=root ; COMMAND=<hidden>' },
    { source: 'kernel', priority: 5, message: 'IPv6: MLD: clamping QRV from 1 to 2!' }];
  for (const e of muted) assert.equal(isMuted(E('x', e), m), true, e.message);
  for (const e of [{ source: 'systemd', priority: 4, message: 'Failed to start foo.service.' },
    { source: 'sshd', priority: 5, message: 'IPv6: MLD: clamping QRV' }]) assert.equal(isMuted(E('y', e), m), false, e.message);
});
test('config mutes never hide priority ≤ 3; local mutes may', () => {
  const e = E('a', { source: 'systemd', priority: 3, message: 'x Consumed 1s CPU time' });
  assert.equal(isMuted(e, compileMutes([{ source: 'systemd', pattern: 'Consumed' }])), false);
  assert.equal(isMuted(e, compileLocalMutes([{ source: 'systemd', prefix: 'x Consumed ' }])), true);
});
test('escapeRegex makes any text literal', () => {
  for (const s of ['a.b', '(x+)+$', '[', '\\', '^*?{}|/-']) {
    const re = new RegExp('^' + escapeRegex(s));
    assert.equal(re.test(s), true, s); assert.equal(re.test('Z' + s), false, s);
  }
});
test('similarMute on hostile messages builds a literal, bounded mute', () => {
  const evil = similarMute(E('a', { source: 'x', message: '((((a+)+)+)+)+$' + 'a'.repeat(5000) }));
  assert.ok(evil.prefix.length <= 60);
  const [rule] = compileLocalMutes([evil]);
  const t0 = performance.now(); rule.re.test('a'.repeat(50_000) + '!'); assert.ok(performance.now() - t0 < 50);
  assert.deepEqual(similarMute(E('b', { source: 'smartd', message: 'Device: /dev/sda [SAT], 8 Currently unreadable sectors' })),
    { source: 'smartd', prefix: 'Device: /dev/sda [SAT],' });
  assert.equal(similarMute(E('c', { message: '2 connections dropped' })).prefix, '2 connections dropped');
});
test('parseLocalMutes drops garbage, dedupes and caps at 50', () => {
  for (const raw of [null, '{', '"x"', '{"a":1}']) assert.deepEqual(parseLocalMutes(raw), []);
  assert.deepEqual(parseLocalMutes('[{"source":"s","prefix":"p"},{"source":"s","prefix":"p"},{"source":1,"prefix":"q"},{"source":"s","prefix":""}]'), [{ source: 's', prefix: 'p' }]);
  assert.equal(parseLocalMutes(JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ source: 's', prefix: 'p' + i })))).length, 50);
});
test('countMuted counts filtered-in muted entries; view(reveal) includes them', () => {
  const s = createEventStore();
  s.upsert(E('a', { source: 'smartd', priority: 5, last_ts: 3 }));
  s.upsert(E('b', { source: 'smartd', priority: 5, last_ts: 2 }));
  s.upsert(E('c', { source: 'other', priority: 5, last_ts: 1 }));
  const mutes = compileLocalMutes([{ source: 'smartd', prefix: 'm' }]);
  const f = { ...ALL, mutes };
  assert.deepEqual(s.view(f).map(e => e.id), ['c']);
  assert.equal(s.countMuted(f), 2);
  assert.equal(s.countMuted({ ...f, severities: new Set(['error']) }), 0);
  assert.deepEqual(s.view({ ...f, reveal: true }).map(e => e.id), ['a', 'b', 'c']);
});

test('a stale snapshot never overwrites a newer upsert; ties keep the greater count', () => {
  const s = createEventStore();
  s.upsert(E('a', { last_ts: 100, count: 5 }));
  assert.equal(s.upsert(E('a', { last_ts: 50, count: 9 })), false);   // older snapshot loses even with a bigger count
  assert.deepEqual([s.view(ALL)[0].last_ts, s.view(ALL)[0].count], [100, 5]);
  s.upsert(E('a', { last_ts: 100, count: 3 }));                       // tie, smaller count loses
  assert.equal(s.view(ALL)[0].count, 5);
  s.upsert(E('a', { last_ts: 100, count: 7 }));                       // tie, greater count wins
  assert.equal(s.view(ALL)[0].count, 7);
  s.upsert(E('a', { last_ts: 101, count: 1 }));                       // newer wins regardless of count
  assert.deepEqual([s.view(ALL)[0].last_ts, s.view(ALL)[0].count], [101, 1]);
});

test('malformed upserts are ignored', () => {
  const s = createEventStore();
  assert.equal(s.upsert(null), false);
  assert.equal(s.upsert({}), false);
  assert.equal(s.size, 0);
});

test('prune ages out entries older than 24h and size reflects it', () => {
  const H = 3_600_000, now = 100 * H;
  const s = createEventStore();
  s.upsert(E('old', { last_ts: now - 24 * H - 1 }));
  s.upsert(E('edge', { last_ts: now - 24 * H }));
  s.upsert(E('new', { last_ts: now - H }));
  assert.equal(s.prune(now), 1);
  assert.equal(s.size, 2);
  assert.deepEqual(s.view(ALL).map(e => e.id), ['new', 'edge']);
  assert.equal(s.prune(now + 1), 1);          // edge is now past the window
  assert.deepEqual(s.view(ALL).map(e => e.id), ['new']);
});

test('similarMute never yields a short, broad prefix (R50)', () => {
  const fs = 'EXT4-fs (sda1): remounting filesystem read-only';
  assert.equal(similarMute(E('a', { source: 'kernel', message: fs })).prefix, fs);
  assert.equal(similarMute(E('b', { message: 'Failed to start foo.service 123' })).prefix, 'Failed to start foo.service');
  assert.equal(similarMute(E('c', { message: 'Error 5 happened' })).prefix, 'Error 5 happened');   // < 12 chars / 1 word
  const long = ('word '.repeat(20)).trim();
  const p = similarMute(E('d', { message: long })).prefix;
  assert.ok(p.length <= 60 && long.startsWith(p) && p.endsWith('word'));
});
test('the shipped sudo mute is anchored to the logged-command shape', () => {
  const m = compileMutes(exampleMutes());
  const ok = 'demo : TTY=pts/0 ; PWD=/home ; USER=root ; COMMAND=<hidden>';
  assert.equal(isMuted(E('a', { source: 'sudo', priority: 5, message: ok }), m), true);
  assert.equal(isMuted(E('b', { source: 'sudo', priority: 5, message: '(command continued) <hidden>' }), m), true);
  for (const message of ['demo : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/home ; USER=root ; COMMAND=<hidden>',
    'demo : user NOT in sudoers ; TTY=pts/0 ; PWD=/home ; USER=root ; COMMAND=<hidden>'])
    assert.equal(isMuted(E('c', { source: 'sudo', priority: 5, message }), m), false, message);
});
