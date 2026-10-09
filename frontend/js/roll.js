// Piyano rulosu (Mikrofon paketi 9, 3. oturum): hedef notalar sağdan sola akar, kullanıcının perdesi üstüne çizilir. Geometri ve çizim SAF
// (tuval bağlamı dışarıdan verilir; sahte bağlamla node'da test ediliyor): node tests\roll_test.mjs
//
// Yatay eksen şarkı zamanı ("şimdi" çizgisi solda ~%27, 1,5 sn geçmiş + 4 sn gelecek), dikey eksen yarım ses (aralık notalara göre kayar,
// yumuşak geçişle). Çizim yalnız GÖRÜNEN pencereyi çizer (~20-60 çubuk): kare başına <1 ms.
// GİZLİLİK: yalnız zaten sayıya çevrilmiş perde (midi) gelir; ses örneği bu dosyada yok.

export const ROLL_PAST = 1.5;
export const ROLL_FUTURE = 4.0;
export const MIN_SPAN = 14;               // en az 14 yarım ses (~1 oktav+) görünür
export const RANGE_MARGIN = 2.5;
export const TRAIL_SECONDS = 8;
export const GAP_SECONDS = 0.09;          // iz noktaları arası bu kadar boşluk = çizgi kopar

export const COLORS = Object.freeze({
  background: "#0d1017", grid: "rgba(255,255,255,0.07)", gridStrong: "rgba(255,255,255,0.16)", label: "rgba(255,255,255,0.4)",
  now: "rgba(255,255,255,0.55)",
  future: "rgba(34,211,238,0.55)", active: "#22d3ee", pastMuted: "rgba(139,149,165,0.35)",
  scoreGood: "rgba(52,211,153,0.6)", scoreMid: "rgba(251,191,36,0.55)", scoreBad: "rgba(248,113,113,0.5)",
  hit: "#34d399", miss: "#fb923c", free: "#e8ecf2",
});

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function rollLayout({ width, height, now, past = ROLL_PAST, future = ROLL_FUTURE, lo, hi, labelWidth = 28, padY = 8 }) {
  const plotLeft = labelWidth;
  const plotRight = width;
  const plotTop = padY;
  const plotBottom = height - padY;
  const span = past + future;
  const pxPerSecond = (plotRight - plotLeft) / span;
  const semis = Math.max(hi - lo, 1e-6);
  const pxPerSemi = (plotBottom - plotTop) / semis;
  return {
    plotLeft, plotRight, plotTop, plotBottom, pxPerSecond, pxPerSemi, t0: now - past, t1: now + future,
    nowX: plotLeft + past * pxPerSecond,
    x: (t) => plotLeft + (t - (now - past)) * pxPerSecond,
    y: (midi) => plotBottom - (midi - lo) * pxPerSemi,
  };
}

/** Görünen notalara (kaydırılmış) göre dikey aralık {lo, hi}; nota yoksa fallbackCenter çevresi. */
export function targetRange(notes, shift = 0, fallbackCenter = 60) {
  if (!notes || !notes.length) return { lo: fallbackCenter - MIN_SPAN / 2, hi: fallbackCenter + MIN_SPAN / 2 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const note of notes) {
    const midi = note.midi + shift;
    if (midi < lo) lo = midi;
    if (midi > hi) hi = midi;
  }
  lo -= RANGE_MARGIN;
  hi += RANGE_MARGIN;
  if (hi - lo < MIN_SPAN) {
    const center = (hi + lo) / 2;
    lo = center - MIN_SPAN / 2;
    hi = center + MIN_SPAN / 2;
  }
  return { lo, hi };
}

/** Aralığı hedefe üstel olarak yaklaştırır (ani sıçrama yok). */
export class RangeEaser {
  constructor(lo = 53, hi = 67, rate = 3) {
    this.lo = lo;
    this.hi = hi;
    this.rate = rate;
  }

  step(target, dtSec) {
    const k = 1 - Math.exp(-this.rate * Math.max(dtSec, 0));
    this.lo += (target.lo - this.lo) * k;
    this.hi += (target.hi - this.hi) * k;
    return { lo: this.lo, hi: this.hi };
  }

  snap(target) {
    this.lo = target.lo;
    this.hi = target.hi;
  }
}

