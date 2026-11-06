// Terminal panel: ttyd over WebSocket, in-terminal login, line-mode rendering.
import { COLORS } from './format.js';
import { h } from './dom.js';
import { createVt, runAttrs, keyToSeq, KEYBAR, keyBarSeq, ctrlSeq, encodeInput, decodeFrame, resizeMessage, handshake, cellFromRect, gridSize, DEFAULT_CELL } from './vt.js';

const STATUS = {
  connecting: { color: COLORS.warn, label: 'connecting' },
  connected: { color: COLORS.healthy, label: 'connected' },
  dead: { color: COLORS.unknown, label: 'disconnected' },
  auth: { color: COLORS.crit, label: 'locked' }
};
// ttyd runs without -c: /term/token answers at once with {"token":""}; the login happens inside the terminal.
const TOKEN_TIMEOUT_MS = 10_000, WS_TIMEOUT_MS = 15_000;
const STYLED_LINES = 500, SPREAD_MAX = 10_000; // older scrollback paints as plain text, keeping the span count bounded
// Hidden-input sentinel (zero-width space) and the edits a soft keyboard reports without text.
const SENTINEL = '\u200b';
const INPUT_EDITS = {
  insertLineBreak: '\r', insertParagraph: '\r',
  deleteContentBackward: '\x7f', deleteWordBackward: '\x17', deleteSoftLineBackward: '\x15', deleteHardLineBackward: '\x15',
  deleteContentForward: '\x1b[3~'
};
const AUTH_REASON = 'Not authorised — the terminal session was refused. Reload the page and sign in again.';

