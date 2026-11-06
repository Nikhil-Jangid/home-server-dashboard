import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoName, buildTiles, parseOrder, applyOrder, moveId, keyboardMove, moveMessage, tileUrl } from '../www/js/quicklaunch.js';
import { COLORS } from '../www/js/format.js';

const C = (name, status, over = {}) => ({ name, id: '', status, image: 'img/' + name, cpu: 0, mem: 0, uptime: '1 hour', ports: [], ...over });
const opts = { live: true, hostname: 'h', ports: {} };

test('autoName trims compose suffixes', () => {
  for (const [i, o] of [['app-web-1', 'web'], ['stack-web-2', 'web'], ['app-1', 'app'],
    ['helper', 'helper'], ['stack-api', 'stack-api'], ['my-proj-api-12', 'api']]) assert.equal(autoName(i), o);
});

test('every running container gets an auto tile; stopped ones do not; no port means no Open link', () => {
  const cs = [C('nginx', 'running', { ports: [8080] }), C('busybox', 'running'), C('oldbox', 'exited', { ports: [9000] })];
  const t = buildTiles([], cs, opts);
  assert.deepEqual(t.map(x => x.id), ['ct:busybox', 'ct:nginx']);
  assert.deepEqual([t[1].kind, t[1].url, t[1].desc, t[1].note], ['auto', 'http://h:8080', 'img/nginx', null]);
  assert.deepEqual([t[0].url, t[0].port, t[0].note], [null, null, 'no web port']);
});

test('a container entry overrides that container\'s auto tile (name, desc, port), matched by exact name', () => {
  const cs = [C('nginx', 'healthy', { ports: [8080] }), C('nginx-old', 'running', { ports: [8081] })];
  const t = buildTiles([{ name: 'Web', container: 'NGINX', port: 9090, desc: 'front door' }], cs, opts);
  assert.deepEqual(t.map(x => [x.id, x.name, x.port, x.url, x.desc, x.statusText]),
    [['ct:nginx', 'Web', 9090, 'http://h:9090', 'front door', 'healthy'], ['ct:nginx-old', 'nginx-old', 8081, 'http://h:8081', 'img/nginx-old', 'running']]);
});

test('a container entry without a port uses the container\'s first published port', () => {
  const [t] = buildTiles([{ name: 'Web', container: 'nginx', port: null, desc: '' }], [C('nginx', 'running', { ports: [8080, 8443] })], opts);
  assert.deepEqual([t.port, t.url], [8080, 'http://h:8080']);
});

test('a container entry matches an ID prefix of 4+ characters, never a shorter one', () => {
  const cs = [C('nginx', 'running', { id: 'f6747af2c86cb9e08a1f', ports: [8080] })];
  const [hit] = buildTiles([{ name: 'By id', container: 'F674', port: null, desc: '' }], cs, opts);
  assert.deepEqual([hit.id, hit.name], ['ct:nginx', 'By id']);
  const short = buildTiles([{ name: 'Short', container: 'f67', port: null, desc: '' }], cs, opts);
  assert.deepEqual(short.map(x => [x.id, x.statusText]), [['cfg:Short', 'no container'], ['ct:nginx', 'running']]);
});

test('a missing container shows "no container"; while the API is down every tile is grey "unknown"', () => {
  const [t] = buildTiles([{ name: 'Gone', container: 'nope', port: 1234, desc: '' }], [], opts);
  assert.deepEqual([t.id, t.dot, t.statusText, t.url], ['cfg:Gone', COLORS.unknown, 'no container', 'http://h:1234']);
  const [u] = buildTiles([{ name: 'W', container: 'nginx', port: null, desc: '' }], [C('nginx', 'running')], { ...opts, live: false });
  assert.deepEqual([u.dot, u.statusText], [COLORS.unknown, 'unknown']);
});

test('a port-only entry takes its status from the port probe', () => {
  const tile = ports => buildTiles([{ name: 'NAS', container: null, port: 5000, desc: 'admin' }], [], { ...opts, ports })[0];
  assert.deepEqual([tile({ 5000: 'up' }).id, tile({ 5000: 'up' }).url], ['port:5000', 'http://h:5000']);
  assert.deepEqual([tile({ 5000: 'up' }).dot, tile({ 5000: 'up' }).statusText], [COLORS.healthy, 'up']);
  assert.deepEqual([tile({ 5000: 'down' }).dot, tile({ 5000: 'down' }).statusText], [COLORS.crit, 'not answering']);
  for (const ports of [{}, null, { 5000: 7 }]) assert.deepEqual([tile(ports).dot, tile(ports).statusText], [COLORS.unknown, 'unknown']);
});

