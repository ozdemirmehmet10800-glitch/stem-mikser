// Söz çevirisi (Aşama 14) arayüz mantığı: SAF, DOM/ağ/ses YOK. node tests\translation_test.mjs
//
// Sunucu: GET /songs/{id}/translation -> { state, code, message, lang, version, missing, has_reading,
//   lines: [{tr, ro?} | null] } (sözlerin o anki satırlarına hizalı). status.translation:
//   running | done | error (+ code busy|refused|auth|invalid|error, message).
//
// İstemci çeviriyi SATIR METNİNE göre tutar (Map: normKey(metin) -> {tr, ro}), indekse DEĞİL: sözler
// yeniden hizalansa/sıra değişse de çeviri doğru satırda kalır, metni değişen satır "çevrilmedi" olur
// (sunucudaki hash mantığının aynısı). Cihaz önbelleği de bu biçimde (çevrimdışı açılış).

export const SHOW_KEY = "stem-mikser.lyrics.show";
export const CACHE_PREFIX = "stem-mikser.translation.";
export const CACHE_LIMIT = 40;
export const TRANSLATE_LANGS = ["en", "ja"];
export const READING_LANGS = ["ja", "en"];     // ja: romaji, en: Türkçe harfli telaffuz
export const BUSY_TEXT = "Çeviri servisi şu an meşgul, biraz sonra tekrar dene.";
export const RUNNING_STALE_SECONDS = 900;

