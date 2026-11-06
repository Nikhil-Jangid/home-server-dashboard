import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVt, xterm256, runAttrs, charWidth, cellFromRect, gridSize, DEFAULT_CELL, keyToSeq, encodeInput, decodeFrame, resizeMessage, handshake } from '../www/js/vt.js';

test('CRLF keeps line content (prototype bug)', () => {
  const vt = createVt();
  vt.write('hello\r\nworld\r\n$ ');
  assert.equal(vt.text(), 'hello\nworld\n$ ');
});

test('bare CR overwrites from column 0', () => {
  const vt = createVt();
  vt.write('progress 10%\rprogress 99%');
  assert.equal(vt.text(), 'progress 99%');
});

test('backspace + erase-to-end edits the line', () => {
  const vt = createVt();
  vt.write('$ lss\b\x1b[K');
  assert.equal(vt.text(), '$ ls');
});

test('readline cursor-left then delete-char', () => {
  const vt = createVt();
  vt.write('$ abcd\x1b[2D\x1b[P');
  assert.equal(vt.text(), '$ abd');
  assert.deepEqual(vt.snapshot(), { before: '$ ab', after: 'd' });
});

test('SGR colours and OSC titles are stripped', () => {
  const vt = createVt();
  vt.write('\x1b]0;user@host: ~\x07\x1b[01;32muser@host\x1b[00m:\x1b[01;34m~\x1b[00m$ ');
  assert.equal(vt.text(), 'user@host:~$ ');
});

test('charset escapes are skipped', () => {
  const vt = createVt();
  vt.write('a\x1b(Bb\x1b=c');
  assert.equal(vt.text(), 'abc');
});

test('escape sequence split across writes is reassembled', () => {
  const vt = createVt();
  vt.write('x\x1b[3');
  vt.write('1mred\x1b[0m');
  assert.equal(vt.text(), 'xred');
});

test('clear screen resets the buffer', () => {
  const vt = createVt();
  vt.write('old stuff\r\n\x1b[H\x1b[2J$ ');
  assert.equal(vt.text(), '$ ');
});

test('buffer is capped at maxLines', () => {
  const vt = createVt({ maxLines: 3 });
  vt.write('1\r\n2\r\n3\r\n4\r\n5');
  assert.equal(vt.text(), '3\n4\n5');
});

test('bell and other C0 controls are ignored', () => {
  const vt = createVt();
  vt.write('a\x07b\x00c');
  assert.equal(vt.text(), 'abc');
});

const K = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test('keyToSeq maps special keys', () => {
  assert.equal(keyToSeq(K('Enter')), '\r');
  assert.equal(keyToSeq(K('Backspace')), '\x7f');
  assert.equal(keyToSeq(K('ArrowUp')), '\x1b[A');
  assert.equal(keyToSeq(K('Delete')), '\x1b[3~');
  assert.equal(keyToSeq(K('a')), 'a');
  assert.equal(keyToSeq(K('l', { ctrlKey: true })), '\x0c');
  assert.equal(keyToSeq(K('d', { ctrlKey: true })), '\x04');
});

test('keyToSeq leaves copy/paste and modifiers to the browser', () => {
  assert.equal(keyToSeq(K('c', { ctrlKey: true })), '\x03');
  assert.equal(keyToSeq(K('c', { ctrlKey: true }), { hasSelection: true }), null);
  assert.equal(keyToSeq(K('c', { metaKey: true })), null);
  assert.equal(keyToSeq(K('v', { ctrlKey: true })), null);
  assert.equal(keyToSeq(K('v', { metaKey: true })), null);
  assert.equal(keyToSeq(K('Shift')), null);
  assert.equal(keyToSeq(K('x', { altKey: true })), null);
});

test('Escape goes to the shell except in fullscreen', () => {
  assert.equal(keyToSeq(K('Escape')), '\x1b');
  assert.equal(keyToSeq(K('Escape'), { fullscreen: true }), null);
});

