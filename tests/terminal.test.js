import { test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { mountTerminal } from '../www/js/terminal.js';

let dom, sockets, fetches, rafs, resolvers, page;

class FakeWS {
  static OPEN = 1;
  constructor(url, protocols) {
    this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; this.closed = false; this.protocol = 'tty';
    sockets.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen(); }
  message(text) { this.onmessage({ data: new TextEncoder().encode('0' + text).buffer }); }
}

// The terminal's token/WS/resize timeouts run on mocked timers: a superseded connect() leaves its 10 s token
// timer armed, and a real one would hold the test process open after the last test.
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  dom = installFakeDom();
  sockets = []; fetches = 0; rafs = []; resolvers = [];
  const ids = ['term-out:pre', 'term-shell', 'term-panel', 'term-scrim', 'term-session', 'term-dot', 'term-label', 'term-overlay',
    'term-overlay-reason', 'term-body', 'term-reconnect:button', 'term-overlay-btn:button', 'term-clear:button', 'term-fs:button', 'term-grab', 'term-keys', 'term-input:textarea'];
  page = {};
  for (const spec of ids) { const [id, tag] = spec.split(':'); page[id] = dom.page(id, tag || 'div'); }
  page['term-out'].focus = () => { page['term-out'].focused = true; };
  const title = document.createElement('div');
  page['term-overlay'].querySelector = () => title;
  Object.assign(globalThis, {
    WebSocket: FakeWS,
    location: { protocol: 'https:', host: 'h.ts.net' },
    window: { addEventListener() {} },
    getSelection: () => '',
    requestAnimationFrame: f => { rafs.push(f); return rafs.length; },
    fetch: () => { fetches++; return new Promise(r => resolvers.push(r)); }
  });
});

afterEach(() => mock.timers.reset());
after(() => {
  // a future leak (an unmocked timer, an interval) fails here instead of silently stalling the suite
  const live = process.getActiveResourcesInfo().filter(r => r === 'Timeout' || r === 'Immediate');
  assert.deepEqual(live, [], 'terminal tests left live timers behind');
});

const tokenOk = () => ({ ok: true, status: 200, json: async () => ({ token: 'tok' }) });
const tick = () => new Promise(r => setImmediate(r));

test('two quick Reconnect clicks leave exactly one live socket, and a stale one is closed', async () => {
  mountTerminal();                       // mount's own connect() = fetch #1
  page['term-reconnect'].fire('click'); // fetch #2
  page['term-overlay-btn'].fire('click'); // fetch #3
  assert.equal(fetches, 3);
  resolvers.forEach(r => r(tokenOk()));  // all three token fetches resolve
  await tick(); await tick();
  assert.equal(sockets.length, 1, 'only the latest connect() may create a socket');
  assert.equal(sockets.filter(s => !s.closed).length, 1);
});

test('a stale socket opening late does not change status or steal focus', async () => {
  mountTerminal();
  resolvers[0](tokenOk());
  await tick(); await tick();
  const stale = sockets[0];
  page['term-reconnect'].fire('click');            // supersedes it
  assert.equal(stale.closed, true);
  page['term-out'].focused = false;
  const label = page['term-label'].textContent;
  stale.open();
  assert.equal(page['term-label'].textContent, label);
  assert.equal(page['term-out'].focused, false);
  assert.equal(stale.sent.length, 0, 'no handshake on a stale socket');
});

test('a stale in-flight token response is discarded', async () => {
  mountTerminal();
  page['term-reconnect'].fire('click');
  resolvers[0](tokenOk());                // the superseded request answers first
  await tick(); await tick();
  assert.equal(sockets.length, 0);
  resolvers[1](tokenOk());
  await tick(); await tick();
  assert.equal(sockets.length, 1);
});

test('Reconnect is disabled while connecting and enabled again afterwards', async () => {
  mountTerminal();
  assert.equal(page['term-reconnect'].disabled, true);
  resolvers[0](tokenOk());
  await tick(); await tick();
  assert.equal(page['term-reconnect'].disabled, true, 'still connecting until the socket opens');
  sockets[0].open();
  assert.equal(page['term-reconnect'].disabled, false);
  assert.equal(page['term-out'].focused, true);
});

test('many WS messages in one frame cause a single paint', async () => {
  mountTerminal();
  resolvers[0](tokenOk());
  await tick(); await tick();
  sockets[0].open();
  rafs.length = 0;
  for (let i = 0; i < 50; i++) sockets[0].message('line ' + i + '\r\n');
  assert.equal(rafs.length, 1, 'one animation frame requested');
  rafs.shift()();
  assert.ok(page['term-out'].textContent.includes('line 49'));
  sockets[0].message('more');
  assert.equal(rafs.length, 1, 'next frame can be requested again');
});

