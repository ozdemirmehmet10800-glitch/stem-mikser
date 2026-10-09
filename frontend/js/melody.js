// Hedef melodi (Mikrofon paketi 9): sunucudaki melody.bin'i okur, notalara böler, kullanıcının perdesini hedefle karşılaştırır.
// SAF mantık (DOM, ses, ağ, depolama YOK); node ile test ediliyor: node tests\melody_test.mjs
//
// melody.bin biçimi (backend/app.py `_melody_encode` ile aynı; little-endian):
//   "MEL1" | u32 başlık uzunluğu | başlık JSON (UTF-8) | n adet int16
//   int16 = MIDI notası x 100 (A4 = 6900); 0 = sessiz / perde yok. Kare süresi = başlık.hop_s (~23,2 ms).
//   başlık: {v, method ("pyin" | ileride "rmvpe"...), source ("vocals" | "lead"), sr, hop, hop_s, frame, n, unit, ...}
// Yöntem başlıkta olduğu için telefon hangi yöntemle üretildiğini bilir ve farklı yöntemler aynı biçimle gelebilir.
//
// Bu dosyada mikrofon verisi YOKTUR: yalnız zaten sayıya çevrilmiş perde (midi) alır.

export const MELODY_MAGIC = "MEL1";
export const MELODY_VERSION = 1;
export const NOTE_MIN_FRAMES = 5;          // ~116 ms: bundan kısa kararlı parça nota sayılmaz (konuşma / kayma / kısa takılma)
export const NOTE_TOLERANCE_SEMIS = 0.6;   // aynı notanın içinde izin verilen sapma (medyana göre)
export const HIT_CENTS = 50;               // isabet toleransı
export const TIME_WINDOW = 0.12;           // sn: hedef notayı bu kadar önce/sonrasında da kabul et (gecikme belirsizliği)

const clean = (value) => (Number.isFinite(value) ? value : 0);

/** ArrayBuffer -> {header, frames: Int16Array, hopS, n, method, source}; geçersizse null. */
export function decodeMelody(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 8) return null;
    for (let i = 0; i < 4; i += 1) if (bytes[i] !== MELODY_MAGIC.charCodeAt(i)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(4, true);
    if (headerLength <= 0 || 8 + headerLength > bytes.length) return null;
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
    if (!header || header.v !== MELODY_VERSION) return null;
    const n = Number(header.n);
    const hopS = Number(header.hop_s);
    if (!Number.isInteger(n) || n < 0 || !(hopS > 0)) return null;
    if (bytes.length - 8 - headerLength !== 2 * n) return null;
    const frames = new Int16Array(n);
    const base = 8 + headerLength;
    for (let i = 0; i < n; i += 1) frames[i] = view.getInt16(base + 2 * i, true);
    return { header, frames, hopS, n, method: String(header.method || ""), source: String(header.source || "") };
  } catch {
    return null;
  }
}

/**
 * Kare dizisini notalara böler: ardışık sesli kareler, medyana en çok `tolerance` yarım ses sapıyorsa aynı nota. En az `minFrames`
 * kare sürenler nota olur (kısa takılma, konuşma, kayma atılır). Dönen: [{t0, t1, midi (medyan), frames}] zamana göre sıralı.
 */
export function segmentNotes(melody, { minFrames = NOTE_MIN_FRAMES, tolerance = NOTE_TOLERANCE_SEMIS } = {}) {
  const { frames, hopS } = melody;
  const notes = [];
  let i = 0;
  const n = frames.length;
  while (i < n) {
    if (frames[i] <= 0) {
      i += 1;
      continue;
    }
    let j = i;
    const values = [frames[i] / 100];
    let median = values[0];
    // Karar son 3 karenin ORTALAMASIYLA verilir: hızlı vibrato (±40 cent) notayı bölmez, gerçek basamak (>= ~1 yarım ses) 2. karede ayrılır.
    const smooth = (next) => {
      const tail = values.slice(-2);
      return (next + tail.reduce((a, b) => a + b, 0)) / (tail.length + 1);
    };
    while (j + 1 < n && frames[j + 1] > 0 && Math.abs(smooth(frames[j + 1] / 100) - median) <= tolerance) {
      j += 1;
      values.push(frames[j] / 100);
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    // Üç karelik ortalama sınırı 1 kare geç yakalar: sondaki medyandan açıkça sapan kareleri sonraki nota için geri ver.
    while (j > i && Math.abs(values[values.length - 1] - median) > tolerance) {
      values.pop();
      j -= 1;
    }
    if (j - i + 1 >= minFrames) {
      notes.push({ t0: i * hopS, t1: (j + 1) * hopS, midi: median, frames: j - i + 1 });
    }
    i = j + 1;
  }
  return notes;
}

/** Zamana göre sıralı notalarda ikili aramayla [t - w, t + w] ile kesişenler. */
export class NoteTrack {
  constructor(notes) {
    this.notes = notes;
    this.maxLength = notes.reduce((m, note) => Math.max(m, note.t1 - note.t0), 0);
  }

  near(t, w = TIME_WINDOW) {
    const notes = this.notes;
    let low = 0;
    let high = notes.length;
    const from = t - w - this.maxLength;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (notes[mid].t0 < from) low = mid + 1;
      else high = mid;
    }
    const out = [];
    for (let k = low; k < notes.length && notes[k].t0 <= t + w; k += 1) {
      if (notes[k].t1 >= t - w) out.push(notes[k]);
    }
    return out;
  }

  /** [t0, t1] ile kesişen notalar (rulo penceresi). */
  between(t0, t1) {
    return this.near((t0 + t1) / 2, (t1 - t0) / 2);
  }
}

