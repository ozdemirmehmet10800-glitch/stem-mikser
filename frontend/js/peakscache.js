// Tepe verisinin cihaz önbelleği (Cache Storage). Stem önbelleğinden (stemcache.js) AYRI bir depo: orada indeks, LRU ve ".m4a"
// anahtar kuralları var; burada şarkı başına tek küçük dosya (~30-150 KB). Anahtar: peaks/<şarkı>@<sürüm etiketi>.bin
// (etiket = stems_version[.pipeline], stemcache.cacheTag ile aynı): yeniden işlemede etiket değişir, eski sürüm silinir.
//
// Sınır: en çok MAX_ENTRIES dosya (~12-60 MB); dolunca en eski eklenen gider. Kota dolarsa put sessizce vazgeçer (dalga bir sonraki
// açılışta yeniden hesaplanır).

const CACHE_NAME = "stem-mikser-peaks-v1";
const MAX_ENTRIES = 400;

const keyFor = (songId, tag) => `peaks/${songId}@${tag}.bin`;

export class PeaksCache {
  constructor(cacheStorage = typeof caches !== "undefined" ? caches : null) {
    this.storage = cacheStorage;
    this.available = Boolean(cacheStorage);
  }

  async get(songId, tag) {
    if (!this.available) return null;
    try {
      const cache = await this.storage.open(CACHE_NAME);
      const hit = await cache.match(keyFor(songId, tag));
      return hit ? await hit.arrayBuffer() : null;
    } catch {
      return null;
    }
  }

  async put(songId, tag, arrayBuffer) {
    if (!this.available) return false;
    try {
      const cache = await this.storage.open(CACHE_NAME);
      const key = keyFor(songId, tag);
      for (const request of await cache.keys()) {
        // aynı şarkının başka sürümleri artık gereksiz
        if (request.url.includes(`peaks/${songId}@`) && !request.url.endsWith(`@${tag}.bin`)) await cache.delete(request);
      }
      await cache.put(key, new Response(arrayBuffer, { headers: { "Content-Type": "application/octet-stream" } }));
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - MAX_ENTRIES; i += 1) await cache.delete(keys[i]);
      return true;
    } catch {
      return false;
    }
  }

  /** Silinen şarkıların dalgaları da gitsin. */
  async removeSongs(songIds) {
    const wanted = new Set(songIds || []);
    if (!this.available || !wanted.size) return 0;
    let removed = 0;
    try {
      const cache = await this.storage.open(CACHE_NAME);
      for (const request of await cache.keys()) {
        if ([...wanted].some((id) => request.url.includes(`peaks/${id}@`))) {
          await cache.delete(request);
          removed += 1;
        }
      }
    } catch {
      /* yok say */
    }
    return removed;
  }

  async clear() {
    if (!this.available) return;
    try {
      await this.storage.delete(CACHE_NAME);
    } catch {
      /* yok say */
    }
  }
}
