// Hedef melodinin cihaz önbelleği (Cache Storage): çevrimdışı da söylenebilsin. Anahtar: melody/<şarkı>@<sürüm>.bin (sürüm = status.melody.version);
// yeni sürüm gelince eski silinir. Küçük dosyalar (~20-50 KB); en çok MAX_ENTRIES. Stem önbelleğinden (stemcache.js) ve dalga önbelleğinden
// (peakscache.js) AYRI bir depo. Kota dolarsa put sessizce vazgeçer (melodi bir sonraki açılışta yeniden indirilir).

const CACHE_NAME = "stem-mikser-melody-v1";
const MAX_ENTRIES = 300;

const keyFor = (songId, version) => `melody/${songId}@${version}.bin`;

export class MelodyCache {
  constructor(cacheStorage = typeof caches !== "undefined" ? caches : null) {
    this.storage = cacheStorage;
    this.available = Boolean(cacheStorage);
  }

  async get(songId, version) {
    if (!this.available) return null;
    try {
      const cache = await this.storage.open(CACHE_NAME);
      const hit = await cache.match(keyFor(songId, version));
      return hit ? await hit.arrayBuffer() : null;
    } catch {
      return null;
    }
  }

  async put(songId, version, arrayBuffer) {
    if (!this.available) return false;
    try {
      const cache = await this.storage.open(CACHE_NAME);
      for (const request of await cache.keys()) {
        if (request.url.includes(`melody/${songId}@`) && !request.url.endsWith(`@${version}.bin`)) await cache.delete(request);
      }
      await cache.put(keyFor(songId, version), new Response(arrayBuffer, { headers: { "Content-Type": "application/octet-stream" } }));
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - MAX_ENTRIES; i += 1) await cache.delete(keys[i]);
      return true;
    } catch {
      return false;
    }
  }

  async removeSongs(songIds) {
    const wanted = [...new Set(songIds || [])];
    if (!this.available || !wanted.length) return 0;
    let removed = 0;
    try {
      const cache = await this.storage.open(CACHE_NAME);
      for (const request of await cache.keys()) {
        if (wanted.some((id) => request.url.includes(`melody/${id}@`))) {
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
