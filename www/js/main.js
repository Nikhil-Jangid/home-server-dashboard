// Wires data to the page. All text goes through textContent or h().
import { CONFIG } from './config.js';
import { COLORS, tone, level, rate, gib, tib, bytes, ago } from './format.js';
import { parseGlances, createPoller } from './api.js';
import { createAlertTracker, trackCpu, buildAlerts } from './alerts.js';
import { containerRows, isUp } from './containers.js';
import { ORDER_KEY, buildTiles, parseOrder, applyOrder } from './quicklaunch.js';
import { mountReorder, flip, prefersReducedMotion, createTile, updateTile, deferWhile, createAnnouncer } from './quicklaunch-view.js';
import { h, setChildren, setText, reconcileKeyed, onLongPress } from './dom.js';
import { setGauge, drawSpark, easeStep } from './gauges.js';
import { applyTheme, nextTheme, parseTheme, themeName, themeLabel, themeTitle, syncThemeColor } from './themes.js';
import { mountTerminal } from './terminal.js';
import { mountEvents, backoffDelay } from './events.js';
import { clearStaleSettings } from './settings.js';
import { hostLabels } from './host.js';

const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const clampPct = p => Math.max(0, Math.min(100, p));

const state = {
  ok: false, lastOkAt: null, err: null, view: null,
  filter: '', sortKey: 'name', sortDir: 1, shell: 'connecting',
  hist: { cpu: [], mem: [], rx: [], tx: [] },
  disp: { cpu: 0, mem: 0, stor: 0, rx: 0, tx: 0 },
  tgt: { cpu: 0, mem: 0, stor: 0, rx: 0, tx: 0 },
  started: false,
  settings: null, ports: null, order: loadOrder()
};
function loadOrder() {
  try { return parseOrder(localStorage.getItem(ORDER_KEY)); } catch { return []; }
}
const tracker = createAlertTracker();
const push = (a, x) => { a.push(x); if (a.length > 60) a.shift(); };

// ── data ───────────────────────────────────────────────────────────────
function ingest(raw) {
  const v = parseGlances(raw);
  const now = Date.now();
  Object.assign(state, { view: v, ok: true, lastOkAt: now, err: null });
  Object.assign(state.tgt, { cpu: v.cpu, mem: v.memPct, stor: v.storPct ?? 0, rx: v.rx, tx: v.tx });
  if (!state.started) { Object.assign(state.disp, state.tgt); state.started = true; }
  push(state.hist.cpu, v.cpu); push(state.hist.mem, v.memPct);
  push(state.hist.rx, v.rx); push(state.hist.tx, v.tx);
  trackCpu(tracker, v.cpu, now);
  renderSlow();
  markDirty();
}

function fail(err) {
  Object.assign(state, { ok: false, err });
  renderSlow();
  markDirty();
}

const poller = createPoller({ url: CONFIG.apiPath, intervalMs: CONFIG.pollSeconds * 1000, onData: ingest, onError: fail });
const isObj = d => d && typeof d === 'object' && !Array.isArray(d);
// The machine's own settings (host labels, Quick Launch file, ignore list, mutes) and the state of
// port-only Quick Launch tiles, both from dash-events. Failures back off up to 60 s; success resets.
const settingsPoller = createPoller({
  url: CONFIG.settingsPath, intervalMs: CONFIG.settingsSeconds * 1000, retryDelay: n => backoffDelay(n, 1000, 60000),
  onData: d => { if (isObj(d)) { state.settings = d; applySettings(); } },
  onError: () => {}   // keep the last good settings
});
const portsPoller = createPoller({
  url: CONFIG.portsPath, intervalMs: 10_000, retryDelay: n => backoffDelay(n, 1000, 60000),
  onData: d => { state.ports = isObj(d) ? d : null; renderServices(); },
  onError: () => { state.ports = null; renderServices(); }
});
const pollers = [poller, settingsPoller, portsPoller];
const listOf = k => (state.settings && Array.isArray(state.settings[k]) ? state.settings[k] : []);

// ── per-poll rendering ─────────────────────────────────────────────────
const ERR_TEXT = {
  network: () => 'The browser could not reach /api/4/all — the server may be down, or this device is not on its network.',
  http: e => 'The API answered with an error: ' + e.message + '.',
  timeout: () => 'The request timed out after 4.5 s.',
  parse: e => 'The API returned something that is not JSON: ' + e.message
};

