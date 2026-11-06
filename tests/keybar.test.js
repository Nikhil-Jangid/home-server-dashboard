import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEYBAR, keyBarSeq, ctrlSeq, keyToSeq } from '../www/js/vt.js';

test('the key bar offers Esc, Tab, Ctrl, the four arrows and Backspace, in that order', () => {
  assert.deepEqual(KEYBAR.map(k => k.key), ['Escape', 'Tab', 'Control', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Backspace']);
  for (const k of KEYBAR) assert.ok(k.label && k.name, k.key + ' needs a visible label and an accessible name');
});

test('each key sends the same bytes as the physical key', () => {
  for (const key of ['Escape', 'Tab', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Backspace']) {
    assert.equal(keyBarSeq(key), keyToSeq({ key }), key);
  }
  assert.equal(keyBarSeq('Escape'), '\x1b');
  assert.equal(keyBarSeq('Tab'), '\t');
  assert.equal(keyBarSeq('ArrowUp'), '\x1b[A');
  assert.equal(keyBarSeq('Backspace'), '\x7f');
});

test('Esc from the bar is sent even in fullscreen, where the physical key exits fullscreen', () => {
  assert.equal(keyToSeq({ key: 'Escape' }, { fullscreen: true }), null);
  assert.equal(keyBarSeq('Escape'), '\x1b');
});

test('Control is a latch, not a sequence', () => {
  assert.equal(keyBarSeq('Control'), null);
  assert.equal(keyBarSeq('Nope'), null);
});

test('ctrlSeq turns a letter or @[\\]^_ into its control code, as a physical Ctrl would', () => {
  assert.equal(ctrlSeq('c'), '\x03');
  assert.equal(ctrlSeq('C'), '\x03');
  assert.equal(ctrlSeq('a'), '\x01');
  assert.equal(ctrlSeq('z'), '\x1a');
  assert.equal(ctrlSeq('['), '\x1b');
  assert.equal(ctrlSeq('@'), '\x00');
  assert.equal(ctrlSeq(' '), '\x00');
  assert.equal(ctrlSeq('?'), '\x7f');
  // (a physical Ctrl+V is left to the paste event; the latch has no clipboard, so it sends ^V like a real terminal)
  for (const ch of 'abcdefghijklmnopqrstuwxyz') assert.equal(ctrlSeq(ch), keyToSeq({ key: ch, ctrlKey: true }), ch);
  assert.equal(ctrlSeq('v'), '\x16');
});

test('ctrlSeq gives Ctrl+arrow and Ctrl+Delete the xterm modifier form', () => {
  assert.equal(ctrlSeq('\x1b[A'), '\x1b[1;5A');
  assert.equal(ctrlSeq('\x1b[D'), '\x1b[1;5D');
  assert.equal(ctrlSeq('\x1b[H'), '\x1b[1;5H');
  assert.equal(ctrlSeq('\x1b[3~'), '\x1b[3;5~');
  for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Home', 'End', 'Delete', 'PageUp'])
    assert.equal(ctrlSeq(keyToSeq({ key })), keyToSeq({ key, ctrlKey: true }), key);
});

test('ctrlSeq applies to the first character of typed text only and leaves other keys alone', () => {
  assert.equal(ctrlSeq('cd'), '\x03d');
  assert.equal(ctrlSeq('\x1b'), '\x1b');
  assert.equal(ctrlSeq('\t'), '\t');
  assert.equal(ctrlSeq('\r'), '\r');
  assert.equal(ctrlSeq('1'), '1');
  assert.equal(ctrlSeq('é'), 'é');
  assert.equal(ctrlSeq(''), '');
});