export function mountTerminal({ onState = () => {} } = {}) {
  const $ = id => document.getElementById(id);
  const out = $('term-out'), shell = $('term-shell'), panel = $('term-panel'), scrim = $('term-scrim');
  const vt = createVt();
  const cursor = h('span', { class: 'term-cursor' });
  let ws = null, tty = true, decoder = null, status = 'dead', fullscreen = false;
  let gen = 0; // bumped by every connect() and close(); async continuations and socket handlers bail when it moves on

  const setSession = label => { $('term-session').textContent = typeof label === 'string' && label ? label : '—'; };
  setSession(null);

  function setStatus(s, reason = '') {
    status = s;
    $('term-dot').style.background = STATUS[s].color;
    $('term-label').textContent = STATUS[s].label;
    $('term-label').style.color = STATUS[s].color;
    $('term-overlay').hidden = s === 'connected' || s === 'connecting';
    $('term-reconnect').disabled = s === 'connecting';
    $('term-overlay').querySelector('.term-ov-title').textContent = s === 'auth' ? 'Terminal locked' : 'Session ended';
    $('term-overlay-reason').textContent = reason;
    onState(STATUS[s].label);
  }

  // One run of same-style cells → a text node, or a span whose classes and inline colours come from runAttrs.
  // Colours are set as style properties (never a parsed style string), and text only ever via text nodes.
  function node(r) {
    if (!r.style) return document.createTextNode(r.text);
    const a = runAttrs(r.style);
    const style = {};
    if (a.color) style.color = a.color;
    if (a.background) style.backgroundColor = a.background;
    return h('span', { class: a.className || null, style }, r.text);
  }

  // Builds every node first, then swaps them in with no layout reads in between (one relayout per frame).
  // Pathological output (every cell a new colour) can exceed engines' argument limits (Safari: 65536),
  // so a huge list is appended node by node instead of spread.
  function paint() {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    const { before, after } = vt.runs({ styledLines: STYLED_LINES });
    const nodes = [...before.map(node), cursor, ...after.map(node)];
    if (nodes.length <= SPREAD_MAX) out.replaceChildren(...nodes);
    else { out.replaceChildren(); for (const n of nodes) out.appendChild(n); }
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  // Paint at most once per animation frame, however many WS messages arrive.
  let paintQueued = false;
  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paint(); });
  }

  // Character cell measured from a hidden block set in the terminal's own font (re-measured on fonts.ready and resize).
  const MEASURE_CHARS = 40, MEASURE_LINES = 2;
  const ruler = h('pre', { class: 'term-out', 'aria-hidden': 'true', style: {
    position: 'absolute', visibility: 'hidden', pointerEvents: 'none', height: 'auto', width: 'auto', padding: '0', border: '0', overflow: 'hidden', whiteSpace: 'pre', scrollbarGutter: 'auto'
  } }, ('M'.repeat(MEASURE_CHARS) + '\n').repeat(MEASURE_LINES - 1) + 'M'.repeat(MEASURE_CHARS));
  $('term-body').appendChild(ruler);
  let cell = DEFAULT_CELL;
  function measure() {
    if (typeof ruler.getBoundingClientRect !== 'function') return;
    cell = cellFromRect(ruler.getBoundingClientRect(), MEASURE_CHARS, MEASURE_LINES) || cell; // hidden panel → keep the last good cell
  }
  function padding() {
    if (typeof getComputedStyle !== 'function') return undefined;
    const cs = getComputedStyle(out);
    const f = k => parseFloat(cs[k]) || 0;
    const pad = { x: f('paddingLeft') + f('paddingRight'), y: f('paddingTop') + f('paddingBottom') };
    return pad.x || pad.y ? pad : undefined;
  }
  const size = () => gridSize(out.clientWidth, out.clientHeight, cell, padding());

  function send(s) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeInput(s, tty)); }

  // The size the shell was last told (handshake or resize); a resize is only sent when it changes.
  let sentSize = '';
  function notifyResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !tty) return;
    const { cols, rows } = size();
    if (cols + 'x' + rows === sentSize) return;
    sentSize = cols + 'x' + rows;
    ws.send(resizeMessage(cols, rows));
  }

  function close() {
    gen++; // invalidates every in-flight connect() and every handler of the old socket
    if (!ws) return;
    const old = ws;
    ws = null;
    try { old.close(); } catch { /* already closed */ }
  }

  async function connect() {
    close();
    const my = gen;
    const stale = () => my !== gen;
    setStatus('connecting');
    let token = '';
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const abortTimer = setTimeout(() => ctrl && ctrl.abort(), TOKEN_TIMEOUT_MS);
    try {
      const r = await fetch('/term/token', { credentials: 'same-origin', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (stale()) return;
      if (r.status === 401 || r.status === 403) { setStatus('auth', AUTH_REASON); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = await r.json();
      if (stale()) return;
      token = body.token || '';
    } catch (e) {
      if (stale()) return;
      setStatus('dead', 'Could not reach the terminal service at /term/ (' + (e.name === 'AbortError' ? 'timed out' : e.message) + '). On the server: systemctl status ttyd-dash');
      return;
    } finally {
      clearTimeout(abortTimer);
    }
    const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/term/ws', ['tty']);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    decoder = new TextDecoder();
    const wsTimer = setTimeout(() => { if (!stale() && status === 'connecting') { try { sock.close(); } catch { /* ignore */ } } }, WS_TIMEOUT_MS);
    // A handler from a superseded connect() closes its own socket and does nothing else.
    const dead = () => { if (!stale()) return false; clearTimeout(wsTimer); try { sock.close(); } catch { /* ignore */ } return true; };
    sock.onopen = () => {
      if (dead()) return;
      clearTimeout(wsTimer);
      tty = sock.protocol === 'tty';
      const { cols, rows } = size();
      if (tty) { sock.send(handshake(token, cols, rows)); sentSize = cols + 'x' + rows; }
      setStatus('connected');
      out.focus();
    };
    sock.onmessage = ev => {
      if (dead() || ws !== sock) return;
      const text = decodeFrame(ev.data, tty, decoder);
      if (text != null) { vt.write(text); schedulePaint(); }
    };
    sock.onclose = ev => {
      clearTimeout(wsTimer);
      if (stale() || ws !== sock) return;
      ws = null;
      if (ev.code === 1008) setStatus('auth', AUTH_REASON);
      else setStatus('dead', ev.wasClean
        ? 'Shell closed the connection (code ' + ev.code + ').'
        : 'Lost connection to the terminal. Check that ttyd-dash is running and Tailscale is connected.');
    };
  }

  function setFullscreen(on) {
    fullscreen = on;
    shell.classList.toggle('fs', on);
    scrim.hidden = !on;
    requestAnimationFrame(notifyResize);
  }

  // input. A latched on-screen Ctrl turns the next key, from any source, into its Ctrl form.
  const keys = $('term-keys');
  let latched = false;
  const ctrlBtn = () => keys && Array.from(keys.childNodes).find(b => b.dataset && b.dataset.key === 'Control');
  function setLatch(on) {
    latched = on;
    const b = ctrlBtn();
    if (b) b.setAttribute('aria-pressed', String(on));
  }
  function sendKey(seq) {
    if (latched) { seq = ctrlSeq(seq); setLatch(false); }
    send(seq);
  }
  function onKeydown(e) { // → true when the key was sent
    if (status !== 'connected') return false;
    if (e.isComposing || e.keyCode === 229) return false; // the IME owns this key; its result arrives as input/composition events
    const seq = keyToSeq(e, { hasSelection: String(getSelection()) !== '', fullscreen });
    if (seq == null) return false;
    e.preventDefault();
    sendKey(seq);
    return true;
  }
  out.addEventListener('keydown', onKeydown);

  // Touch screens: a <pre> cannot raise the soft keyboard, so a tap on the output focuses a hidden textarea.
  // Its keydowns go through keyToSeq like the <pre>'s; text the keyboard produces (Android reports most keys as
  // 'Unidentified'/229) arrives as input events. The textarea holds only SENTINEL between events: typed text is
  // sent and removed at once (a password typed at the login prompt never stays there), and Backspace on an
  // "empty" line still has a character to delete, so the keyboard raises deleteContentBackward → DEL.
  // IME composition (Gboard composes whole words) is held until compositionend and then sent once.
  const input = $('term-input');
  if (input) {
    let composing = false, keySent = false;
    const reset = () => {
      input.value = SENTINEL;
      if (typeof input.setSelectionRange === 'function') input.setSelectionRange(1, 1);
    };
    const flush = () => { // send whatever text the field holds besides the sentinel
      const text = input.value.split(SENTINEL).join('').replace(/\r?\n/g, '\r');
      reset();
      if (status === 'connected' && text) sendKey(text);
    };
    input.addEventListener('keydown', e => { keySent = onKeydown(e); });
    input.addEventListener('keyup', () => { keySent = false; });
    input.addEventListener('blur', () => { keySent = false; composing = false; reset(); });
    input.addEventListener('focus', reset);
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; flush(); });
    input.addEventListener('input', e => {
      if (composing || e.isComposing || e.inputType === 'insertCompositionText') return;
      if (keySent) { keySent = false; reset(); return; } // the keydown already sent it (Android applies the edit anyway)
      const seq = INPUT_EDITS[e.inputType];
      if (seq !== undefined) {
        reset();
        if (status === 'connected' && seq) sendKey(seq);
        return;
      }
      flush();
    });
    reset();
  }
  const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  $('term-body').addEventListener('click', () => {
    if (input && coarse() && !String(getSelection())) input.focus();
  });

  // On-screen key bar (shown by CSS under pointer: coarse). Its buttons never take focus, so the
  // soft keyboard stays up and keystrokes keep going to the terminal.
  if (keys) {
    const noFocus = e => e.preventDefault();
    keys.addEventListener('pointerdown', noFocus);
    keys.addEventListener('mousedown', noFocus);
    keys.replaceChildren(...KEYBAR.map(k => h('button', {
      class: 'term-key mono', type: 'button', 'aria-label': k.name, dataset: { key: k.key },
      'aria-pressed': k.key === 'Control' ? 'false' : null,
      onclick: () => {
        if (k.key === 'Control') setLatch(!latched);
        else if (status === 'connected') sendKey(keyBarSeq(k.key));
      }
    }, k.label)));
  }
  out.addEventListener('paste', e => {
    if (status !== 'connected') return;
    e.preventDefault();
    send(e.clipboardData.getData('text'));
  });
  $('term-body').addEventListener('mousedown', () => out.focus());

  // header buttons
  const reconnect = () => { vt.clear(); paint(); connect(); };
  $('term-reconnect').addEventListener('click', reconnect);
  $('term-overlay-btn').addEventListener('click', reconnect);
  $('term-clear').addEventListener('click', () => {
    vt.clear(); paint();
    if (status === 'connected') send('\x0c'); // Ctrl+L: shell redraws its prompt
  });
  $('term-fs').addEventListener('click', () => setFullscreen(!fullscreen));
  scrim.addEventListener('click', () => setFullscreen(false));
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && fullscreen) setFullscreen(false); });

  // drag-to-resize (pointer events so touch works too)
  const grab = $('term-grab');
  grab.addEventListener('pointerdown', e => {
    if (fullscreen) return;
    e.preventDefault();
    grab.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = panel.getBoundingClientRect().height;
    const move = ev => { panel.style.height = Math.max(180, Math.min(900, h0 + ev.clientY - y0)) + 'px'; };
    const up = () => {
      grab.removeEventListener('pointermove', move);
      grab.removeEventListener('pointerup', up);
      notifyResize();
    };
    grab.addEventListener('pointermove', move);
    grab.addEventListener('pointerup', up);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { measure(); notifyResize(); }, 200); });
  if (globalThis.document.fonts && globalThis.document.fonts.ready) globalThis.document.fonts.ready.then(() => { measure(); notifyResize(); }).catch(() => {});

  // Any change of the output box (panel layout, fullscreen, a soft keyboard) re-sends the size, so a
  // right-aligned prompt never wraps because the shell still has the old column count.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => notifyResize()).observe(out);

  measure();
  paint();
  connect();
  return { setSession };
}
