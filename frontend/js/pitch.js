// Perde algılama (YIN) ve nota yardımcıları. SAF mantık: DOM, ses düğümü, ağ, depolama YOK; node ile test ediliyor:
//   node tests\pitch_test.mjs
//
// Bu dosya hem AudioWorklet işlemcisinde (pitch-processor.js) hem ana iş parçacığında (nota adı, ortanca süzgeç) kullanılır; 10. madde
// (akort aleti) aynı algılayıcıyı kullanacak.
//
// GİZLİLİK: mikrofon örnekleri YALNIZ bu dosyadaki `PitchTracker.push()` içinde işlenir ve dışarıya SADECE sayılar çıkar
// ({hz, clarity, rmsDb, centerSample}). Örnekler kopyalanıp saklanmaz, kaydedilmez, gönderilmez, loga yazılmaz.
//
// YÖNTEM: YIN (de Cheveigné & Kawahara, 2002): fark fonksiyonu + kümülatif ortalamayla normalleştirme + mutlak eşik + parabolik
// interpolasyon. Hız için örnekler ~12 kHz'e indirilir (üçgen süzgeç: ortalama alma iki kez), pencere 512 (~43 ms), adım 256 (~21 ms).
// Oktav hatalarına karşı klasik YIN yolu: eşiğin altına İLK inen τ (alt harmonik değil), sonra yerel minimuma yürünür.

export const PITCH_FMIN = 65;            // Hz (C2 civarı)
export const PITCH_FMAX = 1050;          // Hz (C6 civarı)
export const WORK_RATE = 12000;          // indirgenmiş hız (hedef)
export const WINDOW = 512;               // entegrasyon penceresi (indirgenmiş örnek)
export const HOP = 256;                  // analiz adımı (indirgenmiş örnek)
export const YIN_THRESHOLD = 0.15;
export const CLARITY_MIN = 0.6;          // 1 - d'(τ); altı "perde yok"
export const RMS_GATE_DB = -60;          // dBFS; altı "ses yok"

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** midi (kesirli) -> {note: en yakın tam nota, cents: [-50, 50)}. */
export function nearestNote(midi) {
  const note = Math.round(midi);
  return { note, cents: (midi - note) * 100 };
}

