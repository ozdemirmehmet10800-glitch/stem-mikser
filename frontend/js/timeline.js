// Zaman ekseni bileşeni: şarkı süresi (saniye) <-> yatay konum dönüşümü, dalga çizimi ve KATMANLI yer paylaşımı.
// DOM'a bağımlılığı küçük (root + canvas + win verilir); node'da sahte DOM ile test ediliyor: node tests\timeline_test.mjs
//
// KATMANLAR (alttan üste; hepsi root'un çocuğu, pointer-events: none, konumları AYNI dönüşümden gelir):
//   dalga (canvas)  ->  played (çalınmış kısmın tonu)  ->  bands (7. madde: bölüm bantları)  ->  loop (A-B bölgesi)  ->  markers (8. madde: yer imi bayrakları)
// Bandlar ve yer imleri `timeline.layer("bands" | "markers")` ile katmanı alır, öğelerini `place(el, t)` / `span(el, a, b)` ile yerleştirir;
// yakınlaştırma (view) eklenince dönüşüm tek yerde değişir, öğeler kendiliğinden doğru yere gelir.
// Dokunma: katman öğeleri kendi `pointer-events: auto` kuralını CSS'te açar; boşluğa dokunma `xToTime` ile çözülür (seek).
//
// KONUM: yatay iç boşluk (pad) = seek giriş öğesinin başparmak yarıçapı (6,5 px): range başparmağının merkezi [pad, W-pad] arasında
// gezer, bu bileşen aynı dönüşümü kullandığı için dalga, A-B tutamakları ve çalma çizgisi hizalı kalır.
//
// PERFORMANS: canvas yalnız veri/boyut/ses durumu değişince çizilir, KARE BAŞINA DEĞİL. Çalma konumu yalnız bir öğenin `transform`'u
// (compositor): setPlayed().

export const THUMB = 13;
export const LAYER_ORDER = ["played", "bands", "loop", "markers"];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** view = {start, end} (sn). */
export function fractionOf(t, view) {
  const span = view.end - view.start;
  return span > 0 ? (t - view.start) / span : 0;
}

export function timeToX(t, view, width, pad = THUMB / 2) {
  return pad + Math.max(width - 2 * pad, 0) * fractionOf(t, view);
}

export function xToTime(x, view, width, pad = THUMB / 2) {
  const inner = width - 2 * pad;
  if (!(inner > 0)) return view.start;
  return view.start + clamp01((x - pad) / inner) * (view.end - view.start);
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** CSS `left` (genişlikten bağımsız; yeniden boyutlanınca yeniden hesaplamak gerekmez). */
export function cssLeft(t, view, pad = THUMB / 2) {
  return `calc(${pad}px + (100% - ${2 * pad}px) * ${round6(fractionOf(t, view))})`;
}

export function cssWidth(a, b, view, pad = THUMB / 2) {
  return `calc((100% - ${2 * pad}px) * ${round6(Math.max(fractionOf(b, view) - fractionOf(a, view), 0))})`;
}

/**
 * Yükseklik dizisinden (kutu başına 0..1) çizim sütunları: sütun i, görünen aralığın i'inci dilimindeki kutuların EN BÜYÜĞÜ.
 * count = çizim alanının piksel genişliği.
 */
export function waveColumns(heights, rate, view, count) {
  const out = new Float32Array(Math.max(count, 0));
  const n = heights.length;
  const span = view.end - view.start;
  if (!n || !(span > 0) || !out.length) return out;
  for (let i = 0; i < out.length; i += 1) {
    const t0 = view.start + (span * i) / out.length;
    const t1 = view.start + (span * (i + 1)) / out.length;
    const b0 = Math.max(Math.floor(t0 * rate), 0);
    const b1 = Math.min(Math.max(Math.ceil(t1 * rate), b0 + 1), n);
    let m = 0;
    for (let b = b0; b < b1; b += 1) if (heights[b] > m) m = heights[b];
    out[i] = m;
  }
  return out;
}

/** Simetrik dalga: her sütun ortadan yukarı-aşağı dolu bir çubuk (tek yol, tek dolgu). Sessizlik = 1 px çizgi. */
export function drawColumns(ctx, columns, { x0 = 0, height, color }) {
  const mid = height / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < columns.length; i += 1) {
    const h = Math.max(columns[i] * (mid - 1), 0.5);
    ctx.rect(x0 + i, mid - h, 1, h * 2);
  }
  ctx.fill();
}

