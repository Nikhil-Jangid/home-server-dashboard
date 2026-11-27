import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGlances, createPoller } from '../www/js/api.js';
import { CONFIG } from '../www/js/config.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/glances-all.json', import.meta.url)));

test('parseGlances reads the live fixture without throwing', () => {
  const v = parseGlances(fixture);
  assert.ok(v.cpu >= 0 && v.cpu <= 100);
  assert.ok(v.memPct > 0 && v.memPct <= 100);
  assert.ok(Array.isArray(v.fsList) && v.fsList.length > 0);
  assert.ok(v.storPct === null || (v.storPct >= 0 && v.storPct <= 100));
  assert.ok(Array.isArray(v.gpus));
  assert.ok(v.containers.length > 0);
  for (const c of v.containers) assert.ok(!c.name.startsWith('/'));
  assert.ok(!v.nets.some(n => n === 'lo' || /^(docker|br-|veth|tun|tailscale)/.test(n)));
});

test('parseGlances tolerates an empty payload', () => {
  const v = parseGlances({});
  assert.equal(v.cpu, 0);
  assert.equal(v.memPct, 0);
  assert.equal(v.storPct, null);
  assert.deepEqual(v.fsList, []);
  assert.deepEqual(v.gpus, []);
  assert.equal(v.temp, null);
  assert.equal(v.load, null);
  assert.equal(v.swapPct, null);
  assert.deepEqual(v.containers, []);
  assert.deepEqual(v.nets, []);
});

test('storage lists real filesystems, root first, equal sizes by path, without pseudo mounts or duplicates', () => {
  const F = (mnt_point, extra = {}) => ({ mnt_point, device_name: '/dev/' + mnt_point.replace(/\W/g, ''), fs_type: 'ext4', size: 100, used: 40, free: 60, percent: 40, ...extra });
  const v = parseGlances({ fs: [F('/srv/b'), F('/'), F('/srv/a'), F('/boot/efi', { fs_type: 'vfat' }), F('/snap/core/1', { fs_type: 'squashfs' }),
    F('/var/lib/docker/overlay2/x/merged', { fs_type: 'overlay' }), F('/run/user/1000', { fs_type: 'tmpfs' }), F('/srv/a')] });
  assert.deepEqual(v.fsList.map(f => f.mnt), ['/', '/srv/a', '/srv/b']);
  assert.equal(v.pool, undefined);
});

test('storage puts the OS drive first and tagged, then the rest from largest to smallest', () => {
  const G = 2 ** 30;
  const F = (mnt_point, size) => ({ mnt_point, device_name: '/dev/' + mnt_point.replace(/\W/g, ''), fs_type: 'ext4', size: size * G, used: G, free: (size - 1) * G });
  const v = parseGlances({ fs: [F('/mnt/small', 120), F('/mnt/big', 2000), F('/', 30), F('/mnt/mid', 500)] });
  assert.deepEqual(v.fsList.map(f => f.mnt), ['/', '/mnt/big', '/mnt/mid', '/mnt/small']);
  assert.deepEqual(v.fsList.map(f => f.os), [true, false, false, false]);
});

test('a FAT/exFAT USB drive is real storage; only the EFI partition is hidden (by its path)', () => {
  const v = parseGlances({ fs: [{ mnt_point: '/media/usb', device_name: '/dev/sdc1', fs_type: 'vfat', size: 10, used: 1, free: 9 },
    { mnt_point: '/boot/efi', device_name: '/dev/sda1', fs_type: 'vfat', size: 1, used: 0, free: 1 }] });
  assert.deepEqual(v.fsList.map(f => f.mnt), ['/media/usb']);
});

test('the storage gauge is used/size over distinct devices (a bind mount is counted once)', () => {
  const v = parseGlances({ fs: [
    { mnt_point: '/', device_name: '/dev/sda1', size: 100, used: 50, free: 50, percent: 50 },
    { mnt_point: '/srv/data', device_name: '/dev/sdb1', size: 300, used: 30, free: 270, percent: 10 },
    { mnt_point: '/srv/bind', device_name: '/dev/sdb1', size: 300, used: 30, free: 270, percent: 10 }] });
  assert.equal(v.storPct, 20);
  assert.deepEqual([v.storSize, v.storUsed], [400, 80]);
  assert.equal(parseGlances({}).storPct, null);
});

test('GPUs are listed when Glances reports them, and absent otherwise', () => {
  const v = parseGlances({ gpu: [{ name: 'Demo GPU', proc: 37.5, mem: 12.25, temperature: 61 }, null] });
  assert.deepEqual(v.gpus, [{ name: 'Demo GPU', util: 37.5, mem: 12.25, temp: 61 }]);
  assert.deepEqual(parseGlances({}).gpus, []);
});

