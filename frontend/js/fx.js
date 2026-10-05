// Kanal şeridi (pan, 3 bantlı EQ, yankı gönderimi) ve ortak yankı odası: SAF mantık. node tests\fx_test.mjs
//
// Ses grafiği (Engine, esneticiden ÖNCE):
//   kaynak(playbackRate) -> gainNode (fader/mute) -> bas rafı -> orta -> tiz rafı -> StereoPanner -> hedef
//                                                                         \-> gönderim gain'i -> ortak bara -> ConvolverNode -> dönüş gain'i -> hedef
// Nötr kanalda (pan 0, EQ 0, gönderim 0) şerit HİÇ bağlanmaz. Dışa aktarma (sunucu) aynı sabitleri ve aynı
// impuls yanıtı algoritmasını kullanır (Python portu), bu yüzden SABİTLER ve ALGORİTMA burada tek yerde.

export const EQ_LIMIT = 12;                       // dB
export const PAN_LIMIT = 1;
export const SEND_MAX = 1;
// Web Audio BiquadFilterNode (RBJ): bas/tiz rafı (slope 1, Q yok sayılır), orta çan (peaking, Q).
export const EQ_BANDS = Object.freeze([
  Object.freeze({ id: "lo", type: "lowshelf", frequency: 120 }),
  Object.freeze({ id: "mid", type: "peaking", frequency: 1000, q: 0.9 }),
  Object.freeze({ id: "hi", type: "highshelf", frequency: 6000 }),
]);
export const EQ_LABELS = ["Bas", "Orta", "Tiz"];

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function neutralFx() {
  return { pan: 0, eq: [0, 0, 0], send: 0 };
}

/** Geçersiz/eksik alanlar nötre, değerler sınırlara çekilir. pan -1..1 (2 basamak), eq ±12 dB (0,1 dB), send 0..1. */
export function normalizeFx(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const eq = Array.isArray(source.eq) ? source.eq : [];
  return {
    pan: Math.round(clamp(num(source.pan), -PAN_LIMIT, PAN_LIMIT) * 100) / 100,
    eq: [0, 1, 2].map((i) => Math.round(clamp(num(eq[i]), -EQ_LIMIT, EQ_LIMIT) * 10) / 10),
    send: Math.round(clamp(num(source.send), 0, SEND_MAX) * 100) / 100,
  };
}

export function isNeutralFx(fx) {
  const f = normalizeFx(fx);
  return f.pan === 0 && f.send === 0 && f.eq.every((gain) => gain === 0);
}

/** Alt kanalın ETKİN değeri = kendi + ana kanalın (fader çarpımıyla aynı mantık): pan ve send toplanıp kırpılır, EQ dB toplanır. */
export function composeFx(own, parent) {
  const a = normalizeFx(own);
  if (!parent) return a;
  const b = normalizeFx(parent);
  return {
    pan: clamp(a.pan + b.pan, -PAN_LIMIT, PAN_LIMIT),
    eq: a.eq.map((gain, i) => clamp(gain + b.eq[i], -EQ_LIMIT, EQ_LIMIT)),
    send: clamp(a.send + b.send, 0, SEND_MAX),
  };
}

export function sameFx(a, b) {
  const x = normalizeFx(a);
  const y = normalizeFx(b);
  return x.pan === y.pan && x.send === y.send && x.eq.every((gain, i) => gain === y.eq[i]);
}

// --------------------------------------------------------------- ortak oda

export const DEFAULT_ROOM = Object.freeze({ size: 0.5, decay: 1.6, level: 0.5 });
export const DECAY_MIN = 0.4;
export const DECAY_MAX = 3.0;
export const ROOM_PRESETS = Object.freeze([
  Object.freeze({ id: "small", label: "Küçük", size: 0.15, decay: 0.6 }),
  Object.freeze({ id: "medium", label: "Orta", size: 0.4, decay: 1.2 }),
  Object.freeze({ id: "large", label: "Büyük", size: 0.7, decay: 2.2 }),
  Object.freeze({ id: "hall", label: "Salon", size: 1.0, decay: 3.0 }),
]);

export function normalizeRoom(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const pick = (key) => (Number.isFinite(Number(source[key])) ? Number(source[key]) : DEFAULT_ROOM[key]);
  return {
    size: Math.round(clamp(pick("size"), 0, 1) * 100) / 100,
    decay: Math.round(clamp(pick("decay"), DECAY_MIN, DECAY_MAX) * 100) / 100,
    level: Math.round(clamp(pick("level"), 0, 1) * 100) / 100,
  };
}

