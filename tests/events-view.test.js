import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { CATEGORIES } from '../www/js/events-model.js';
import { renderEventRow, parseFilters, backoffDelay, mountEvents } from '../www/js/events.js';

let dom;
beforeEach(() => { dom = installFakeDom(); });

const evil = '<img src=x onerror=alert(1)>';

test('event row renders markup as literal text', () => {
  const row = renderEventRow({ id: 'g1', source: evil, message: evil, category: 'disk_io', priority: 3, first_ts: 1000, last_ts: 1000, count: 3 }, 6000);
  assert.equal(dom.created.some(e => e.tagName === 'IMG'), false);
  assert.ok(row.textContent.includes(evil));
  assert.ok(row.textContent.includes('DISK/IO'));
  assert.ok(row.textContent.includes('×3'));
  assert.ok(row.textContent.includes('5s ago'));
  assert.equal(row.className, 'ev-row ev-error');
  assert.equal(row.dataset.id, 'g1');
});

test('prototype property names as category render as OTHER', () => {
  const row = renderEventRow({ id: 'g3', source: 's', message: 'm', category: 'constructor', priority: 3, first_ts: 0, last_ts: 0, count: 1 }, 0);
  assert.ok(row.textContent.includes('OTHER'));
  assert.ok(!row.textContent.includes('function'));
});

test('count badge hidden for single occurrences; unknown category → OTHER', () => {
  const row = renderEventRow({ id: 'g2', source: 's', message: 'm', category: 'weird', priority: 5, first_ts: 0, last_ts: 0, count: 1 }, 0);
  assert.ok(!row.textContent.includes('×'));
  assert.ok(row.textContent.includes('OTHER'));
  assert.equal(row.className, 'ev-row ev-notice');
});

test('parseFilters defaults to error and warning with all categories', () => {
  const f = parseFilters(null);
  assert.deepEqual([...f.severities], ['error', 'warning']);
  assert.equal(f.categories.size, 7);
});

test('parseFilters keeps known keys only and survives garbage', () => {
  const f = parseFilters(JSON.stringify({ severities: ['error', 'bogus'], categories: ['disk_io'] }));
  assert.deepEqual([...f.severities], ['error']);
  assert.deepEqual([...f.categories], ['disk_io']);
  assert.equal(parseFilters('{not json').severities.size, 2);
  assert.deepEqual([...parseFilters('{"severities":["notice"]}').severities], ['notice']);
  assert.equal(parseFilters(JSON.stringify({ severities: 'x' })).severities.size, 2);
});

test('backoffDelay doubles from 1s and caps at 30s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(n => backoffDelay(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('parseFilters: an explicit empty array persists as empty, other bad shapes give defaults', () => {
  const none = parseFilters(JSON.stringify({ severities: [], categories: [] }));
  assert.equal(none.severities.size, 0);
  assert.equal(none.categories.size, 0);
  const mixed = parseFilters(JSON.stringify({ severities: [] }));
  assert.equal(mixed.severities.size, 0);
  assert.equal(mixed.categories.size, 7);      // missing key -> defaults
  for (const raw of [null, '', 'null', '5', '"x"', '[]', '{"severities":null}', '{"severities":{"a":1}}', '{"severities":["bogus"]}']) {
    assert.equal(parseFilters(raw).severities.size, 2, String(raw));
  }
});

// ── mountEvents with injected fetch / EventSource / timers ──────────────
class FakeES {
  static CLOSED = 2;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.l = {}; this.closed = false; FakeES.instances.push(this); }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  close() { this.closed = true; this.readyState = 2; }
  emit(t, ev = {}) { for (const f of this.l[t] || []) f(ev); }
}