/** 69 -> "A4", 60 -> "C4". */
export function noteName(midiInt, names = SHARP_NAMES) {
  const n = Math.round(midiInt);
  return `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/**
 * YIN: x[offset .. offset+windowSize+tauMax) aralığında temel periyot. Dönen {tau (kesirli), clarity} ya da null (perde yok).
 * scratch: yeniden kullanılan Float32Array (tauMax + 2) ya da verilmezse ayrılır (her çağrıda ayırmamak için worklet'te verilir).
 */
export function yinDetect(x, offset, windowSize, tauMin, tauMax, threshold = YIN_THRESHOLD, scratch = null) {
  const cmnd = scratch && scratch.length >= tauMax + 2 ? scratch : new Float32Array(tauMax + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    let sum = 0;
    for (let j = 0; j < windowSize; j += 1) {
      const delta = x[offset + j] - x[offset + j + tau];
      sum += delta * delta;
    }
    running += sum;
    cmnd[tau] = running > 0 ? (sum * tau) / running : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau += 1;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    // eşiğin altına inen yok: en küçük değer yeterince düşükse (zayıf ama periyodik) onu al
    let min = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau += 1) {
      if (cmnd[tau] < min) {
        min = cmnd[tau];
        best = tau;
      }
    }
    if (best < 0 || min > 0.5) return null;
  }
  let tauF = best;
  if (best > 1 && best < tauMax) {
    const a = cmnd[best - 1];
    const b = cmnd[best];
    const c = cmnd[best + 1];
    const denominator = a - 2 * b + c;
    if (denominator > 1e-12) tauF = best + 0.5 * (a - c) / denominator;
  }
  return { tau: tauF, clarity: 1 - cmnd[best] };
}

/**
 * Akan örnekleri alıp ~21 ms'de bir {hz, clarity, rmsDb, centerSample} üretir. centerSample = analiz penceresinin ORTASININ
 * (ham) örnek sırası, akışın başından itibaren: zamanı çağıran (worklet) kendi saatinden hesaplar.
 */
export class PitchTracker {
  constructor(sampleRate, options = {}) {
    const { fmin = PITCH_FMIN, fmax = PITCH_FMAX, threshold = YIN_THRESHOLD, clarityMin = CLARITY_MIN, rmsGateDb = RMS_GATE_DB } = options;
    this.sampleRate = sampleRate;
    this.d = Math.max(1, Math.round(sampleRate / WORK_RATE));
    this.rate = sampleRate / this.d;
    this.tauMax = Math.ceil(this.rate / fmin);
    this.tauMin = Math.max(2, Math.floor(this.rate / fmax));
    this.threshold = threshold;
    this.clarityMin = clarityMin;
    this.rmsGateDb = rmsGateDb;
    this.need = WINDOW + this.tauMax + 2;               // bir analiz için indirgenmiş örnek
    this.span = (this.need + 2) * this.d;               // ham örnek (süzgeç kenarları dahil)
    this.capacity = this.span * 2 + 1024;
    this.buf = new Float32Array(this.capacity);
    this.dec = new Float32Array(this.need);
    this.cmnd = new Float32Array(this.tauMax + 2);
    this.weights = new Float32Array(2 * this.d - 1);    // üçgen süzgeç: ağırlıklar toplamı 1
    for (let k = -(this.d - 1); k <= this.d - 1; k += 1) this.weights[k + this.d - 1] = (this.d - Math.abs(k)) / (this.d * this.d);
    this.reset();
  }

  reset() {
    this.write = 0;                                      // buf içindeki yazılan miktar
    this.start = this.d - 1;                             // sonraki analizin ilk indirgenmiş örneğinin ham sırası (buf'a göre)
    this.dropped = 0;                                    // buf'un başından atılan ham örnek sayısı (akış sırası = dropped + sıra)
  }

  /** samples: Float32Array (mono). Dönen: bu çağrıda tamamlanan kareler (çoğunlukla 0 ya da 1). */
  push(samples) {
    const frames = [];
    let offset = 0;
    while (offset < samples.length) {
      if (this.write >= this.capacity) this.#compact();
      const room = this.capacity - this.write;
      const take = Math.min(room, samples.length - offset);
      this.buf.set(samples.subarray(offset, offset + take), this.write);
      this.write += take;
      offset += take;
      while (this.start + (this.need - 1) * this.d + (this.d - 1) < this.write) {
        frames.push(this.#analyze());
        this.start += HOP * this.d;
      }
      if (this.start > this.capacity / 2) this.#compact();
    }
    return frames;
  }

  #compact() {
    const keepFrom = Math.max(this.start - this.d, 0);
    this.buf.copyWithin(0, keepFrom, this.write);
    this.write -= keepFrom;
    this.start -= keepFrom;
    this.dropped += keepFrom;
  }

  #analyze() {
    const { d, need, dec, buf, weights } = this;
    let energy = 0;
    for (let i = 0; i < need; i += 1) {
      const center = this.start + i * d;
      let value = 0;
      for (let k = -(d - 1); k <= d - 1; k += 1) value += weights[k + d - 1] * buf[center + k];
      dec[i] = value;
      if (i < WINDOW) energy += value * value;
    }
    const rms = Math.sqrt(energy / WINDOW);
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120;
    const centerSample = this.dropped + this.start + Math.floor((WINDOW / 2) * d);
    if (rmsDb < this.rmsGateDb) return { hz: null, clarity: 0, rmsDb, centerSample };
    const found = yinDetect(dec, 0, WINDOW, this.tauMin, this.tauMax, this.threshold, this.cmnd);
    if (!found || found.clarity < this.clarityMin) return { hz: null, clarity: found ? found.clarity : 0, rmsDb, centerSample };
    return { hz: this.rate / found.tau, clarity: found.clarity, rmsDb, centerSample };
  }
}

/**
 * Ana iş parçacığı: son N sesli kareden ortanca (midi alanında) + tek karelik oktav sıçramasını yok sayma.
 * push(hz|null) -> düzleştirilmiş midi (kesirli) ya da null.
 */
export class PitchSmoother {
  constructor(size = 3, maxJumpSemis = 9) {
    this.size = size;
    this.maxJump = maxJumpSemis;
    this.recent = [];
    this.last = null;
    this.misses = 0;
    this.pending = 0;
  }

  reset() {
    this.recent = [];
    this.last = null;
    this.misses = 0;
    this.pending = 0;
  }

  push(hz) {
    if (!(hz > 0)) {
      this.misses += 1;
      if (this.misses >= 2) {
        this.recent = [];
        this.last = null;
      }
      return null;
    }
    const midi = hzToMidi(hz);
    if (this.last !== null && Math.abs(midi - this.last) >= this.maxJump && this.recent.length) {
      // ani sıçrama (oktav hatası adayı): yeni değer birbirini doğrulayana kadar eskiyi tut; arka arkaya gelirse kabul et
      this.pending += 1;
      if (this.pending < 2) return this.last;
      this.recent = [];                                  // iki kare üst üste: gerçek sıçrama (yeni nota), eskiyi bırak
    }
    this.pending = 0;
    this.misses = 0;
    this.recent.push(midi);
    if (this.recent.length > this.size) this.recent.shift();
    const sorted = [...this.recent].sort((a, b) => a - b);
    this.last = sorted[Math.floor(sorted.length / 2)];
    return this.last;
  }
}
