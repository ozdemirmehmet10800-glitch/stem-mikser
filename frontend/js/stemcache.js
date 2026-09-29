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
// Boyut sınırı 2 GB, dolunca EN ESKİ KULLANILAN siliniyor. Kullanım
// zamanları localStorage'da: Cache Storage kendi başına "ne zaman okundu"
// bilgisini tutmuyor.
//
// Sınır 300 MB -> 2 GB -> 20 GB. Telefon depolaması bol; stem'ler 256k
// olunca şarkı başı ~11.5 MB/dk (6 kanal), yani 20 GB ~400 şarkı demek.
// Asıl tavan artık tarayıcının kendi kotası: dolarsa put sessizce vazgeçiyor
// ve uygulama ağdan çalışmaya devam ediyor.
// Tarayıcının kendi kotası ayrı bir tavan: dolarsa put sessizce vazgeçiyor.

const CACHE_NAME = "stem-mikser-stems-v1";
const INDEX_KEY = "stem-mikser.stemcache";
const MAX_BYTES = 20 * 1024 * 1024 * 1024;

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

  /**
   * Bu şarkının BÜTÜN stem'leri cihazda mı? (çevrimdışı açılabilir mi)
   *
   * Cache Storage'a değil İNDEKSE bakıyor: senkron olması gerekiyor, kitaplık
   * her çizimde altı şarkı için bunu soruyor. İndeks put/remove ile birlikte
   * güncelleniyor, yani yanılma payı yalnızca "sistem Cache Storage'ı silmiş
   * ama localStorage kalmış" durumunda - o zaman şarkı açılışta ağa düşer,
   * zaten olması gereken de bu.
   */
  indexHas(songId, names, version = 0, index = null) {
    if (!songId || !names || !names.length) return false;
    const table = index || loadIndex();
    return names.every((name) => Boolean(table[keyFor(songId, name, version)]));
  }

  /**
   * İndeksin tek seferlik kopyası. Kitaplık her çizimde ONLARCA şarkı için
   * `indexHas` soruyor; her çağrıda indeksi yeniden ayrıştırmak (2 GB'lık bir
   * önbellekte 240+ girdi) boşuna iş. Çizim başında bir kez alınıp geçiliyor.
   */
  indexSnapshot() {
    return loadIndex();
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

  // Bir şarkının bütün stem'lerini önbellekten siler (şarkı silinince).
  // İki kaynaktan da temizliyor: indeks (songId alanı) VE Cache Storage'ın
  // kendi anahtarları. Sebep: localStorage silinmiş ama Cache Storage
  // dolu kalmış olabilir - o zaman indekse bakan bir temizlik depoyu
  // şişmiş bırakır ve kullanıcı neden yer açılmadığını anlamaz.
  //
  // Anahtar sürümlü olabildiği için (`...@3.m4a`) isimden değil, önekten
  // eşleşiyoruz: `stems/<id>/`.
  async removeSongs(songIds) {
    const wanted = new Set(songIds || []);
    if (!wanted.size) return { removed: 0, bytes: 0 };

    const prefixes = [...wanted].map((id) => `stems/${id}/`);
    const matches = (text) => prefixes.some((prefix) => text.includes(prefix));
    // Cache Storage anahtarları Request'e dönüşüyor ve URL'leri MUTLAK oluyor
    // (sayfa origin'ine göre çözülüyor); indeks anahtarları ise göreli. İki
    // tarafı aynı kefeye koymak için "stems/" ile başlayan kuyruğu alıyoruz,
    // yoksa aynı dosya iki kez sayılırdı.
    const tailOf = (text) => {
      const at = text.indexOf("stems/");
      return at < 0 ? text : text.slice(at);
    };

    let cache = null;
    if (this.available) {
      try {
        cache = await caches.open(CACHE_NAME);
      } catch {
        cache = null;
      }
    }

    const dropped = new Set();
    if (cache) {
      try {
        for (const request of await cache.keys()) {
          if (!matches(request.url)) continue;
          try {
            await cache.delete(request);
          } catch {
            /* yok say */
          }
          dropped.add(tailOf(request.url));
        }
      } catch {
        /* keys() patlarsa indeks yolu yeter */
      }
    }

    const index = loadIndex();
    let bytes = 0;
    for (const key of Object.keys(index)) {
      const entry = index[key] || {};
      if (!wanted.has(entry.songId) && !matches(key)) continue;
      bytes += entry.size || 0;
      dropped.add(tailOf(key));
      delete index[key];
      if (cache) {
        try {
          await cache.delete(key);      // indekste var, cache'te kalmışsa
        } catch {
          /* yok say */
        }
      }
    }
    saveIndex(index);
    return { removed: dropped.size, bytes };
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