/** Kullanıcı izi: {t (şarkı zamanı), midi (çizilecek), hit}. Eski noktalar atılır. */
export class Trail {
  constructor(seconds = TRAIL_SECONDS) {
    this.seconds = seconds;
    this.items = [];
  }

  push(t, midi, hit) {
    this.items.push({ t, midi, hit });
  }

  prune(now) {
    const limit = now - this.seconds;
    let drop = 0;
    while (drop < this.items.length && this.items[drop].t < limit) drop += 1;
    if (drop) this.items.splice(0, drop);
    if (this.items.length > 4000) this.items.splice(0, this.items.length - 4000);
  }

  clear() {
    this.items.length = 0;
  }
}

function bar(ctx, x, y, w, h, radius) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
}

export const noteLabel = (midi) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

/**
 * view = {width, height, now, notes (zaman penceresindekiler), shift, lo, hi, trail (Trail.items), noteScore(note) -> yüzde | null, colors}
 * Dönen {notes, segments, dots}: çizilen öğe sayıları (test / ölçüm).
 */
export function drawRoll(ctx, view) {
  const { width, height, now, notes = [], shift = 0, lo, hi, trail = [], noteScore = () => null } = view;
  const colors = view.colors || COLORS;
  const layout = rollLayout({ width, height, now, lo, hi });
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);

  // ızgara: her C çizgisi (etiketli), araya G çizgisi silik
  ctx.font = "10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (let midi = Math.ceil(lo); midi <= Math.floor(hi); midi += 1) {
    const pc = ((midi % 12) + 12) % 12;
    if (pc !== 0 && pc !== 7) continue;
    const y = layout.y(midi);
    ctx.fillStyle = pc === 0 ? colors.gridStrong : colors.grid;
    ctx.fillRect(layout.plotLeft, Math.round(y), layout.plotRight - layout.plotLeft, 1);
    if (pc === 0) {
      ctx.fillStyle = colors.label;
      ctx.fillText(noteLabel(midi), 2, y);
    }
  }

  // hedef notalar
  let drawnNotes = 0;
  const barHeight = Math.max(layout.pxPerSemi * 0.85, 6);
  for (const note of notes) {
    if (note.t1 < layout.t0 || note.t0 > layout.t1) continue;
    const x0 = Math.max(layout.x(note.t0), layout.plotLeft);
    const x1 = Math.min(layout.x(note.t1), layout.plotRight);
    if (x1 <= x0) continue;
    const y = layout.y(note.midi + shift) - barHeight / 2;
    if (note.t1 < now) {
      const score = noteScore(note);
      ctx.fillStyle = score === null ? colors.pastMuted : score >= 70 ? colors.scoreGood : score >= 40 ? colors.scoreMid : colors.scoreBad;
    } else if (note.t0 <= now) {
      ctx.fillStyle = colors.active;
    } else {
      ctx.fillStyle = colors.future;
    }
    bar(ctx, x0, y, x1 - x0, barHeight, Math.min(4, barHeight / 2));
    drawnNotes += 1;
  }

  // "şimdi" çizgisi
  ctx.fillStyle = colors.now;
  ctx.fillRect(Math.round(layout.nowX), layout.plotTop - 4, 2, layout.plotBottom - layout.plotTop + 8);

  // kullanıcı izi: ardışık noktalar çizgi, kopukluk / tek nokta daire
  let segments = 0;
  let dots = 0;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  let previous = null;
  const clampY = (y) => Math.min(Math.max(y, layout.plotTop), layout.plotBottom);
  for (const point of trail) {
    if (point.t < layout.t0 - 0.2 || point.t > layout.t1) {
      previous = null;
      continue;
    }
    const x = layout.x(point.t);
    const y = clampY(layout.y(point.midi));          // aralık dışı perde kenarda görünür ("çok alçak / yüksek")
    const color = point.hit === true ? colors.hit : point.hit === false ? colors.miss : colors.free;
    if (previous && point.t - previous.t >= 0 && point.t - previous.t <= GAP_SECONDS) {      // sıra bozuksa / boşluk varsa çizgi kopar
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(layout.x(previous.t), clampY(layout.y(previous.midi)));
      ctx.lineTo(x, y);
      ctx.stroke();
      segments += 1;
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      dots += 1;
    }
    previous = point;
  }
  return { notes: drawnNotes, segments, dots };
}
