import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { h } from '../www/js/dom.js';
import { COLORS } from '../www/js/format.js';
import { createGesture, indexAtPoint, mountReorder, flip, createTile, updateTile } from '../www/js/quicklaunch-view.js';

test('mouse and pen drags start only after 6 px', () => {
  for (const type of ['mouse', 'pen']) {
    const g = createGesture();
    assert.equal(g.down(type, 0, 0, 0), 'none');
    assert.equal(g.move(5, 0, 10), 'none');
    assert.equal(g.move(6, 0, 20), 'start');
    assert.equal(g.dragging, true);
  }
});

test('touch on the handle starts at once (no long-press); up resets', () => {
  const g = createGesture();
  assert.equal(g.down('touch', 0, 0, 0), 'start');
  assert.equal(g.dragging, true);
  assert.equal(g.move(30, 0, 5), 'none');
  g.up();
  assert.equal(g.dragging, false);
  assert.equal(g.move(50, 0, 6), 'none');
});

test('indexAtPoint picks the nearest tile centre', () => {
  const r = (l, t) => ({ left: l, top: t, width: 100, height: 50 });
  const rects = [r(0, 0), r(110, 0), r(220, 0), r(0, 60), r(110, 60)];
  assert.equal(indexAtPoint(rects, 20, 95), 3);
  assert.equal(indexAtPoint(rects, 500, 0), 2);
  assert.equal(indexAtPoint([], 0, 0), -1);
});

const T = (id, over = {}) => ({ id, name: id.toUpperCase(), desc: 'd', port: 80, url: 'http://h', note: null,
  dot: COLORS.healthy, statusText: 'running', ...over });
const handleOf = tile => tile.childNodes[0].childNodes.find(n => n.classList?.contains('ql-handle'));
const ids = grid => grid.childNodes.map(n => n.dataset.id);

function setup() {
  installFakeDom();
  const grid = h('div', { class: 'services' });
  const tiles = ['a', 'b', 'c'].map(id => grid.appendChild(createTile(T(id))));
  const commits = [], announced = [];
  const reorder = mountReorder(grid, {
    ids: () => ids(grid),
    nameOf: id => id.toUpperCase(),
    commit: list => commits.push(list),
    announce: t => announced.push(t)
  });
  return { grid, tiles, commits, announced, reorder };
}

test('every tile has a real reorder button with an aria-label naming the tile', () => {
  const { tiles } = setup();
  for (const tile of tiles) {
    const hd = handleOf(tile);
    assert.ok(hd, 'handle exists');
    assert.equal(hd.tagName, 'BUTTON');
    assert.equal(hd.getAttribute('type'), 'button');
    assert.equal(hd.getAttribute('aria-label'), 'Reorder ' + tile.dataset.id.toUpperCase());
  }
  assert.equal(tiles[0].getAttribute('tabindex'), null, 'the handle, not the tile, is the focus target');
  updateTile(tiles[0], T('a', { name: 'Renamed' }));
  assert.equal(handleOf(tiles[0]).getAttribute('aria-label'), 'Reorder Renamed');
});

test('a tile without a URL shows its note instead of OPEN, and gains OPEN when a port appears', () => {
  installFakeDom();
  const el = createTile(T('x', { url: null, port: null, note: 'no web port' }));
  const foot = el.childNodes[2];
  assert.equal(foot.childNodes[0].className, 'no-port');
  assert.equal(foot.childNodes[0].textContent, 'no web port');
  assert.equal(el.childNodes[0].textContent.includes(':'), false);
  updateTile(el, T('x', { url: 'http://h:81', port: 81 }));
  assert.equal(foot.childNodes[0].className, 'open-btn');
  assert.equal(foot.childNodes[0].getAttribute('href'), 'http://h:81');
});

test('Alt+Arrow on the handle moves the tile, commits and announces', () => {
  const { grid, tiles: [a], commits, announced, reorder } = setup();
  grid.fire('keydown', { target: handleOf(a), altKey: true, key: 'ArrowRight' });
  assert.deepEqual(commits, [['b', 'a', 'c']]);
  assert.deepEqual(announced, ['Moved A to position 2 of 3']);
  assert.equal(reorder.dragging(), false);
  grid.fire('keydown', { target: handleOf(a), key: 'ArrowRight' });
  assert.equal(commits.length, 1);
});

function layout(grid) {
  grid.childNodes.forEach((el, i) => Object.assign(el, { offsetLeft: i * 110, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 }));
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 330, height: 50 });
}
const P = (target, x, y, over = {}) => ({ target, pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, pageX: x, pageY: y, ...over });

