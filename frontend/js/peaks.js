// Dalga şeritleri için tepe verisi (peaks). SAF mantık (DOM yok), node ile test ediliyor: node tests\peaks_test.mjs
//
// Tepe verisi TELEFONDA, zaten çözülmüş stem tamponlarından hesaplanır (sunucu değişikliği yok). Hesap şarkı açılışını UZATMAZ:
// çalma/açılış bittikten sonra, küçük zaman dilimlerine bölünerek arka planda yürür (PeakJob.step bütçeli); sonuç cihaz önbelleğine
// yazılır (peakscache.js), sonraki açılışlarda yeniden hesaplanmaz.
//
// Biçim: kanal başına saniyede PEAK_RATE (20) kutu, kutu başına 1 bayt = o kutudaki en büyük |örnek|, karekök sıkıştırmalı
// (q = 255 * sqrt(tepe)): sessiz kısımlar da 8 bitte seçilebilsin. 4 dk x 6 stem ~ 29 KB.

export const PEAK_RATE = 20;
export const PEAK_VERSION = 1;
const MAGIC = "PKS1";

/** Süreye göre kutu sayısı. */
export function expectedBins(duration, rate = PEAK_RATE) {
  const d = Number(duration);
  return Number.isFinite(d) && d > 0 ? Math.ceil(d * rate - 1e-9) : 0;
}

/** |örnek| (0..1) -> bayt (karekök sıkıştırmalı). */
export function quantize(peak) {
  const p = peak > 1 ? 1 : peak > 0 ? peak : 0;
  return Math.round(255 * Math.sqrt(p));
}

/** bayt -> doğrusal genlik (0..1). */
export function linear(q) {
  const x = q / 255;
  return x * x;
}

/** AudioBuffer benzeri nesnenin kanal dizileri (kopyalamaz). */
export function channelsOf(buffer) {
  const out = [];
  for (let i = 0; i < buffer.numberOfChannels; i += 1) out.push(buffer.getChannelData(i));
  return out;
}

/**
 * Artımlı tepe hesabı. step(bütçe_ms) bütçe dolunca durur ve true/false döner (bitti mi); ana iş parçacığı bloklanmasın diye
 * çağıran her adımdan sonra denetimi tarayıcıya bırakır. Kutu sınırları örnek hızından bağımsız (kutu b = [b/rate, (b+1)/rate) sn).
 */
export class PeakJob {
  constructor(channels, sampleRate, bins, rate = PEAK_RATE) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.bins = bins;
    this.rate = rate;
    this.out = new Uint8Array(bins);
    this.next = 0;
    this.slices = 0;
    this.maxSliceMs = 0;
  }

  get done() {
    return this.next >= this.bins;
  }

  get progress() {
    return this.bins ? this.next / this.bins : 1;
  }

  step(budgetMs = 4, now = () => performance.now()) {
    const started = now();
    const perBin = this.sampleRate / this.rate;
    const channels = this.channels;
    while (this.next < this.bins) {
      const b = this.next;
      const from = Math.floor(b * perBin);
      const to = Math.floor((b + 1) * perBin);
      let peak = 0;
      for (let c = 0; c < channels.length; c += 1) {
        const data = channels[c];
        const limit = to < data.length ? to : data.length;
        for (let i = from; i < limit; i += 1) {
          const v = data[i];
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
        }
      }
      this.out[b] = quantize(peak);
      this.next += 1;
      // zamanı her kutuda değil, 8 kutuda bir yokla (kutu ~2400 örnek)
      if ((this.next & 7) === 0 && now() - started >= budgetMs) break;
    }
    const spent = now() - started;
    this.slices += 1;
    if (spent > this.maxSliceMs) this.maxSliceMs = spent;
    return this.done;
  }
}

/** Bir şarkının tüm kanallarının tepe verisi. */
export class PeakSet {
  constructor(bins, rate = PEAK_RATE) {
    this.bins = bins;
    this.rate = rate;
    this.data = new Map();      // ad -> Uint8Array
    this.lin = new Map();       // ad -> Float32Array (önbellek: doğrusal genlik)
    this.mixRef = 0;            // karışımın (birim kazançta) en yüksek tepesi: genel şerit ölçeği
    this.laneRef = 0;           // kanalların en yükseği: kanal şeritleri ortak ölçek
  }

  has(name) {
    return this.data.has(name);
  }

  names() {
    return [...this.data.keys()];
  }

  set(name, q) {
    this.data.set(name, q);
    this.lin.delete(name);
  }

