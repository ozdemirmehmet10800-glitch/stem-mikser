// Kapak kayıtları: YALNIZ bu cihazda, IndexedDB'de (kapak resimleri localStorage'a sığmaz). Sunucuya ve depoya hiçbir şey gitmez.
// Şarkı başına tek kayıt: {source: "user"|"found"|"embedded"|"none", blob?, savedAt}. IndexedDB yoksa/reddedilirse hata atmaz:
// getMany boş döner, put false döner; uygulama otomatik kapaklarla çalışır.
//
// Ayrı bir veritabanı (stem-mikser-covers): "Önbelleği temizle" / "Çevrimdışı kopyaları sil" buna DOKUNMAZ (Cache Storage'dır);
// sürüm geçişlerinde de silinmez.

const DB_NAME = "stem-mikser-covers";
const STORE = "covers";

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

async function withStore(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      try {
        result = action(tx.objectStore(STORE));
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(typeof result === "function" ? result() : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("işlem iptal"));
    });
  } finally {
    db.close();
  }
}

export const coverStore = {
  /** ids -> Map(id -> kayıt). Okunamazsa boş Map. */
  async getMany(ids) {
    const found = new Map();
    try {
      await withStore("readonly", (store) => {
        const requests = ids.map((id) => ({ id, request: store.get(id) }));
        return () => {
          for (const { id, request } of requests) {
            if (request.result) found.set(id, request.result);
          }
        };
      });
    } catch {
      return new Map();
    }
    return found;
  },

  /** Tüm kayıtlar: Map(id -> kayıt) (kapak yedeği için). Okunamazsa boş Map. */
  async all() {
    const out = new Map();
    try {
      await withStore("readonly", (store) => {
        const keys = store.getAllKeys();
        const values = store.getAll();
        return () => {
          keys.result.forEach((key, index) => {
            if (values.result[index]) out.set(String(key), values.result[index]);
          });
        };
      });
    } catch {
      return new Map();
    }
    return out;
  },

  async put(id, record) {
    try {
      await withStore("readwrite", (store) => { store.put(record, id); });
      return true;
    } catch {
      return false;
    }
  },

  async delete(ids) {
    try {
      await withStore("readwrite", (store) => { for (const id of ids) store.delete(id); });
      return true;
    } catch {
      return false;
    }
  },
};
