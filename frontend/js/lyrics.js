// Şarkı sözleri (Aşama 11): arayüz durumu ve saf yardımcılar. DOM, ağ, ses YOK;
// node ile test ediliyor: node tests\lyrics_test.mjs
//
// Sunucu şeması (lyrics.json, schema 1): zamanlar ŞARKI saniyesinde (hızdan bağımsız):
//   { schema, version, source: "auto"|"pasted", language: "tr"|"en"|"ja", duration,
//     lines: [{ t: başlangıç, e: bitiş, text, w: [[bas, bit, kelime], ...] }] }
// Durum (status.lyrics): running | done | no_vocals | no_lyrics | error (yoksa: hiç
// istenmemiş). done iken: source, language, version, warning ("text_mismatch"),
// parent_stems_version (ana şarkı sonradan yeniden işlendiyse stale), last_attempt.

export const LANG_CHOICES = [
  ["auto", "Otomatik"], ["tr", "Türkçe"], ["en", "English"], ["ja", "日本語"],
];
export const LANGS = ["tr", "en", "ja"];

// Şu anki satır: son başlayan satır; sonrasında bu kadar sn geçtiyse (ara müzik)
// vurgu kalkar.
export const HOLD_SECONDS = 3.0;
// Vurgu ve otomatik kaydırma satırı bu kadar ERKEN başlatır: ölçümde stable yolu satır
// başları ortanca +0.25 sn geç çıkmıştı. YALNIZ görsel; dokunup atlama (satır t'si) ve
// uzun-basma döngüsü uçları DEĞİŞMEZ.
export const HIGHLIGHT_LEAD_SECONDS = 0.25;

export function highlightTime(time) {
  return time + HIGHLIGHT_LEAD_SECONDS;
}
// Uzun-basma döngüsünde sonraki satır bu kadar sn'den uzaksa (ara müzik) döngü
// satırın bitişinden kısa bir pay sonra biter: sessizlikte dönmesin.
export const GAP_CAP_SECONDS = 6.0;
export const GAP_TAIL_SECONDS = 1.0;
// "Zamanı düzelt": kullanıcı satırın başladığını DUYUP dokunur; tepki gecikmesi kadar geriye al.
export const TIMING_REACTION_SECONDS = 0.25;
// Sunucudaki 40 dk takılma kuralıyla aynı.
export const LYRICS_STALE_SECONDS = 2400;
export const MAX_TEXT_LINES = 400;        // sunucu sınırıyla aynı
export const MAX_TEXT_CHARS = 30000;

export function lyricsOf(status) {
  return status ? status.lyrics : undefined;
}

export function isRunning(lyr, nowSec = Date.now() / 1000) {
  if (!lyr || lyr.state !== "running") return false;
  return nowSec - (Number(lyr.started) || 0) < LYRICS_STALE_SECONDS;
}

/** Ana şarkı sözlerden SONRA yeniden işlendi mi ("eski ayrıştırmadan")? */
export function isStale(status) {
  const lyr = lyricsOf(status);
  if (!lyr || lyr.state !== "done") return false;
  const parent = Number(lyr.parent_stems_version);
  const current = Number(status.stems_version);
  if (!parent || !current) return false;
  return parent !== current;
}

/**
 * Sunucu cevabını/önbellek kaydını doğrular. Geçersizse null. Dönen satırlar
 * zamana göre sıralı, her biri {t, e, text}; kelime dizisi `w` korunur ama
 * bu sürümde kullanılmıyor (yalnız satır düzeyi vurgu).
 */
export function normalizeDoc(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.lines)) return null;
  const lines = [];
  for (const item of doc.lines) {
    if (!item || typeof item.text !== "string") continue;
    const t = Number(item.t);
    const e = Number(item.e);
    if (!Number.isFinite(t) || t < 0) continue;
    const text = item.text.trim();
    if (!text) continue;
    const line = { t, e: Number.isFinite(e) && e >= t ? e : t, text, w: Array.isArray(item.w) ? item.w : [] };
    if (item.c === 0) line.c = 0;          // düşük güven: metin sesle eşleşmedi, yeri kestirme
    if (item.m) line.m = 1;                // elle konan zaman (yeniden hizalamada çapa)
    lines.push(line);
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.t - b.t);
  return {
    version: Number(doc.version) || 0,
    source: doc.source === "pasted" ? "pasted" : "auto",
    language: LANGS.includes(doc.language) ? doc.language : null,
    duration: Number(doc.duration) || 0,
    lines,
  };
}

