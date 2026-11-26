// "Sözleri bul": açık söz veritabanı LRCLIB'de (lrclib.net, anahtarsız, CORS açık) şarkı adı + sanatçıyla arama. SAF: DOM/ses YOK,
// ağ yalnız `searchLyrics`e verilen fetch ile. node tests\lyricsfind_test.mjs
//
// Gizlilik: yalnız kullanıcının "Ara"ya ya da "Sözleri bul"a bastığında, yalnız şarkı adı ve sanatçı gider; çerez/referrer GİTMEZ.
// Bulunan metin kullanıcı seçip "Hizala" deyince "yapıştır ve hizala" ile sese oturtulur (sunucuda Volume'da kalır, depoya girmez).

import { searchTerms } from "./cover.js";

export const LRCLIB_SEARCH = "https://lrclib.net/api/search";
export const FIND_MAX = 6;
export const FIND_TIMEOUT_MS = 15000;

// Sürüm etiketleri: adın kendisi değil (slowed, nightcore, lyrics...). Parantez içindekiler searchTerms'te zaten atılıyor.
const TAG_RE = new RegExp(
  "(?<![\\p{L}\\p{N}])(?:slowed(?:\\s*(?:\\+|and|&)\\s*reverb(?:ed)?)?|reverb(?:ed)?|sped\\s*up|speed\\s*up|nightcore|daycore|8d(?:\\s*audio)?|"
  + "bass\\s*boosted|lyrics?|lyric\\s*video|official(?:\\s*(?:music|lyric))?\\s*(?:video|audio)|official|audio|visuali[sz]er|"
  + "hd|hq|4k|mv|m/v|karaoke|instrumental|cover|(?:türkçe|turkce|turkish)(?:\\s*(?:çeviri|ceviri|translation|sub(?:title)?s?|version))?|"
  + "altyaz[ıi]l[ıi]|tiktok\\s*version|extended)(?![\\p{L}\\p{N}])", "giu");

function tidy(text) {
  return String(text || "").replace(/\s*[|/]\s*$/, "").replace(/\s+/g, " ").replace(/^[\s\-–—:+&|]+|[\s\-–—:+&|]+$/g, "").trim();
}

/** Şarkı başlığı (genelde dosya/video adı) -> {artist, title}: uzantı, alt çizgi, sürüm etiketleri ve parantez notları atılır. */
export function lyricsSearchTerms(rawTitle) {
  let text = String(rawTitle || "").normalize("NFC")
    .replace(/\.(?:mp3|m4a|mp4|wav|flac|ogg|opus|webm|aac)$/i, "")
    .replace(/_/g, " ");
  text = text.replace(/[(\[{][^)\]}]*[)\]}]/g, " ");
  const terms = searchTerms(text);
  return { artist: tidy(terms.artist.replace(TAG_RE, " ")), title: tidy(terms.title.replace(TAG_RE, " ")) };
}

/** Arama adresleri, sırayla denenir: (ad + sanatçı), (serbest metin), (yalnız ad). Ad boşsa []. */
export function searchUrls({ artist = "", title = "" }) {
  const name = tidy(title);
  const by = tidy(artist);
  if (!name) return [];
  const urls = [];
  if (by) {
    urls.push(`${LRCLIB_SEARCH}?track_name=${encodeURIComponent(name)}&artist_name=${encodeURIComponent(by)}`);
    urls.push(`${LRCLIB_SEARCH}?q=${encodeURIComponent(`${by} ${name}`)}`);
  }
  urls.push(`${LRCLIB_SEARCH}?track_name=${encodeURIComponent(name)}`);
  return urls;
}

export function fold(text) {
  return String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("tr")
    .replace(/ı/g, "i").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function closeness(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.7;
  const wx = new Set(x.split(" "));
  const wy = y.split(" ");
  const common = wy.filter((w) => wx.has(w)).length;
  return common ? 0.5 * common / Math.max(wx.size, wy.length) : 0;
}

/** LRCLIB `syncedLyrics` ("[00:12.34] satır") -> düz metin. */
export function stripSynced(text) {
  return String(text || "").split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*)+/, "").replace(/^\s*\[[a-z]{2,6}:[^\]]*\]\s*$/i, "").trim())
    .join("\n");
}