test('network sums only physical interfaces', () => {
  const v = parseGlances({ network: [
    { interface_name: 'enp0s25', bytes_recv_rate_per_sec: 100, bytes_sent_rate_per_sec: 10 },
    { interface_name: 'wlp3s0', bytes_recv_rate_per_sec: 50, bytes_sent_rate_per_sec: 5 },
    { interface_name: 'lo', bytes_recv_rate_per_sec: 9999, bytes_sent_rate_per_sec: 9999 },
    { interface_name: 'docker0', bytes_recv_rate_per_sec: 9999, bytes_sent_rate_per_sec: 9999 },
    { interface_name: 'veth12ab', bytes_recv_rate_per_sec: 9999, bytes_sent_rate_per_sec: 9999 },
    { interface_name: 'tailscale0', bytes_recv_rate_per_sec: 9999, bytes_sent_rate_per_sec: 9999 }
  ] });
  assert.equal(v.rx, 150);
  assert.equal(v.tx, 15);
  assert.deepEqual(v.nets, ['enp0s25', 'wlp3s0']);
});

test('temperature prefers package sensor and reports hottest sensor label', () => {
  const v = parseGlances({ sensors: [
    { label: 'Core 0', value: 55, unit: 'C' },
    { label: 'Package id 0', value: 60, unit: 'C' },
    { label: 'acpitz 1', value: 83, unit: 'C' },
    { label: 'fan1', value: 3000, unit: 'R' }
  ] });
  assert.equal(v.temp, 60);
  assert.equal(v.maxTemp, 83);
  assert.equal(v.maxTempLabel, 'acpitz 1');
});

test('containers normalise name, image list/string and missing stats', () => {
  const v = parseGlances({ containers: [
    { name: '/nginx', status: 'Running', image: ['nginx/nginx:latest'], cpu: { total: 4.2 }, memory: { usage: 1024 }, uptime: '2 days' },
    { name: 'whoami', status: 'exited', image: 'demo/whoami' }
  ] });
  assert.deepEqual(v.containers[0], { name: 'nginx', status: 'running', image: 'nginx/nginx:latest', cpu: 4.2, mem: 1024, uptime: '2 days', ports: [], id: '' });
  assert.deepEqual(v.containers[1], { name: 'whoami', status: 'exited', image: 'demo/whoami', cpu: 0, mem: 0, uptime: '—', ports: [], id: '' });
});

const okResponse = body => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });

test('poller delivers data', async () => {
  let got = null;
  const p = createPoller({ url: '/x', intervalMs: 1000, fetchImpl: async () => okResponse({ a: 1 }), onData: d => { got = d; }, onError: () => {} });
  await p.pollNow();
  assert.deepEqual(got, { a: 1 });
});

test('poller classifies http, network, parse and timeout errors', async () => {
  const errs = [];
  const onError = e => errs.push(e.kind);
  const mk = fetchImpl => createPoller({ url: '/x', intervalMs: 1000, timeoutMs: 20, fetchImpl, onData: () => {}, onError });
  await mk(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway' })).pollNow();
  await mk(async () => { throw new TypeError('Failed to fetch'); }).pollNow();
  await mk(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })).pollNow();
  await mk((url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))).pollNow();
  assert.deepEqual(errs, ['http', 'network', 'parse', 'timeout']);
});

test('poller start/stop toggles running', () => {
  const p = createPoller({ url: '/x', intervalMs: 60000, fetchImpl: async () => okResponse({}), onData: () => {}, onError: () => {} });
  p.start();
  assert.equal(p.running, true);
  p.stop();
  assert.equal(p.running, false);
});

test('parseGlances skips null and non-object array elements', () => {
  const v = parseGlances({
    fs: [null, 5, { mnt_point: '/', size: 10, used: 5, free: 5 }],
    network: [null, 'x', { interface_name: 'eth0', bytes_recv_rate_per_sec: 4 }],
    sensors: [undefined, { unit: 'C', value: 40, label: 'Package id 0' }],
    containers: [null, 7, { name: '/a', status: 'running' }]
  });
  assert.equal(v.fsList.length, 1);
  assert.deepEqual(v.nets, ['eth0']);
  assert.equal(v.temp, 40);
  assert.deepEqual(v.containers.map(c => c.name), ['a']);
});

test('a body-read abort from the timeout is a timeout, not a parse error', async () => {
  const errs = [];
  const p = createPoller({
    url: '/x', intervalMs: 1000, timeoutMs: 20, onData: () => {}, onError: e => errs.push(e.kind),
    fetchImpl: async (u, { signal }) => ({
      ok: true, status: 200,
      json: () => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    })
  });
  await p.pollNow();
  assert.deepEqual(errs, ['timeout']);
});

