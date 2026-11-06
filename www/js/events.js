// Errors section view: row rendering, filter persistence, live stream wiring.
import { h, setChildren } from './dom.js';
import { ago, COLORS } from './format.js';
import {
  severityOf, SEVERITY_COLORS, CATEGORY_LABELS, SEVERITIES, CATEGORIES,
  createEventStore, compileMutes, compileLocalMutes, isMuted, similarMute
} from './events-model.js';

export function renderEventRow(e, now = Date.now()) {
  const sev = severityOf(e.priority);
  return h('div', { class: 'ev-row ev-' + sev, dataset: { id: e.id } },
    h('span', { class: 'dot', style: { background: SEVERITY_COLORS[sev] } }),
    h('span', { class: 'ev-cat' }, Object.hasOwn(CATEGORY_LABELS, e.category) ? CATEGORY_LABELS[e.category] : 'OTHER'),
    h('span', { class: 'ev-src', title: e.source }, e.source),
    h('span', { class: 'ev-msg', title: e.message }, e.message),
    e.count > 1 ? h('span', { class: 'ev-count' }, '×' + e.count) : null,
    h('span', { class: 'ev-ago' }, ago(e.last_ts, now)),
    h('button', { class: 'ev-hide link-btn', type: 'button' }, e.priority <= 3 ? 'Hide similar errors' : 'Hide similar')
  );
}

/** Bounded exponential backoff: 1s, 2s, 4s ... capped at 30s. */
export const backoffDelay = (attempt, base = 1000, cap = 30000) => Math.min(cap, base * 2 ** Math.max(0, attempt));

export const DEFAULT_SEVERITIES = ['error', 'warning'];

/**
 * Stored filters -> Sets. An explicit empty array persists as empty (all chips off);
 * null, missing, invalid JSON, a non-array, or an array with no recognisable key falls back to the defaults (error + warning severities, all categories).
 */
export function parseFilters(raw) {
  let saved = {};
  try { saved = JSON.parse(raw || '{}') || {}; } catch { saved = {}; }
  if (typeof saved !== 'object') saved = {};
  const pick = (list, allowed, dflt) => {
    if (!Array.isArray(list)) return new Set(dflt);
    const keep = list.filter(x => allowed.includes(x));
    return new Set(list.length && !keep.length ? dflt : keep);
  };
  return {
    severities: pick(saved.severities, SEVERITIES, DEFAULT_SEVERITIES),
    categories: pick(saved.categories, CATEGORIES, CATEGORIES)
  };
}


/**
 * `env` is a dependency-injection seam for tests; every member defaults to the browser global:
 * { fetch, EventSource, raf, setTimeout, clearTimeout, setInterval, now }.
 */