export function isDefaultRoom(room) {
  const r = normalizeRoom(room);
  return r.size === DEFAULT_ROOM.size && r.decay === DEFAULT_ROOM.decay && r.level === DEFAULT_ROOM.level;
}

/** Hazır odadan biri mi? (arayüzde seçili görünsün); değilse null. */
export function roomPresetId(room) {
  const r = normalizeRoom(room);
  const hit = ROOM_PRESETS.find((p) => p.size === r.size && p.decay === r.decay);
  return hit ? hit.id : null;
}

export const RETURN_SCALE = 1;                     // dönüş kazancı = seviye x bu
export function returnGain(level) {
  return clamp(num(level), 0, 1) * RETURN_SCALE;
}

// ------------------------------------------------- prosedürel impuls yanıtı
// Dış dosya YOK. Sabit tohumlu PRNG ile 44100 Hz'de üretilir (sunucu aynı algoritmayı Python'da koşar):
//   ön gecikme + seyrek erken yansımalar + üstel sönen gürültü (RT60 = decay) + zamanla kararan tek kutuplu
//   alçak geçiren (hava sönümü). Kanal başına ayrı akış (ilintisiz stereo). Sonunda kanal başına enerji 1.

export const IR_RATE = 44100;
export const IR_MAX_SECONDS = 3.5;
const IR_SEEDS = [0x9e3779b1, 0x85ebca6b];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function impulseLength(decay) {
  return Math.round(Math.min(num(decay) * 1.15 + 0.05, IR_MAX_SECONDS) * IR_RATE);
}

/** { left, right, rate: 44100 } (Float32Array'ler). */
export function makeImpulse(size, decay) {
  const s = clamp(num(size), 0, 1);
  const d = clamp(num(decay), DECAY_MIN, DECAY_MAX);
  const count = impulseLength(d);
  const predelay = 0.004 + 0.036 * s;
  const lateStart = Math.round((predelay + 0.012) * IR_RATE);
  const channels = [];
  for (let c = 0; c < 2; c += 1) {
    const rand = mulberry32(IR_SEEDS[c]);
    const data = new Float64Array(count);
    let lp = 0;
    for (let i = lateStart; i < count; i += 1) {
      const t = (i - lateStart) / IR_RATE;
      const x = (rand() * 2 - 1) * Math.exp((-6.907755 * t) / d);
      lp += (0.18 + 0.8 * Math.exp(-t / 0.35)) * (x - lp);
      data[i] = lp;
    }
    for (let k = 0; k < 8; k += 1) {
      const when = predelay + k * (0.009 + 0.018 * s) + rand() * 0.004;
      const index = Math.round(when * IR_RATE);
      const sign = rand() < 0.5 ? -1 : 1;
      if (index < count) data[index] += sign * 0.6 * 0.78 ** k;
    }
    channels.push(data);
  }
  const out = [];
  for (const data of channels) {
    let energy = 0;
    for (let i = 0; i < count; i += 1) energy += data[i] * data[i];
    const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    const array = new Float32Array(count);
    for (let i = 0; i < count; i += 1) array[i] = data[i] * scale;
    out.push(array);
  }
  return { left: out[0], right: out[1], rate: IR_RATE };
}

/** Doğrusal yeniden örnekleme (bağlamın hızı 44100 değilse). Enerji korunur (1 örnek = 1/hız saniye). */
export function resample(array, from, to) {
  if (from === to) return array;
  const length = Math.max(1, Math.round((array.length * to) / from));
  const out = new Float32Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = array[Math.min(index, array.length - 1)];
    const b = array[Math.min(index + 1, array.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  let before = 0;
  let after = 0;
  for (let i = 0; i < array.length; i += 1) before += array[i] * array[i];
  for (let i = 0; i < length; i += 1) after += out[i] * out[i];
  if (after > 0 && before > 0) {
    const fix = Math.sqrt(before / after);
    for (let i = 0; i < length; i += 1) out[i] *= fix;
  }
  return out;
}

const impulseCache = new Map();

/** Bağlamın hızında {left, right} (üretilen önbelleğe alınır: aynı oda için bir kez). */
export function impulseFor(size, decay, rate) {
  const key = `${Math.round(num(size) * 100)}|${Math.round(num(decay) * 100)}|${rate}`;
  let hit = impulseCache.get(key);
  if (!hit) {
    const base = makeImpulse(size, decay);
    hit = { left: resample(base.left, IR_RATE, rate), right: resample(base.right, IR_RATE, rate) };
    if (impulseCache.size >= 6) impulseCache.delete(impulseCache.keys().next().value);
    impulseCache.set(key, hit);
  }
  return hit;
}
