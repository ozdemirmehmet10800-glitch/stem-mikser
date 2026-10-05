// Ses tanısı: sayaçlar + kısa olay günlüğü.
//
// Telefonda cızırtı/donma gibi bir hata olduğunda ⚙ ekranından okunup
// kopyalanabilsin diye var. Davranışı DEĞİŞTİRMEZ, yalnız kaydeder. Günlük
// localStorage'a da yazılıyor: uygulama kapanıp açılınca önceki oturumun son
// olayları okunabilsin.

const KEY = "stem-mikser.diag";
const MAX_EVENTS = 20;

export const COUNTER_LABELS = {
  state: "durum değişimi",
  error: "yakalanmamış hata",
  rejection: "yakalanmamış söz",
  processor: "processorerror",
  decode: "çözme hatası",
  interrupt: "kesinti",
};

function clock(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

export class Diag {
  constructor(storage) {
    this.storage = storage;
    this.counts = {};
    this.events = [];
    this.previous = [];   // önceki oturumdan kalan son olaylar
    try {
      const saved = JSON.parse(storage && storage.getItem(KEY));
      if (saved && Array.isArray(saved.events)) this.previous = saved.events.slice(-MAX_EVENTS);
    } catch {
      /* bozuk ya da yok: boş başla */
    }
  }

  note(kind, text) {
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    this.events.push(`${clock()} ${kind}: ${text}`);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    try {
      if (this.storage) this.storage.setItem(KEY, JSON.stringify({ events: this.events }));
    } catch {
      /* kota dolu / kapalı: günlük yalnız bellekte kalsın */
    }
  }

  countsText() {
    const parts = Object.keys(COUNTER_LABELS).map(
      (kind) => `${COUNTER_LABELS[kind]} ${this.counts[kind] || 0}`
    );
    return parts.join(", ");
  }
}

export function formatMb(bytes) {
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Tek satırlık özet. `info` = Engine.diagnostics() + isteğe bağlı bellek/cihaz.
 */
export function summarize(info, diag) {
  const bits = [];
  bits.push(`ctx ${info.state}`);
  if (info.sampleRate) bits.push(`${info.sampleRate} Hz`);
  if (Number.isFinite(info.baseLatency)) bits.push(`gecikme ${info.baseLatency.toFixed(3)} sn`);
  if (info.clockRatio != null) bits.push(`saat ${info.clockRatio.toFixed(2)}x`);
  bits.push(`bellekte ${info.songs} şarkı (${info.stems} kanal)`);
  bits.push(`PCM ${formatMb(info.pcmBytes)}`);
  bits.push(`düğüm ${info.liveGains} (yaratılan ${info.gainsCreated}, sökülen ${info.gainsReleased})`);
  if (info.deviceMemoryGb) bits.push(`cihaz ${info.deviceMemoryGb} GB`);
  if (info.jsHeapBytes) bits.push(`JS ${formatMb(info.jsHeapBytes)}`);
  // Tarayıcı depolama temizliğinde ayarları (API adresi, token) silebilir; "hayır"
  // ise Chrome kalıcılık izni vermemiş demektir.
  bits.push(`kalıcı depolama: ${info.persisted === true ? "evet" : info.persisted === false ? "hayır" : "bilinmiyor"}`);
  bits.push(`hata: ${diag.countsText()}`);
  return bits.join(" · ");
}

export function eventsText(diag) {
  const lines = [];
  if (diag.previous.length) {
    lines.push("-- önceki oturum --", ...diag.previous);
  }
  lines.push("-- bu oturum --", ...(diag.events.length ? diag.events : ["(olay yok)"]));
  return lines.join("\n");
}

let storage = null;
try {
  storage = typeof localStorage !== "undefined" ? localStorage : null;
} catch {
  storage = null;
}

export const diag = new Diag(storage);
