// Quick Launch view: tile markup, handle-only drag (mouse, pen, touch), keyboard pick-up/move/drop and FLIP.
// All text goes through h()/setText.
import { h, setText } from './dom.js';
import { ring } from './format.js';
import { keyboardMove, moveId, moveMessage } from './quicklaunch.js';

const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
const FLIP_MS = 180;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const prefersReducedMotion = () =>
  !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Decides when a press on a drag handle becomes a drag. Touch starts at once (the handle has
 * touch-action: none, so nothing else wants the gesture); mouse and pen start after moving `threshold` px,
 * so a plain click on the handle does not make the tile jump.
 */
export function createGesture({ threshold = 6 } = {}) {
  let press = null, dragging = false;
  return {
    down(pointerType, x, y) {
      press = { x, y };
      dragging = pointerType === 'touch';
      return dragging ? 'start' : 'none';
    },
    move(x, y) {
      if (!press || dragging) return 'none';
      if (Math.hypot(x - press.x, y - press.y) < threshold) return 'none';
      dragging = true;
      return 'start';
    },
    up() { press = null; dragging = false; },
    get dragging() { return dragging; }
  };
}

/**
 * Runs `fn` unless `busy()`; a call made while busy is remembered and replayed by `flush()`.
 * Keeps data refreshes from rearranging tiles under a drag without dropping them.
 */
export function deferWhile(busy, fn) {
  let pending = false;
  const self = {
    run() {
      if (busy()) { pending = true; return false; }
      pending = false;
      fn();
      return true;
    },
    flush() { if (pending) self.run(); },
    get pending() { return pending; }
  };
  return self;
}

/**
 * Polite live-region writer. The region is emptied first and the text set on a later frame, so a repeated
 * message ("Order reset" twice) is still a change that screen readers announce. Only the latest message lands.
 */
export function createAnnouncer(region, { defer = fn => (globalThis.requestAnimationFrame || setTimeout)(fn) } = {}) {
  let seq = 0;
  return text => {
    const mine = ++seq;
    region.textContent = '';
    defer(() => { if (mine === seq) region.textContent = text; });
  };
}

