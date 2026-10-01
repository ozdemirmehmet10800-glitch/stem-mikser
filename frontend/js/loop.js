// A-B döngü: SAF mantık (DOM, ses, depolama yok). node ile test ediliyor:
//     node tests\loop_test.mjs
//
// Zaman modeli. Motor kaynakları native döngüyle çalıyor (loopStart=a,
// loopEnd=b) ve konum "ham zaman" r ile tutuluyor: r = offset + geçen*rate,
// DÖNGÜ AÇILMAMIŞ gibi doğrusal artıyor. Şarkı konumu r'nin döngüye
// sarılmışı:
//     r <  b  ->  r
//     r >= b  ->  a + ((r - a) mod (b - a))
// Bu formül r kaç tur attıysa atsın doğru (ilk geçişin b'de olduğunu varsaymaya
// gerek yok), yani hız değişiminde ham zaman yeniden çıpalanırken tur sayısı
// kaybolmuyor. Tur numarası: 0 = ilk geçiş (b'ye varmadan), k >= 1 = k. dikiş
// sonrası. Dikiş k, ham zamanda a + k*(b-a) anında.
//
// Izgara telafisi YOK: vuruş ızgarası davuldan 8-15 ms önde (PLAN.md Aşama 8),
// uçlar ızgara noktasında kalınca iki uç da atağın hemen öncesine düşüyor;
// telafi eklemek ucu ataklara taşırdı.

export const MIN_LOOP = 0.25;        // sn: bundan kısa döngü kurulmaz
export const BAR_CHOICES = [1, 2, 4, 8];

// Sıralı bir diziden t'ye en yakın elemanın indeksi (boş dizide -1).
export function nearestIndex(sorted, t) {
  const n = sorted.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  // lo = t'ye eşit ya da büyük ilk eleman; önceki daha yakın olabilir.
  if (lo > 0 && t - sorted[lo - 1] <= sorted[lo] - t) return lo - 1;
  return lo;
}

// t'den küçük-eşit son elemanın indeksi (yoksa -1).
export function floorIndex(sorted, t) {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function numbers(list) {
  return (list || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
}

// grid: {beats, downbeats} (sn). mode: "beat" | "bar" | "free".
// Izgara yoksa ya da mod "free" ise t olduğu gibi (10 ms'ye yuvarlı) döner.
export function snapPoint(grid, t, mode = "beat") {
  const free = Math.round(t * 100) / 100;
  if (mode === "free" || !grid) return free;
  const source = mode === "bar" ? numbers(grid.downbeats) : numbers(grid.beats);
  const index = nearestIndex(source, t);
  return index < 0 ? free : source[index];
}

export function hasGrid(grid) {
  return Boolean(grid && grid.beats && grid.beats.length >= 2);
}

export function hasBars(grid) {
  return Boolean(grid && grid.downbeats && grid.downbeats.length >= 2);
}

// Hazır uzunluk: a en yakın ölçü başına yapışır, b = N ölçü sonrası ölçü başı.
// Şarkı sonuna taşarsa b = duration (clipped=true). Ölçü bilgisi yoksa null.
export function barLoop(grid, t, bars, duration) {
  if (!hasBars(grid) || !(bars >= 1)) return null;
  const downs = numbers(grid.downbeats);
  // Son ölçüde basılırsa kalan süre kısa kalabiliyor: bir önceki ölçü başına
  // geri çekilerek tam N ölçülük (ya da en uzun) döngü aranır.
  for (let i = nearestIndex(downs, t); i >= 0; i -= 1) {
    const a = downs[i];
    if (a >= duration) continue;
    const end = downs[i + bars];
    const b = end === undefined ? duration : Math.min(end, duration);
    if (b - a >= MIN_LOOP) return { a, b, clipped: end === undefined || end > duration };
  }
  return null;
}

// Geçerli döngüyü üretir: sıralar, [0, duration]'a kırpar, çok kısaysa null.
export function normalizeLoop(a, b, duration) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(duration, Math.max(a, b));
  return hi - lo >= MIN_LOOP ? { a: lo, b: hi } : null;
}

// Ham zaman -> şarkı konumu (yukarıdaki formül). loop yoksa r aynen.
export function mapLoop(raw, loop) {
  if (!loop || raw < loop.b) return raw;
  const length = loop.b - loop.a;
  return loop.a + ((raw - loop.a) % length);
}

// Ham zamandaki tur numarası (0 = ilk geçiş).
export function turnAt(raw, loop) {
  if (!loop || raw < loop.b) return 0;
  return Math.floor((raw - loop.a) / (loop.b - loop.a));
}

// k. dikişin ham zamanı (k >= 1).
export function seamRaw(loop, k) {
  return loop.a + k * (loop.b - loop.a);
}

// Konum döngünün içinde mi? tail: sonuna bırakılan pay (kaynak b'yi geçmiş
// olabilir).
export function inside(t, loop, tail = 0) {
  return t >= loop.a && t < loop.b - tail;
}

// Döngü dışına atlama: döngü kapanmalı mı? Tolerans: a'nın 5 ms altı.
export function seekClosesLoop(target, loop) {
  return Boolean(loop) && (target < loop.a - 0.005 || target >= loop.b);
}