/**
 * O anki satırın dizini (yoksa -1). Son başlayan satır; ilk satırdan önce -1;
 * satırın bitişinden HOLD_SECONDS sonrası (ara müzik) yine -1.
 * İkili arama: her kare çağrılıyor.
 */
export function findLine(lines, time, hold = HOLD_SECONDS) {
  if (!lines || !lines.length || !Number.isFinite(time)) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return -1;
  // Biten satırdan sonra ara müzik: sonraki satır başlayana kadar vurgu kalkar.
  if (time > lines[found].e + hold) return -1;
  return found;
}

/** Dokunma anındaki şarkı konumundan satırın yeni başlangıcı (tepki payı düşülür, 0'ın altına inmez). */
export function fixTime(time) {
  return Math.max(0, Math.round((time - TIMING_REACTION_SECONDS) * 100) / 100);
}

/** m:ss (bölüm aralıklarını göstermek için). */
export function formatClock(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function normText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Düzenlenmiş metinde elle konan zamanları taşır: eski belgedeki elle satırlar (m) yeni metinde AYNI
 * metinle, eski sıraya göre ilerleyerek bulunur. Satırlar eklenip silinse de eşleşenler çapa kalır.
 * Dönen: [{i, t}] (i yeni metindeki sıra, t artan).
 */
export function mapManual(oldLines, newTexts) {
  const out = [];
  let from = 0;
  let lastTime = -1;
  for (const line of oldLines || []) {
    if (!line.m) continue;
    const wanted = normText(line.text);
    let found = -1;
    for (let k = from; k < newTexts.length; k += 1) {
      if (normText(newTexts[k]) === wanted) { found = k; break; }
    }
    if (found < 0 || !(line.t > lastTime)) continue;
    out.push({ i: found, t: Math.round(line.t * 100) / 100 });
    from = found + 1;
    lastTime = line.t;
  }
  return out;
}

/** Sunucunun döndürdüğü değişen satırları (i, t, e) yerel belgeye uygular; yeni belge döner. */
export function applyChanged(doc, changed, version) {
  const lines = doc.lines.map((line) => ({ ...line }));
  for (const item of changed || []) {
    const line = lines[item.i];
    if (!line) continue;
    const delta = item.t - line.t;
    line.t = item.t;
    line.e = Number.isFinite(item.e) ? item.e : line.e + delta;
    line.m = 1;
    delete line.c;
    line.w = (line.w || []).map(([a, b, word]) => [a + delta, b + delta, word]);
    if (item.i > 0 && lines[item.i - 1].e > item.t - 0.02) {
      lines[item.i - 1].e = Math.max(lines[item.i - 1].t + 0.05, item.t - 0.02);
    }
  }
  return { ...doc, lines, version: Number(version) || doc.version };
}

/**
 * "Şimdiye dön" için kaydırma hedefi: o anki satır; ara müzikteyse sıradaki satır;
 * hepsi bittiyse son satır; henüz başlamadıysa ilk satır. Satır yoksa -1.
 */
export function scrollTarget(lines, time) {
  if (!lines || !lines.length || !Number.isFinite(time)) return -1;
  const current = findLine(lines, time);
  if (current >= 0) return current;
  const upcoming = lines.findIndex((line) => line.t > time);
  return upcoming >= 0 ? upcoming : lines.length - 1;
}

/**
 * Bir satırı A-B döngüye çevirir: A = satır başı, B = sonraki satırın başı (son
 * satırda satır bitişi). Sonraki satır GAP_CAP_SECONDS'tan uzaksa (ara müzik) B =
 * satır bitişi + GAP_TAIL_SECONDS. minLen'den kısaysa B uzatılır (şarkı sonunu
 * geçmez). Dönen {a, b} ya da null (şarkı sonunda minLen sığmıyor).
 */
export function lineLoop(lines, index, duration, minLen) {
  const line = lines && lines[index];
  if (!line) return null;
  const next = lines[index + 1];
  let a = line.t;
  let b;
  if (next) {
    b = next.t - line.e > GAP_CAP_SECONDS ? line.e + GAP_TAIL_SECONDS : next.t;
  } else {
    b = line.e;
  }
  if (Number.isFinite(duration) && duration > 0) b = Math.min(b, duration);
  if (b - a < minLen) {
    b = a + minLen;
    if (Number.isFinite(duration) && duration > 0 && b > duration) {
      b = duration;
      a = Math.max(0, b - minLen);           // sona yaslan: önceye uzat
    }
  }
  if (!(b - a >= minLen - 1e-6)) return null;
  return { a, b };
}

/** Düzenleme kutusu için: satırlar alt alta (boş satır yok). */
export function linesToText(lines) {
  return (lines || []).map((line) => line.text).join("\n");
}

/** Kutudaki metni sunucunun kurallarına göre denetler: {lines, error}. */
export function checkText(text) {
  if (typeof text !== "string") return { lines: [], error: "Metin gerekli." };
  if (text.length > MAX_TEXT_CHARS) {
    return { lines: [], error: `Metin en fazla ${MAX_TEXT_CHARS} karakter olabilir.` };
  }
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!lines.length) return { lines: [], error: "Metin boş." };
  if (lines.length > MAX_TEXT_LINES) {
    return { lines: [], error: `En fazla ${MAX_TEXT_LINES} satır olabilir.` };
  }
  return { lines, error: null };
}

