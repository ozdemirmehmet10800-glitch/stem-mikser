// Sahte DOM (LyricsScreen testleri için ortak): dinleyici / animasyon / kare sayaçları `live`'da.
// Gerçek tarayıcıya ihtiyaç duymadan "aç/kapa iz bırakmaz" doğrulanır.

// ------------------------------------------------------------- sahte DOM
export const live = { listeners: 0, anims: 0, frames: new Set(), nextFrame: 1 };

export class FakeEl {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = new Map();
    this.dataset = {};
    this.style = { setProperty(key, value) { this[key] = value; } };
    this.hidden = false;
    this.className = "";
    this._classes = new Set();
    this.handlers = new Map();
    this.offsetTop = 0;
    this.offsetHeight = 0;
    this.clientHeight = 0;
    this.played = 0;
    this.paused = 0;
    const self = this;
    this.classList = {
      add: (...names) => names.forEach((n) => self._classes.add(n)),
      remove: (...names) => names.forEach((n) => self._classes.delete(n)),
      toggle: (n, force) => { if (force === undefined ? !self._classes.has(n) : force) self._classes.add(n); else self._classes.delete(n); },
      contains: (n) => self._classes.has(n),
    };
  }
  get cls() { return new Set([...this.className.split(" ").filter(Boolean), ...this._classes]); }
  has(name) { return this.cls.has(name); }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  set textContent(value) { if (value === "") this.children = []; this._text = value; }
  get textContent() { return this._text || ""; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    if (!this.handlers.get(type).has(fn)) { this.handlers.get(type).add(fn); live.listeners += 1; }
  }
  removeEventListener(type, fn) {
    const set = this.handlers.get(type);
    if (set && set.delete(fn)) live.listeners -= 1;
  }
  fire(type, event = {}) { for (const fn of [...(this.handlers.get(type) || [])]) fn({ target: this, ...event }); }
  closest(selector) {
    const wanted = selector.replace(".", "");
    for (let n = this; n; n = n.parent) if (n.has(wanted)) return n;
    return null;
  }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  load() {}
  play() { this.played += 1; return Promise.resolve(); }
  pause() { this.paused += 1; }
  animate(frames, opts) {
    live.anims += 1;
    const anim = { frames, opts, cancelled: false, finished: false,
      cancel() { if (!this.finished && !this.cancelled) { this.cancelled = true; live.anims -= 1; this.oncancel && this.oncancel(); } },
      finish() { if (!this.finished && !this.cancelled) { this.finished = true; live.anims -= 1; this.onfinish && this.onfinish(); } } };
    this.lastAnim = anim;
    (this.allAnims ||= []).push(anim);
    return anim;
  }
}

export function makeEnv(visibility = "visible") {
  const doc = new FakeEl("document");
  doc.visibilityState = visibility;
  doc.createElement = (tag) => new FakeEl(tag);
  const win = new FakeEl("window");
  win.requestAnimationFrame = (fn) => { const id = live.nextFrame++; live.frames.add(id); win._cb = (win._cb || new Map()).set(id, fn); return id; };
  win.cancelAnimationFrame = (id) => { live.frames.delete(id); };
  win.flushFrames = () => {
    for (let guard = 0; guard < 5 && live.frames.size; guard += 1) {
      for (const id of [...live.frames]) { live.frames.delete(id); const fn = win._cb.get(id); fn && fn(); }
    }
  };
  const ui = {
    root: new FakeEl(), bg: new FakeEl(), media: new FakeEl(), flow: new FakeEl(), pulse: new FakeEl(),
    track: new FakeEl("ul"), stage: new FakeEl(), title: new FakeEl("span"), followBtn: new FakeEl("button"),
    closeBtn: new FakeEl("button"), playBtn: new FakeEl("button"), settingsBtn: new FakeEl("button"),
  };
  ui.root.hidden = true;
  ui.stage.clientHeight = 600;
  ui.stage.scrollTop = 0;
  ui.stage.scrolls = [];
  ui.stage.scrollTo = (opts) => { ui.stage.scrolls.push(opts); ui.stage.scrollTop = opts.top; };
  ui.followBtn.hidden = true;
  return { doc, win, ui };
}