export class Timeline {
  constructor({ root, canvas, win = globalThis.window, doc = globalThis.document, pad = THUMB / 2, color = "#6b7482", getDuration = () => 0 }) {
    this.root = root;
    this.canvas = canvas;
    this.win = win;
    this.doc = doc;
    this.pad = pad;
    this.color = color;
    this.getDuration = getDuration;
    this.view = null;                 // null = tüm şarkı; {start, end} = yakınlaştırılmış aralık (sonra)
    this.heights = null;
    this.rate = 0;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.layers = new Map();
    this.playedFraction = -1;
    this.draws = 0;                   // test / ölçüm: kaç kez çizildi
  }

  /** Görünen aralık (sn). */
  range() {
    if (this.view) return this.view;
    return { start: 0, end: Math.max(this.getDuration() || 0, 0) };
  }

  timeToX(t) {
    return timeToX(t, this.range(), this.width, this.pad);
  }

  xToTime(x) {
    return xToTime(x, this.range(), this.width, this.pad);
  }

  setView(view) {
    this.view = view && view.end > view.start ? { start: view.start, end: view.end } : null;
    this.draw();
    this.#relayout();
  }

  /** Boyut değiştiyse tuvali yeniden boyutlar. Dönen: değişti mi. */
  resize() {
    const width = this.root.clientWidth || 0;
    const height = this.root.clientHeight || 0;
    const dpr = (this.win && this.win.devicePixelRatio) || 1;
    if (width === this.width && height === this.height && dpr === this.dpr) return false;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(Math.round(width * dpr), 0);
    this.canvas.height = Math.max(Math.round(height * dpr), 0);
    return true;
  }

  setHeights(heights, rate) {
    this.heights = heights;
    this.rate = rate;
    this.root.classList.toggle("ready", Boolean(heights));
    this.draw();
  }

  clear() {
    this.heights = null;
    this.root.classList.remove("ready");
    this.playedFraction = -1;
    this.draw();
    this.setPlayed(0);
  }

  draw() {
    const ctx = this.canvas.getContext ? this.canvas.getContext("2d") : null;
    if (!ctx || !this.width || !this.height) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.heights) return;
    const count = Math.floor(this.width - 2 * this.pad);
    if (count <= 0) return;
    const columns = waveColumns(this.heights, this.rate, this.range(), count);
    drawColumns(ctx, columns, { x0: this.pad, height: this.height, color: this.color });
    this.draws += 1;
  }

  /** Katman (div.tl-layer.tl-<ad>), yoksa kurulur; sıra LAYER_ORDER'a göre. */
  layer(name) {
    let node = this.layers.get(name);
    if (node) return node;
    node = this.doc.createElement("div");
    node.className = `tl-layer tl-${name}`;
    // çift sayılar: aradaki tek sayılar CSS'teki öğelere (seek girişi 5, A-B bölgesi 3, tutamaçlar 9) ayrılmış
    node.style.zIndex = String((LAYER_ORDER.indexOf(name) + 1 || LAYER_ORDER.length + 1) * 2);
    if (name === "played") {
      node.style.left = `${this.pad}px`;
      node.style.right = `${this.pad}px`;
    }
    this.root.append(node);
    this.layers.set(name, node);
    return node;
  }

  /** Öğeyi t anına koyar (görünen aralığın dışındaysa gizler). */
  place(node, t) {
    const view = this.range();
    const f = fractionOf(t, view);
    node.hidden = !(f >= -0.001 && f <= 1.001);
    node.style.left = cssLeft(t, view, this.pad);
  }

  /** Öğeyi [a, b] aralığına yayar (bölüm bandı gibi). */
  span(node, a, b) {
    const view = this.range();
    const fa = fractionOf(a, view);
    const fb = fractionOf(b, view);
    node.hidden = fb < 0 || fa > 1;
    node.style.left = cssLeft(Math.max(a, view.start), view, this.pad);
    node.style.width = cssWidth(Math.max(a, view.start), Math.min(b, view.end), view, this.pad);
  }

  /** Çalınmış kısmın tonu: yalnız transform (kare başına çağrılabilir). */
  setPlayed(t) {
    const view = this.range();
    const f = clamp01(fractionOf(t, view));
    if (Math.abs(f - this.playedFraction) < 0.0005) return;
    this.playedFraction = f;
    this.layer("played").style.transform = `scaleX(${round6(f)})`;
  }

  #relayout() {
    // yakınlaştırma eklenince katman öğeleri yeniden yerleşir (7 / 8): şimdilik kayıtlı öğe yok
  }
}