/** Bir kaydın düz sözleri (boş satırlar atılır); yoksa "". */
export function plainOf(record) {
  const raw = (record && (record.plainLyrics || stripSynced(record.syncedLyrics))) || "";
  return String(raw).split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/**
 * Yanıt dizisi -> en çok FIND_MAX aday: [{id, title, artist, album, duration, synced, text, lines, score}].
 * Enstrümantal ve sözü olmayanlar atılır; aynı metin bir kez. Sıra: ad > sanatçı > süre yakınlığı (slowed/nightcore'da süre
 * farklı olabileceği için süre zayıf bir işaret) > senkronlu.
 */
export function rankResults(records, { artist = "", title = "", duration = 0 } = {}) {
  const list = Array.isArray(records) ? records : [];
  const seen = new Set();
  const out = [];
  for (const record of list) {
    if (!record || record.instrumental) continue;
    const text = plainOf(record);
    if (!text) continue;
    const key = fold(text).slice(0, 400);
    if (seen.has(key)) continue;
    seen.add(key);
    const length = Number(record.duration) || 0;
    let timeScore = 0;
    if (duration > 0 && length > 0) {
      const ratio = Math.abs(length - duration) / duration;
      timeScore = ratio < 0.03 ? 1 : ratio < 0.1 ? 0.6 : ratio < 0.3 ? 0.3 : 0;
    }
    const score = 3 * closeness(record.trackName, title) + (artist ? 2 * closeness(record.artistName, artist) : 0)
      + timeScore + (record.syncedLyrics ? 0.2 : 0);
    out.push({
      id: record.id, title: String(record.trackName || ""), artist: String(record.artistName || ""),
      album: String(record.albumName || ""), duration: length, synced: Boolean(record.syncedLyrics),
      text, lines: text.split("\n").length, score: Math.round(score * 100) / 100,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, FIND_MAX);
}

/** Metnin dili (tr/en/ja/ru) ya da emin değilse "auto". */
export function guessLanguage(text) {
  const source = String(text || "");
  const letters = source.match(/\p{L}/gu) || [];
  if (letters.length < 4) return "auto";
  const count = (re) => (source.match(re) || []).length;
  const cyr = count(/[А-Яа-яЁё]/g);
  const jp = count(/[぀-ヿ㐀-䶿一-鿿]/g);
  if (cyr / letters.length > 0.5) return "ru";
  if (jp / letters.length > 0.3) return "ja";
  const latin = count(/[A-Za-zÇçĞğİıÖöŞşÜü]/g);
  if (latin / letters.length < 0.6) return "auto";
  const words = fold(source).split(" ");
  const trHits = words.filter((w) => TR_WORDS.has(w)).length;
  const enHits = words.filter((w) => EN_WORDS.has(w)).length;
  if (count(/[ğışİĞŞ]/g) >= 2 || trHits > enHits * 1.5 + 1) return "tr";
  if (enHits > trHits) return "en";
  return "auto";
}
const TR_WORDS = new Set(("ve bir bu ben sen o biz siz ne de da ki mi mu gibi icin ama cok yok var beni seni bana sana gel git "
  + "gibi daha her hic simdi artik kadar ile olan oldu benim senin askim gece gun kalbim").split(" "));
const EN_WORDS = new Set(("the and you i me my your to of in it is on that we be for all love are was with no not this so "
  + "what can just like know don t when oh baby").split(" "));

/** Sırayla adresleri dener, ilk boş olmayan sonucu sıralanmış döndürür. fetchImpl: fetch. Hata: Error(kind: offline|busy|network). */
export async function searchLyrics(query, { fetchImpl = globalThis.fetch, duration = 0, timeoutMs = FIND_TIMEOUT_MS } = {}) {
  const urls = searchUrls(query);
  let lastError = null;
  for (const url of urls) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" }, referrerPolicy: "no-referrer", credentials: "omit",
        signal: controller ? controller.signal : undefined,
      });
      if (response.status === 429 || response.status === 503) {
        const error = new Error("busy");
        error.kind = "busy";
        throw error;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const ranked = rankResults(await response.json(), { ...query, duration });
      if (ranked.length) return ranked;
    } catch (error) {
      if (error && error.kind === "busy") throw error;
      lastError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (lastError) {
    const error = new Error("network");
    error.kind = "network";
    throw error;
  }
  return [];
}

export function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return "";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
