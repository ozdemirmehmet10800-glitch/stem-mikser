// Çalma sırası ("sıradakine ekle"): SAF mantık + depolama dışarıdan. node tests\queue_test.mjs
// Çalma listesinden (prova modu) bağımsız ve geçici: kitaplıkta şarkılara uzun basıp "Sıraya ekle"; şarkı bitince sıradaki başlar.
// Tek anahtar `stem-mikser.queue` (kimlik dizisi). Çalma listesi modunda sıra İŞLEMEZ (liste kendi sırasını yürütür).

export const QUEUE_KEY = "stem-mikser.queue";
export const QUEUE_MAX = 100;
const ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;

export function readQueue(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? sanitize(parsed) : [];
  } catch {
    return [];
  }
}

export function writeQueue(storage, ids) {
  try {
    storage.setItem(QUEUE_KEY, JSON.stringify(sanitize(ids)));
    return true;
  } catch {
    return false;
  }
}

/** Geçerli, tekrarsız, en çok QUEUE_MAX kimlik (sıra korunur). */
export function sanitize(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string" || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= QUEUE_MAX) break;
  }
  return out;
}

/** Sona ekler (zaten sırada olan eklenmez). Dönen {ids, added}. */
export function addToQueue(ids, more) {
  const before = sanitize(ids);
  const after = sanitize([...before, ...more]);
  return { ids: after, added: after.length - before.length };
}

export function removeFromQueue(ids, id) {
  return ids.filter((other) => other !== id);
}

/** Sıradaki ÇALINABİLİR kimlik: çalınamayanlar (silinmiş / hazır değil) atılır. Dönen {id, rest, dropped} (id null: çalınacak yok, rest boş). */
export function takeNext(ids, isPlayable) {
  const list = [...ids];
  let dropped = 0;
  while (list.length) {
    const id = list.shift();
    if (isPlayable(id)) return { id, rest: list, dropped };
    dropped += 1;
  }
  return { id: null, rest: [], dropped };
}