// Ölçülen (PLAN.md Aşama 11): T4, Zeus auto 20.8 sn, NEM pasted 17.2 sn (model yükleme
// dahil); soğuk konteyner boot'u eklenir. T4 saniyesi $0.000164.
const USD_PER_SECOND = 0.000164;

export function estimateLyrics(durationSec) {
  const duration = Math.max(0, Number(durationSec) || 0);
  const seconds = Math.round(30 + 0.06 * duration);
  const usd = Math.round(seconds * USD_PER_SECOND * 1000) / 1000;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return { seconds, minutes, usd, text: `~${minutes} dk, ~$${usd.toFixed(3).replace(/0$/, "")}` };
}

/**
 * Yapıştır-hizala sonucundaki eşleşme bilgisinden (status.lyrics.match) açıklayıcı notlar:
 * eşleşme yüzdesi, düşük güvenle yerleştirilen satırlar, metinde olmayan bölümler.
 */
export function matchNotices(lyr) {
  const match = lyr && lyr.match;
  if (!match || lyr.source !== "pasted") return [];
  if (match.method !== "anchored") {
    return [{ tone: "info", text: "Sözler tek parça hizalandı (ses eşleşmesi kullanılamadı)" }];
  }
  const notices = [];
  const percent = Math.round(Number(match.match_ratio || 0) * 100);
  const low = (match.low_confidence_lines || []).length;
  let text = `Metnin %${percent}'i sesle eşleşti`;
  if (low) text += ` · ${low} satır düşük güvenle yerleştirildi (soluk)`;
  notices.push({ tone: percent < 50 ? "warn" : "info", text });
  const gaps = (match.gaps || []).filter((gap) => gap[1] - gap[0] >= 5);
  if (gaps.length) {
    const shown = gaps.slice(0, 3).map((gap) => `${formatClock(gap[0])}–${formatClock(gap[1])}`).join(", ");
    const more = gaps.length > 3 ? ` +${gaps.length - 3}` : "";
    notices.push({ tone: "info", text: `Seste olup metinde olmayan bölümler: ${shown}${more} (nakarat tekrarı eksik olabilir)` });
  }
  return notices;
}