async function openTerminal() {
  mountTerminal();
  resolvers[0](tokenOk());
  await tick(); await tick();
  sockets[0].open();
  rafs.length = 0;
}
const flush = () => { while (rafs.length) rafs.shift()(); };
const spans = () => page['term-out'].childNodes.filter(n => n.tagName === 'SPAN' && n.className !== 'term-cursor');

test('coloured output renders as spans built from text, never markup', async () => {
  await openTerminal();
  sockets[0].message('\x1b[31m<img src=x onerror=alert(1)>\x1b[0m plain');
  flush();
  const kids = page['term-out'].childNodes;
  assert.equal(kids[0].tagName, 'SPAN'); assert.equal(kids[0].className, 'fg-1');
  assert.equal(kids[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(kids[1].textContent, ' plain');
  assert.equal(kids[1].nodeType, 3, 'unstyled text is a bare text node');
  assert.equal(dom.created.filter(e => e.tagName === 'IMG').length, 0);
  assert.equal(Object.keys(kids[0].style).length, 0, 'palette colours come from classes only');
});

test('256-colour and truecolor go through style.color', async () => {
  await openTerminal();
  sockets[0].message('\x1b[38;2;1;2;3mX\x1b[48;5;196mY');
  flush();
  const [x, y] = spans();
  assert.equal(x.textContent, 'X'); assert.equal(x.style.color, '#010203');
  assert.equal(x.getAttribute('style'), null, 'never a style attribute string');
  assert.equal(y.textContent, 'Y'); assert.equal(y.style.color, '#010203'); assert.equal(y.style.backgroundColor, '#ff0000');
  assert.equal(x.className, '', 'no class attribute for a style with only inline colours');
});

test('attributes map to t-* classes, combined with palette classes', async () => {
  await openTerminal();
  sockets[0].message('\x1b[1;3;4;2;92mA\x1b[0m');
  flush();
  const [a] = spans();
  assert.deepEqual(a.className.split(' ').sort(), ['fg-10', 't-b', 't-d', 't-i', 't-u']);
});

test('the cursor sits between the styled runs before and after it', async () => {
  await openTerminal();
  sockets[0].message('\x1b[32mab\x1b[0mcd\x1b[2D');
  flush();
  const kids = page['term-out'].childNodes;
  const at = kids.findIndex(n => n.className === 'term-cursor');
  assert.equal(kids.slice(0, at).map(n => n.textContent).join(''), 'ab');
  assert.equal(kids.slice(at + 1).map(n => n.textContent).join(''), 'cd');
});

test('a frame with more runs than one spread call can take still paints every run', async () => {
  await openTerminal();
  const line = '\x1b[31ma\x1b[32mb'.repeat(2000);  // lines clamp at 4096 cells, so 3 lines of 4000 runs
  sockets[0].message([line, line, line].join('\r\n'));
  flush();
  assert.equal(spans().length, 12000);
  assert.equal(page['term-out'].textContent, Array(3).fill('ab'.repeat(2000)).join('\n'));
});

// ── on-screen key bar and the touch keyboard input ──
const keyBtn = key => page['term-keys'].childNodes.find(b => b.dataset.key === key);
const typed = () => sockets[0].sent.slice(1).map(d => d.slice(1)); // drop the handshake and the '0' input prefix

test('the key bar is built from text and labelled buttons', async () => {
  await openTerminal();
  const btns = page['term-keys'].childNodes;
  assert.deepEqual(btns.map(b => b.textContent), ['Esc', 'Tab', 'Ctrl', '←', '↑', '↓', '→', '⌫']);
  for (const b of btns) {
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.getAttribute('type'), 'button');
    assert.ok(b.getAttribute('aria-label'));
  }
  assert.equal(keyBtn('Control').getAttribute('aria-pressed'), 'false');
});

test('key-bar keys send the physical key sequences', async () => {
  await openTerminal();
  for (const k of ['Escape', 'Tab', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']) keyBtn(k).fire('click');
  assert.deepEqual(typed(), ['\x1b', '\t', '\x1b[D', '\x1b[A', '\x1b[B', '\x1b[C']);
});

test('pressing a key-bar button does not take focus from the terminal', async () => {
  await openTerminal();
  let prevented = 0;
  const ev = { preventDefault() { prevented++; } };
  page['term-keys'].fire('pointerdown', ev);
  page['term-keys'].fire('mousedown', ev);
  assert.equal(prevented, 2);
});

test('Ctrl latches for the next key, then releases', async () => {
  await openTerminal();
  keyBtn('Control').fire('click');
  assert.equal(keyBtn('Control').getAttribute('aria-pressed'), 'true');
  page['term-out'].fire('keydown', { key: 'c' });
  assert.equal(keyBtn('Control').getAttribute('aria-pressed'), 'false');
  page['term-out'].fire('keydown', { key: 'c' });
  assert.deepEqual(typed(), ['\x03', 'c']);
});

test('Ctrl pressed again unlatches without sending anything', async () => {
  await openTerminal();
  keyBtn('Control').fire('click');
  keyBtn('Control').fire('click');
  assert.equal(keyBtn('Control').getAttribute('aria-pressed'), 'false');
  page['term-out'].fire('keydown', { key: 'c' });
  assert.deepEqual(typed(), ['c']);
});

test('a latched Ctrl applies to key-bar arrows too', async () => {
  await openTerminal();
  keyBtn('Control').fire('click');
  keyBtn('ArrowLeft').fire('click');
  assert.deepEqual(typed(), ['\x1b[1;5D']);
});

// The hidden input always holds one sentinel character, so a soft-keyboard Backspace on an "empty" field
// still has something to delete and raises an input event. `soft` mimics the browser: it sets the new value,
// then fires the input event.
const soft = (input, value, ev) => { input.value = value; input.fire('input', { isComposing: false, data: null, ...ev }); };

test('the hidden input holds a single sentinel character and nothing typed', async () => {
  await openTerminal();
  const S = page['term-input'].value;
  assert.equal([...S].length, 1, 'one sentinel character');
  assert.doesNotMatch(S, /[\x21-\x7e]/, 'the sentinel is not a printable ASCII character a person could type');
});

test('soft-keyboard text arrives through the hidden input and honours the latch', async () => {
  await openTerminal();
  const input = page['term-input'];
  const S = input.value;
  soft(input, S + 'l', { inputType: 'insertText', data: 'l' });
  assert.equal(input.value, S, 'the input is back to the sentinel after every send');
  keyBtn('Control').fire('click');
  soft(input, S + 'd', { inputType: 'insertText', data: 'd' });
  soft(input, S + '\n', { inputType: 'insertLineBreak' });
  assert.equal(input.value, S);
  assert.deepEqual(typed(), ['l', '\x04', '\r']);
});

test('IME composition is sent once, as the committed word, when composition ends', async () => {
  await openTerminal();
  const input = page['term-input'];
  const S = input.value;
  input.fire('compositionstart', { data: '' });
  soft(input, S + 'h', { inputType: 'insertCompositionText', data: 'h', isComposing: true });
  soft(input, S + 'he', { inputType: 'insertCompositionText', data: 'he', isComposing: true });
  soft(input, S + 'hel', { inputType: 'insertCompositionText', data: 'hel', isComposing: true });
  soft(input, S + 'he', { inputType: 'deleteContentBackward', isComposing: true }); // backspace inside the composition
  assert.deepEqual(typed(), [], 'nothing is sent mid-composition');
  input.fire('compositionend', { data: 'he' });
  assert.deepEqual(typed(), ['he']);
  assert.equal(input.value, S, 'the committed word does not linger in the input');
  // WebKit fires a trailing non-composing input after compositionend; it must not send the word again
  soft(input, input.value, { inputType: 'insertFromComposition', data: 'he' });
  assert.deepEqual(typed(), ['he']);
});

test('an insertCompositionText event without isComposing is still held until compositionend', async () => {
  await openTerminal();
  const input = page['term-input'];
  const S = input.value;
  input.fire('compositionstart', { data: '' });
  soft(input, S + 'ok', { inputType: 'insertCompositionText', data: 'ok' });
  assert.deepEqual(typed(), []);
  input.fire('compositionend', { data: 'ok' });
  assert.deepEqual(typed(), ['ok']);
});

test('soft-keyboard Backspace on an empty line deletes the sentinel and sends DEL, every time', async () => {
  await openTerminal();
  const input = page['term-input'];
  const S = input.value;
  soft(input, '', { inputType: 'deleteContentBackward' });
  assert.equal(input.value, S, 'the sentinel is put back');
  soft(input, '', { inputType: 'deleteContentBackward' });
  soft(input, '', { inputType: 'deleteWordBackward' });
  soft(input, '', { inputType: 'deleteContentForward' });
  assert.deepEqual(typed(), ['\x7f', '\x7f', '\x17', '\x1b[3~']);
});

test('a Backspace keydown whose edit the keyboard applies anyway is sent once', async () => {
  // Android ignores preventDefault on keydown for IME edits: the keydown and the delete input both arrive.
  await openTerminal();
  const input = page['term-input'];
  input.fire('keydown', { key: 'Backspace', keyCode: 8 });
  soft(input, '', { inputType: 'deleteContentBackward' });
  input.fire('keyup', { key: 'Backspace', keyCode: 8 });
  assert.deepEqual(typed(), ['\x7f']);
  assert.equal(input.value.length, 1, 'the sentinel is restored');
  soft(input, '', { inputType: 'deleteContentBackward' });
  assert.deepEqual(typed(), ['\x7f', '\x7f'], 'the next soft Backspace is not swallowed');
});

test('keydowns that belong to an IME (isComposing, keyCode 229) are not routed through keyToSeq', async () => {
  await openTerminal();
  const input = page['term-input'];
  let prevented = 0;
  input.fire('keydown', { key: 'Enter', isComposing: true, preventDefault() { prevented++; } });
  input.fire('keydown', { key: 'Unidentified', keyCode: 229, preventDefault() { prevented++; } });
  input.fire('keydown', { key: 'Backspace', keyCode: 229, preventDefault() { prevented++; } });
  assert.equal(prevented, 0);
  assert.deepEqual(typed(), []);
});

test('the key bar has a Backspace key that sends DEL', async () => {
  await openTerminal();
  keyBtn('Backspace').fire('click');
  assert.deepEqual(typed(), ['\x7f']);
});

test('token fetch aborts after 10 s now that no password prompt can be pending', () => {
  const delays = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { delays.push(ms); return real(fn, ms, ...a); };
  try { mountTerminal(); } finally { globalThis.setTimeout = real; }
  assert.equal(fetches, 1);
  assert.ok(delays.includes(10_000), 'token abort timer armed at 10 s, got ' + JSON.stringify(delays));
  assert.ok(!delays.includes(120_000));
});

test('a 401 token response shows wording for the in-terminal login, not a browser password popup', async () => {
  mountTerminal();
  resolvers[0]({ ok: false, status: 401, json: async () => ({}) });
  await tick(); await tick();
  const reason = page['term-overlay-reason'].textContent;
  assert.ok(reason.length > 0);
  assert.doesNotMatch(reason, /cancel|password/i);
  assert.match(reason, /sign in|reload/i);
  assert.equal(sockets.length, 0);
});

test('special keys typed into the hidden input go through keyToSeq', async () => {
  await openTerminal();
  let prevented = false;
  page['term-input'].fire('keydown', { key: 'Backspace', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(typed(), ['\x7f']);
});

test('the scrollbar gutter is always reserved, so the column count never changes when output starts to scroll', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../www/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.term-out\s*\{[^}]*\}/)[0];
  assert.match(rule, /scrollbar-gutter:\s*stable/);
});

test('a change in the output box size (not just a window resize) tells the shell the new size, once', async () => {
  let observed = null, cb = null;
  globalThis.ResizeObserver = class { constructor(f) { cb = f; } observe(el) { observed = el; } disconnect() {} };
  try {
    const out = page['term-out'];
    out.clientWidth = 1000; out.clientHeight = 400;
    await openTerminal();
    assert.equal(observed, out);
    const resizes = () => sockets[0].sent.filter(d => typeof d === 'string' && d.startsWith('1{'));
    cb([]);                                   // same size as the handshake: nothing to send
    assert.deepEqual(resizes(), []);
    out.clientWidth = 600;
    cb([]);
    assert.equal(resizes().length, 1);
    const { columns } = JSON.parse(resizes()[0].slice(1));
    assert.ok(columns < 100, 'narrower box, fewer columns: ' + columns);
    cb([]);                                   // unchanged since: no duplicate
    assert.equal(resizes().length, 1);
  } finally { delete globalThis.ResizeObserver; }
});

test('the cursor overlays its cell instead of taking one, so a full-width line (the prompt time) never wraps', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../www/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.term-cursor\s*\{[^}]*\}/)[0];
  assert.match(rule, /width:\s*1ch/);           // one cell of the terminal's own font, at any font size
  assert.match(rule, /margin-right:\s*-1ch/);   // and zero net advance: the text after it does not move
});

test('the hidden ruler that measures a character cell reserves no scrollbar gutter (it would inflate the cell)', () => {
  mountTerminal();
  const ruler = page['term-body'].childNodes.find(n => n.tagName === 'PRE');
  assert.ok(ruler, 'ruler mounted');
  assert.equal(ruler.style.scrollbarGutter, 'auto');
});

test('the session label is set from the server settings, as plain text', () => {
  const term = mountTerminal();
  assert.equal(page['term-session'].textContent, '—');
  term.setSession('ann@box');
  assert.equal(page['term-session'].textContent, 'ann@box');
  term.setSession(null);
  assert.equal(page['term-session'].textContent, '—');
});