test('huge cursor-forward is clamped', () => {
  const vt = createVt();
  const t0 = Date.now();
  vt.write('a\x1b[99999999Cb');
  assert.ok(Date.now() - t0 < 200, 'write took too long');
  assert.ok(vt.text().length <= 4096);
});

test('huge insert-blank is clamped', () => {
  const vt = createVt();
  vt.write('ab\x1b[1D\x1b[99999999@');
  assert.ok(vt.text().length <= 4096);
});

test('huge column-absolute is clamped', () => {
  const vt = createVt();
  vt.write('\x1b[99999999Gx');
  assert.ok(vt.text().length <= 4096);
});

test('ttyd framing', () => {
  assert.equal(encodeInput('ls', true), '0ls');
  assert.equal(encodeInput('ls', false), 'ls');
  assert.equal(resizeMessage(80, 24), '1{"columns":80,"rows":24}');
  assert.deepEqual(JSON.parse(handshake('tok', 80, 24)), { AuthToken: 'tok', columns: 80, rows: 24 });
  const dec = new TextDecoder();
  const enc = s => new TextEncoder().encode(s).buffer;
  assert.equal(decodeFrame(enc('0hi'), true, dec), 'hi');
  assert.equal(decodeFrame(enc('1title'), true, dec), null);
  assert.equal(decodeFrame(enc('raw'), false, dec), 'raw');
  assert.equal(decodeFrame('text', true, dec), 'text');
});

test('modified arrows and nav keys send xterm modifier sequences', () => {
  assert.equal(keyToSeq(K('ArrowUp', { ctrlKey: true })), '\x1b[1;5A');
  assert.equal(keyToSeq(K('ArrowLeft', { altKey: true })), '\x1b[1;3D');
  assert.equal(keyToSeq(K('ArrowRight', { shiftKey: true })), '\x1b[1;2C');
  assert.equal(keyToSeq(K('ArrowDown', { ctrlKey: true, shiftKey: true })), '\x1b[1;6B');
  assert.equal(keyToSeq(K('Home', { ctrlKey: true })), '\x1b[1;5H');
  assert.equal(keyToSeq(K('Delete', { altKey: true })), '\x1b[3;3~');
  assert.equal(keyToSeq(K('PageUp', { shiftKey: true })), '\x1b[5;2~');
  assert.equal(keyToSeq(K('ArrowUp')), '\x1b[A');
  assert.equal(keyToSeq(K('ArrowUp', { metaKey: true })), null);
});

test('cursor up/down move between lines and clamp', () => {
  const vt = createVt();
  vt.write('one\r\ntwo\r\nthree');
  vt.write('\x1b[1A\r\x1b[Kfoo');           // up one, rewrite "two" as "foo"
  assert.equal(vt.text(), 'one\nfoo\nthree');
  vt.write('\x1b[99A\x1b[99B');             // clamp at both ends, never throws
  assert.equal(vt.text(), 'one\nfoo\nthree');
  vt.write('\x1b[99A\rX');
  assert.equal(vt.text(), 'Xne\nfoo\nthree');
  assert.doesNotThrow(() => vt.write('\x1b[0A\x1b[B\x1b[;A'));
});

test('erase to end of screen drops lines below the cursor', () => {
  const vt = createVt();
  vt.write('a\r\nb\r\nc\x1b[2A\r\x1b[J');
  assert.equal(vt.text(), '');
  vt.write('x\r\ny\x1b[1A\x1b[J');
  assert.equal(vt.text(), 'x');
});

test('wrapped readline redraw: up, erase below, rewrite', () => {
  const vt = createVt();
  vt.write('$ long command\r\ncontinued');
  vt.write('\x1b[1A\r\x1b[J$ short');
  assert.equal(vt.text(), '$ short');
});

test('erase to start of line blanks up to and including the cursor', () => {
  const vt = createVt();
  vt.write('abcdef\x1b[3D\x1b[1K');
  assert.equal(vt.text(), '    ef');
  assert.deepEqual(vt.snapshot(), { before: '   ', after: ' ef' });
});