const NOTICE = {
  mismatch: "Metin sesle uyuşmuyor olabilir",
  stale: "Sözler eski ayrıştırmadan, yeniden hizala",
  noVocals: "Bu şarkıda vokal yok",
  noLyrics: "Bu sesten söz çıkarılamadı",
  failed: "Sözler çıkarılamadı",
  retryFailed: "Son deneme başarısız oldu, önceki sözler duruyor",
  running: "Sözler hazırlanıyor… (bu ekranda kalabilirsin)",
};
export const LYRICS_MESSAGES = NOTICE;

/**
 * Söz bölümünün durumu.
 *   status    şarkı durumu (status.lyrics + stems_version)
 *   hasDoc    cihazda gösterilecek söz var mı
 *   starting  istek gidiyor
 *   offline   sunucuya ulaşılamıyor
 * çıktı: { kind, text, notices: [{tone, text}], canExtract, canPaste, canEdit, canRealign,
 *          disabled, hint, estimate }
 *   kind none | running | no_vocals | no_lyrics | error | ready
 */
export function sectionView({
  status, hasDoc = false, duration = 0, offline = false, starting = false,
  nowSec = Date.now() / 1000,
}) {
  const lyr = lyricsOf(status);
  const base = {
    kind: "none", text: "", notices: [], canExtract: false, canPaste: false,
    canEdit: false, canRealign: false, canFix: false, disabled: false, hint: offline ? "İnternet yok" : "",
    estimate: estimateLyrics(duration).text,
  };
  if (starting || isRunning(lyr, nowSec)) {
    return { ...base, kind: "running", text: NOTICE.running, hint: "" };
  }
  const state = lyr && lyr.state;
  if (state === "no_vocals") {
    return { ...base, kind: "no_vocals", text: NOTICE.noVocals, hint: "" };
  }
  if (state === "done" || (hasDoc && state !== "running")) {
    const notices = [];
    if (lyr && lyr.warning === "text_mismatch") notices.push({ tone: "warn", text: NOTICE.mismatch });
    notices.push(...matchNotices(lyr));
    const stale = isStale(status);
    if (stale) notices.push({ tone: "warn", text: NOTICE.stale });
    if (lyr && lyr.last_attempt) {
      const attempt = lyr.last_attempt.state;
      notices.push({ tone: "info", text: attempt === "no_lyrics" ? NOTICE.noLyrics : NOTICE.retryFailed });
    }
    return {
      ...base, kind: "ready", notices, canEdit: true, canRealign: stale && hasDoc, canFix: hasDoc,
      disabled: offline,
    };
  }
  if (state === "no_lyrics") {
    return {
      ...base, kind: "no_lyrics", text: NOTICE.noLyrics, canPaste: true, disabled: offline,
    };
  }
  if (state === "error") {
    return {
      ...base, kind: "error", text: NOTICE.failed, canExtract: true, canPaste: true,
      disabled: offline,
    };
  }
  return { ...base, canExtract: true, canPaste: true, disabled: offline };
}

// ---------------------------------------------------------------- cihaz önbelleği
// lyrics.json cihazda tutulur (çevrimdışı çalışsın). Depolama dışarıdan verilir
// (localStorage benzeri: getItem/setItem/removeItem/key/length): node ile test.

export const CACHE_PREFIX = "stem-mikser.lyrics.";
export const CACHE_LIMIT = 40;           // şarkı başına ~10-40 KB

export function readCache(storage, id) {
  try {
    const raw = storage.getItem(CACHE_PREFIX + id);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    const doc = normalizeDoc(entry && entry.doc);
    return doc ? { version: Number(entry.version) || 0, savedAt: Number(entry.savedAt) || 0, doc } : null;
  } catch {
    return null;
  }
}

export function writeCache(storage, id, doc, version, now = Date.now()) {
  try {
    storage.setItem(CACHE_PREFIX + id, JSON.stringify({ version: Number(version) || 0, savedAt: now, doc }));
    pruneCache(storage);
    return true;
  } catch {
    return false;       // kota dolu: önemli değil, söz yine ağdan gelir
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
