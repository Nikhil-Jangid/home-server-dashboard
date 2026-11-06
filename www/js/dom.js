// The only way views create DOM. Text always goes through text nodes.
const SAFE_URL = /^(https?:|\/|#)/i;
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data', 'background']);
const BLOCKED_TAGS = new Set([
  'script', 'iframe', 'frame', 'object', 'embed', 'base', 'link', 'meta', 'style', 'template',
  'animate', 'set', 'animatetransform', 'animatemotion', 'foreignobject'
]);
// srcdoc/srcset/ping can load or exfiltrate; the rest are SVG animation attributes that can rewrite href at runtime.
const BLOCKED_ATTRS = new Set(['srcdoc', 'srcset', 'ping', 'attributename', 'values', 'from', 'to', 'by', 'begin']);

function appendAll(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : globalThis.document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...children) {
  if (BLOCKED_TAGS.has(String(tag).toLowerCase())) throw new Error('blocked tag: ' + tag);
  const el = globalThis.document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    const key = k.toLowerCase();
    if (key === 'class') el.className = v;
    else if (key === 'style') Object.assign(el.style, v);
    else if (key === 'dataset') Object.assign(el.dataset, v);
    else if (key.startsWith('on')) {
      if (typeof v !== 'function') throw new Error('event handler must be a function: ' + key);
      el.addEventListener(key.slice(2), v);
    } else if (BLOCKED_ATTRS.has(key)) {
      throw new Error('attribute not allowed: ' + k);
    } else if (URL_ATTRS.has(key)) {
      const s = String(v).trim();
      if (!SAFE_URL.test(s)) throw new Error('unsafe url: ' + key);
      el.setAttribute(key, s);
    } else el.setAttribute(key, String(v));
  }
  appendAll(el, children);
  return el;
}

export function setChildren(el, ...children) {
  el.replaceChildren();
  appendAll(el, children);
}

/** Sets an element's text without replacing an unchanged text node (keeps selection and focus intact). */
export function setText(el, text) {
  const s = String(text);
  const f = el.firstChild;
  if (f && f.nodeType === 3 && f === el.lastChild) { if (f.data !== s) f.data = s; }
  else if (el.textContent !== s || f) el.textContent = s;
}

/**
 * Touch long-press on el: fn runs after `ms` of a still finger. The click that ends a long press is still
 * dispatched, so the element's click handler asks press.took() first (true once after a long press).
 */
export function onLongPress(el, fn, { ms = 500, slop = 10 } = {}) {
  let timer = null, x = 0, y = 0, took = false, pressing = false;
  const stop = () => { clearTimeout(timer); timer = null; pressing = false; };
  el.addEventListener('pointerdown', e => {
    stop();
    took = false;
    if (e.pointerType !== 'touch') return;
    x = e.clientX; y = e.clientY; pressing = true;
    timer = setTimeout(() => { timer = null; took = true; fn(); }, ms);
  });
  el.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > slop) stop(); });
  el.addEventListener('pointerup', () => { clearTimeout(timer); timer = null; pressing = false; });
  el.addEventListener('pointercancel', stop);
  el.addEventListener('contextmenu', e => { if (pressing || took) e.preventDefault(); });
  return { took() { const t = took; took = false; return t; } };
}

const MANAGED = new WeakMap();

/** Indices into `seq` of one longest strictly increasing subsequence (seq holds distinct numbers). */
function lisIndices(seq) {
  const tails = [], prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (seq[tails[m]] < seq[i]) lo = m + 1; else hi = m; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(i);
  return out;
}

/**
 * Keyed in-place list update. Existing elements are updated and reused, new ones created,
 * stale (and foreign) children removed. Order is fixed by keeping a longest increasing
 * subsequence of the existing nodes (by old position) where they are and moving only the rest.
 * Moves use parent.moveBefore when available (it preserves focus, selection and iframe/animation
 * state); otherwise insertBefore, which is remove-plus-insert and drops them.
 * `items` may repeat a key; the first wins.
 */
export function reconcileKeyed(parent, items, { key, create, update }) {
  const prev = MANAGED.get(parent) || new Map();
  const next = new Map();
  for (const item of items) {
    const k = String(key(item));
    if (next.has(k)) continue;
    let el = prev.get(k);
    if (el && el.parentNode === parent) update(el, item); else el = create(item);
    next.set(k, el);
  }
  const keep = new Set(next.values());
  for (let n = parent.firstChild; n;) {
    const after = n.nextSibling;
    if (!keep.has(n)) parent.removeChild(n);
    n = after;
  }
  const oldPos = new Map();
  let pos = 0;
  for (let n = parent.firstChild; n; n = n.nextSibling) oldPos.set(n, pos++);
  const order = [...next.values()];
  const existing = [];  // indices into `order` that are already children, with their old positions
  for (let i = 0; i < order.length; i++) if (oldPos.has(order[i])) existing.push(i);
  const stay = new Set(lisIndices(existing.map(i => oldPos.get(order[i]))).map(j => existing[j]));
  const move = typeof parent.moveBefore === 'function'
    ? (el, ref) => parent.moveBefore(el, ref)
    : (el, ref) => parent.insertBefore(el, ref);
  let ref = null;
  for (let i = order.length - 1; i >= 0; i--) {
    const el = order[i];
    if (!stay.has(i)) { if (oldPos.has(el)) move(el, ref); else parent.insertBefore(el, ref); }
    ref = el;
  }
  MANAGED.set(parent, next);
}