function harness({ stored = null, storedMutes = null, recent = [], recentOk = true } = {}) {
  FakeES.instances = [];
  const page = {
    status: dom.page('ev-status'), hidden: dom.page('ev-hidden', 'button'), manage: dom.page('ev-manage', 'button'), mutes: dom.page('ev-mutes'), chips: dom.page('ev-chips'), list: dom.page('ev-list'), count: dom.page('ev-count')
  };
  page.mutes.hidden = true; page.hidden.hidden = true;   // as in index.html
  const mem = {};
  if (stored) mem['dash.events.filters'] = stored;
  if (storedMutes) mem['dash.events.mutes'] = storedMutes;
  const timers = [];
  const rafs = [];
  const fx = { recent, recentOk, fetches: 0, now: 1_000_000_000 };
  const badge = [];
  const env = {
    EventSource: FakeES,
    storage: { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } },
    fetch: async url => {
      fx.fetches++;
      assert.equal(url, '/events/recent');
      return { ok: fx.recentOk, status: fx.recentOk ? 200 : 502, json: async () => fx.recent };
    },
    raf: f => rafs.push(f),
    setTimeout: (f, ms) => { const t = { f, ms, live: true }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.live = false; },
    setInterval: () => 0,
    now: () => fx.now
  };
  const api = mountEvents({ onBadge: n => badge.push(n), mutes: [], env });
  const flush = async () => { await new Promise(r => setImmediate(r)); while (rafs.length) rafs.shift()(); };
  const fire = async () => { const t = timers.filter(x => x.live).shift(); t.live = false; t.f(); await flush(); return t; };
  return { api, page, mem, timers, fx, badge, flush, fire, es: () => FakeES.instances.at(-1) };
}

const ev = (id, over = {}) => ({ id, source: 'kernel', message: 'msg ' + id, category: 'disk_io', priority: 3, first_ts: 1_000_000_000 - 1000, last_ts: 1_000_000_000 - 1000, count: 1, ...over });
const chipsOf = page => page.chips.childNodes;
const rowsOf = page => page.list.childNodes.filter(n => n.classList.contains('ev-row'));

test('mountEvents back-fills on open and merges it with live upserts (newest wins)', async () => {
  const t = harness({ recent: [ev('a', { count: 2, last_ts: 1_000_000_000 - 500 }), ev('b')] });
  t.es().emit('open');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 2);
  assert.ok(t.page.count.textContent.startsWith('2 shown · 2 in last 24h'));
  t.es().emit('upsert', { data: JSON.stringify(ev('a', { count: 7, last_ts: 1_000_000_000 - 100 })) });
  t.es().emit('upsert', { data: 'not json' });
  t.es().emit('upsert', { data: 'null' });
  await t.flush();
  assert.equal(rowsOf(t.page).length, 2);
  assert.ok(rowsOf(t.page)[0].textContent.includes('×7'));
  // a stale back-fill after the live upsert must not roll the group back
  t.fx.recent = [ev('a', { count: 2, last_ts: 1_000_000_000 - 500 })];
  t.es().emit('open');
  await t.flush();
  assert.ok(rowsOf(t.page)[0].textContent.includes('×7'));
});

test('a dash-events restart (new id epoch) replaces the list instead of duplicating it', async () => {
  // ids are "<server start epoch>-<seq>"; after a restart the 24 h replay comes back under new ids
  const t = harness({ recent: [ev('100-1'), ev('100-2')] });
  t.es().emit('open');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 2);
  t.fx.recent = [ev('200-1'), ev('200-2')];          // same events, replayed by the restarted server
  t.es().emit('open');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 2, 'restart must not double the list');
  assert.ok(rowsOf(t.page).every(r => r.dataset.id.startsWith('200-')));
  // a live upsert from the new process before any back-fill also switches epochs cleanly
  t.es().emit('upsert', { data: JSON.stringify(ev('300-1')) });
  await t.flush();
  assert.deepEqual(rowsOf(t.page).map(r => r.dataset.id), ['300-1']);
});

test('filter chips toggle, expose aria-pressed, can all be switched off, and are never saved', async () => {
  const t = harness({ recent: [ev('a', { priority: 3 }), ev('b', { priority: 5 })] });
  t.es().emit('open');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 1);                 // defaults: notice is off
  const notice = chipsOf(t.page).find(c => c.textContent === 'notice');
  assert.equal(notice.getAttribute('aria-pressed'), 'false');
  notice.fire('click');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 2);
  const again = chipsOf(t.page).find(c => c.textContent === 'notice');
  assert.equal(again.getAttribute('aria-pressed'), 'true');
  assert.equal(again.classList.contains('on'), true);
  for (const s of ['error', 'warning', 'notice']) chipsOf(t.page).find(c => c.textContent === s).fire('click');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 0);
  assert.ok(t.page.list.textContent.includes('Nothing matches'));
  assert.deepEqual(t.mem, {});                            // nothing written to storage
});