test('a pointerdown on the tile body never starts a drag', () => {
  for (const pointerType of ['mouse', 'touch']) {
    const { grid, tiles: [a], commits, reorder } = setup();
    layout(grid);
    const body = a.childNodes[1]; // the description
    grid.fire('pointerdown', P(body, 50, 25, { pointerType }));
    grid.fire('pointermove', P(body, 270, 25, { pointerType }));
    assert.equal(reorder.dragging(), false);
    assert.equal(a.classList.contains('lifted'), false);
    assert.deepEqual(ids(grid), ['a', 'b', 'c']);
    grid.fire('pointerup', P(body, 270, 25, { pointerType }));
    assert.equal(commits.length, 0);
  }
});

test('touch on the handle lifts the tile immediately', () => {
  const { grid, tiles: [a], reorder } = setup();
  layout(grid);
  grid.fire('pointerdown', P(handleOf(a), 90, 10, { pointerType: 'touch' }));
  assert.equal(reorder.dragging(), true);
  assert.equal(a.classList.contains('lifted'), true);
});

test('mouse drag from the handle reorders, commits on drop and swallows the click', () => {
  const { grid, tiles: [a], commits, announced, reorder } = setup();
  layout(grid);
  const hd = handleOf(a);
  grid.fire('pointerdown', P(hd, 50, 25));
  grid.fire('pointermove', P(hd, 53, 25));
  assert.equal(reorder.dragging(), false, 'below the 6 px threshold');
  grid.fire('pointermove', P(hd, 60, 25));
  assert.equal(reorder.dragging(), true);
  assert.equal(a.classList.contains('lifted'), true);
  assert.deepEqual(ids(grid), ['a', 'b', 'c'], 'a small move never reorders');
  grid.fire('pointermove', P(hd, 270, 25));
  assert.deepEqual(ids(grid), ['b', 'c', 'a']);
  grid.fire('pointerup', P(hd, 270, 25));
  assert.equal(reorder.dragging(), false);
  assert.equal(a.classList.contains('lifted'), false);
  assert.deepEqual(commits, [['b', 'c', 'a']]);
  assert.deepEqual(announced, ['Moved A to position 3 of 3']);
  let stopped = false;
  grid.fire('click', { target: hd, detail: 1, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});

test('pointercancel during a drag restores the original order without committing', () => {
  const { grid, tiles: [a], commits } = setup();
  layout(grid);
  grid.fire('pointerdown', P(handleOf(a), 50, 25));
  grid.fire('pointermove', P(handleOf(a), 270, 25));
  assert.deepEqual(ids(grid), ['b', 'c', 'a']);
  grid.fire('pointercancel', P(handleOf(a), 270, 25));
  assert.deepEqual(ids(grid), ['a', 'b', 'c']);
  assert.equal(commits.length, 0);
});

test('a plain mouse click on the handle neither drags nor picks up', () => {
  const { grid, tiles: [a], commits, reorder } = setup();
  layout(grid);
  grid.fire('pointerdown', P(handleOf(a), 50, 25));
  grid.fire('pointerup', P(handleOf(a), 50, 25));
  grid.fire('click', { target: handleOf(a), detail: 1 });
  assert.equal(reorder.dragging(), false);
  assert.equal(commits.length, 0);
});

test('keyboard: Space/Enter picks up, arrows move, Space/Enter drops and commits once', () => {
  const { grid, tiles: [a], commits, announced, reorder } = setup();
  layout(grid);
  const hd = handleOf(a);
  grid.fire('click', { target: hd, detail: 0 }); // what Space/Enter (and screen readers) dispatch on a button
  assert.equal(reorder.dragging(), true);
  assert.equal(hd.getAttribute('aria-pressed'), 'true');
  assert.match(announced.at(-1), /^Picked up A, position 1 of 3/);
  grid.fire('keydown', { target: hd, key: 'ArrowRight' });
  assert.deepEqual(ids(grid), ['b', 'a', 'c']);
  assert.equal(announced.at(-1), 'Moved A to position 2 of 3');
  grid.fire('keydown', { target: hd, key: 'End' });
  assert.deepEqual(ids(grid), ['b', 'c', 'a']);
  assert.equal(commits.length, 0, 'nothing is saved until the drop');
  grid.fire('click', { target: hd, detail: 0 });
  assert.equal(reorder.dragging(), false);
  assert.equal(hd.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(commits, [['b', 'c', 'a']]);
  assert.equal(announced.at(-1), 'Dropped A at position 3 of 3');
});

test('keyboard: Escape cancels a pick-up and restores the order', () => {
  const { grid, tiles: [, b], commits, announced, reorder } = setup();
  layout(grid);
  const hd = handleOf(b);
  grid.fire('click', { target: hd, detail: 0 });
  grid.fire('keydown', { target: hd, key: 'Home' });
  assert.deepEqual(ids(grid), ['b', 'a', 'c']);
  grid.fire('keydown', { target: hd, key: 'Escape' });
  assert.deepEqual(ids(grid), ['a', 'b', 'c']);
  assert.equal(reorder.dragging(), false);
  assert.equal(commits.length, 0);
  assert.equal(announced.at(-1), 'Cancelled. B is back at position 2 of 3');
});

test('flip with reduceMotion just runs the mutation', () => {
  const { grid, tiles: [a, b] } = setup();
  flip(grid, () => grid.insertBefore(b, a), { reduceMotion: true });
  assert.deepEqual(ids(grid), ['b', 'a', 'c']);
  assert.equal(a.style.transform ?? '', '');
});

// ── hardening round ──
import { deferWhile, createAnnouncer } from '../www/js/quicklaunch-view.js';

function setupWith(extra = {}) {
  installFakeDom();
  const grid = h('div', { class: 'services' });
  ['a', 'b', 'c'].forEach(id => grid.appendChild(createTile(T(id))));
  const commits = [], announced = [];
  const reorder = mountReorder(grid, {
    ids: () => ids(grid), nameOf: id => id.toUpperCase(),
    commit: list => commits.push(list), announce: t => announced.push(t), ...extra
  });
  layout(grid);
  return { grid, tiles: grid.childNodes.slice(), commits, announced, reorder };
}

test('a second pointer is ignored while the first one drags', () => {
  const { grid, tiles: [a, b], commits, reorder } = setupWith();
  grid.fire('pointerdown', P(handleOf(a), 50, 25));
  grid.fire('pointermove', P(handleOf(a), 60, 25));
  assert.equal(reorder.dragging(), true);
  grid.fire('pointerdown', P(handleOf(b), 160, 25, { pointerId: 2 }));
  grid.fire('pointermove', P(handleOf(b), 270, 25, { pointerId: 2 }));
  assert.deepEqual(ids(grid), ['a', 'b', 'c']);
  grid.fire('pointerup', P(handleOf(b), 270, 25, { pointerId: 2 }));
  assert.equal(reorder.dragging(), true, 'the other pointer cannot end the drag');
  assert.equal(b.classList.contains('lifted'), false);
  grid.fire('pointerup', P(handleOf(a), 60, 25));
  assert.equal(reorder.dragging(), false);
  assert.equal(commits.length, 0);
});

test('lostpointercapture mid-drag restores the order without committing', () => {
  const { grid, tiles: [a], commits, reorder } = setupWith();
  grid.fire('pointerdown', P(handleOf(a), 50, 25));
  grid.fire('pointermove', P(handleOf(a), 270, 25));
  assert.deepEqual(ids(grid), ['b', 'c', 'a']);
  grid.fire('lostpointercapture', { target: handleOf(a), pointerId: 1 });
  assert.deepEqual(ids(grid), ['a', 'b', 'c']);
  assert.equal(reorder.dragging(), false);
  assert.equal(a.classList.contains('lifted'), false);
  assert.equal(commits.length, 0);
});

test('window blur mid-drag restores the order without committing', () => {
  installFakeDom();
  const win = h('div');
  const { grid, tiles: [a], commits, reorder } = setupWith({ win });
  grid.fire('pointerdown', P(handleOf(a), 50, 25));
  grid.fire('pointermove', P(handleOf(a), 270, 25));
  win.fire('blur');
  assert.deepEqual(ids(grid), ['a', 'b', 'c']);
  assert.equal(reorder.dragging(), false);
  assert.equal(commits.length, 0);
});

test('a render that arrives mid-drag is deferred and flushed once the drag ends', () => {
  for (const end of ['drop', 'cancel', 'keyboard-noop']) {
    let reorder, renders = 0;
    const render = deferWhile(() => reorder.dragging(), () => { renders++; });
    const s = setupWith({ onIdle: () => render.flush() });
    reorder = s.reorder;
    const { grid, tiles: [a] } = s;
    if (end === 'keyboard-noop') grid.fire('click', { target: handleOf(a), detail: 0 });
    else { grid.fire('pointerdown', P(handleOf(a), 50, 25)); grid.fire('pointermove', P(handleOf(a), 270, 25)); }
    assert.equal(render.run(), false, end);
    assert.equal(renders, 0, end);
    if (end === 'drop') grid.fire('pointerup', P(handleOf(a), 270, 25));
    else if (end === 'cancel') grid.fire('pointercancel', P(handleOf(a), 270, 25));
    else grid.fire('click', { target: handleOf(a), detail: 0 });
    assert.equal(renders, 1, end);
    render.flush();
    assert.equal(renders, 1, end + ': flush without a pending render is a no-op');
  }
});

test('a keyboard move at an edge says so', () => {
  const { grid, tiles: [a, , c], announced } = setupWith();
  grid.fire('click', { target: handleOf(a), detail: 0 });
  grid.fire('keydown', { target: handleOf(a), key: 'ArrowLeft' });
  assert.equal(announced.at(-1), 'A is already first');
  grid.fire('keydown', { target: handleOf(a), key: 'Escape' });
  grid.fire('keydown', { target: handleOf(c), altKey: true, key: 'End' });
  assert.equal(announced.at(-1), 'C is already last');
});

test('announcer clears the region first, so identical text is announced again', () => {
  installFakeDom();
  const region = h('div');
  const queue = [];
  const announce = createAnnouncer(region, { defer: fn => queue.push(fn) });
  const seen = [];
  for (let i = 0; i < 2; i++) {
    announce('Order reset');
    seen.push(region.textContent);
    queue.shift()();
    seen.push(region.textContent);
  }
  assert.deepEqual(seen, ['', 'Order reset', '', 'Order reset']);
  announce('one'); announce('two');
  queue.splice(0).forEach(fn => fn());
  assert.equal(region.textContent, 'two', 'only the latest message lands');
});

test('help text is referenced once from the grid, not from every handle', () => {
  const { grid, tiles } = setupWith({ helpId: 'ql-help' });
  assert.equal(grid.getAttribute('aria-describedby'), 'ql-help');
  for (const t of tiles) assert.equal(handleOf(t).getAttribute('aria-describedby'), null);
});

test('dragstart is cancelled only on the handle, so the OPEN link stays draggable', () => {
  const { grid, tiles: [a] } = setupWith();
  const fire = target => { let prevented = false; grid.fire('dragstart', { target, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(fire(handleOf(a)), true);
  const open = a.childNodes[2].childNodes[0];
  assert.equal(open.className, 'open-btn');
  assert.equal(fire(open), false);
});

test('the dragged / picked-up tile is never detached (detaching drops pointer capture and focus)', () => {
  const { grid, tiles: [a, , c], commits } = setupWith();
  const moved = [];
  const ins = grid.insertBefore.bind(grid);
  grid.insertBefore = (n, ref) => { moved.push(n.dataset.id); return ins(n, ref); };
  grid.fire('pointerdown', P(handleOf(a), 50, 25));
  grid.fire('pointermove', P(handleOf(a), 270, 25));
  assert.deepEqual(ids(grid), ['b', 'c', 'a']);
  assert.equal(moved.includes('a'), false, 'pointer drag moved the neighbours, not the dragged tile');
  layout(grid); // the fake DOM has no layout engine: re-assign offsets for the new order
  grid.fire('pointermove', P(handleOf(a), 50, 25));
  assert.deepEqual(ids(grid), ['a', 'b', 'c']);
  assert.equal(moved.includes('a'), false);
  grid.fire('pointerup', P(handleOf(a), 50, 25));
  assert.equal(commits.length, 0);
  moved.length = 0;
  grid.fire('click', { target: handleOf(c), detail: 0 });
  grid.fire('keydown', { target: handleOf(c), key: 'Home' });
  assert.deepEqual(ids(grid), ['c', 'a', 'b']);
  assert.equal(moved.includes('c'), false, 'keyboard move kept the focused tile in place');
});

test('a long description keeps its full text in a title, since CSS clamps it to two lines', () => {
  installFakeDom();
  const img = 'ghcr.io/example/some-very-long-container-image-name-without-spaces:2026.11.06-amd64';
  const tile = createTile(T('x', { desc: img }));
  const desc = tile.childNodes[1];
  assert.equal(desc.textContent, img);
  assert.equal(desc.getAttribute('title'), img);
  updateTile(tile, T('x', { desc: 'short' }));
  assert.equal(desc.getAttribute('title'), 'short');
});
