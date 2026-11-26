// Tam ekran sözlerin "kendi resmim / videom" arka planı: dosya YALNIZ bu cihazda, IndexedDB'de
// (localStorage'a sığmaz). Sunucuya ve depoya hiçbir şey gitmez. ŞARKI BAŞINA (2026-11-26): her şarkının kendi dosyası
// ("song:<id>"); kendi dosyası olmayan şarkı varsayılanı kullanır ("lyrics-bg": eski tek kayıt, tüm şarkılar).
//
// IndexedDB yoksa/reddedilirse (özel pencere gibi) hata atmaz: null/false döner, uygulama
// "sade" arka planla devam eder.

const DB_NAME = "stem-mikser-bg";
const STORE = "files";
const KEY = "lyrics-bg";                       // varsayılan (tüm şarkılar)
const songKey = (id) => `song:${id}`;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB yok"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB engelli"));
  });
}

async function run(mode, action) {
  const db = await openDb();
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

/** {blob, name, type, size, scope} ya da null. songId verilirse önce o şarkının kendi dosyası ("song"), yoksa varsayılan ("all"). */
export async function getBackground(songId = null) {
  try {
    if (songId) {
      const own = await run("readonly", (store) => store.get(songKey(songId)));
      if (own && own.blob) return { ...own, scope: "song" };
    }
    const record = await run("readonly", (store) => store.get(KEY));
    return record && record.blob ? { ...record, scope: "all" } : null;
  } catch {
    return null;
  }
}

/** Dosyayı kaydeder: songId varsa YALNIZ o şarkıya, yoksa varsayılan (tüm şarkılar). Başarılıysa true (kota dolduysa false). */
export async function putBackground(file, songId = null) {
  try {
    await run("readwrite", (store) => store.put(
      { blob: file, name: file.name || "arka plan", type: file.type || "", size: file.size || 0, savedAt: Date.now() },
      songId ? songKey(songId) : KEY));
    return true;
  } catch {
    return false;
  }
}

/** "Kaldır": şarkının kendi dosyası varsa onu siler ("song"), yoksa varsayılanı ("all"). Hata: null. */
export async function clearBackground(songId = null) {
  try {
    if (songId) {
      const own = await run("readonly", (store) => store.get(songKey(songId)));
      if (own) {
        await run("readwrite", (store) => store.delete(songKey(songId)));
        return "song";
      }
    }
    await run("readwrite", (store) => store.delete(KEY));
    return "all";
  } catch {
    return null;
  }
}

/** Silinen şarkıların kendi arka plan dosyaları da gitsin. */
export async function dropBackgrounds(ids) {
  if (!ids || !ids.length) return true;
  try {
    await run("readwrite", (store) => { for (const id of ids) store.delete(songKey(id)); return null; });
    return true;
  } catch {
    return false;
  }
}