test('filters saved by an older version are ignored: every visit starts from the defaults', async () => {
  const t = harness({ stored: JSON.stringify({ severities: [], categories: [] }), recent: [ev('a')] });
  t.es().emit('open');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 1);
  assert.equal(chipsOf(t.page).find(c => c.textContent === 'error').getAttribute('aria-pressed'), 'true');
});

test('back-fill failures retry with growing backoff', async () => {
  const t = harness({ recentOk: false });
  t.es().emit('open');
  await t.flush();
  assert.deepEqual(t.timers.filter(x => x.live).map(x => x.ms), [1000]);
  await t.fire();
  assert.deepEqual(t.timers.filter(x => x.live).map(x => x.ms), [2000]);
});

// ── Hide similar / local mutes ──────────────────────────────────────────
const smart = (id, n, over = {}) => ev(id, { source: 'smartd', priority: 4, message: `Device: /dev/sda [SAT], ${n} Currently unreadable sectors`, ...over });
const hideBtn = row => row.childNodes.find(c => c.classList.contains('ev-hide'));

test('Hide similar adds a local mute for this visit only, and "N hidden · show" reveals the family', async () => {
  const t = harness({ recent: [smart('a', 8), smart('b', 9, { last_ts: 1_000_000_000 - 2000 }), ev('c', { last_ts: 1_000_000_000 - 3000 })] });
  t.es().emit('open');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 3);
  assert.equal(t.page.hidden.hidden, true);
  const row = rowsOf(t.page)[0];
  t.page.list.fire('click', { target: row });          // open the row
  assert.equal(row.classList.contains('open'), true);
  t.page.list.fire('click', { target: hideBtn(row) });
  await t.flush();
  assert.deepEqual(t.mem, {});                            // never written to storage
  assert.equal(rowsOf(t.page).length, 1);
  assert.equal(t.page.hidden.hidden, false);
  assert.equal(t.page.hidden.textContent, '2 hidden · show');
  t.page.hidden.fire('click');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 3);
  assert.equal(rowsOf(t.page).filter(r => r.classList.contains('ev-muted')).length, 2);
  assert.equal(t.page.hidden.textContent, '2 hidden · hide');
  assert.ok(t.page.count.textContent.startsWith('1 shown (2 muted, revealed)'), t.page.count.textContent);
  t.page.hidden.fire('click');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 1);
});

const hideRow = async (t, pick) => {
  const row = rowsOf(t.page).find(pick);
  t.page.list.fire('click', { target: hideBtn(row) });
  await t.flush();
};

test('Manage lists local mutes and Remove deletes one', async () => {
  const t = harness({ recent: [smart('a', 8), ev('c', { message: 'Bad sector on disk 4' })] });
  t.es().emit('open');
  await t.flush();
  await hideRow(t, r => r.dataset.id === 'a');
  await hideRow(t, r => r.dataset.id === 'c');
  assert.equal(rowsOf(t.page).length, 0);
  assert.equal(t.page.mutes.hidden, true);
  t.page.manage.fire('click');
  assert.equal(t.page.mutes.hidden, false);
  assert.equal(t.page.manage.getAttribute('aria-expanded'), 'true');
  const muteRows = () => t.page.mutes.childNodes.filter(n => n.classList.contains('ev-mute'));
  assert.equal(muteRows().length, 2);
  const remove = muteRows()[0].childNodes.find(c => c.tagName === 'BUTTON');
  t.page.mutes.fire('click', { target: remove });
  await t.flush();
  assert.equal(muteRows().length, 1);
  assert.equal(rowsOf(t.page).length, 1);              // smartd row is back
  assert.deepEqual(t.mem, {});
});

