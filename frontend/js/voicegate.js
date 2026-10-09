// Ses süzgeci (Mikrofon paketi 9, 3. oturum): ortam seslerini (uğultu, tıkırtı, uzaktaki konuşma, sızan müzik) eleyip YALNIZ kullanıcının
// kendi sesini (şarkı söylemesini) perde olarak geçirir. SAF mantık (DOM, ses, ağ, depolama YOK); node ile test ediliyor: node tests\voicegate_test.mjs
//
// Ses TANIMA yok; pratik üç adım:
//  1) GÜRÜLTÜ KALİBRASYONU: mikrofon açılınca ~2 sn sessiz kalınır, kare seviyelerinin (dBFS) %90'lık dilimi ortam TABANI olur; kapı eşiği =
//     taban + pay (+ "Hassasiyet" kaydırıcısı). Kalibrasyon şarkı çalarken yapılırsa kulaklıktan sızan müzik de tabana girer.
//  2) KARE SÜZGECİ: perde yalnız netlik (clarity) yüksek, insan sesi aralığında (80-1000 Hz) ve seviye eşiğin üstündeyse geçerli.
//  3) KARARLILIK: geçerli kareler en az ~90 ms ARDIŞIK kararlı (kare arası sıçrama <= 150 cent, ilk kümede toplam yayılım <= 500 cent)
//     olmadıkça "sesli" sayılmaz; kısa / titrek algılar atılır. Kabul edilen kümenin ilk kareleri GERİYE DÖNÜK kabul edilir (zamanları korunur),
//     yani nota başı kaybolmaz; tek karelik boşluk kümeyi bozmaz.
// Eşiğin altındaki ya da süzgeçten geçemeyen kareler perde olarak HİÇ çıkmaz (rulo ve puana girmez).
//
// GİZLİLİK: yalnız zaten sayıya çevrilmiş kareler ({hz, clarity, rmsDb}) girer; ses örneği bu dosyaya hiç gelmez.

import { hzToMidi } from "./pitch.js";

export const VOICE_FMIN = 80;
export const VOICE_FMAX = 1000;
export const VOICE_CLARITY = 0.8;           // YIN netliği (1 - d'); worklet'in kendi alt sınırı 0,6
export const VOICE_MIN_MS = 90;             // en az bu kadar ardışık kararlı perde
export const MAX_STEP_CENTS = 150;          // ardışık kareler arası izin verilen sıçrama
export const MAX_SPREAD_CENTS = 500;        // ilk kümenin en yüksek - en düşük farkı
export const MAX_GAP_FRAMES = 1;            // küme içinde tolere edilen ardışık boş kare
export const GATE_BASE_MARGIN_DB = 8;       // taban + pay
export const SENSITIVITY_DEFAULT = 50;      // 0 (az hassas = yüksek eşik) .. 100 (çok hassas = düşük eşik)
export const SENSITIVITY_DB_PER_STEP = 0.4; // kaydırıcı adımı başına dB (orta noktadan ±20 dB)
export const MIN_FLOOR_DB = -78;
export const MIN_THRESHOLD_DB = -66;        // hassasiyet en yüksekken bile bundan aşağı inmez
export const MAX_THRESHOLD_DB = -8;
export const DEFAULT_FLOOR_DB = -60;        // kalibrasyon yapılmadıysa varsayım
export const MIN_CALIBRATION_FRAMES = 25;   // ~0,5 sn: bundan azıyla taban güvenilmez