function renderHeader() {
  const { ok, view: v, err } = state;
  $('status-pill').classList.toggle('online', ok);
  $('status-pill').querySelector('.pill-text').textContent = ok ? 'online' : 'offline';
  $('uptime').textContent = v && v.uptime ? v.uptime : '—';
  const t = $('temp');
  t.textContent = v && v.temp != null ? v.temp.toFixed(0) + ' °C' : '—';
  t.style.color = !ok || !v || v.temp == null ? COLORS.unknown : v.temp > 80 ? COLORS.crit : v.temp > 70 ? COLORS.warn : '';
  $('api-banner').hidden = ok || !err;
  $('api-banner-detail').textContent = err ? (ERR_TEXT[err.kind] || (e => e.message))(err) : '';
}

function renderVitalText() {
  const { ok, view: v, lastOkAt } = state;
  const stale = ok ? '' : lastOkAt ? 'unavailable · last known ' + new Date(lastOkAt).toLocaleTimeString() : 'unavailable · no successful poll yet';
  for (const card of document.querySelectorAll('.vital')) {
    card.classList.toggle('dim', !ok);
    card.querySelector('.stale').textContent = stale;
  }
  $('cpu-proc').textContent = v && v.proc ? v.proc.total + ' proc · ' + v.proc.running + ' run' : '—';
  $('cpu-load').textContent = 'load ' + (v && v.load ? v.load.map(x => x.toFixed(2)).join(' ') : '—');
  $('mem-swap').textContent = v && v.swapPct != null ? 'swap ' + v.swapPct.toFixed(0) + '%' : 'swap —';
  $('mem-sub').textContent = v && v.mem.total ? gib(v.mem.used) + ' / ' + gib(v.mem.total) + ' GiB' : '—';
  $('mem-free').textContent = v && v.mem.available != null ? gib(v.mem.available) + ' GiB available' : '—';
  $('stor-sub').textContent = v && v.storSize ? tib(v.storSize - v.storUsed) + ' TiB free of ' + tib(v.storSize) + ' TiB' : '—';
  $('stor-note').textContent = v ? v.fsList.length + (v.fsList.length === 1 ? ' drive' : ' drives') : '—';
  $('net-ifaces').textContent = v && v.nets.length ? v.nets.slice(0, 2).join(' · ') : '—';
}