export function normKey(text) {
  return String(text || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function isTranslatable(lang) {
  return TRANSLATE_LANGS.includes(lang);
}

export function translationOf(status) {
  return status ? status.translation : undefined;
}

export function isRunning(record, nowSec = Date.now() / 1000) {
  if (!record || record.state !== "running") return false;
  return nowSec - (Number(record.started) || 0) < RUNNING_STALE_SECONDS;
}

// ------------------------------------------------------------------ eşleme

/** Sunucu cevabının satırları (lyricLines ile aynı sayıda olmalı) -> Map normKey -> {tr, ro?}; sayı tutmazsa null. */
export function buildMap(lyricLines, serverLines) {
  if (!Array.isArray(lyricLines) || !Array.isArray(serverLines) || lyricLines.length !== serverLines.length) return null;
  const map = new Map();
  lyricLines.forEach((line, index) => {
    const item = serverLines[index];
    if (item && typeof item.tr === "string" && item.tr) {
      const entry = { tr: item.tr };
      if (typeof item.ro === "string" && item.ro) entry.ro = item.ro;
      map.set(normKey(line.text), entry);
    }
  });
  return map;
}

export function lookup(map, text) {
  return map ? map.get(normKey(text)) || null : null;
}

/** Çevirisi olmayan satır sayısı (aynı metin tek sayılmaz: satır sayısı; sunucudaki "missing"le aynı birim). */
export function missingCount(lyricLines, map) {
  if (!lyricLines) return 0;
  let missing = 0;
  for (const line of lyricLines) {
    if (!lookup(map, line.text)) missing += 1;
  }
  return missing;
}

/** Çevirisi olup okunuşu olmayan satır sayısı ("Okunuşu ekle" yalnız İngilizcede ve bunlar için). */
export function readingMissingCount(lyricLines, map) {
  if (!lyricLines || !map) return 0;
  let missing = 0;
  for (const line of lyricLines) {
    const entry = lookup(map, line.text);
    if (entry && !entry.ro) missing += 1;
  }
  return missing;
}

export function hasAnyReading(map) {
  if (!map) return false;
  for (const entry of map.values()) {
    if (entry.ro) return true;
  }
  return false;
}

// ------------------------------------------------------------ gösterim tercihi

export function defaultShow() {
  return { tr: true, ro: true };
}

export function readShow(storage) {
  try {
    const raw = storage.getItem(SHOW_KEY);
    if (!raw) return defaultShow();
    const parsed = JSON.parse(raw);
    return { tr: parsed.tr !== false, ro: parsed.ro !== false };
  } catch {
    return defaultShow();
  }
}

export function writeShow(storage, show) {
  try {
    storage.setItem(SHOW_KEY, JSON.stringify({ tr: show.tr !== false, ro: show.ro !== false }));
  } catch {
    /* kota: önemli değil */
  }
}

/**
 * Bir satırın alt yazıları: önce okunuş, sonra çeviri. Okunuş Japonca (romaji) ve İngilizcede (Türkçe harfli
 * telaffuz) var; kapalıysa boş string.
 * Dönen {ro, tr} (her biri string, boş olabilir).
 */
export function subsFor(entry, show, lang) {
  if (!entry) return { ro: "", tr: "" };
  return {
    ro: show.ro && READING_LANGS.includes(lang) && entry.ro ? entry.ro : "",
    tr: show.tr && entry.tr ? entry.tr : "",
  };
}

export function subsList(lyricLines, map, show, lang) {
  return (lyricLines || []).map((line) => subsFor(lookup(map, line.text), show, lang));
}

// ------------------------------------------------------------ düğme / durum

export function statusMessage(record) {
  if (!record || record.state !== "error") return null;
  switch (record.code) {
    case "busy": return { tone: "warn", text: BUSY_TEXT };
    case "refused": return { tone: "warn", text: "Model bu şarkıyı çevirmeyi reddetti." };
    case "auth": return { tone: "error", text: "Çeviri anahtarı kabul edilmedi (Modal secret'ını kontrol et)." };
    default: return { tone: "error", text: record.message ? `Çeviri başarısız: ${record.message}` : "Çeviri başarısız oldu, tekrar dene." };
  }
}

/** ApiError / ağ hatası -> kullanıcıya tek cümle. */
export function errorMessage(error) {
  const kind = error && error.kind;
  const status = error && error.status;
  const detail = String((error && error.message) || "").toLowerCase();
  if (kind === "offline") return "İnternet yok, çeviri için bağlantı gerekiyor.";
  if (kind === "network") return "Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene.";
  if (kind === "auth") return "Token kabul edilmedi. Ayarlar ekranından kontrol et.";
  if (kind === "notfound" || status === 404) return "Şarkı bulunamadı.";
  if (status === 400 && detail.includes("turkce")) return "Türkçe sözler çevrilmez.";
  if (status === 400) return "Bu dildeki sözler çevrilemez.";
  if (status === 409) {
    if (detail.includes("hazirlan")) return "Sözler hazırlanırken çevrilemez.";
    if (detail.includes("once sozler")) return "Önce sözler gerekli.";
    return "Şu an çevrilemiyor, biraz sonra tekrar dene.";
  }
  if (status >= 500) return "Sunucu hatası. Biraz sonra tekrar dene.";
  return "Çeviri başlatılamadı.";
}

/**
 * Söz panelindeki çeviri denetimi. `addReading`: İngilizce çeviri var ama bazı satırların telaffuzu yok ->
 * "Okunuşu ekle" (çeviriye dokunmadan); `readingMissing` o satır sayısı.
 *   lang: sözlerin dili, hasDoc: söz gösteriliyor mu, record: status.translation, map: eldeki çeviri (ya da null),
 *   lines: sözlerin satırları, offline, starting: istek gidiyor.
 * çıktı { kind, label, disabled, hint, note: {tone,text}|null, showTr, showRo }
 *   kind hidden | translate | update | running | retry
 */
export function actionView({ lang, hasDoc, record, map, lines, offline = false, starting = false, nowSec = Date.now() / 1000 }) {
  const base = { kind: "hidden", label: "", disabled: false, hint: "", note: null, showTr: false, showRo: false,
    addReading: false, readingMissing: 0 };
  if (!hasDoc || !isTranslatable(lang)) return base;          // Türkçe (ve bilinmeyen dil): hiçbir şey görünmez
  const has = Boolean(map && map.size);
  const missing = missingCount(lines, map);
  const readingMissing = lang === "en" ? readingMissingCount(lines, map) : 0;
  const view = { ...base, showTr: has, showRo: has && READING_LANGS.includes(lang) && hasAnyReading(map),
    addReading: has && readingMissing > 0, readingMissing };
  if (starting || isRunning(record, nowSec)) {
    return { ...view, kind: "running", addReading: false, note: { tone: "info", text: "Çeviri hazırlanıyor… (bu ekranda kalabilirsin)" } };
  }
  const failure = statusMessage(record);
  const hint = offline ? "İnternet yok" : "";
  if (failure) {
    return { ...view, kind: "retry", label: has && missing ? `Güncelle (${missing})` : "Tekrar dene", disabled: offline, hint, note: failure };
  }
  if (!has) return { ...view, kind: "translate", label: "Çevir", disabled: offline, hint };
  if (missing > 0) return { ...view, kind: "update", label: `Güncelle (${missing})`, disabled: offline, hint };
  return view;
}

// ------------------------------------------------------------ cihaz önbelleği

export function readCache(storage, id) {
  try {
    const raw = storage.getItem(CACHE_PREFIX + id);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || entry.v !== 1 || !entry.items || typeof entry.items !== "object") return null;
    const map = new Map();
    for (const [key, value] of Object.entries(entry.items)) {
      if (value && typeof value.tr === "string" && value.tr) {
        map.set(key, value.ro ? { tr: value.tr, ro: value.ro } : { tr: value.tr });
      }
    }
    return map.size ? { version: Number(entry.version) || 0, lang: entry.lang || null, map } : null;
  } catch {
    return null;
  }
}

export function writeCache(storage, id, map, version, lang, now = Date.now()) {
  try {
    const items = {};
    for (const [key, value] of map) items[key] = value;
    storage.setItem(CACHE_PREFIX + id, JSON.stringify({ v: 1, savedAt: now, version: Number(version) || 0, lang, items }));
    pruneCache(storage);
    return true;
  } catch {
    return false;
  }
}

export function dropCache(storage, ids) {
  for (const id of ids || []) {
    try { storage.removeItem(CACHE_PREFIX + id); } catch { /* yok say */ }
  }
}

export function pruneCache(storage) {
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) keys.push(key);
    }
    if (keys.length <= CACHE_LIMIT) return 0;
    const aged = keys.map((key) => {
      let savedAt = 0;
      try { savedAt = (JSON.parse(storage.getItem(key)) || {}).savedAt || 0; } catch { savedAt = 0; }
      return { key, savedAt };
    }).sort((x, y) => x.savedAt - y.savedAt);
    const drop = aged.slice(0, aged.length - CACHE_LIMIT);
    for (const item of drop) storage.removeItem(item.key);
    return drop.length;
  } catch {
    return 0;
  }
}