/** Kare seviyelerinden (dBFS) ortam tabanı: %90'lık dilim (birkaç tıkırtı tabanı şişirmesin). Yetersiz örnekte null. */
export function calibrateFloor(rmsDbList) {
  const values = (rmsDbList || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (values.length < MIN_CALIBRATION_FRAMES) return null;
  const at = Math.min(values.length - 1, Math.floor(values.length * 0.9));
  return Math.max(values[at], MIN_FLOOR_DB);
}

/** Kapı eşiği (dBFS): taban + pay + hassasiyet düzeltmesi. sensitivity 0..100 (yüksek = düşük eşik). */
export function thresholdDb(floorDb, sensitivity = SENSITIVITY_DEFAULT) {
  const floor = Number.isFinite(floorDb) ? floorDb : DEFAULT_FLOOR_DB;
  const s = Math.min(Math.max(Number.isFinite(sensitivity) ? sensitivity : SENSITIVITY_DEFAULT, 0), 100);
  const value = floor + GATE_BASE_MARGIN_DB + (SENSITIVITY_DEFAULT - s) * SENSITIVITY_DB_PER_STEP;
  return Math.min(Math.max(value, MIN_THRESHOLD_DB), MAX_THRESHOLD_DB);
}

/** Tek kare geçerli mi? Dönen: hz ya da null. frame = {hz, clarity, rmsDb}. */
export function validHz(frame, thresholdDbValue) {
  if (!frame || !(frame.hz > 0)) return null;
  if (!(frame.clarity >= VOICE_CLARITY)) return null;
  if (frame.hz < VOICE_FMIN || frame.hz > VOICE_FMAX) return null;
  if (!(frame.rmsDb >= thresholdDbValue)) return null;
  return frame.hz;
}

/**
 * Kararlılık süzgeci. push(midi | null, meta) -> olaylar [{accepted, midi, meta}] (zaman sırasına yakın; kabul edilen kümenin bekleyen
 * kareleri kabul anında toplu çıkar). midi: zaten geçerli (validHz + ortanca süzgeç) kesirli nota ya da null. meta: çağıranın kare bilgisi
 * (örn. şarkı zamanı); olaylarda aynen geri verilir.
 */
export class VoiceGate {
  constructor({ frameMs = 21.33, minMs = VOICE_MIN_MS, maxGap = MAX_GAP_FRAMES } = {}) {
    this.need = Math.max(2, Math.ceil(minMs / frameMs));
    this.maxGap = maxGap;
    this.reset();
  }

  reset() {
    this.run = [];            // [{midi | null, meta}] sırayla
    this.voiced = 0;
    this.accepted = false;
    this.gaps = 0;
  }

  #lastVoiced() {
    for (let i = this.run.length - 1; i >= 0; i -= 1) if (this.run[i].midi !== null) return this.run[i].midi;
    return null;
  }

  #end(events) {
    if (!this.accepted) for (const entry of this.run) events.push({ accepted: false, midi: null, meta: entry.meta });
    this.reset();
  }

  push(midi, meta = null) {
    const events = [];
    if (midi === null || midi === undefined || !Number.isFinite(midi)) {
      if (this.run.length) {
        this.gaps += 1;
        if (this.gaps <= this.maxGap) {
          this.run.push({ midi: null, meta });
          if (this.accepted) events.push({ accepted: false, midi: null, meta });
          return events;                         // bekleyen kümede boş kare sonuç bilinene dek tutulur
        }
        this.#end(events);
      }
      events.push({ accepted: false, midi: null, meta });
      return events;
    }
    this.gaps = 0;
    const last = this.#lastVoiced();
    if (last !== null && Math.abs(midi - last) * 100 > MAX_STEP_CENTS) this.#end(events);
    this.run.push({ midi, meta });
    this.voiced += 1;
    if (this.accepted) {
      events.push({ accepted: true, midi, meta });
      return events;
    }
    if (this.voiced >= this.need) {
      const values = this.run.filter((entry) => entry.midi !== null).map((entry) => entry.midi);
      if ((Math.max(...values) - Math.min(...values)) * 100 > MAX_SPREAD_CENTS) {
        // çok oynak (konuşma / gürültü): bekleyenler atılır, bu kareyle yeni küme başlar
        for (const entry of this.run.slice(0, -1)) events.push({ accepted: false, midi: null, meta: entry.meta });
        this.reset();
        this.run.push({ midi, meta });
        this.voiced = 1;
        return events;
      }
      this.accepted = true;
      for (const entry of this.run) events.push({ accepted: entry.midi !== null, midi: entry.midi, meta: entry.meta });
    }
    return events;
  }

  /** Akış bitti / mikrofon kapandı: bekleyenler atılır. */
  flush() {
    const events = [];
    this.#end(events);
    return events;
  }
}

export { hzToMidi };