function warnIcon(color) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, val] of Object.entries({ width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', 'stroke-width': 2.2, 'stroke-linecap': 'round' })) svg.setAttribute(k, val);
  svg.style.stroke = color; // var() works in a style, not in the presentation attribute
  for (const d of ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2.4 18a1.9 1.9 0 0 0 1.7 2.9h15.8a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z']) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function renderStorage() {
  const { ok, view: v } = state;
  $('fs-count').textContent = v ? v.fsList.length + ' mounted' : 'unavailable';
  if (!v || !v.fsList.length) {
    setChildren($('fs-rows'), h('div', { class: 'fs-row' },
      h('div', { class: 'fs-line' }, h('span', { class: 'fs-mnt' }, '—'), h('span', { class: 'fs-size' }, 'unavailable'),
        h('span', { class: 'fs-detail' }, v ? 'no drives reported' : '—'), h('span', { class: 'fs-pct', style: { color: COLORS.muted } }, '—')),
      h('div', { class: 'fs-bar' })));
    return;
  }
  setChildren($('fs-rows'), v.fsList.map(f => {
    const mnt = f.mnt;
    const color = ok ? tone(f.pct) : COLORS.muted;
    const size = bytes(f.size), used = bytes(f.used), free = bytes(f.free);
    return h('div', { class: 'fs-row' },
      h('div', { class: 'fs-line' },
        level(f.pct) ? warnIcon(tone(f.pct)) : null,
        h('span', { class: 'fs-mnt' }, mnt),
        h('span', { class: 'fs-size' }, size.n + ' ' + size.u),
        h('span', { class: 'fs-detail' }, used.n + ' ' + used.u + ' used · ' + free.n + ' ' + free.u + ' free'),
        h('span', { class: 'fs-pct', style: { color } }, f.pct.toFixed(1) + '%')),
      h('div', { class: 'fs-bar' }, h('div', { class: 'fs-fill', style: { width: clampPct(f.pct).toFixed(1) + '%', background: color } })));
  }));
}

function renderGpus() {
  const { ok, view: v } = state;
  const gpus = v ? v.gpus : [];
  $('gpu-card').hidden = gpus.length === 0;
  if (!gpus.length) return;
  $('gpu-count').textContent = gpus.length === 1 ? '1 GPU' : gpus.length + ' GPUs';
  setChildren($('gpu-rows'), gpus.map(g => {
    const pct = g.util ?? 0;
    const color = ok ? tone(pct) : COLORS.muted;
    const detail = [g.mem != null ? 'memory ' + g.mem.toFixed(0) + '%' : null, g.temp != null ? g.temp.toFixed(0) + ' °C' : null].filter(Boolean).join(' · ');
    return h('div', { class: 'fs-row' },
      h('div', { class: 'fs-line' },
        h('span', { class: 'fs-mnt' }, g.name),
        h('span', { class: 'fs-detail' }, detail || '—'),
        h('span', { class: 'fs-pct', style: { color } }, g.util != null ? g.util.toFixed(0) + '%' : '—')),
      h('div', { class: 'fs-bar' }, h('div', { class: 'fs-fill', style: { width: clampPct(pct).toFixed(1) + '%', background: color } })));
  }));
}

// Per-element handles for in-place updates (set at creation, never read from the DOM).
const REFS = new WeakMap();

// ── quick launch ───────────────────────────────────────────────────────
let qlTiles = [];
let reorder = { dragging: () => false }; // replaced by mountReorder() at startup

// While a tile is dragged or picked up, a refresh is held back (not dropped) and replayed when it ends.
const servicesRender = deferWhile(() => reorder.dragging(), renderServicesNow);
function renderServices() { servicesRender.run(); }
function renderServicesNow() {
  const containers = state.view ? state.view.containers : [];
  qlTiles = applyOrder(buildTiles(listOf('quicklaunch'), containers,
    { live: state.ok, hostname: location.hostname, ports: state.ports, ignore: listOf('ignore') }), state.order);
  reconcileKeyed($('services'), qlTiles, { key: t => t.id, create: createTile, update: updateTile });
}

const announce = createAnnouncer($('ql-live'));

function commitOrder(ids) {
  state.order = ids;
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch { /* storage full or blocked: order lasts this visit */ }
  flip($('services'), renderServices, { reduceMotion: prefersReducedMotion() });
}

function resetOrder() {
  try { localStorage.removeItem(ORDER_KEY); } catch { /* nothing stored */ }
  state.order = [];
  flip($('services'), renderServices, { reduceMotion: prefersReducedMotion() });
  announce('Order reset');
}

function createRow(r) {
  const dot = h('span', { class: 'dot' });
  const name = h('span', null, r.name);
  const cells = {
    // data-label captions each value when a row becomes a stacked card on phones (CSS ::before)
    image: h('td', { class: 'c-image', dataset: { label: 'Image' } }), status: h('td', { class: 'c-status' }),
    cpu: h('td', { class: 'r c-cpu', dataset: { label: 'CPU %' } }),
    mem: h('td', { class: 'r c-mem', dataset: { label: 'Memory' } }), up: h('td', { class: 'r c-up', dataset: { label: 'Uptime' } })
  };
  const el = h('tr', null, h('td', { class: 'c-name' }, dot, name), cells.image, cells.status, cells.cpu, cells.mem, cells.up);
  REFS.set(el, { dot, name, ...cells });
  updateRow(el, r);
  return el;
}

function updateRow(el, r) {
  const c = REFS.get(el);
  el.classList.toggle('ct-stopped', r.stopped);
  c.dot.style.background = r.dot;
  setText(c.image, r.image); c.image.setAttribute('title', r.image);
  setText(c.status, r.status); c.status.style.color = r.statusColor || '';
  setText(c.cpu, r.cpu); c.cpu.style.color = r.cpuColor || '';
  setText(c.mem, r.mem);
  setText(c.up, r.uptime);
}

const TH_LABELS = {};
function renderContainers() {
  const { ok, view: v } = state;
  const cs = v ? v.containers : [];
  $('running').textContent = v ? cs.filter(c => isUp(c.status)).length + '/' + cs.length + ' running' : '—';
  for (const th of $('ct-head').children) {
    const k = th.dataset.key;
    TH_LABELS[k] ??= th.textContent;
    th.textContent = TH_LABELS[k] + (state.sortKey === k ? (state.sortDir > 0 ? ' ↑' : ' ↓') : '');
  }
  $('ct-sort').value = state.sortKey + ':' + state.sortDir; // the phone layout sorts through this select
  const rows = containerRows(cs, { ...state, ignore: listOf('ignore') });
  reconcileKeyed($('ct-body'), rows, { key: r => r.name, create: createRow, update: updateRow });
  const empty = $('ct-empty');
  empty.hidden = rows.length > 0;
  const noDocker = state.settings && state.settings.docker === false;
  empty.textContent = !ok ? 'Container data unavailable — API unreachable.'
    : noDocker && cs.length === 0 ? 'Docker not found on this server.'
    : cs.length === 0 ? 'No containers reported. If Docker was installed after setup, run sudo ./setup.sh again.'
    : rows.length === 0 && !state.filter ? 'Every container is listed in your ignore file.'
    : 'No containers match “' + state.filter + '”.';
}

function createAlert(a) {
  if (a.nominal) {
    return h('div', { class: 'nominal' }, h('span', { class: 'dot', style: { background: COLORS.healthy } }), 'All systems nominal');
  }
  const r = { dot: h('span', { class: 'dot' }), title: h('div', { class: 'alert-title' }), detail: h('div', { class: 'alert-detail' }),
    sev: h('span', { class: 'alert-sev' }), ago: h('span', { class: 'alert-ago' }) };
  const el = h('div', null, r.dot,
    h('div', { class: 'alert-body' }, r.title, r.detail),
    h('div', { class: 'alert-meta' }, r.sev, r.ago));
  REFS.set(el, r);
  updateAlert(el, a);
  return el;
}

function updateAlert(el, a) {
  if (a.nominal) return;
  const r = REFS.get(el);
  const color = a.severity === 'critical' ? COLORS.crit : COLORS.warn;
  el.className = 'alert ' + a.severity;
  r.dot.style.background = color;
  setText(r.title, a.title); setText(r.detail, a.detail);
  setText(r.sev, a.severity); r.sev.style.color = color;
  setText(r.ago, ago(a.since));
}

function renderAlerts() {
  const { ok, view: v } = state;
  const alerts = ok && v ? buildAlerts(v, tracker) : [];
  $('alert-count').textContent = alerts.length ? alerts.length + ' active' : ok ? 'none' : 'data unavailable';
  const items = alerts.length ? alerts : ok ? [{ key: '__nominal', nominal: true }] : [];
  reconcileKeyed($('alerts'), items, { key: a => a.key, create: createAlert, update: updateAlert });
}

function renderFooter() {
  const version = hostLabels(state.settings).version;
  $('footer').textContent = (version ? version + ' · ' : '') + 'poll ' + CONFIG.pollSeconds + 's · shell ' + state.shell;
}

function renderSlow() {
  renderHeader();
  renderVitalText();
  renderStorage();
  renderGpus();
  renderServices();
  renderContainers();
  renderAlerts();
  renderFooter();
  $('ago').textContent = state.lastOkAt ? ago(state.lastOkAt) : 'never';
}

// ── animation (~25 fps, only while something changes and the tab is visible) ──
let lastFrame = 0, dirty = true, rafId = 0;
function markDirty() {
  dirty = true;
  if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame);
}
function frame(now) {
  rafId = 0;
  if (document.hidden) return; // resumed by markDirty() on visibilitychange
  if (now - lastFrame >= 40) {
    lastFrame = now;
    const ranges = { cpu: 100, mem: 100, stor: 100, rx: Math.max(1, ...state.hist.rx), tx: Math.max(1, ...state.hist.tx) };
    const moving = easeStep(state.disp, state.tgt, ranges);
    paintVitals();
    dirty = moving;
  }
  if (dirty) rafId = requestAnimationFrame(frame);
}

function paintVitals() {
  const { disp, hist, view: v } = state;
  const dim = !state.ok;
  const col = p => (dim ? COLORS.muted : tone(p));
  setGauge($('cpu-gauge'), disp.cpu, col(disp.cpu), v ? disp.cpu.toFixed(1) : '—');
  setGauge($('mem-gauge'), disp.mem, col(disp.mem), v ? disp.mem.toFixed(1) : '—');
  setGauge($('stor-gauge'), disp.stor, col(disp.stor), v && v.storPct != null ? disp.stor.toFixed(1) : '—');
  const bar = $('stor-bar');
  bar.style.width = clampPct(disp.stor).toFixed(1) + '%';
  bar.style.background = col(disp.stor);
  const rx = rate(disp.rx), tx = rate(disp.tx);
  $('rx-num').textContent = v ? rx.n : '—'; $('rx-unit').textContent = rx.u;
  $('tx-num').textContent = v ? tx.n : '—'; $('tx-unit').textContent = tx.u;
  drawSpark($('cpu-spark'), [{ data: hist.cpu, color: col(disp.cpu), fill: 'var(--healthy-dim)' }], { max: 100 });
  drawSpark($('mem-spark'), [{ data: hist.mem, color: col(disp.mem), fill: 'var(--healthy-dim)' }], { max: 100 });
  drawSpark($('net-spark'), [
    { data: hist.rx, color: dim ? COLORS.muted : COLORS.healthy },
    { data: hist.tx, color: dim ? 'var(--t-placeholder)' : COLORS.violet }
  ]);
}

// ── exports for other views ────────────────────────────────────────────
export function setFooterShell(label) { state.shell = label; renderFooter(); }
export function setErrorBadge(count) {
  const b = $('err-badge');
  b.hidden = count === 0;
  b.textContent = count + (count === 1 ? ' error' : ' errors') + ' · 1h';
}

// ── events ─────────────────────────────────────────────────────────────
$('host-sub').textContent = location.host;
let terminal = null, events = null;   // mounted at the end of this file
function applySettings() {
  const l = hostLabels(state.settings);
  $('host-name').textContent = l.hostName;
  $('cpu-label').textContent = l.cpu;
  document.title = l.hostName === '—' ? 'Server Dashboard' : l.hostName + ' · Server Dashboard';
  const p = $('ql-problems');
  p.textContent = l.problems;
  p.hidden = !l.problems;
  if (terminal) terminal.setSession(l.session);
  if (events) events.setMutes(listOf('mutes'));
  renderSlow();
}
applySettings();
$('refresh').addEventListener('click', () => pollers.forEach(p => p.pollNow()));
// Theme: click cycles forward, Shift+click back. DOM colours are var() tokens and follow at once;
// the canvases resolve theirs per draw, so a repaint is all they need.
// On touch screens a long press steps back.
function syncThemeButton() {
  const id = parseTheme(document.documentElement.getAttribute('data-theme'));
  $('theme-name').textContent = themeName(id);
  $('theme-btn').setAttribute('aria-label', themeLabel(id));
  $('theme-btn').setAttribute('title', themeTitle(id));
  syncThemeColor();
}
function stepTheme(dir) {
  applyTheme(nextTheme(document.documentElement.getAttribute('data-theme'), dir));
  syncThemeButton();
  renderSlow(); markDirty();
}
const themePress = onLongPress($('theme-btn'), () => stepTheme(-1));
$('theme-btn').addEventListener('click', e => {
  if (themePress.took()) return; // the click that ends a long press
  stepTheme(e.shiftKey ? -1 : 1);
});
syncThemeButton();
$('ql-reset').addEventListener('click', resetOrder);
reorder = mountReorder($('services'), {
  ids: () => qlTiles.map(t => t.id),
  nameOf: id => qlTiles.find(t => t.id === id)?.name || id,
  commit: commitOrder,
  announce,
  helpId: 'ql-help',
  onIdle: () => { if (servicesRender.pending) flip($('services'), () => servicesRender.flush(), { reduceMotion: prefersReducedMotion() }); }
});
$('err-badge').addEventListener('click', () => $('errors').scrollIntoView({ behavior: 'smooth' }));
$('ct-filter').addEventListener('input', e => { state.filter = e.target.value; renderContainers(); });
$('ct-sort').addEventListener('change', e => {
  const [k, d] = e.target.value.split(':');
  state.sortKey = k; state.sortDir = Number(d) < 0 ? -1 : 1;
  renderContainers();
});
$('ct-head').addEventListener('click', e => {
  const k = e.target.closest('th')?.dataset.key;
  if (!k) return;
  state.sortDir = state.sortKey === k ? -state.sortDir : 1;
  state.sortKey = k;
  renderContainers();
});
function onVisibility() {
  if (document.hidden) pollers.forEach(p => p.stop());
  else {
    for (const p of pollers) if (!p.running) { p.pollNow(); p.start(); }
    markDirty();
  }
}
window.addEventListener('resize', markDirty);
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('focus', onVisibility);

setInterval(() => {
  $('ago').textContent = state.lastOkAt ? ago(state.lastOkAt) : 'never';
  renderAlerts();
}, 1000);

renderSlow();
pollers.forEach(p => { p.pollNow(); p.start(); });
markDirty();
terminal = mountTerminal({ onState: setFooterShell });
try { clearStaleSettings(localStorage); } catch { /* storage blocked */ }
events = mountEvents({ onBadge: setErrorBadge, mutes: [] });
applySettings();
