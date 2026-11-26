// Paylaş menüsünden şarkı ekleme (Web Share Target): uygulama tarafı. SAF mantık + Cache Storage yardımcıları
// (caches dışarıdan verilir, testte sahtesi); DOM yok. node tests\share_test.mjs
//
// Akış: manifest share_target -> POST /share-target -> sw.js ilk dosyayı `stem-mikser-share-v1` cache'ine koyar ve
// ?paylasim=1'e yönlendirir -> uygulama burada dosyayı alır, onay kartı gösterir. Sunucuya (ve GPU'ya) YALNIZ kullanıcı
// kartta "Yükle ve ayır"a basınca gidilir. Kayıt yükleme başarılı olunca ya da "Vazgeç"te silinir; 1 saatten eskisi
// açılışta silinir.

import { parseSharedText } from "./wishlist.js";

// sw.js ile AYNI sabitler (sw.js klasik betik, buradan içe aktaramaz; tests/sw_share_test.mjs eşitliği sınar).
export const SHARE_PARAM = "paylasim";
export const SHARE_CACHE = "stem-mikser-share-v1";
export const SHARE_KEY = "share-pending/current";
export const SHARE_EXTRA_PREFIX = "share-pending/extra-";   // 2., 3., ... paylaşılan dosya (sw.js ile AYNI)
export const SHARE_MAX_FILES = 20;                          // bir paylaşımda en çok (sw.js ile AYNI)
export const SHARE_MAX_BYTES = 30 * 1024 * 1024;      // sunucu MAX_UPLOAD_BYTES (yüklenen dosya)
export const SHARE_VIDEO_MAX_BYTES = 400 * 1024 * 1024;   // paylaşılan KLİP bu boyuta kadar saklanır; telefonda sesi ayıklanıp yüklenir (mp4audio.js)
export const SHARE_MAX_AGE_MS = 60 * 60 * 1000;       // bekleyen kayıt ömrü
export const SERVER_MAX_SECONDS = 10 * 60;            // sunucu MAX_DURATION_SEC (GPU'ya girmeden reddeder)
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"];
// Klip / video dosyaları (mp4 vb.): sunucu içindeki SESİ okur (ffmpeg), görüntü atılır; boyut sınırı TÜM dosyaya uygulanır (30 MB).
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-m4v"];