export function mountEvents({ onBadge = () => {}, mutes = [], env = {} } = {}) {
  const fetchFn = env.fetch || ((...a) => fetch(...a));
  const ES = env.EventSource || EventSource;
  const raf = env.raf || (f => requestAnimationFrame(f));
  const setT = env.setTimeout || ((f, ms) => setTimeout(f, ms));
  const clearT = env.clearTimeout || (t => clearTimeout(t));
  const setI = env.setInterval || ((f, ms) => setInterval(f, ms));
  const nowFn = env.now || (() => Date.now());

  const $ = id => document.getElementById(id);
  const store = createEventStore();
  let configMutes = compileMutes(mutes);
  let localMutes = [];   // "Hide similar" rules last this visit only
  let compiled = [...configMutes, ...compileLocalMutes(localMutes)];
  let revealMuted = false;
  const byIdEntry = new Map(); // id -> entry as last rendered, for "Hide similar"
  const filters = parseFilters(null);   // defaults every visit; chip changes are not saved
  const open = new Set();
  let flash = new Set();
  let pending = false;

  // Two independent status sources; the most important one is shown (back-fill outage > stream state).
  const statusSrc = { recent: '', stream: '' };
  let undo = null; // { rule, label, timer } while the post-"Hide similar" Undo line is showing
  const focusEl = el => { if (el && typeof el.focus === 'function') el.focus(); };
  function renderStatus() {
    const box = $('ev-status');
    if (undo) {
      box.hidden = false;
      setChildren(box, undo.label + ' · ', h('button', { class: 'link-btn', type: 'button', onClick: doUndo }, 'Undo'));
      return;
    }
    const text = statusSrc.recent || statusSrc.stream;
    box.hidden = !text;
    box.textContent = text;
  }
  function clearUndo() { if (undo) { clearT(undo.timer); undo = null; } }
  function doUndo() {
    if (!undo) return;
    const { rule } = undo;
    clearUndo();
    setLocalMutes(localMutes.filter(x => !(x.source === rule.source && x.prefix === rule.prefix)));
    renderStatus();
    focusEl($('ev-hidden').hidden ? $('ev-manage') : $('ev-hidden'));
  }

  function chip(set, key, label) {
    return h('button', {
      class: 'chip' + (set.has(key) ? ' on' : ''), type: 'button', 'aria-pressed': set.has(key) ? 'true' : 'false',
      onClick: () => {
        if (set.has(key)) set.delete(key); else set.add(key);
        renderChips(); render();
      }
    }, label);
  }

  function renderChips() {
    setChildren($('ev-chips'),
      SEVERITIES.map(s => chip(filters.severities, s, s)),
      CATEGORIES.map(c => chip(filters.categories, c, CATEGORY_LABELS[c])));
  }

  function setLocalMutes(list) {
    localMutes = list;
    compiled = [...configMutes, ...compileLocalMutes(localMutes)];
    renderMutes();
    schedule();
  }

  function renderMutes() {
    const box = $('ev-mutes');
    setChildren(box, localMutes.length
      ? localMutes.map((m, i) => h('div', { class: 'ev-mute' },
        h('span', { class: 'ev-src' }, m.source),
        h('span', { class: 'ev-msg' }, m.prefix + '…'),
        h('button', { class: 'link-btn', type: 'button', 'aria-label': 'Remove mute for ' + m.source, dataset: { i: String(i) } }, 'Remove')))
      : h('div', { class: 'ev-empty-mutes' }, 'No local mutes. Expand a row and choose “Hide similar”.'));
  }

  function render() {
    pending = false;
    const now = nowFn();
    store.prune(now);
    const rows = store.view({ ...filters, mutes: compiled, reveal: revealMuted });
    const nMuted = store.countMuted({ ...filters, mutes: compiled });
    byIdEntry.clear();
    for (const e of rows) byIdEntry.set(String(e.id), e);
    $('ev-count').textContent = (revealMuted ? (rows.length - nMuted) + ' shown (' + nMuted + ' muted, revealed)' : rows.length + ' shown') + ' · ' + store.size + ' in last 24h';
    const hid = $('ev-hidden');
    hid.hidden = nMuted === 0 && !revealMuted;
    hid.textContent = nMuted + ' hidden · ' + (revealMuted ? 'hide' : 'show');
    if (!rows.length) {
      setChildren($('ev-list'), h('div', { class: 'ev-empty' },
        h('span', { class: 'dot', style: { background: COLORS.healthy } }),
        store.size ? 'Nothing matches the current filters' : 'No problems logged in the last 24 hours'));
    } else {
      setChildren($('ev-list'), rows.slice(0, 300).map(e => {
        const row = renderEventRow(e, now);
        if (open.has(e.id)) row.classList.add('open');
        if (revealMuted && isMuted(e, compiled)) row.classList.add('ev-muted');
        if (flash.has(e.id)) row.classList.add('flash');
        return row;
      }));
    }
    flash = new Set();
    onBadge(store.recentErrorCount(now));
  }

  function schedule() {
    if (!pending) { pending = true; raf(render); }
  }

  let recentTimer = null;
  let recentFails = 0;

  // dash-events ids are "<server start epoch>-<seq>". After a restart it replays the last 24 h under
  // new ids, so merging by id would show every event twice; a new epoch replaces the list instead.
  let serverEpoch = null;
  function noteEpoch(id) {
    const s = String(id), i = s.indexOf('-');
    if (i <= 0) return;
    const epoch = s.slice(0, i);
    if (serverEpoch !== null && epoch !== serverEpoch) { store.clear(); flash.clear(); }
    serverEpoch = epoch;
  }

  async function loadRecent() {
    clearT(recentTimer);
    recentTimer = null;
    try {
      const r = await fetchFn('/events/recent', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const list = await r.json();
      if (!Array.isArray(list)) throw new Error('unexpected payload');
      const first = list.find(e => e && typeof e === 'object' && e.id != null);
      if (first) noteEpoch(first.id);
      for (const e of list) store.upsert(e);
      recentFails = 0;
      statusSrc.recent = ''; // cleared only now that the back-fill result is known
      renderStatus();
      schedule();
    } catch {
      statusSrc.recent = 'log service unreachable (/events/) — retrying';
      renderStatus();
      if (!recentTimer) recentTimer = setT(loadRecent, backoffDelay(recentFails++));
    }
  }

  $('ev-list').addEventListener('click', e => {
    const row = e.target.closest('.ev-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.ev-hide')) {
      const entry = byIdEntry.get(String(id));
      if (!entry) return;
      const m = similarMute(entry);
      if (m.prefix && !localMutes.some(x => x.source === m.source && x.prefix === m.prefix)) {
        setLocalMutes([...localMutes, m].slice(-50));
        clearUndo();
        undo = { rule: m, label: entry.priority <= 3 ? 'Hidden errors like this' : 'Hidden messages like this', timer: setT(() => { undo = null; renderStatus(); }, 8000) };
        renderStatus();
        focusEl($('ev-status').childNodes.find(c => c.tagName === 'BUTTON'));
      }
      return;
    }
    if (open.has(id)) open.delete(id); else open.add(id);
    row.classList.toggle('open');
  });

  $('ev-hidden').addEventListener('click', () => { revealMuted = !revealMuted; render(); });
  $('ev-manage').addEventListener('click', () => {
    const box = $('ev-mutes');
    box.hidden = !box.hidden;
    $('ev-manage').setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
  });
  $('ev-mutes').addEventListener('click', e => {
    const btn = e.target.closest('.link-btn');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (Number.isInteger(i) && i >= 0 && i < localMutes.length) {
      setLocalMutes(localMutes.filter((_, j) => j !== i));
      const next = $('ev-mutes').childNodes.map(n => n.childNodes && n.childNodes.find(c => c.tagName === 'BUTTON')).filter(Boolean)[Math.min(i, localMutes.length - 1)];
      focusEl(next || $('ev-manage'));
    }
  });

  let es = null;
  let streamTimer = null;
  let streamFails = 0;

  function connect() {
    clearT(streamTimer);
    streamTimer = null;
    if (es) es.close();
    const cur = es = new ES('/events/stream');
    cur.addEventListener('open', () => {
      if (es !== cur) return;
      streamFails = 0;
      statusSrc.stream = ''; // the back-fill status is left alone until loadRecent() reports
      renderStatus();
      loadRecent();
    });
    cur.addEventListener('error', () => {
      if (es !== cur) return;
      if (cur.readyState === ES.CLOSED) {
        // browser gave up (e.g. 502 from the proxy): reopen ourselves
        statusSrc.stream = 'log stream closed — reconnecting';
        if (!streamTimer) streamTimer = setT(connect, backoffDelay(streamFails++));
      } else {
        statusSrc.stream = 'log stream disconnected — retrying';
      }
      renderStatus();
    });
    cur.addEventListener('upsert', ev => {
      let e;
      try { e = JSON.parse(ev.data); } catch { return; }
      if (!e || typeof e !== 'object' || e.id == null) return;
      noteEpoch(e.id);
      store.upsert(e);
      flash.add(e.id);
      schedule();
    });
  }

  renderChips();
  renderMutes();
  render();
  connect();
  setI(schedule, 30_000); // re-renders: keeps "Nm ago" fresh and prunes entries past 24h
  return {
    /** Replace the server-side mutes (from /api/settings); "Hide similar" choices stay. */
    setMutes(next) {
      configMutes = compileMutes(Array.isArray(next) ? next : []);
      compiled = [...configMutes, ...compileLocalMutes(localMutes)];
      schedule();
    }
  };
}
