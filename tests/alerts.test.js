import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertTracker, trackCpu, buildAlerts } from '../www/js/alerts.js';
import { parseGlances } from '../www/js/api.js';

const base = over => ({ ...parseGlances({}), ...over });

test('no conditions → no alerts', () => {
  assert.deepEqual(buildAlerts(base({}), createAlertTracker(), 1000), []);
});

test('restarting container raises a warning with status and image', () => {
  const v = base({ containers: [{ name: 'whoami', status: 'restarting', image: 'lsio/whoami', cpu: 0, mem: 0, uptime: '—' }] });
  const [a] = buildAlerts(v, createAlertTracker(), 1000);
  assert.equal(a.severity, 'warning');
  assert.equal(a.title, 'Container not running — whoami');
  assert.equal(a.detail, 'status restarting · lsio/whoami');
});

test('exited and created containers are intentionally stopped and raise no alert', () => {
  const v = base({ containers: ['exited', 'created'].map(status => ({ name: 'x' + status, status, image: 'i', cpu: 0, mem: 0, uptime: '—' })) });
  assert.deepEqual(buildAlerts(v, createAlertTracker(), 1000).map(a => a.title), []);
});

test('filesystem above 85% warns, above 95% is critical', () => {
  const v = base({ fsList: [
    { mnt: '/srv/fast', size: 100, used: 90, free: 10 * 1024 ** 3, pct: 90 },
    { mnt: '/', size: 100, used: 97, free: 1024 ** 3, pct: 97 },
    { mnt: '/srv/big', size: 100, used: 50, free: 50, pct: 50 }
  ] });
  const alerts = buildAlerts(v, createAlertTracker(), 1000);
  assert.deepEqual(alerts.map(a => [a.severity, a.title]), [
    ['critical', 'Filesystem above 95% — /'],
    ['warning', 'Filesystem above 85% — /srv/fast']
  ]);
  assert.equal(alerts[1].detail, '90.0% used · 10.0 GiB free');
});

test('CPU alert only after 60s sustained above 80%', () => {
  const t = createAlertTracker();
  trackCpu(t, 85, 0);
  assert.equal(buildAlerts(base({ cpu: 85 }), t, 59_000).length, 0);
  trackCpu(t, 90, 60_000);
  const [a] = buildAlerts(base({ cpu: 90, load: [3.5, 2, 1] }), t, 60_000);
  assert.equal(a.title, 'CPU sustained above 80% for over 60s');
  assert.equal(a.detail, 'now 90.0% · load 3.50');
  trackCpu(t, 40, 61_000);
  assert.equal(t.cpuHotSince, null);
});

test('temperature alert names the hottest sensor', () => {
  const [a] = buildAlerts(base({ maxTemp: 83.4, maxTempLabel: 'acpitz 1' }), createAlertTracker(), 1000);
  assert.equal(a.severity, 'critical');
  assert.equal(a.detail, '83 °C on acpitz 1');
});

test('since is stable while active and cleared after resolution', () => {
  const t = createAlertTracker();
  const hot = base({ maxTemp: 90, maxTempLabel: 'x' });
  assert.equal(buildAlerts(hot, t, 1000)[0].since, 1000);
  assert.equal(buildAlerts(hot, t, 5000)[0].since, 1000);
  buildAlerts(base({}), t, 6000);
  assert.equal(buildAlerts(hot, t, 7000)[0].since, 7000);
});

test('healthy and starting containers raise no alert', () => {
  const mk = status => ({ name: 'x', status, image: 'i', cpu: 0, mem: 0, uptime: '1 hour' });
  assert.deepEqual(buildAlerts(base({ containers: [mk('healthy'), mk('starting')] }), createAlertTracker(), 1000), []);
});

test('unhealthy container raises a warning', () => {
  const v = base({ containers: [{ name: 'status', status: 'unhealthy', image: 'demo/adminer', cpu: 0, mem: 0, uptime: '1 hour' }] });
  const [a] = buildAlerts(v, createAlertTracker(), 1000);
  assert.equal(a.key, 'u:status');
  assert.equal(a.severity, 'warning');
  assert.equal(a.title, 'Container unhealthy — status');
  assert.equal(a.detail, 'health check failing · demo/adminer');
});

test('filesystem alert title and severity track escalation at 70/85/95 boundaries', () => {
  const at = pct => buildAlerts(base({ fsList: [{ mnt: '/d', size: 100, used: pct, free: 1024, pct }] }), createAlertTracker(), 1000);
  assert.deepEqual(at(70), []);
  assert.deepEqual(at(85), []);
  assert.deepEqual(at(85.1).map(a => [a.severity, a.title]), [['warning', 'Filesystem above 85% — /d']]);
  assert.deepEqual(at(95).map(a => [a.severity, a.title]), [['warning', 'Filesystem above 85% — /d']]);
  assert.deepEqual(at(95.1).map(a => [a.severity, a.title]), [['critical', 'Filesystem above 95% — /d']]);
});