export const MESSAGES = Object.freeze({
  empty: "Paylaşımda ses dosyası ya da metin yoktu. Bir ses dosyasını ya da bir şarkı bağlantısını paylaş.",
  nowish: "Paylaşımda şarkı adı ya da bağlantı bulunamadı.",
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

/** Video (klip) mu? Yalnız seçilen/paylaşılan dosyanın SESİ alınır. */
export function isVideo({ name = "", type = "" } = {}) {
  if (VIDEO_TYPES.includes(String(type).toLowerCase())) return true;
  const match = /\.([a-z0-9]+)$/i.exec(String(name));
  return Boolean(match && VIDEO_EXTENSIONS.includes(match[1].toLowerCase()));
}

/** Yüklenebilir mi? Ses: MIME audio/* ya da bilinen uzantı (dosya yöneticileri bazen genel MIME verir); klip: mp4/mov/webm/mkv (sesi alınır). */
export function isAudio({ name = "", type = "" } = {}) {
  if (String(type).toLowerCase().startsWith("audio/")) return true;
  const match = /\.([a-z0-9]+)$/i.exec(String(name));
  if (match && AUDIO_EXTENSIONS.includes(match[1].toLowerCase())) return true;
  return isVideo({ name, type });
}

/** Adres satırındaki ?paylasim=... değerini yorumlar: "1" dosya var, "metin" metin/bağlantı var, "bos" hiçbiri, "hata" işlenemedi, yoksa null. */
export function launchKind(search) {
  const value = new URLSearchParams(String(search || "")).get(SHARE_PARAM);
  if (value === null) return null;
  if (value === "bos") return "empty";
  if (value === "hata") return "error";
  if (value === "metin") return "text";
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
  if (header("x-share-state") === "text") {
    // Metin/bağlantı paylaşımı (Eklenecekler): JSON {title, text, url}
    const time = Number(header("x-share-time")) || 0;
    if (!(time > 0) || now - time > SHARE_MAX_AGE_MS) return { state: "stale", name: "", size: 0, type: "", skipped: 0, time };
    let body = {};
    try {
      body = JSON.parse(await hit.text());
    } catch {
      body = {};
    }
    return {
      state: "text", name: "", size: 0, type: "application/json", skipped: 0, time,
      title: String(body.title || ""), text: String(body.text || ""), url: String(body.url || ""),
    };
  }
  const pending = { ...entryHeaders(hit), skipped: Number(header("x-share-skipped")) || 0 };
  const count = Math.min(Math.max(Number(header("x-share-count")) || 1, 1), SHARE_MAX_FILES);
  if (!(pending.time > 0) || now - pending.time > SHARE_MAX_AGE_MS) return { ...pending, state: "stale" };
  await attachFile(hit, pending);
  // 2., 3., ... dosyalar (çoklu paylaşım). Eksik olan atlanır.
  pending.extras = [];
  for (let index = 1; index < count; index += 1) {
    const extra = await cache.match(new URL(`${SHARE_EXTRA_PREFIX}${index}`, base).href);
    if (!extra) continue;
    const entry = entryHeaders(extra);
    await attachFile(extra, entry);
    pending.extras.push(entry);
  }
  return pending;
}

function entryHeaders(hit) {
  const header = (name) => hit.headers.get(name);
  let name = "";
  try {
    name = decodeURIComponent(header("x-share-name") || "");
  } catch {
    name = header("x-share-name") || "";
  }
  return {
    state: header("x-share-state") === "large" ? "large" : "ok",
    name: name || "paylasilan-ses",
    size: Number(header("x-share-size")) || 0,
    type: header("content-type") || "",
    time: Number(header("x-share-time")) || 0,
  };
}

async function attachFile(hit, entry) {
  if (entry.state !== "ok") return;
  const blob = await hit.blob();
  entry.file = new File([blob], entry.name, { type: entry.type === "application/octet-stream" ? "" : entry.type });
  entry.size = entry.size || blob.size;
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
  if (pending.state === "text") {
    const entry = parseSharedText({ title: pending.title, text: pending.text, url: pending.url });
    if (!entry) return { action: "message", kind: "nowish", text: MESSAGES.nowish, clear: true };
    return { action: "wish", entry, clear: true };
  }
  const entries = [pending, ...(pending.extras || [])];
  const usable = entries.filter((entry) => entry.state === "ok" && entry.file && isAudio({ name: entry.name, type: entry.type }));
  if (entries.length > 1 && usable.length) {
    // Çoklu paylaşım: kullanılabilenler kartta, sırayla yüklenir; kullanılamayanlar notta sayılır.
    const rejected = entries.length - usable.length;
    const note = [
      usable.length > 1 ? `${usable.length} şarkı: hepsi sırayla yüklenip ayrılacak.` : "",
      rejected ? `${rejected} dosya atlandı (çok büyük ya da ses/klip değil).` : "",
      pending.skipped > 0 ? `${pending.skipped} dosya atlandı (bir seferde en çok ${SHARE_MAX_FILES}).` : "",
      usable.some((entry) => isVideo({ name: entry.name, type: entry.type })) ? "Klip dosyalarının yalnız sesi alınır." : "",
    ].filter(Boolean).join(" ");
    return { action: "card", note, files: usable };
  }
  if (pending.state === "large") {
    return {
      action: "message", kind: "large", clear: true,
      text: `"${pending.name}" ${formatSize(pending.size)}; sınır ${formatSize(isVideo({ name: pending.name, type: pending.type }) ? SHARE_VIDEO_MAX_BYTES : SHARE_MAX_BYTES)}. `
        + "Daha kısa ya da sıkıştırılmış bir dosya paylaş.",
    };
  }
  if (!isAudio({ name: pending.name, type: pending.type })) {
    return { action: "message", kind: "notaudio", text: `"${pending.name}" ses ya da video (klip) dosyası gibi görünmüyor.`, clear: true };
  }
  const skipped = pending.skipped > 0 ? `${pending.skipped} dosya atlandı (bir seferde en çok ${SHARE_MAX_FILES}).` : "";
  const note = [isVideo({ name: pending.name, type: pending.type }) ? "Video dosyası: yalnız sesi alınır, görüntü atılır." : "", skipped].filter(Boolean).join(" ");
  return { action: "card", note, files: [pending] };
}

/** Süre biliniyorsa sunucu sınırını aşıyor mu? (kartta uyarı; sunucu zaten GPU'ya girmeden reddeder) */
export function durationWarning(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= SERVER_MAX_SECONDS) return "";
  return `Süre ${formatDuration(s)}; sunucu ${SERVER_MAX_SECONDS / 60} dakikadan uzun şarkıyı reddeder.`;
}

/**
 * Onay kartının görünümü (saf; app.js yalnız uygular). `pending`: {file, name, size, note, files?, step?} ya da null.
 * files: çoklu paylaşımda yüklenecekler (ad "X ve N şarkı daha", düğme "N şarkıyı yükle ve ayır"); step: yüklenen sıra (1..N).
 * Geçerli bir paylaşım kaydı (dosya) YOKSA kart GİZLİ ve "Yükle ve ayır" pasif: boş kart hiç görünmez, dosyasız istek
 * hiç gitmez. Dönen: {hidden, name, meta, note, goDisabled, cancelDisabled, qualityDisabled, goLabel, hint}.
 */
export function cardView({ pending, seconds = null, offline = false, configured = true, busy = false } = {}) {
  if (!pending || !pending.file) {
    return { hidden: true, name: "", meta: "", note: "", goDisabled: true, cancelDisabled: true, qualityDisabled: true,
      goLabel: "Yükle ve ayır", hint: "" };
  }
  const files = Array.isArray(pending.files) && pending.files.length ? pending.files : [pending];
  const many = files.length > 1;
  const notes = [pending.note, many ? "" : durationWarning(seconds)].filter(Boolean);
  const total = files.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);
  return {
    hidden: false,
    name: many ? `${files[0].name} ve ${files.length - 1} şarkı daha` : pending.name,
    meta: many ? `${files.length} dosya · ${formatSize(total)}` : [formatSize(pending.size), formatDuration(seconds)].filter(Boolean).join(" · "),
    note: notes.join(" "),
    goDisabled: busy || offline || !configured,
    cancelDisabled: busy,
    qualityDisabled: busy,
    goLabel: busy ? (many && pending.step ? `Yükleniyor… (${pending.step}/${files.length})` : "Yükleniyor…")
      : many ? `${files.length} şarkıyı yükle ve ayır` : "Yükle ve ayır",
    hint: !configured ? "Önce Ayarlar'dan API adresini ve token'ı gir."
      : offline ? "İnternet yok; bağlanınca yükleyebilirsin."
      : 'Ayırma (GPU) yalnız "Yükle ve ayır"a basınca başlar.',
  };
}