test('mutes saved by an older version are ignored; the empty Manage panel explains how to add mutes', async () => {
  const t = harness({ storedMutes: JSON.stringify([{ source: 'kernel', prefix: 'msg ' }]), recent: [ev('a')] });
  t.es().emit('open');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 1);              // not hidden
  t.page.manage.fire('click');
  assert.equal(t.page.mutes.childNodes.filter(n => n.classList.contains('ev-mute')).length, 0);
  assert.ok(t.page.mutes.textContent.includes('Hide similar'), t.page.mutes.textContent);
});

test('badge still counts muted priority-3 entries', async () => {
  const t = harness({ recent: [ev('a')] });
  t.es().emit('open');
  await t.flush();
  await hideRow(t, r => r.dataset.id === 'a');
  assert.equal(rowsOf(t.page).length, 0);
  assert.equal(t.badge.at(-1), 1);
});

test('Hide similar shows an 8 s Undo that removes the rule; errors get the "errors" wording', async () => {
  const t = harness({ recent: [smart('a', 8), ev('e', { message: 'Bad sector on disk 4', last_ts: 1_000_000_000 - 5000 })] });
  t.es().emit('open');
  await t.flush();
  const [r1, r2] = rowsOf(t.page);
  assert.equal(hideBtn(r1).textContent, 'Hide similar');
  assert.equal(hideBtn(r2).textContent, 'Hide similar errors');
  t.page.list.fire('click', { target: hideBtn(r1) });
  await t.flush();
  assert.equal(t.page.status.hidden, false);
  assert.equal(t.page.status.textContent, 'Hidden messages like this · Undo');
  const undo = t.page.status.childNodes.find(c => c.tagName === 'BUTTON');
  assert.equal(rowsOf(t.page).length, 1);
  undo.fire('click');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 2);
  assert.equal(t.page.status.hidden, true);
  // errors wording and auto-expiry after 8 s
  t.page.list.fire('click', { target: hideBtn(rowsOf(t.page)[1]) });
  await t.flush();
  assert.equal(t.page.status.textContent, 'Hidden errors like this · Undo');
  const timer = t.timers.find(x => x.live && x.ms === 8000);
  assert.ok(timer);
  timer.f();
  assert.equal(t.page.status.hidden, true);
});

test('focus moves to a surviving control after Hide similar and Remove', async () => {
  const focused = [];
  const orig = document.createElement.bind(document);
  document.createElement = tag => { const el = orig(tag); el.focus = () => focused.push(el); return el; };
  const t = harness({ recent: [smart('s', 1), ev('x', { source: 'a', message: 'xx alpha one' }), ev('y', { source: 'b', message: 'yy beta two' })] });
  t.page.manage.focus = () => focused.push(t.page.manage);
  t.es().emit('open');
  await t.flush();
  await hideRow(t, r => r.dataset.id === 'x');
  await hideRow(t, r => r.dataset.id === 'y');
  t.page.list.fire('click', { target: hideBtn(rowsOf(t.page)[0]) });
  assert.equal(focused.at(-1).textContent, 'Undo');
  t.page.manage.fire('click');
  const rm = () => t.page.mutes.childNodes.map(n => n.childNodes.find(c => c.tagName === 'BUTTON'));
  t.page.mutes.fire('click', { target: rm()[0] });
  assert.equal(focused.at(-1), rm()[0]);                 // the next Remove button took its place
  t.page.mutes.fire('click', { target: rm()[0] });
  t.page.mutes.fire('click', { target: rm()[0] });
  assert.equal(focused.at(-1), t.page.manage);           // none left: back to Manage
});

test('setMutes swaps the server mutes in place; real errors stay visible', async () => {
  const t = harness({ recent: [ev('a', { source: 'kernel', priority: 4, message: 'noisy warning' }), ev('b', { source: 'kernel', priority: 3 })] });
  t.es().emit('open');
  await t.flush();
  assert.equal(rowsOf(t.page).length, 2);
  t.api.setMutes([{ source: 'kernel' }]);
  await t.flush();
  assert.equal(rowsOf(t.page).length, 1);
  t.api.setMutes(null);
  await t.flush();
  assert.equal(rowsOf(t.page).length, 2);
});
