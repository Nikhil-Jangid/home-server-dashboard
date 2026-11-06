// Minimal DOM for view tests. innerHTML deliberately throws.
class Node {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes;
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    nodes.forEach(n => this.appendChild(n));
  }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(new Text(String(v))); }
}
class Text extends Node {
  constructor(data) { super(); this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class Element extends Node {
  constructor(tag) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase();
    this.attributes = {}; this.style = {}; this.dataset = {}; this.className = ''; this.listeners = {};
    this.hidden = false; this.id = '';
    const self = this;
    this.classList = {
      contains: c => self.className.split(/\s+/).includes(c),
      add: c => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove: c => { self.className = self.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      toggle: (c, force) => {
        const on = force === undefined ? !self.classList.contains(c) : force;
        self.classList[on ? 'add' : 'remove'](c);
        return on;
      }
    };
  }
  setAttribute(k, v) { this.attributes[String(k).toLowerCase()] = String(v); }
  getAttribute(k) { return this.attributes[String(k).toLowerCase()] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  // test helper: invoke listeners as the browser would
  fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, ...ev }); }
  closest(sel) {
    const cls = sel.replace(/^\./, '');
    for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && n.classList.contains(cls)) return n;
    return null;
  }
  set innerHTML(_) { throw new Error('innerHTML is banned'); }
  get innerHTML() { throw new Error('innerHTML is banned'); }
}

export function installFakeDom() {
  const created = [];
  const byId = {};
  globalThis.document = {
    createElement(tag) { const e = new Element(tag); created.push(e); return e; },
    createTextNode(d) { return new Text(d); },
    getElementById(id) { return byId[id] ?? null; },
    hidden: false
  };
  // register a pre-existing page element, as index.html would provide
  const page = (id, tag = 'div') => { const e = globalThis.document.createElement(tag); e.id = id; byId[id] = e; return e; };
  return { created, byId, page };
}
