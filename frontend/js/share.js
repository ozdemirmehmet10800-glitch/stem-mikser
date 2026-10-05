// Paylaş menüsünden şarkı ekleme (Web Share Target): uygulama tarafı. SAF mantık + Cache Storage yardımcıları
// (caches dışarıdan verilir, testte sahtesi); DOM yok. node tests\share_test.mjs
//
// Akış: manifest share_target -> POST /share-target -> sw.js ilk dosyayı `stem-mikser-share-v1` cache'ine koyar ve
// ?paylasim=1'e yönlendirir -> uygulama burada dosyayı alır, onay kartı gösterir. Sunucuya (ve GPU'ya) YALNIZ kullanıcı
// kartta "Yükle ve ayır"a basınca gidilir. Kayıt yükleme başarılı olunca ya da "Vazgeç"te silinir; 1 saatten eskisi
// açılışta silinir.

// sw.js ile AYNI sabitler (sw.js klasik betik, buradan içe aktaramaz; tests/sw_share_test.mjs eşitliği sınar).
export const SHARE_PARAM = "paylasim";
export const SHARE_CACHE = "stem-mikser-share-v1";
export const SHARE_KEY = "share-pending/current";
export const SHARE_MAX_BYTES = 30 * 1024 * 1024;      // sunucu MAX_UPLOAD_BYTES
export const SHARE_MAX_AGE_MS = 60 * 60 * 1000;       // bekleyen kayıt ömrü
export const SERVER_MAX_SECONDS = 10 * 60;            // sunucu MAX_DURATION_SEC (GPU'ya girmeden reddeder)
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"];

export const MESSAGES = Object.freeze({
  empty: "Dosya gelmedi. Bağlantı ya da metin eklenemez; bir ses dosyasını paylaş.",
  error: "Paylaşılan dosya alınamadı. Tekrar paylaşmayı dene.",
  gone: "Paylaşılan dosya bulunamadı (süresi geçmiş olabilir). Tekrar paylaş.",
});

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function formatDuration(seconds) {
  const s = Math.round(Number(seconds));
  if (!Number.isFinite(s) || s <= 0) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Ses mi? MIME audio/* ya da bilinen uzantı (dosya yöneticileri bazen genel MIME verir). */
export function isAudio({ name = "", type = "" } = {}) {
  if (String(type).toLowerCase().startsWith("audio/")) return true;
  const match = /\.([a-z0-9]+)$/i.exec(String(name));
  return Boolean(match && AUDIO_EXTENSIONS.includes(match[1].toLowerCase()));
}

/** Adres satırındaki ?paylasim=... değerini yorumlar: "1" dosya var, "bos" dosya yok, "hata" işlenemedi, yoksa null. */
export function launchKind(search) {
  const value = new URLSearchParams(String(search || "")).get(SHARE_PARAM);
  if (value === null) return null;
  if (value === "bos") return "empty";
  if (value === "hata") return "error";
  return "file";
}

export function keyUrl(base) {
  return new URL(SHARE_KEY, base).href;
}

/**
 * Bekleyen paylaşımı okur. Dönen: null (yok) ya da
 * {state: "ok" | "large" | "stale", name, size, type, skipped, time, file?}. "ok"ta file bir File.
 */
export async function readPending(cachesApi, base, now = Date.now()) {
  if (!cachesApi) return null;
  const cache = await cachesApi.open(SHARE_CACHE);
  const hit = await cache.match(keyUrl(base));
  if (!hit) return null;
  const header = (name) => hit.headers.get(name);
  let name = "";
  try {
    name = decodeURIComponent(header("x-share-name") || "");
  } catch {
    name = header("x-share-name") || "";
  }
  const pending = {
    state: header("x-share-state") === "large" ? "large" : "ok",
    name: name || "paylasilan-ses",
    size: Number(header("x-share-size")) || 0,
    type: header("content-type") || "",
    skipped: Number(header("x-share-skipped")) || 0,
    time: Number(header("x-share-time")) || 0,
  };
  if (!(pending.time > 0) || now - pending.time > SHARE_MAX_AGE_MS) return { ...pending, state: "stale" };
  if (pending.state === "ok") {
    const blob = await hit.blob();
    pending.file = new File([blob], pending.name, { type: pending.type === "application/octet-stream" ? "" : pending.type });
    pending.size = pending.size || blob.size;
  }
  return pending;
}

export async function clearPending(cachesApi) {
  if (!cachesApi) return;
  const cache = await cachesApi.open(SHARE_CACHE);
  for (const request of await cache.keys()) await cache.delete(request);
}

/**
 * Bekleyen kaydı kullanıcıya ne gösterileceğine çevirir. Dönen:
 *   {action: "card", note}              onay kartı (note: "N dosya atlandı…" ya da "")
 *   {action: "message", kind, text}     yalnız mesaj; kayıt silinmeli (clear: true)
 */
export function classify(pending) {
  if (!pending || pending.state === "stale") return { action: "message", kind: "gone", text: MESSAGES.gone, clear: true };
  if (pending.state === "large") {
    return {
      action: "message", kind: "large", clear: true,
      text: `"${pending.name}" ${formatSize(pending.size)}; sınır ${formatSize(SHARE_MAX_BYTES)}. `
        + "Daha kısa ya da sıkıştırılmış bir dosya paylaş.",
    };
  }
  if (!isAudio({ name: pending.name, type: pending.type })) {
    return { action: "message", kind: "notaudio", text: `"${pending.name}" ses dosyası gibi görünmüyor.`, clear: true };
  }
  const note = pending.skipped > 0 ? `${pending.skipped} dosya atlandı (yalnız ilki alındı).` : "";
  return { action: "card", note };
}

/** Süre biliniyorsa sunucu sınırını aşıyor mu? (kartta uyarı; sunucu zaten GPU'ya girmeden reddeder) */
export function durationWarning(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= SERVER_MAX_SECONDS) return "";
  return `Süre ${formatDuration(s)}; sunucu ${SERVER_MAX_SECONDS / 60} dakikadan uzun şarkıyı reddeder.`;
}