/** Kullanıcı perdesini hedefe en yakın oktava kaydırır (hedef ± 6 yarım ses içine). */
export function foldOctave(userMidi, targetMidi) {
  return userMidi + 12 * Math.round((targetMidi - userMidi) / 12);
}

/**
 * Bir kareyi değerlendirir. userMidi: kesirli midi ya da null (sessiz); shift: hedefe eklenen yarım ses (ton / "Plak gibi"; kesirli olabilir).
 * Dönen: {target (kaydırılmış hedef midi) | null, diffCents (kullanıcı - hedef, oktav katlanmış) | null, hit: true | false | null, folded}
 *   hit null = o anda hedef nota yok (puana girmez); hit false = hedef var ama kullanıcı sessiz ya da tutmadı.
 * octave: oktav farkı doğru sayılsın (varsayılan açık).
 */
export function judge(userMidi, track, t, { shift = 0, octave = true, tolCents = HIT_CENTS, windowSec = TIME_WINDOW } = {}) {
  const candidates = track.near(t, windowSec);
  if (!candidates.length) return { target: null, diffCents: null, hit: null, folded: false };
  // t anına zamanca en yakın nota (içindeyse 0), eşitlikte perdeye en yakın
  const distance = (note) => (t < note.t0 ? note.t0 - t : t > note.t1 ? t - note.t1 : 0);
  if (userMidi === null || userMidi === undefined) {
    const closest = candidates.reduce((best, note) => (distance(note) < distance(best) ? note : best), candidates[0]);
    return { target: closest.midi + shift, diffCents: null, hit: false, folded: false };
  }
  let best = null;
  for (const note of candidates) {
    const target = note.midi + shift;
    const folded = octave ? foldOctave(userMidi, target) : userMidi;
    const diff = (folded - target) * 100;
    if (!best || Math.abs(diff) < Math.abs(best.diffCents)) best = { target, diffCents: diff, folded: folded !== userMidi };
  }
  return { target: best.target, diffCents: clean(best.diffCents), hit: Math.abs(best.diffCents) <= tolCents, folded: best.folded };
}

/**
 * İsabet sayacı: kare başına BİR kayıt (kare = ~21 ms dilimi; aynı kare yeniden yazılırsa SON değer geçerli: geri sarıp yeniden
 * söyleyince eski deneme silinir). Aralık sorgusu satır / nota başına yüzde içindir (kare sayısı kadar iş: ~100). Yalnız sayılar tutulur.
 */
export const SCORE_FRAME = 0.0213;
export const SCORE_MAX_FRAMES = 200000;

export class Scoreboard {
  constructor() {
    this.map = new Map();            // kare sırası -> 1 (isabet) | 0 (kaçırdı)
  }

  get size() {
    return this.map.size;
  }

  reset() {
    this.map.clear();
  }

  /** hit: true | false | null (null kaydedilmez). */
  add(t, hit) {
    if (hit === null || hit === undefined || !Number.isFinite(t)) return;
    this.map.set(Math.round(t / SCORE_FRAME), hit ? 1 : 0);
    if (this.map.size > SCORE_MAX_FRAMES) {
      let drop = 50000;
      for (const key of this.map.keys()) {
        if (drop-- <= 0) break;
        this.map.delete(key);
      }
    }
  }

  range(t0, t1) {
    let total = 0;
    let hits = 0;
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      const from = Math.ceil(t0 / SCORE_FRAME - 0.5);
      const to = Math.ceil(t1 / SCORE_FRAME - 0.5);          // t1 hariç
      if (to - from > this.map.size) {
        for (const [key, value] of this.map) {
          if (key >= from && key < to) { total += 1; hits += value; }
        }
      } else {
        for (let key = from; key < to; key += 1) {
          const value = this.map.get(key);
          if (value !== undefined) { total += 1; hits += value; }
        }
      }
    } else {
      for (const value of this.map.values()) { total += 1; hits += value; }
    }
    return { hits, total, percent: total ? Math.round((100 * hits) / total) : null };
  }

  all() {
    return this.range(-Infinity, Infinity);
  }
}
