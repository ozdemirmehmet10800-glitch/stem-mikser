// Yükleme sırası (çoklu şarkı ekleme): yüklenmeyi bekleyen dosyalar telefonda (IndexedDB) tutulur. Uygulama kapanır ya da internet
// giderse yarım kalan sıra, uygulama yeniden açılınca kaldığı yerden sürer. Sunucuya ve depoya hiçbir şey gitmez; yalnız bu telefonda.
//
// Kayıt: {id, file (File), name, size, quality, addedAt}. Başarıyla yüklenen ya da kalıcı hata veren (çok büyük, ses değil, iptal)
// dosya silinir; ağ/sunucu hatasında kalır. QUEUE_MAX_AGE_MS'den eski kayıt kendiliğinden silinir (unutulmuş sıra GPU açmasın).
// IndexedDB yoksa/reddedilirse (özel pencere, kota) hata atmaz: sıra yalnız bellekte yürür (eskisi gibi).

const DB_NAME = "stem-mikser-uploads";
const STORE = "queue";
export const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function openDb(idb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!idb) {
      reject(new Error("IndexedDB yok"));
      return;
    }
    const request = idb.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB engelli"));
  });
}

async function run(mode, action, idb) {
  const db = await openDb(idb);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("işlem iptal"));
    });
  } finally {
    db.close();
  }
}

let counter = 0;
function newId(now) {
  counter = (counter + 1) % 1000;
  return `${now}-${String(counter).padStart(3, "0")}`;
}

/** Dosyaları sıraya yazar. Dönen: [{id, file, name, size, quality}] (kaydedilemeyenlerin id'si null: yalnız bellekte). */
export async function enqueue(files, quality, { idb = globalThis.indexedDB, now = Date.now() } = {}) {
  const items = files.map((file) => ({ id: newId(now), file, name: file.name || "sarki", size: file.size || 0, quality: quality || null, addedAt: now }));
  try {
    await run("readwrite", (store) => { for (const item of items) store.put(item); return null; }, idb);
    return items;
  } catch {
    return items.map((item) => ({ ...item, id: null }));
  }
}

/** Bekleyenler (eskiden yeniye). Eski kayıtlar silinir. Hata: []. */
export async function pending({ idb = globalThis.indexedDB, now = Date.now() } = {}) {
  try {
    const all = (await run("readonly", (store) => store.getAll(), idb)) || [];
    const fresh = all.filter((item) => item && item.file && now - (Number(item.addedAt) || 0) <= QUEUE_MAX_AGE_MS);
    const stale = all.filter((item) => !fresh.includes(item)).map((item) => item.id);
    if (stale.length) await remove(stale, { idb });
    return fresh.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  } catch {
    return [];
  }
}

/** Sıradan siler (yüklendi ya da kalıcı hata). */
export async function remove(ids, { idb = globalThis.indexedDB } = {}) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return true;
  try {
    await run("readwrite", (store) => { for (const id of list) store.delete(id); return null; }, idb);
    return true;
  } catch {
    return false;
  }
}

/** Hata kalıcı mı (dosya sıradan çıkar) yoksa yeniden denenebilir mi (internet/sunucu; sırada kalır)? */
export function isRetryable(reason) {
  return reason === "offline" || reason === "network" || reason === "server";
}