test('ignored containers get no auto tile (name, compose base or ID prefix, case-insensitive)', () => {
  const cs = [C('helper', 'running'), C('Helper-helper-1', 'running'), C('busybox', 'running', { id: 'abcdef123456' }), C('web', 'running')];
  assert.deepEqual(buildTiles([], cs, { ...opts, ignore: ['HELPER', 'ABCD'] }).map(t => t.id), ['ct:web']);
  for (const ignore of [undefined, null, 'helper', [null, 3, {}]]) assert.equal(buildTiles([], cs, { ...opts, ignore }).length, 4);
});

test('tile ids are unique; first wins', () => {
  const t = buildTiles([{ name: 'A', container: 'web', port: 1 }, { name: 'B', container: 'web', port: 2 },
    { name: 'P', container: null, port: 7 }, { name: 'P2', container: null, port: 7 }], [C('web', 'running')], opts);
  assert.deepEqual(t.map(x => x.name), ['A', 'P']);
  assert.deepEqual(parseOrder('["a","b","a"]'), ['a', 'b']);
  assert.deepEqual(applyOrder([{ id: 'x' }, { id: 'x' }, { id: 'y' }], ['y']).map(z => z.id), ['y', 'x']);
});

test('hostile entries are harmless', () => {
  const t = buildTiles([null, 5, { name: 'X' }, { name: 'Bad port', container: null, port: 99999 }], [C('x', 'running')], opts);
  assert.ok(t.every(x => x.url === null || /^http:\/\/h(:\d+)?$/.test(x.url)));
});

test('never derives a URL from a container name', () => {
  for (const t of buildTiles([], [C('whoami', 'running')], opts)) assert.equal(t.url, null);
});

test('parseOrder survives corrupt storage', () => {
  for (const raw of [null, '', '{', '"x"', '{"a":1}', 'null']) assert.deepEqual(parseOrder(raw), []);
  assert.deepEqual(parseOrder('[1,null,"ct:a",{"x":1}]'), ['ct:a']);
  assert.equal(parseOrder(JSON.stringify(Array.from({ length: 900 }, (_, i) => 'ct:' + i))).length, 500);
});
test('applyOrder: stored first, unknown ignored, new tiles append in default order', () => {
  const tiles = ['ct:A', 'ct:B', 'ct:C', 'ct:D'].map(id => ({ id }));
  assert.deepEqual(applyOrder(tiles, ['ct:D', 'gone', 'ct:B', 'ct:D']).map(t => t.id), ['ct:D', 'ct:B', 'ct:A', 'ct:C']);
});
test('moveId and keyboardMove', () => {
  assert.deepEqual(moveId(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 0, 9), ['b', 'c', 'a']);
  const k = (i, key) => keyboardMove(i, key, 12, 4);
  assert.deepEqual([k(5, 'ArrowLeft'), k(5, 'ArrowRight'), k(5, 'ArrowUp'), k(5, 'ArrowDown')], [4, 6, 1, 9]);
  assert.deepEqual([k(0, 'ArrowLeft'), k(11, 'ArrowRight'), k(1, 'ArrowUp'), k(10, 'ArrowDown'), k(7, 'ArrowDown'), k(3, 'Enter')], [0, 11, 1, 10, 11, 3]);
  assert.equal(moveMessage('Whoami', 2, 12), 'Moved Whoami to position 3 of 12');
});
test('keyboardMove hardening, Home/End', () => {
  assert.equal(keyboardMove(3, 'constructor', 12, 4), 3);
  assert.equal(keyboardMove(3, '__proto__', 12, 4), 3);
  assert.deepEqual([keyboardMove(5, 'Home', 12, 4), keyboardMove(5, 'End', 12, 4)], [0, 11]);
  assert.equal(keyboardMove(5, 'ArrowDown', 12, NaN), 6);
  assert.equal(keyboardMove(5, 'ArrowDown', 12, 0), 6);
});
test('moveId rejects bad indexes', () => {
  for (const [f, to] of [[NaN, 1], [0, NaN], [1.5, 0], [0, 1.5], [-1, 0], [7, 0]]) assert.deepEqual(moveId(['a', 'b', 'c'], f, to), ['a', 'b', 'c']);
});
test('tileUrl rejects bad ports', () => {
  for (const p of ['8;x', 1.5, 0, 65536, NaN, null, undefined, -1]) assert.equal(tileUrl('h', p), null);
  assert.equal(tileUrl('h', 65535), 'http://h:65535');
  assert.equal(tileUrl('::1', 81), 'http://[::1]:81');
});

test('config.js holds no host-specific values any more', () => {
  const src = readFileSync(new URL('../www/js/config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /services|quickLaunchIgnore|pool|hostLabel|cpuLabel|sessionLabel|mutes/);
});
