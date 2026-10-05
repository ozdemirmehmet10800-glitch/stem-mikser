// Tam ekran sözlerin "kendi resmim / videom" arka planı: dosya YALNIZ bu cihazda, IndexedDB'de
// (localStorage'a sığmaz). Sunucuya ve depoya hiçbir şey gitmez. Tek kayıt: tüm şarkılar için tek ayar.
//
// IndexedDB yoksa/reddedilirse (özel pencere gibi) hata atmaz: null/false döner, uygulama
// "sade" arka planla devam eder.

const DB_NAME = "stem-mikser-bg";
const STORE = "files";
const KEY = "lyrics-bg";

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

/** {blob, name, type, size} ya da null. */
export async function getBackground() {
  try {
    const record = await run("readonly", (store) => store.get(KEY));
    return record && record.blob ? record : null;
  } catch {
    return null;
  }
}

/** Dosyayı kaydeder. Başarılıysa true (kota dolduysa false). */
export async function putBackground(file) {
  try {
    await run("readwrite", (store) => store.put(
      { blob: file, name: file.name || "arka plan", type: file.type || "", size: file.size || 0, savedAt: Date.now() },
      KEY));
    return true;
  } catch {
    return false;
  }
}

export async function clearBackground() {
  try {
    await run("readwrite", (store) => store.delete(KEY));
    return true;
  } catch {
    return false;
  }
}
