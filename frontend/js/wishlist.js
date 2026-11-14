// "Eklenecekler" (istek listesi): SAF mantık. DOM, ağ, depolama yok; node ile test ediliyor: node tests\wishlist_test.mjs
//
// Kaynaklar: (1) Paylaş menüsünden gelen metin/bağlantı (ör. YouTube Music'ten bir şarkı), (2) Google Takeout CSV'leri, (3) elle.
// KURAL: bağlantılara HİÇBİR İSTEK atılmaz, hiçbir şey indirilmez; bağlantı yalnız kullanıcı dokununca tarayıcıda açılır.
// Şarkı adı/sanatçı yalnız verilen metinden ve CSV sütunlarından okunur. Veri yalnız telefonda kalır (collection belgesi).

import { fold, queryTokens } from "./songfilter.js";

export const WISH_LIMIT = 2000;                 // en çok kayıt (localStorage tek anahtarı şişmesin)
export const WISH_TITLE_MAX = 160;
export const WISH_ARTIST_MAX = 120;
export const WISH_URL_MAX = 500;
export const WISH_FROM_MAX = 60;
export const CSV_MAX_ROWS = 20000;
export const MATCH_THRESHOLD = 0.8;

const TRACKING = /^(si|feature|pp|utm_[a-z]+|fbclid|igshid|gclid|ref|app)$/i;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// ------------------------------------------------------------------ bağlantı

/** Güvenli bağlantı ya da "": yalnız http/https, izleme parametreleri atılır, uzunluk sınırlı. */
export function cleanUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (url.username || url.password) return "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  const out = url.href;
  return out.length > WISH_URL_MAX ? "" : out;
}

/** YouTube / YouTube Music bağlantısından video kimliği (11 karakter) ya da "". Ağa gitmez. */
export function videoIdOf(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return "";
  }
  const host = parsed.hostname.replace(/^www\./, "").replace(/^m\./, "");
  let id = "";
  if (host === "youtu.be") id = parsed.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "music.youtube.com") id = parsed.searchParams.get("v") || "";
  return VIDEO_ID_RE.test(id) ? id : "";
}

/** Video kimliğinden YouTube Music bağlantısı (yalnız adres üretir; istek ATMAZ). */
export function musicUrlOf(videoId) {
  return VIDEO_ID_RE.test(String(videoId)) ? `https://music.youtube.com/watch?v=${videoId}` : "";
}

// ------------------------------------------------------------------ paylaşılan metin

