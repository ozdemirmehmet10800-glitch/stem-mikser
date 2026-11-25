// Sahne klipleri: yüklenen klibin (videonun) kendisi YALNIZ bu telefonda, IndexedDB'de saklanır; sahne modunda arka planda sessizce, sesle
// senkron oynar. Sunucuya ve depoya hiçbir şey gitmez. Şarkı başına tek kayıt: {blob, name, type, size, savedAt}.
//
// Ayrı veritabanı (stem-mikser-clips): "Önbelleği temizle" / "Çevrimdışı kopyaları sil" buna DOKUNMAZ; yalnız Ayarlar'daki "Sahne kliplerini
// sil" ya da şarkı silinince gider. IndexedDB yoksa/reddedilirse hata atmaz (null/false/boş liste).   node tests\clipframe_test.mjs

const DB_NAME = "stem-mikser-clips";
const STORE = "clips";
export const CLIP_KEEP_KEY = "stem-mikser.clipkeep";       // "0": yüklenen klipleri saklama (varsayılan: sakla)
export const STAGE_CLIP_KEY = "stem-mikser.stageclip";     // sahnede klip: "0" kapalı, "full" tam (net), başka her şey karartılmış (varsayılan)
// Oynatıcıdaki Klip | Mikser anahtarı: "0" mikser görünümü, başka her şey klip görünümü (varsayılan: klip). Yeni anahtar: v79 ("playerclip")
// ve v80 ("mixerclip") seçimleri buna taşınmaz (o anahtarlar silinmez, yalnız okunmaz); güncellemeden sonra klip yine doğrudan görünür.
export const PLAYER_CLIP_KEY = "stem-mikser.clipview";
export const CLIP_MODES = ["dim", "full", "off"];          // sahnedeki film düğmesi bu sırayla döner

/** Ayar açık mı (varsayılan açık; depolama yoksa da açık sayılır). */
export function settingOn(storage, key) {
  try {
    return !storage || storage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

/** Sahne klibi görünümü: "off" | "dim" | "full" (depolama yoksa "dim"). */
export function clipMode(storage) {
  try {
    const value = storage ? storage.getItem(STAGE_CLIP_KEY) : null;
    if (value === "0") return "off";
    if (value === "full") return "full";
  } catch {
    /* varsayılan */
  }
  return "dim";
}

/** Film düğmesi: karartılmış -> tam -> kapalı -> karartılmış. */
export function nextClipMode(mode) {
  const index = CLIP_MODES.indexOf(mode);
  return CLIP_MODES[(index + 1) % CLIP_MODES.length];
}

export const storedClipMode = (mode) => (mode === "off" ? "0" : mode === "full" ? "full" : "1");

/** [{size}] -> {count, bytes}. */
export function summarizeClips(list) {
  let bytes = 0;
  for (const item of list || []) bytes += Number(item && item.size) || 0;
  return { count: (list || []).length, bytes };
}

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

export const clipStore = {
  /** {blob, name, type, size, savedAt} ya da null. */
  async get(id) {
    try {
      const record = await run("readonly", (store) => {
        const request = store.get(id);
        return () => request.result;
      });
      return record && record.blob ? record : null;
    } catch {
      return null;
    }
  },

  /** Klibi kaydeder. Başarılıysa true (kota dolduysa / depo yoksa false). */
  async put(id, file) {
    try {
      await run("readwrite", (store) => store.put(
        { blob: file, name: file.name || "klip", type: file.type || "", size: file.size || 0, savedAt: Date.now() }, id));
      return true;
    } catch {
      return false;
    }
  },

  /** [{id, name, size, savedAt}] (resimleri okumadan). */
  async list() {
    try {
      return await run("readonly", (store) => {
        const keys = store.getAllKeys();
        const values = store.getAll();
        return () => keys.result.map((key, index) => {
          const value = values.result[index] || {};
          return { id: String(key), name: value.name || "", size: Number(value.size) || 0, savedAt: value.savedAt || 0 };
        });
      });
    } catch {
      return [];
    }
  },

  async remove(ids) {
    try {
      await run("readwrite", (store) => {
        for (const id of ids) store.delete(id);
      });
      return true;
    } catch {
      return false;
    }
  },

  /** Tüm klipleri siler (yalnız Ayarlar'daki onaylı düğmeden). Kayıtlar tek tek silinir: depolar toptan temizlenmez (storage_safety_test). */
  async removeAll() {
    const list = await this.list();
    return list.length ? this.remove(list.map((item) => item.id)) : true;
  },
};
