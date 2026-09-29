// Stem'lerin cihazda önbelleklenmesi.
//
// Her şarkı açılışında 6 stem yeniden iniyordu (~19 MB). Artık Cache
// Storage'da tutuluyorlar; ikinci açılışta ağ isteği yok.
//
// Neden Cache Storage: ikili veriyi Response olarak saklıyor, IndexedDB'nin
// aksine ek serileştirme yok. Service worker'ın cache'inden AYRI bir isim
// kullanıyoruz; sw.js ses dosyalarına hiç karışmıyor, burası tamamen
// uygulamanın denetiminde.
//
// Boyut sınırı 300 MB, dolunca EN ESKİ KULLANILAN siliniyor. Kullanım
// zamanları localStorage'da: Cache Storage kendi başına "ne zaman okundu"
// bilgisini tutmuyor.

const CACHE_NAME = "stem-mikser-stems-v1";
const INDEX_KEY = "stem-mikser.stemcache";
const MAX_BYTES = 300 * 1024 * 1024;

function loadIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY)) || {};
  } catch {
    return {};
  }
}

function saveIndex(index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Kota dolduysa indeks yazılamaz; önbellek yine çalışır, yalnızca LRU
    // sırası bozulur.
  }
}

function keyFor(songId, name, version = 0) {
  // Sahte ama kararlı bir URL: Cache Storage anahtarları Request olmak
  // zorunda. Bu adrese hiç istek atılmıyor.
  //
  // SÜRÜM ŞART: "Hi-Fi ile yeniden işle" aynı şarkı kimliği altındaki
  // stem dosyalarını değiştiriyor. Anahtar sürümsüz kalsaydı cihaz eski
  // sesi çalmaya devam ederdi - üstelik sessizce, hata bile vermeden.
  // Sürüm 0 = sunucu bildirmiyor (eski şarkılar); davranış eskisi gibi.
  const suffix = version ? `@${version}` : "";
  return `stems/${songId}/${name}${suffix}.m4a`;
}

export class StemCache {
  constructor() {
    this.available = "caches" in window;
    this.persisted = null;
  }

  // Tarayıcıdan kalıcı depolama izni ister. Verilmezse önbellek yine
  // çalışır, ama sistem yer açmak için silebilir.
  async requestPersistence() {
    if (!navigator.storage || !navigator.storage.persist) return null;
    try {
      this.persisted = (await navigator.storage.persisted())
        || (await navigator.storage.persist());
    } catch {
      this.persisted = null;
    }
    return this.persisted;
  }

  async get(songId, name, version = 0) {
    if (!this.available) return null;
    try {
      const cache = await caches.open(CACHE_NAME);
      const key = keyFor(songId, name, version);
      const hit = await cache.match(key);
      if (!hit) return null;
      const index = loadIndex();
      const entry = index[key];
      if (entry) {
        entry.lastUsed = Date.now();
        saveIndex(index);
      }
      return await hit.arrayBuffer();
    } catch {
      return null;
    }
  }

  async put(songId, name, arrayBuffer, version = 0) {
    if (!this.available) return false;
    try {
      const cache = await caches.open(CACHE_NAME);
      const key = keyFor(songId, name, version);
      await cache.put(
        key,
        new Response(arrayBuffer, { headers: { "Content-Type": "audio/mp4" } })
      );
      const index = loadIndex();
      index[key] = { size: arrayBuffer.byteLength, lastUsed: Date.now(), songId };
      saveIndex(index);
      await this.#evict();
      return true;
    } catch {
      // Kota dolduysa sessizce vazgeç; uygulama ağdan çalışmaya devam eder.
      return false;
    }
  }

  async #evict() {
    const index = loadIndex();
    let total = Object.values(index).reduce((sum, item) => sum + (item.size || 0), 0);
    if (total <= MAX_BYTES) return;
    const cache = await caches.open(CACHE_NAME);
    const byAge = Object.entries(index).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, item] of byAge) {
      if (total <= MAX_BYTES) break;
      await cache.delete(key);
      total -= item.size || 0;
      delete index[key];
    }
    saveIndex(index);
  }

  async usage() {
    const index = loadIndex();
    const entries = Object.values(index);
    const bytes = entries.reduce((sum, item) => sum + (item.size || 0), 0);
    const songs = new Set(entries.map((item) => item.songId)).size;
    let quota = null;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        quota = (await navigator.storage.estimate()).quota || null;
      } catch {
        quota = null;
      }
    }
    return { bytes, files: entries.length, songs, limit: MAX_BYTES, quota };
  }

  async clear() {
    if (this.available) {
      try {
        await caches.delete(CACHE_NAME);
      } catch {
        /* yok say */
      }
    }
    try {
      localStorage.removeItem(INDEX_KEY);
    } catch {
      /* yok say */
    }
  }
}

export { CACHE_NAME, MAX_BYTES, keyFor };
