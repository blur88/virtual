class FakeClassList {
  constructor(el) {
    this.el = el;
    this._set = new Set();
  }
  add(...names) {
    for (const n of names) {
      if (n) this._set.add(n);
    }
  }
  remove(...names) {
    for (const n of names) this._set.delete(n);
  }
  toggle(name, force) {
    if (force === true) this._set.add(name);
    else if (force === false) this._set.delete(name);
    else if (this._set.has(name)) this._set.delete(name);
    else this._set.add(name);
  }
  contains(name) {
    return this._set.has(name);
  }
  toString() {
    return [...this._set].join(' ');
  }
}

function matchesSingleSelector(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  let rest = selector.trim();
  if (!rest) return false;

  const attrMatches = [];
  rest = rest.replace(/\[([^\]=]+)(?:="([^"]*)")?\]/g, (_, key, val) => {
    attrMatches.push({ key, val });
    return '';
  });

  const classMatches = [];
  rest = rest.replace(/\.([a-zA-Z0-9_-]+)/g, (_, cls) => {
    classMatches.push(cls);
    return '';
  });

  let idMatch = null;
  rest = rest.replace(/#([a-zA-Z0-9_-]+)/g, (_, id) => {
    idMatch = id;
    return '';
  });

  const tagMatch = rest.trim().toLowerCase();

  if (tagMatch && el.tagName.toLowerCase() !== tagMatch) return false;
  if (idMatch && el.getAttribute('id') !== idMatch) return false;
  for (const cls of classMatches) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const { key, val } of attrMatches) {
    const actual = el.getAttribute(key);
    if (val === undefined) {
      if (actual === null) return false;
    } else if (actual !== val) {
      return false;
    }
  }
  return true;
}

class FakeTextNode {
  constructor(text, ownerDocument) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
  }
}

export class FakeElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.childNodes = [];
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
    this.dataset = new Proxy(
      {},
      {
        get: (_, prop) => {
          const attr = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
          return this.getAttribute(attr) ?? undefined;
        },
        set: (_, prop, value) => {
          const attr = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
          this.setAttribute(attr, String(value));
          return true;
        },
      }
    );
    this._value = '';
    this.disabled = false;
    this.type = '';
    this.name = '';
    this.required = false;
    this.placeholder = '';
  }

  get id() {
    return this.getAttribute('id') || '';
  }
  set id(val) {
    this.setAttribute('id', String(val));
  }

  get className() {
    return this.classList.toString();
  }
  set className(val) {
    this.classList = new FakeClassList(this);
    for (const part of String(val).split(/\s+/)) {
      if (part) this.classList.add(part);
    }
  }

  get hidden() {
    return this.attributes.has('hidden');
  }
  set hidden(val) {
    if (val) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }

  get value() {
    return this._value;
  }
  set value(val) {
    this._value = String(val ?? '');
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(val) {
    this.children = [];
    this.childNodes = [];
    if (val !== '' && val !== null && val !== undefined) {
      this.appendChild(new FakeTextNode(String(val), this.ownerDocument));
    }
  }

  setAttribute(name, value) {
    if (name === 'class') {
      this.className = value;
      return;
    }
    if (name === 'value') {
      this._value = String(value);
    }
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    if (name === 'class') return this.className || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(node) {
    if (node.parentNode) {
      const idx = node.parentNode.childNodes.indexOf(node);
      if (idx >= 0) node.parentNode.childNodes.splice(idx, 1);
      if (node.nodeType === 1) {
        const cidx = node.parentNode.children.indexOf(node);
        if (cidx >= 0) node.parentNode.children.splice(cidx, 1);
      }
    }
    node.parentNode = this;
    this.childNodes.push(node);
    if (node.nodeType === 1) this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.childNodes = [];
    for (const n of nodes) {
      if (typeof n === 'string') {
        this.appendChild(new FakeTextNode(n, this.ownerDocument));
      } else if (n) {
        this.appendChild(n);
      }
    }
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    event.currentTarget = this;
    event.preventDefault = event.preventDefault || (() => { event.defaultPrevented = true; });
    const list = this.listeners.get(event.type) || [];
    for (const fn of list) {
      fn.call(this, event);
    }
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this });
  }

  focus() {}

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSingleSelector(child, selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matchesSingleSelector(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}

export class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
    this.listeners = new Map();
  }

  createElement(tag) {
    return new FakeElement(tag, this);
  }

  createTextNode(text) {
    return new FakeTextNode(text, this);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  dispatchEvent(event) {
    event.preventDefault = event.preventDefault || (() => {});
    const list = this.listeners.get(event.type) || [];
    for (const fn of [...list]) {
      fn.call(this, event);
    }
  }
}