const BOILERPLATE_HEAD = /^(?:listen to|check out|watch|now playing|dinle|izle|şuna göz at|bu şarkıyı dinle)\s*:?\s*/i;
const BOILERPLATE_TAIL = /\s+(?:on|at|için|—|-)?\s*youtube(?: music)?(?:'te| üzerinde)?\s*$/i;

function trimTitle(text, max) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/**
 * Paylaşım üçlüsünden {title, artist, url} ya da null (hiçbir şey yoksa). `url` temizlenir; ilk bağlantı alınır (metnin içinde
 * olabilir). Metin tek satırdır: "Ad • Sanatçı", "Ad by Sanatçı"; belirsiz ayraçta ("-") hepsi ad olur.
 */
export function parseSharedText({ title = "", text = "", url = "" } = {}) {
  const joined = [title, text, url].map((part) => String(part ?? "")).join("\n");
  const found = /https?:\/\/[^\s<>"']+/i.exec(String(url || "")) || /https?:\/\/[^\s<>"']+/i.exec(joined);
  const link = found ? cleanUrl(found[0].replace(/[.,;)\]]+$/, "")) : "";
  const withoutLinks = (value) => String(value ?? "").replace(/https?:\/\/[^\s<>"']+/gi, " ");
  const lines = [title, text]
    .flatMap((part) => withoutLinks(part).split(/\r?\n/))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const labels = lines.map((line) => line.replace(BOILERPLATE_HEAD, "").replace(BOILERPLATE_TAIL, "").replace(/^["“”'«»]+|["“”'«»]+$/g, "").trim());
  const split = (label) => {
    const dot = /\s[•·]\s/.exec(label);
    if (dot) return { name: label.slice(0, dot.index), artist: label.slice(dot.index + dot[0].length) };
    const byMatch = /^(.*?)\s+by\s+(.*)$/i.exec(label);
    return byMatch ? { name: byMatch[1], artist: byMatch[2] } : null;
  };
  // "Ad • Sanatçı" / "Ad by Sanatçı" biçimli ilk satır varsa o; yoksa ilk satırın tamamı ad
  let name = labels[0] || "";
  let artist = "";
  for (const label of labels) {
    const parts = split(label);
    if (parts) {
      name = parts.name;
      artist = parts.artist;
      break;
    }
  }
  name = trimTitle(name.replace(/^["“”'«»]+|["“”'«»]+$/g, ""), WISH_TITLE_MAX);
  artist = trimTitle(artist, WISH_ARTIST_MAX);
  if (!name && !link) return null;
  return { title: name, artist, url: link, vid: videoIdOf(link) };
}

// ------------------------------------------------------------------ eşleştirme

const NOISE = new Set([
  "official", "video", "videoclip", "audio", "lyrics", "lyric", "hd", "hq", "mv", "ft", "feat", "featuring", "clip", "music",
  "resmi", "klip", "sozleri", "sozlu", "the", "a", "an", "of", "and", "ve", "bir", "turkce", "cover",
]);

/** Katlanmış, gürültüsüz sözcükler (parantez ve köşeli ek notlar atılır). */
export function tokens(text) {
  return fold(String(text ?? "").replace(/[(\[][^)\]]*[)\]]/g, " "))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word && !NOISE.has(word));
}

/** İstek adının şarkı adında ne kadarı geçiyor (0..1); sanatçı da geçiyorsa küçük bir artış. Başlık yoksa 0. */
export function matchScore(wish, songTitle) {
  const want = [...new Set(tokens(wish.title))];
  if (!want.length) return 0;
  const have = new Set(tokens(songTitle));
  if (!have.size) return 0;
  const hit = want.filter((word) => have.has(word)).length;
  let score = hit / want.length;
  if (score < 1 && want.length === 1) return score;             // tek sözcük: ya tam ya hiç
  const artist = [...new Set(tokens(wish.artist))];
  if (artist.length && artist.filter((word) => have.has(word)).length / artist.length >= 0.5) score = Math.min(1, score + 0.1);
  // Tek sözcüklü istek yalnız KISA şarkı adıyla eşleşir ("Hello" -> "Hello Kitty Tema Müziği" olmasın)
  if (want.length === 1 && have.size > 4) return 0;
  return score;
}

/** Bekleyen isteklerden (done yok) şarkılarla eşleşenler: [{id, songId, score}]. Şarkı başına en iyi istek DEĞİL, istek başına en iyi şarkı. */
export function findMatches(wishes, songs, threshold = MATCH_THRESHOLD) {
  const out = [];
  for (const wish of wishes) {
    if (wish.done) continue;
    let best = null;
    for (const song of songs) {
      if (!song || !song.id) continue;
      const score = matchScore(wish, song.title || "");
      if (score >= threshold && (!best || score > best.score)) best = { id: wish.id, songId: song.id, score };
    }
    if (best) out.push(best);
  }
  return out;
}

/** Aynı isteği ayırt eden anahtar: video kimliği varsa o, yoksa katlanmış ad + sanatçı. */
export function wishKey(wish) {
  const vid = wish.vid || videoIdOf(wish.url || "");
  if (vid) return `yt:${vid}`;
  const name = tokens(wish.title).join(" ");
  if (!name) return wish.url ? `url:${wish.url}` : "";
  return `t:${name}|${tokens(wish.artist).join(" ")}`;
}

// ------------------------------------------------------------------ CSV (Google Takeout)

/** CSV metnini satırlara böler (tırnak, "" kaçışı, tırnak içi satır sonu, BOM, ayraç , ; sekme otomatik). */
export function parseCsv(input, maxRows = CSV_MAX_ROWS) {
  let text = String(input ?? "");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiters = [",", ";", "\t"];
  const counts = delimiters.map((d) => (firstLine.match(d === "\t" ? /\t/g : new RegExp(`\\${d}`, "g")) || []).length);
  const delimiter = delimiters[counts.indexOf(Math.max(...counts))];
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length >= maxRows + 1) return rows;
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

const TITLE_HEADS = ["song title", "track name", "track title", "video title", "sarki adi", "parca adi", "sarki", "baslik", "title", "name", "ad"];
const ARTIST_HEADS = ["artist name 1", "artist name", "artist", "artists", "performer", "sanatci", "sanatci adi", "channel title", "channel", "kanal"];

function findColumn(headers, candidates, exclude = []) {
  for (const candidate of candidates) {
    const index = headers.findIndex((head, i) => !exclude.includes(i) && head === candidate);
    if (index >= 0) return index;
  }
  for (const candidate of candidates) {
    const index = headers.findIndex((head, i) => !exclude.includes(i) && head.startsWith(candidate));
    if (index >= 0) return index;
  }
  return -1;
}

/** Sütun başlıklarından yerler: {title, artist, id, url} (-1 = yok). Başlık adlarına KATI bağlı değil: ilk eşleşen aday. */
export function pickColumns(headerRow) {
  const headers = headerRow.map((cell) => fold(cell).replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim());
  const id = headers.findIndex((head) => head === "video id" || head === "videoid" || head === "video kimligi" || head === "video id 1");
  const url = headers.findIndex((head) => head === "video url" || head === "url" || head === "link" || head === "baglanti");
  const title = findColumn(headers, TITLE_HEADS, [id, url]);
  const artist = findColumn(headers, ARTIST_HEADS, [id, url, title]);
  return { title, artist, id, url, headers };
}

/**
 * Tek CSV metninden istekler: {entries: [{title, artist, url, vid}], rows, untitled, kind}.
 *   kind: "songs" (başlık sütunu var) | "ids" (yalnız video kimliği: başlıksız, bağlantı üretilir) | "meta" (liste üst verisi: Playlist ID...) |
 *         "unknown" (şarkı sütunu bulunamadı).
 * Üst veri dosyaları (playlists.csv: "Playlist ID, ... Title") şarkı SAYILMAZ.
 */
export function wishesFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { entries: [], rows: 0, untitled: 0, kind: "unknown" };
  const columns = pickColumns(rows[0]);
  const hasPlaylistId = columns.headers.some((head) => head === "playlist id" || head === "playlistid");
  if (hasPlaylistId && columns.id < 0) return { entries: [], rows: rows.length - 1, untitled: 0, kind: "meta" };
  const body = rows.slice(1);
  const entries = [];
  let untitled = 0;
  if (columns.title >= 0) {
    for (const row of body) {
      const title = trimTitle(row[columns.title], WISH_TITLE_MAX);
      if (!title) continue;
      const rawId = columns.id >= 0 ? String(row[columns.id] || "").trim() : "";
      const link = cleanUrl(columns.url >= 0 ? row[columns.url] : "") || musicUrlOf(rawId);
      entries.push({
        title, artist: columns.artist >= 0 ? trimTitle(row[columns.artist], WISH_ARTIST_MAX) : "", url: link, vid: videoIdOf(link),
      });
    }
    return { entries, rows: body.length, untitled: 0, kind: "songs" };
  }
  if (columns.id >= 0 || columns.url >= 0) {
    for (const row of body) {
      const link = cleanUrl(columns.url >= 0 ? row[columns.url] : "") || musicUrlOf(columns.id >= 0 ? String(row[columns.id] || "").trim() : "");
      if (!link) continue;
      entries.push({ title: "", artist: "", url: link, vid: videoIdOf(link) });
      untitled += 1;
    }
    return { entries, rows: body.length, untitled, kind: "ids" };
  }
  return { entries: [], rows: body.length, untitled: 0, kind: "unknown" };
}

// ------------------------------------------------------------------ arama

/** Eklenecekler araması: sorgunun her sözcüğü ad, sanatçı ya da kaynak etiketinde geçmeli (Türkçe/aksan/büyük-küçük katlamalı). Boş sorgu = hepsi. */
export function wishMatchesQuery(wish, query) {
  const words = queryTokens(query);
  if (!words.length) return true;
  const text = fold([wish.title, wish.artist, wish.from].filter(Boolean).join(" "));
  return words.every((word) => text.includes(word));
}

// ------------------------------------------------------------------ özet cümlesi

/** İçe aktarma özeti (kullanıcıya tek paragraf). r: {files, found, added, duplicate, untitled, skippedFiles, limit}. */
export function importSummary(r) {
  if (!r.found) {
    return r.files
      ? "Seçtiğin dosyalarda şarkı listesi bulunamadı. Takeout'ta YouTube Music ya da beğendiğin videoların CSV dosyaları gerekir."
      : "Dosya seçilmedi.";
  }
  const parts = [`${r.found} kayıt bulundu`, `${r.added} yeni eklendi`];
  if (r.duplicate) parts.push(`${r.duplicate} zaten vardı`);
  let text = `${parts.join(", ")}.`;
  if (r.untitled) text += ` ${r.untitled} kayıtta başlık yok (Takeout yalnız video kimliği vermiş): yalnız bağlantı eklendi.`;
  if (r.limit) text += ` Üst sınır ${WISH_LIMIT} kayıt: ${r.limit} kayıt eklenemedi.`;
  return text;
}