test('charWidth: wide, narrow and zero-width', () => {
  assert.equal(charWidth('a'), 1);
  assert.equal(charWidth('漢'), 2);
  assert.equal(charWidth('ｱ'), 1);
  assert.equal(charWidth('Ａ'), 2);
  assert.equal(charWidth('😀'), 2);
  assert.equal(charWidth('́'), 0);
});

test('wide characters take two columns for cursor math', () => {
  const vt = createVt();
  vt.write('漢字ab');
  assert.equal(vt.text(), '漢字ab');
  vt.write('\x1b[2D');                       // back over "ab"
  assert.deepEqual(vt.snapshot(), { before: '漢字', after: 'ab' });
  vt.write('\x1b[1G' + 'x');                 // column 0 overwrites the left half of 漢
  assert.equal(vt.text(), 'x 字ab');
  vt.write('\x1b[3Gy');                      // column 2 is 字's left half
  assert.equal(vt.text(), 'x y ab');
});

test('astral emoji are one wide character, not two columns of surrogates', () => {
  const vt = createVt();
  vt.write('😀b\x1b[1D' + 'c');
  assert.equal(vt.text(), '😀c');
  vt.write('\x1b[1D\x1b[K');
  assert.equal(vt.text(), '😀');
  vt.write('\x1b[2G');                       // column 1: the right half of 😀
  vt.write('z');
  assert.equal(vt.text(), ' z');
});

test('combining marks attach to the previous cell', () => {
  const vt = createVt();
  vt.write('éx');
  assert.equal(vt.text(), 'éx');
  assert.deepEqual(vt.snapshot(), { before: 'éx', after: '' });
});

test('backspace over a wide character then erase', () => {
  const vt = createVt();
  vt.write('漢\b\b\x1b[K');
  assert.equal(vt.text(), '');
});

test('cellFromRect derives the character cell and rejects unusable measurements', () => {
  assert.deepEqual(cellFromRect({ width: 312, height: 39 }, 40, 2), { w: 7.8, h: 19.5 });
  assert.equal(cellFromRect({ width: 0, height: 0 }, 40, 2), null);       // hidden panel
  assert.equal(cellFromRect({ width: NaN, height: 10 }, 40, 2), null);
  assert.equal(cellFromRect({ width: 10, height: 10 }, 0, 2), null);
});

test('gridSize turns the measured cell into cols/rows with padding and minimums', () => {
  assert.deepEqual(gridSize(840, 630, { w: 8, h: 20 }, { x: 40, y: 30 }), { cols: 100, rows: 30 });
  assert.deepEqual(gridSize(840, 630, { w: 7.8, h: 19.5 }), { cols: 102, rows: 30 });
  assert.deepEqual(gridSize(10, 10, { w: 8, h: 20 }), { cols: 20, rows: 6 });
  assert.deepEqual(gridSize(NaN, NaN, { w: 8, h: 20 }), { cols: 20, rows: 6 });
  assert.deepEqual(gridSize(840, 630, null), gridSize(840, 630, DEFAULT_CELL));
});

