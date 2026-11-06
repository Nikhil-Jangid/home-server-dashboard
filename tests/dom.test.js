import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { h, setChildren, setText, reconcileKeyed, onLongPress } from '../www/js/dom.js';

let dom;
beforeEach(() => { dom = installFakeDom(); });

test('strings become text nodes, never markup', () => {
  const el = h('div', null, '<b>x</b>', 42, null, false, ['a', ['b']]);
  assert.equal(el.childNodes.length, 4);
  assert.ok(el.childNodes.every(n => n.nodeType === 3));
  assert.equal(el.textContent, '<b>x</b>42ab');
  assert.equal(dom.created.filter(e => e.tagName === 'B').length, 0);
});

test('props: class, style, dataset, listener, attributes', () => {
  const fn = () => {};
  const el = h('a', { class: 'k', style: { color: 'red' }, dataset: { id: '7' }, onClick: fn, href: 'http://h:1', title: 't' });
  assert.equal(el.className, 'k');
  assert.equal(el.style.color, 'red');
  assert.equal(el.dataset.id, '7');
  assert.deepEqual(el.listeners.click, [fn]);
  assert.equal(el.getAttribute('href'), 'http://h:1');
  assert.equal(el.getAttribute('title'), 't');
});

test('rejects string event handlers and javascript: urls', () => {
  assert.throws(() => h('div', { onclick: 'alert(1)' }), /handler/);
  assert.throws(() => h('a', { href: 'javascript:alert(1)' }), /href/);
  assert.throws(() => h('a', { href: ' JavaScript:alert(1)' }), /href/);
});

test('setChildren replaces content', () => {
  const el = h('ul', null, h('li', null, 'old'));
  setChildren(el, h('li', null, 'new'), 'txt');
  assert.equal(el.textContent, 'newtxt');
});

test('attribute keys are case-insensitive for URL checks', () => {
  assert.throws(() => h('a', { HREF: 'javascript:alert(1)' }), /unsafe url/);
  assert.throws(() => h('a', { Href: 'javascript:alert(1)' }), /unsafe url/);
});

test('href rejects data:, vbscript: and whitespace-prefixed javascript:', () => {
  assert.throws(() => h('a', { href: 'data:text/html,x' }), /unsafe url/);
  assert.throws(() => h('a', { href: 'vbscript:x' }), /unsafe url/);
  assert.throws(() => h('a', { href: '\tjavascript:x' }), /unsafe url/);
  assert.throws(() => h('a', { href: '\njavascript:x' }), /unsafe url/);
});

test('other URL attributes are validated too', () => {
  assert.throws(() => h('img', { src: 'javascript:x' }), /unsafe url/);
  assert.throws(() => h('form', { action: 'javascript:x' }), /unsafe url/);
  assert.throws(() => h('button', { formaction: 'javascript:x' }), /unsafe url/);
});

test('srcdoc is refused', () => {
  assert.throws(() => h('div', { srcdoc: '<p>x</p>' }), /srcdoc/);
});

test('dangerous tags are refused, in any case', () => {
  assert.throws(() => h('script'), /blocked tag/);
  assert.throws(() => h('IFRAME'), /blocked tag/);
});

test('protocol-relative URLs are allowed', () => {
  const el = h('a', { href: '//host' });
  assert.equal(el.getAttribute('href'), '//host');
});

test('srcset, ping and SVG animation attributes are refused', () => {
  for (const k of ['srcset', 'ping', 'attributeName', 'values', 'from', 'to', 'by', 'begin', 'SrcSet']) {
    assert.throws(() => h('img', { [k]: 'x' }), /not allowed/, k);
  }
  assert.throws(() => h('a', { 'xlink:href': 'javascript:x' }), /unsafe url/);
});

test('animation, script and embedding elements are refused', () => {
  for (const t of ['animate', 'set', 'animateTransform', 'animateMotion', 'script', 'iframe', 'object', 'embed', 'foreignObject']) {
    assert.throws(() => h(t), /blocked tag/, t);
  }
});

const mk = k => h('li', { dataset: { k } }, k);
const keyed = (ul, keys, calls = {}) => reconcileKeyed(ul, keys, {
  key: k => k,
  create: k => { (calls.created ||= []).push(k); return mk(k); },
  update: (el, k) => { (calls.updated ||= []).push(k); setText(el, k); }
});

test('reconcileKeyed creates, updates in place, reorders and removes', () => {
  const ul = h('ul');
  const c1 = {};
  keyed(ul, ['a', 'b', 'c'], c1);
  assert.deepEqual(ul.childNodes.map(n => n.textContent), ['a', 'b', 'c']);
  const [a, b, c] = ul.childNodes;
  const c2 = {};
  keyed(ul, ['c', 'a', 'd'], c2);
  assert.deepEqual(ul.childNodes.map(n => n.textContent), ['c', 'a', 'd']);
  assert.equal(ul.childNodes[0], c);              // same node instances survive
  assert.equal(ul.childNodes[1], a);
  assert.equal(b.parentNode, null);               // removed
  assert.deepEqual(c2.created, ['d']);
  assert.deepEqual(c2.updated, ['c', 'a']);
});