/** Index of the rect whose centre is nearest (x, y); -1 for an empty list. */
export function indexAtPoint(rects, x, y) {
  let best = -1, bestD = Infinity;
  rects.forEach((r, i) => {
    const d = (r.left + r.width / 2 - x) ** 2 + (r.top + r.height / 2 - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

const elements = parent => Array.from(parent.childNodes).filter(n => n.nodeType === 1);
const FLIP_GEN = new WeakMap();

/**
 * FLIP: record children's boxes, mutate, then slide each child from its old box to its new one.
 * `skip` (optional) is left alone, e.g. the tile being dragged.
 */
export function flip(parent, mutate, { reduceMotion = false, skip = null } = {}) {
  if (reduceMotion || typeof globalThis.requestAnimationFrame !== 'function') { mutate(); return; }
  const first = new Map(elements(parent).filter(el => el !== skip).map(el => [el, el.getBoundingClientRect()]));
  mutate();
  const moved = [];
  for (const el of elements(parent)) {
    const a = first.get(el);
    if (!a) continue;
    el.style.transition = 'none';
    el.style.transform = '';
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (dx || dy) { el.style.transform = `translate(${dx}px, ${dy}px)`; moved.push(el); }
  }
  const gen = (FLIP_GEN.get(parent) || 0) + 1;
  FLIP_GEN.set(parent, gen);
  if (!moved.length) return;
  requestAnimationFrame(() => {
    if (FLIP_GEN.get(parent) !== gen) return; // a newer flip owns these transforms now
    for (const el of moved) {
      if (el.classList.contains('lifted')) continue;
      el.style.transition = `transform ${FLIP_MS}ms ease`;
      el.style.transform = '';
    }
  });
}

// ── tiles ──────────────────────────────────────────────────────────────
const REFS = new WeakMap();

function gripIcon() {
  const svg = globalThis.document.createElementNS?.(SVG_NS, 'svg');
  if (!svg) return null;
  for (const [k, v] of Object.entries({ width: 12, height: 18, viewBox: '0 0 12 18', fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  for (const cx of [3, 9]) for (const cy of [3, 9, 15]) {
    const c = globalThis.document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', 1.6);
    svg.appendChild(c);
  }
  return svg;
}

function tileAction(t) {
  // OPEN stretches over the whole tile (CSS ::after), so a tap anywhere but the handle opens the service.
  return t.url
    ? h('a', { class: 'open-btn', href: t.url, target: '_blank', rel: 'noopener noreferrer' }, 'OPEN')
    : h('span', { class: 'no-port' }, t.note ?? '');
}

export function createTile(t) {
  const r = {
    dot: h('span', { class: 'dot' }), name: h('span', { class: 'svc-name' }), port: h('span', { class: 'svc-port' }),
    desc: h('div', { class: 'svc-desc' }), status: h('span', { class: 'svc-status' }), action: tileAction(t), url: t.url,
    handle: h('button', { class: 'ql-handle', type: 'button' }, gripIcon())
  };
  r.foot = h('div', { class: 'svc-foot' }, r.action, r.status);
  const el = h('div', { class: 'svc', role: 'listitem', dataset: { id: t.id } },
    h('div', { class: 'svc-top' }, r.dot, r.name, r.port, r.handle), r.desc, r.foot);
  REFS.set(el, r);
  updateTile(el, t);
  return el;
}

export function updateTile(el, t) {
  const r = REFS.get(el);
  setText(r.name, t.name);
  setText(r.port, t.port != null ? ':' + t.port : '');
  setText(r.desc, t.desc);
  r.desc.setAttribute('title', t.desc ?? ''); // CSS clamps the text to two lines; the tooltip keeps all of it
  r.handle.setAttribute('aria-label', 'Reorder ' + t.name);
  // an auto tile can gain (or lose) a port: swap OPEN and the "no web port" note
  if (t.url !== r.url) {
    const next = tileAction(t);
    r.foot.insertBefore(next, r.action);
    r.foot.removeChild(r.action);
    Object.assign(r, { action: next, url: t.url });
  } else if (!t.url) setText(r.action, t.note ?? '');
  r.dot.style.background = t.dot;
  r.dot.style.boxShadow = ring(t.dot);
  r.status.style.color = t.dot;
  setText(r.status, t.statusText);
}

// ── reordering ─────────────────────────────────────────────────────────
/** Columns in the grid: leading tiles that share the first tile's row. */
function columnCount(tiles) {
  if (!tiles.length) return 1;
  const top = tiles[0].offsetTop;
  let n = 0;
  while (n < tiles.length && tiles[n].offsetTop === top) n++;
  return n;
}

/**
 * Moves `tile` to index `to` by moving the tiles in between across it. The tile itself never leaves the DOM:
 * detaching it would drop its pointer capture (ending the drag with lostpointercapture) and its focus.
 */
export function moveTile(grid, tile, to) {
  const tiles = elements(grid);
  const from = tiles.indexOf(tile);
  if (from < 0 || to === from || to < 0 || to >= tiles.length) return;
  if (from < to) for (let i = from + 1; i <= to; i++) grid.insertBefore(tiles[i], tile);
  else for (let i = from - 1; i >= to; i--) grid.insertBefore(tiles[i], tile.nextSibling);
}

/** Layout boxes in the grid's own coordinates; transforms (FLIP, lift) do not affect them. */
const layoutRect = el => ({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });

export function mountReorder(grid, { ids, nameOf, commit, announce, onIdle = () => {}, helpId = null, win = globalThis.window }) {
  const gesture = createGesture();
  const doc = globalThis.document;
  if (helpId) grid.setAttribute('aria-describedby', helpId);
  let drag = null;           // pointer press on a handle: { tile, handle, pointerId, startX, startY, active, order }
  let grab = null;           // keyboard pick-up: { tile, handle, order }
  let suppressClick = false;

  const closest = (target, sel) => (target && typeof target.closest === 'function' ? target.closest(sel) : null);
  const domIds = () => elements(grid).map(el => el.dataset.id);
  const motion = () => ({ reduceMotion: prefersReducedMotion() });
  const handleOf = tile => tile.querySelector?.('.ql-handle') ?? null;
  const position = tile => elements(grid).indexOf(tile);
  const BACK = new Set(['ArrowLeft', 'ArrowUp', 'Home']);
  function edgeMessage(name, from, key, total) {
    if (BACK.has(key)) return from === 0 ? `${name} is already first` : `${name} is already in the top row`;
    return from === total - 1 ? `${name} is already last` : `${name} is already in the bottom row`;
  }

  function restore(order) {
    for (const id of order) {
      const el = elements(grid).find(x => x.dataset.id === id);
      if (el) grid.appendChild(el);
    }
  }

  /** Commits and announces if the order changed. Returns true when it did. */
  function settle(tile, order, message) {
    const next = domIds();
    if (next.join('\n') === order.join('\n')) return false;
    commit(next);
    announce(message ?? moveMessage(nameOf(tile.dataset.id), next.indexOf(tile.dataset.id), next.length));
    return true;
  }

  // pointer drag
  function place(x, y) {
    const d = drag;
    const dx = (x - d.startX) - (d.tile.offsetLeft - d.left0);
    const dy = (y - d.startY) - (d.tile.offsetTop - d.top0);
    d.tile.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function startDrag() {
    const d = drag;
    if (!d || d.tile.parentNode !== grid) { endPointer(); return; }
    d.active = true;
    d.order = domIds();
    d.left0 = d.tile.offsetLeft; d.top0 = d.tile.offsetTop;
    d.tile.style.transition = 'none';
    d.tile.classList.add('lifted');
    grid.classList.add('dragging');
    doc.addEventListener?.('keydown', onDocKey, true);
    place(d.lastX, d.lastY);
  }

  function retarget(clientX, clientY) {
    const d = drag;
    const tiles = elements(grid);
    const box = grid.getBoundingClientRect();
    const px = clientX - box.left - (grid.clientLeft || 0), py = clientY - box.top - (grid.clientTop || 0);
    // nearest slot, counting the dragged tile's own (untransformed) slot so a small move doesn't reorder
    const to = indexAtPoint(tiles.map(layoutRect), px, py);
    const from = tiles.indexOf(d.tile);
    if (to < 0 || from < 0 || to === from) return;
    flip(grid, () => moveTile(grid, d.tile, to), { ...motion(), skip: d.tile });
  }

  function endPointer() {
    gesture.up();
    if (drag) { try { drag.handle.releasePointerCapture?.(drag.pointerId); } catch { /* not captured */ } }
    drag = null;
    grid.classList.remove('dragging');
    doc.removeEventListener?.('keydown', onDocKey, true);
  }

  function finishDrag(keep) {
    const d = drag;
    endPointer();
    if (!d || !d.active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    flip(grid, () => {
      if (!keep) restore(d.order);
      d.tile.classList.remove('lifted');
      d.tile.style.transition = '';
      d.tile.style.transform = '';
    }, motion());
    if (keep) settle(d.tile, d.order);
    onIdle();
  }

  function onDocKey(e) {
    if (e.key === 'Escape' && drag?.active) { e.preventDefault(); e.stopPropagation(); finishDrag(false); }
  }

  // keyboard (and screen reader) pick-up / move / drop on the handle
  function pickUp(tile, handle) {
    grab = { tile, handle, order: domIds() };
    tile.classList.add('lifted');
    handle.setAttribute('aria-pressed', 'true');
    const n = elements(grid).length;
    announce(`Picked up ${nameOf(tile.dataset.id)}, position ${position(tile) + 1} of ${n}. ` +
      'Arrow keys move it, Space drops it, Escape cancels.');
  }

  function putDown(keep) {
    const g = grab;
    grab = null;
    if (!g) return;
    flip(grid, () => { if (!keep) restore(g.order); g.tile.classList.remove('lifted'); }, motion());
    g.handle.setAttribute('aria-pressed', 'false');
    const n = elements(grid).length, name = nameOf(g.tile.dataset.id), at = position(g.tile) + 1;
    if (!keep) announce(`Cancelled. ${name} is back at position ${at} of ${n}`);
    else if (!settle(g.tile, g.order, `Dropped ${name} at position ${at} of ${n}`)) announce(`Dropped ${name}, order unchanged`);
    refocus(g.tile);
    onIdle();
  }

  function refocus(tile) {
    const target = handleOf(tile);
    if (target && doc.activeElement !== target) target.focus?.({ preventScroll: false });
  }

  function keyMove(key) {
    const g = grab;
    const tiles = elements(grid);
    const from = tiles.indexOf(g.tile);
    const to = keyboardMove(from, key, tiles.length, columnCount(tiles));
    if (to === from) { announce(edgeMessage(nameOf(g.tile.dataset.id), from, key, tiles.length)); return; }
    flip(grid, () => moveTile(grid, g.tile, to), motion());
    announce(moveMessage(nameOf(g.tile.dataset.id), to, tiles.length));
    refocus(g.tile);
  }

  grid.addEventListener('pointerdown', e => {
    const handle = closest(e.target, '.ql-handle');
    const tile = handle && closest(handle, '.svc');
    if (!tile || drag || (e.pointerType === 'mouse' && e.button !== 0) || e.isPrimary === false) return;
    if (grab) putDown(true);
    e.preventDefault(); // no text selection or focus-scroll from the handle press
    drag = { tile, handle, pointerId: e.pointerId, startX: e.pageX, startY: e.pageY, lastX: e.pageX, lastY: e.pageY, active: false };
    try { handle.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
    if (gesture.down(e.pointerType, e.clientX, e.clientY) === 'start') startDrag();
  });

  grid.addEventListener('pointermove', e => {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.lastX = e.pageX; d.lastY = e.pageY;
    if (!d.active) {
      if (gesture.move(e.clientX, e.clientY) === 'start') startDrag();
      if (!drag?.active) return;
    }
    e.preventDefault();
    retarget(e.clientX, e.clientY);
    place(d.lastX, d.lastY);
  });

  grid.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) finishDrag(true); });
  grid.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pointerId) finishDrag(false); });
  // Capture lost without a pointerup (capture refused, element moved, OS gesture): the up may never reach us.
  grid.addEventListener('lostpointercapture', e => { if (drag && e.pointerId === drag.pointerId) finishDrag(false); });
  // Switching apps or windows mid-drag must never leave a tile stuck in the air.
  win?.addEventListener?.('blur', () => { if (drag) finishDrag(false); });
  // Belt and braces for browsers that ignore touch-action on the handle.
  grid.addEventListener('touchmove', e => { if (drag?.active) e.preventDefault(); }, { passive: false });
  // Only the grip opts out of native drag; the OPEN link can still be dragged to the bookmarks bar.
  grid.addEventListener('dragstart', e => { if (closest(e.target, '.ql-handle')) e.preventDefault(); });

  grid.addEventListener('click', e => {
    // The click that ends a drag must not press anything.
    // Keyboard/screen-reader activation (detail 0) is never that click.
    if (suppressClick && e.detail !== 0) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    const handle = closest(e.target, '.ql-handle');
    if (!handle) return;
    e.preventDefault();
    // Keyboard (Space/Enter) and screen-reader activation report detail 0; a mouse click on the grip does nothing.
    if (e.detail) return;
    if (grab) putDown(true);
    else pickUp(closest(handle, '.svc'), handle);
  }, true);

  grid.addEventListener('keydown', e => {
    if (grab) {
      if (e.key === 'Escape') { e.preventDefault(); putDown(false); }
      else if (MOVE_KEYS.has(e.key)) { e.preventDefault(); keyMove(e.key); }
      else if (e.key === 'Tab') putDown(true);
      return;
    }
    // Shortcut: Alt+Arrow/Home/End moves a tile at once and saves.
    if (!e.altKey || !MOVE_KEYS.has(e.key) || drag?.active) return;
    const tile = closest(e.target, '.svc');
    const id = tile?.dataset.id;
    const list = ids();
    const from = list.indexOf(id);
    if (from < 0) return;
    e.preventDefault(); // Alt+Left is "Back" in most browsers
    const to = keyboardMove(from, e.key, list.length, columnCount(elements(grid)));
    if (to === from) { announce(edgeMessage(nameOf(id), from, e.key, list.length)); return; }
    const next = moveId(list, from, to);
    commit(next);
    announce(moveMessage(nameOf(id), to, next.length));
    const moved = elements(grid).find(el => el.dataset.id === id);
    if (moved) refocus(moved);
  });

  // Focus leaving the grid while a tile is picked up drops it where it is.
  grid.addEventListener('focusout', () => {
    if (!grab) return;
    setTimeout(() => {
      if (grab && !grid.contains?.(doc.activeElement)) putDown(true);
    }, 0);
  });

  return { dragging: () => !!drag?.active || !!grab };
}