const S = (o = {}) => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, ...o });
const plain = runs => runs.map(r => [r.text, r.style && { ...r.style }]);
test('SGR sets and resets styles per cell', () => {
  const vt = createVt(); vt.write('\x1b[1;31mA\x1b[0mB');
  assert.deepEqual(plain(vt.runs().before), [['A', S({ bold: true, fg: 1 })], ['B', null]]);
});
test('bright, 256-colour and truecolor fg/bg, and 39/49 defaults', () => {
  const vt = createVt(); vt.write('\x1b[91mA\x1b[38;5;208mB\x1b[48;2;1;2;3mC\x1b[39;49mD\x1b[105mE');
  assert.deepEqual(plain(vt.runs().before), [['A', S({ fg: 9 })], ['B', S({ fg: 208 })], ['C', S({ fg: 208, bg: '#010203' })], ['D', null], ['E', S({ bg: 13 })]]);
});
test('attribute-off codes 22/23/24/27 and 2/3/4/7', () => {
  const vt = createVt(); vt.write('\x1b[2;3;4;7mA\x1b[22;23;24;27mB');
  assert.deepEqual(plain(vt.runs().before), [['A', S({ dim: true, italic: true, underline: true, inverse: true })], ['B', null]]);
});
test('malformed extended colours are ignored and do not shift later params', () => {
  const vt = createVt();
  vt.write('\x1b[38;5;300mA\x1b[38;2;999;0;0mB\x1b[38;5mC\x1b[0m\x1b[38;5;1;4mD\x1b[0m\x1b[' + '1;'.repeat(3000) + 'mE\x1b[0mF');
  const r = plain(vt.runs().before);
  assert.deepEqual(r.slice(0, 2), [['ABC', null], ['D', S({ fg: 1, underline: true })]]);
  assert.deepEqual(r.at(-1), ['F', null]);
});
test('colon sub-parameter SGR is consumed and ignored', () => {
  const vt = createVt(); vt.write('\x1b[38:2::1:2:3mA\x1b[4:3mB');
  assert.deepEqual(plain(vt.runs().before), [['AB', null]]);
  assert.equal(vt.text(), 'AB');
});
test('equal styles are interned and frozen', () => {
  const vt = createVt(); vt.write('\x1b[31ma\x1b[0mx\x1b[31mb');
  const r = vt.runs().before;
  assert.equal(r.length, 3);
  assert.equal(r[0].style, r[2].style);
  assert.ok(Object.isFrozen(r[0].style));
});
test('styles survive CR overwrite and erase leaves default cells', () => {
  const vt = createVt(); vt.write('\x1b[31mab\x1b[0m\rX\x1b[K');
  assert.deepEqual(plain(vt.runs().before), [['X', null]]);
  const v2 = createVt(); v2.write('\x1b[31mab\x1b[0m\rX');
  assert.deepEqual(plain(v2.runs().before), [['X', null]]); // the cursor sits after X, so the surviving 'b' is in `after`
  assert.deepEqual(plain(v2.runs().after), [['b', S({ fg: 1 })]]);
});
test('runs split at the cursor and delete/insert keep styles aligned', () => {
  const vt = createVt(); vt.write('\x1b[31mab\x1b[32mcd\x1b[0m\x1b[3D');
  const r = vt.runs();
  assert.deepEqual(plain(r.before), [['a', S({ fg: 1 })]]);
  assert.deepEqual(plain(r.after), [['b', S({ fg: 1 })], ['cd', S({ fg: 2 })]]);
  vt.write('\x1b[P');
  assert.deepEqual(plain(vt.runs().after), [['cd', S({ fg: 2 })]]);
  vt.write('\x1b[2@');
  assert.deepEqual(plain(vt.runs().after), [['  ', null], ['cd', S({ fg: 2 })]]);
});
test('runs merge across lines and lines beyond styledLines are plain', () => {
  const vt = createVt(); vt.write('\x1b[32ma\r\nb\r\nc');
  assert.deepEqual(plain(vt.runs().before), [['a\nb\nc', S({ fg: 2 })]]);
  assert.deepEqual(plain(vt.runs({ styledLines: 1 }).before), [['a\nb\n', null], ['c', S({ fg: 2 })]]);
});
test('xterm256 and runAttrs', () => {
  assert.equal(xterm256(196), '#ff0000'); assert.equal(xterm256(232), '#080808'); assert.equal(xterm256(244), '#808080');
  assert.deepEqual(runAttrs(S({ fg: 1, bold: true, underline: true })), { className: 't-b t-u fg-1', color: null, background: null });
  assert.deepEqual(runAttrs(S({ fg: 196 })), { className: '', color: '#ff0000', background: null });
  assert.deepEqual(runAttrs(S({ inverse: true })), { className: '', color: 'var(--term-bg)', background: 'var(--t-term)' });
  assert.deepEqual(runAttrs(S({ inverse: true, fg: 2 })), { className: 'bg-2', color: 'var(--term-bg)', background: null });
  assert.deepEqual(runAttrs(null), { className: '', color: null, background: null });
});