  linear(name) {
    let arr = this.lin.get(name);
    if (!arr) {
      const q = this.data.get(name);
      if (!q) return null;
      arr = new Float32Array(q.length);
      for (let i = 0; i < q.length; i += 1) arr[i] = linear(q[i]);
      this.lin.set(name, arr);
    }
    return arr;
  }

  /** Ölçekleri bir kez belirler (ana kanallar birim kazançta); alt parçalar eklense de değişmez, şerit sabit kalır. */
  fixReferences(names) {
    const unity = names.map((name) => ({ name, gain: 1 }));
    this.mixRef = maxOf(mixLinear(this, unity)) || 1e-6;
    let lane = 0;
    for (const name of names) lane = Math.max(lane, maxOf(this.linear(name) || []));
    this.laneRef = lane || 1e-6;
  }
}

function maxOf(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i += 1) if (arr[i] > m) m = arr[i];
  return m;
}

/**
 * Duyulan kanalların birleşik zarfı (doğrusal): kutu başına sqrt(sum((kazanç * genlik)^2)). Bağımsız kaynaklarda güç toplanır;
 * gerçek karışım tepesine yakın bir yaklaşım (maks ile toplam arası). entries: [{name, gain}]; gain 0 olan atlanır.
 */
export function mixLinear(set, entries) {
  const out = new Float32Array(set.bins);
  for (const { name, gain } of entries) {
    if (!(gain > 0)) continue;
    const lin = set.linear(name);
    if (!lin) continue;
    const g2 = gain * gain;
    const n = Math.min(lin.length, out.length);
    for (let i = 0; i < n; i += 1) out[i] += g2 * lin[i] * lin[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sqrt(out[i]);
  return out;
}

/** Doğrusal genlik -> çizim yüksekliği (0..1), ortak ölçeğe (ref) göre, karekök sıkıştırmalı. */
export function heightsOf(lin, ref) {
  const out = new Float32Array(lin.length);
  const scale = ref > 0 ? 1 / ref : 0;
  for (let i = 0; i < lin.length; i += 1) {
    const v = lin[i] * scale;
    out[i] = Math.sqrt(v > 1 ? 1 : v);
  }
  return out;
}

/** Genel şerit: duyulan karışımın yükseklikleri. */
export function overviewHeights(set, entries) {
  return heightsOf(mixLinear(set, entries), set.mixRef);
}

/** Kanal şeridi: tek kanalın yükseklikleri (kanallar arası ortak ölçek). */
export function laneHeights(set, name) {
  const lin = set.linear(name);
  return lin ? heightsOf(lin, set.laneRef) : null;
}

// ---------------------------------------------------------------- önbellek biçimi

/** [MAGIC][u32 başlık uzunluğu][başlık JSON][kanal verileri art arda]. */
export function encodePeaks(set, tag = "") {
  const names = set.names();
  const header = new TextEncoder().encode(JSON.stringify({ v: PEAK_VERSION, rate: set.rate, bins: set.bins, tag: String(tag), names, mixRef: set.mixRef, laneRef: set.laneRef }));
  const out = new Uint8Array(8 + header.length + names.length * set.bins);
  for (let i = 0; i < 4; i += 1) out[i] = MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let at = 8 + header.length;
  for (const name of names) {
    out.set(set.data.get(name), at);
    at += set.bins;
  }
  return out.buffer;
}

/** Geçersizse null (bozuk, kesik, sürüm farkı). */
export function decodePeaks(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 8) return null;
    for (let i = 0; i < 4; i += 1) if (bytes[i] !== MAGIC.charCodeAt(i)) return null;
    const hlen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (hlen <= 0 || 8 + hlen > bytes.length) return null;
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen)));
    if (!header || header.v !== PEAK_VERSION || !Array.isArray(header.names)) return null;
    const bins = Number(header.bins);
    const rate = Number(header.rate);
    if (!Number.isInteger(bins) || bins <= 0 || !(rate > 0)) return null;
    if (8 + hlen + header.names.length * bins !== bytes.length) return null;
    const set = new PeakSet(bins, rate);
    let at = 8 + hlen;
    for (const name of header.names) {
      if (typeof name !== "string" || !name) return null;
      set.data.set(name, bytes.slice(at, at + bins));
      at += bins;
    }
    set.mixRef = Number(header.mixRef) || 0;
    set.laneRef = Number(header.laneRef) || 0;
    return set;
  } catch {
    return null;
  }
}
