// Kitaplık sıralaması ve çalma sayacı: SAF mantık + depolama dışarıdan. node tests\sort_test.mjs
//
// Sıralar: "new" (sunucu sırası: yeniden eskiye, varsayılan), "name" (ada göre, Türkçe), "long" / "short" (süre), "played" (en çok çalınan).
// Çalma sayacı yalnız telefonda (`stem-mikser.plays`: {kimlik: sayı}), en çok 400 şarkı tutulur.

export const SORT_KEY = "stem-mikser.sort";
export const PLAYS_KEY = "stem-mikser.plays";
export const SORT_MODES = ["new", "name", "played", "long", "short"];
export const SORT_LABELS = { new: "Yeni", name: "Ada göre", played: "En çok çalınan", long: "En uzun", short: "En kısa" };
const PLAYS_MAX = 400;

export function normalizeSort(value) {
  return SORT_MODES.includes(value) ? value : "new";
}

export function readSort(storage) {
  try {
    return normalizeSort(storage.getItem(SORT_KEY));
  } catch {
    return "new";
  }
}

export function writeSort(storage, mode) {
  try {
    storage.setItem(SORT_KEY, normalizeSort(mode));
    return true;
  } catch {
    return false;
  }
}

export function readPlays(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(PLAYS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [id, count] of Object.entries(parsed)) {
      if (Number.isFinite(count) && count > 0 && /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/.test(id)) out[id] = Math.floor(count);
    }
    return out;
  } catch {
    return {};
  }
}

/** Sayacı 1 artırır; yazar. Dönen: yeni sayı (yazılamazsa da bellekteki değer). Sınırı aşınca en az çalınanlar atılır. */
export function bumpPlays(storage, id) {
  const plays = readPlays(storage);
  plays[id] = (plays[id] || 0) + 1;
  const entries = Object.entries(plays);
  if (entries.length > PLAYS_MAX) {
    entries.sort((a, b) => b[1] - a[1]);
    for (const [drop] of entries.slice(PLAYS_MAX)) delete plays[drop];
  }
  try {
    storage.setItem(PLAYS_KEY, JSON.stringify(plays));
  } catch {
    /* kota: sayaç bu sefer yazılamadı */
  }
  return plays[id] || 0;
}

/** Sıralı KOPYA (girdi değişmez). "new": olduğu gibi. Eşitlikte özgün (sunucu) sırası korunur. */
export function sortSongs(songs, mode, plays = {}) {
  const base = songs.map((song, index) => ({ song, index }));
  const title = (song) => String(song.title || song.id || "");
  const compare = {
    name: (a, b) => title(a.song).localeCompare(title(b.song), "tr", { sensitivity: "base", numeric: true }),
    played: (a, b) => (plays[b.song.id] || 0) - (plays[a.song.id] || 0),
    long: (a, b) => (Number(b.song.duration) || 0) - (Number(a.song.duration) || 0),
    short: (a, b) => {
      const da = Number(a.song.duration) || Infinity;
      const db = Number(b.song.duration) || Infinity;
      return da === db ? 0 : da - db;
    },
  }[normalizeSort(mode)];
  if (!compare) return [...songs];
  return base.sort((a, b) => compare(a, b) || a.index - b.index).map((item) => item.song);
}