test('reconcileKeyed leaves untouched nodes alone when nothing moved', () => {
  const ul = h('ul');
  keyed(ul, ['a', 'b']);
  const moves = [];
  const orig = ul.insertBefore.bind(ul);
  ul.insertBefore = (n, r) => { moves.push(n.textContent); return orig(n, r); };
  keyed(ul, ['a', 'b']);
  assert.deepEqual(moves, []);
});

test('reconcileKeyed tolerates duplicate keys and drops foreign children', () => {
  const ul = h('ul', null, h('li', null, 'stray'));
  keyed(ul, ['a', 'a', 'b']);
  assert.deepEqual(ul.childNodes.map(n => n.textContent), ['a', 'b']);
});

const track = ul => {
  const log = [];
  for (const m of ['insertBefore', 'moveBefore']) {
    const orig = ul[m] && ul[m].bind(ul);
    if (orig) ul[m] = (n, r) => { log.push([m, n.textContent]); return orig(n, r); };
  }
  return log;
};

test('reconcileKeyed moving one item to the end is a single move', () => {
  const ul = h('ul');
  keyed(ul, ['a', 'b', 'c', 'd', 'e']);
  const nodes = [...ul.childNodes];
  const log = track(ul);
  keyed(ul, ['b', 'c', 'd', 'e', 'a']);
  assert.deepEqual(log, [['insertBefore', 'a']]);
  assert.deepEqual(ul.childNodes.map(n => n.textContent), ['b', 'c', 'd', 'e', 'a']);
  assert.deepEqual(ul.childNodes, [nodes[1], nodes[2], nodes[3], nodes[4], nodes[0]]);
});

test('reconcileKeyed reverses a list', () => {
  const ul = h('ul');
  keyed(ul, ['a', 'b', 'c', 'd']);
  const nodes = [...ul.childNodes];
  keyed(ul, ['d', 'c', 'b', 'a']);
  assert.deepEqual(ul.childNodes, nodes.reverse());
});

test('reconcileKeyed removes stale nodes and orders mixed new/kept/moved items', () => {
  const ul = h('ul');
  keyed(ul, ['a', 'b', 'c', 'd', 'e']);
  keyed(ul, ['e', 'x', 'b', 'y', 'a']);
  assert.deepEqual(ul.childNodes.map(n => n.textContent), ['e', 'x', 'b', 'y', 'a']);
  assert.equal(ul.childNodes.length, 5);
});

test('reconcileKeyed prefers moveBefore when present', () => {
  const ul = h('ul');
  ul.moveBefore = (n, r) => Object.getPrototypeOf(ul).insertBefore.call(ul, n, r);
  keyed(ul, ['a', 'b', 'c']);
  const log = track(ul);
  keyed(ul, ['b', 'c', 'a', 'n']);
  assert.deepEqual(log, [['insertBefore', 'n'], ['moveBefore', 'a']]);
  assert.deepEqual(ul.childNodes.map(n => n.textContent), ['b', 'c', 'a', 'n']);
});

test('setText keeps the existing text node when the text is unchanged', () => {
  const el = h('span', null, 'hello');
  const node = el.firstChild;
  setText(el, 'hello');
  assert.equal(el.firstChild, node);
  setText(el, 'bye');
  assert.equal(el.firstChild, node);
  assert.equal(el.textContent, 'bye');
  const empty = h('span');
  setText(empty, 'x');
  assert.equal(empty.textContent, 'x');
});

// ── long press ──
function pressable() {
  mock.timers.enable({ apis: ['setTimeout'] });
  const el = h('button');
  let fired = 0;
  const press = onLongPress(el, () => fired++, { ms: 500 });
  return { el, press, fired: () => fired };
}
afterEach(() => mock.timers.reset());

test('a touch held for the delay fires once and swallows the click that follows', () => {
  const { el, press, fired } = pressable();
  el.fire('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
  mock.timers.tick(499);
  assert.equal(fired(), 0);
  mock.timers.tick(1);
  assert.equal(fired(), 1);
  el.fire('pointerup', { pointerType: 'touch' });
  assert.equal(press.took(), true, 'the click after a long press is consumed');
  assert.equal(press.took(), false, 'only once');
});

test('a short tap is an ordinary click', () => {
  const { el, press, fired } = pressable();
  el.fire('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
  mock.timers.tick(200);
  el.fire('pointerup', { pointerType: 'touch' });
  mock.timers.tick(1000);
  assert.equal(fired(), 0);
  assert.equal(press.took(), false);
});

test('moving the finger or a cancelled pointer abandons the long press', () => {
  const { el, fired } = pressable();
  el.fire('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
  el.fire('pointermove', { pointerType: 'touch', clientX: 40, clientY: 10 });
  mock.timers.tick(1000);
  el.fire('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
  el.fire('pointercancel', { pointerType: 'touch' });
  mock.timers.tick(1000);
  assert.equal(fired(), 0);
});

test('a mouse held down is not a long press (Shift+click covers it)', () => {
  const { el, fired } = pressable();
  el.fire('pointerdown', { pointerType: 'mouse', clientX: 10, clientY: 10 });
  mock.timers.tick(1000);
  assert.equal(fired(), 0);
});

test('a long press suppresses the context menu (iOS/Android callout)', () => {
  const { el } = pressable();
  let prevented = false;
  el.fire('pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 });
  el.fire('contextmenu', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});