test('poller never overlaps requests', async () => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const p = createPoller({ url: '/x', intervalMs: 1000, fetchImpl: async () => { calls++; await gate; return okResponse({}); }, onData: () => {}, onError: () => {} });
  const a = p.pollNow(), b = p.pollNow();
  assert.equal(calls, 1);
  release();
  await Promise.all([a, b]);
  await p.pollNow();
  assert.equal(calls, 2);
});

test('stop() aborts the in-flight request without reporting an error', async () => {
  let sig = null;
  const errs = [];
  const p = createPoller({
    url: '/x', intervalMs: 1000, timeoutMs: 5000, onData: () => errs.push('data'), onError: e => errs.push(e.kind),
    fetchImpl: (u, { signal }) => { sig = signal; return new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); }
  });
  const run = p.pollNow();
  p.stop();
  await run;
  assert.equal(sig.aborted, true);
  assert.deepEqual(errs, []);
});

test('parseGlances keeps container ports as valid ints only', () => {
  const v = parseGlances({ containers: [{ name: 'a', ports: [3001, '80', 0, 70000, 1.5, 8080] }, { name: 'b' }] });
  assert.deepEqual(v.containers.map(c => c.ports), [[3001, 8080], []]);
});

test('poller with retryDelay backs off on failure, resets on success, and stops scheduling when stopped', async () => {
  const delays = [];
  const setT = (fn, ms) => { delays.push(ms); return delays.length; };
  let up = false;
  const p = createPoller({
    url: '/x', intervalMs: 3000, retryDelay: n => Math.min(60000, 1000 * 2 ** n), setT, clearT: () => {},
    fetchImpl: async () => { if (!up) throw new TypeError('down'); return okResponse({}); }, onData: () => {}, onError: () => {}
  });
  p.start();
  assert.equal(p.running, true);
  await p.pollNow(); await p.pollNow(); await p.pollNow();
  up = true; await p.pollNow();
  up = false; await p.pollNow();
  assert.deepEqual(delays, [3000, 1000, 2000, 4000, 3000, 1000]);
  p.stop();
  assert.equal(p.running, false);
  await p.pollNow();
  assert.equal(delays.length, 6, 'a stopped poller schedules nothing');
});

test('kernel tunnel stubs are not network adapters', () => {
  const names = ['tunl0', 'gre0', 'gretap0', 'erspan0', 'ip_vti0', 'ip6_vti0', 'sit0', 'ip6tnl0', 'ip6gre0', 'eth0', 'wlan0', 'bond0'];
  const v = parseGlances({ network: names.map(interface_name => ({ interface_name })) });
  assert.deepEqual(v.nets, ['eth0', 'wlan0']);
});

test('links mark the bond port carrying traffic', () => {
  const network = [
    { interface_name: 'enp3s0', bytes_recv_rate_per_sec: 1, bytes_sent_rate_per_sec: 1 },
    { interface_name: 'wlp2s0', bytes_recv_rate_per_sec: 1, bytes_sent_rate_per_sec: 1 },
    { interface_name: 'bond0', bytes_recv_rate_per_sec: 2, bytes_sent_rate_per_sec: 2 }
  ];
  const bond = [{ name: 'bond0', active: 'enp3s0', ports: [{ name: 'enp3s0', up: true }, { name: 'wlp2s0', up: true }] }];
  assert.deepEqual(parseGlances({ network, bond }).links, [
    { name: 'enp3s0', state: 'active', bond: 'bond0' },
    { name: 'wlp2s0', state: 'standby', bond: 'bond0' }
  ]);
});

test('a bond is not counted on top of its ports', () => {
  const v = parseGlances({ network: [
    { interface_name: 'enp3s0', bytes_recv_rate_per_sec: 100, bytes_sent_rate_per_sec: 10 },
    { interface_name: 'wlp2s0', bytes_recv_rate_per_sec: 1, bytes_sent_rate_per_sec: 0 },
    { interface_name: 'bond0', bytes_recv_rate_per_sec: 101, bytes_sent_rate_per_sec: 10 }
  ] });
  assert.equal(v.rx, 101);
  assert.equal(v.tx, 10);
  assert.deepEqual(v.nets, ['enp3s0', 'wlp2s0']);
});

test('links show a port whose cable is down', () => {
  const v = parseGlances({
    network: [{ interface_name: 'enp3s0' }, { interface_name: 'wlp2s0' }],
    bond: [{ name: 'bond0', active: 'wlp2s0', ports: [{ name: 'enp3s0', up: false }, { name: 'wlp2s0', up: true }] }]
  });
  assert.deepEqual(v.links.map(l => l.state), ['down', 'active']);
});

test('links without bond data fall back to plain names', () => {
  const v = parseGlances({ network: [{ interface_name: 'enp0s25' }], bond: 'junk' });
  assert.deepEqual(v.links, [{ name: 'enp0s25', state: null, bond: null }]);
  assert.deepEqual(parseGlances({}).links, []);
});
