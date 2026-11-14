// Kapaklar (Görsel yenileme, Aşama 2): SAF mantık + yönetici. DOM / IndexedDB / ağ dışarıdan verilir; node ile test ediliyor:
//   node tests\cover_test.mjs
//
// Kaynak önceliği (TEK kayıt / şarkı, kayıt yoksa otomatik kapak):
//   "user"     : kullanıcının seçtiği resim ya da onayladığı "Kapak bul" sonucu ("found") - gömülüyü EZER (açık seçim önceliklidir)
//   "embedded" : dosyanın gömülü kapağı (sunucuda GET /songs/{id}/cover, salt okunur)
//   "none"     : sunucu "kapak yok" dedi (204): tekrar sorulmaz
//   (kayıt yok): şarkı adından üretilen renkli kapak (aynı ad hep aynı renk)
// Resimler yalnız bu telefonda (IndexedDB); sunucuya yüklenmez. MusicBrainz araması YALNIZ kullanıcı onayıyla (arayüz tarafı).

export const COVER_PX = 384;           // saklanan en büyük kenar (liste, kilit ekranı için yeter)
export const SOURCES = ["user", "found", "embedded", "none"];

// ------------------------------------------------------------------ otomatik kapak

/** FNV-1a 32 bit: aynı metin -> hep aynı sayı. */
export function hash32(text) {
  let hash = 0x811c9dc5;
  const input = String(text);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Karşılaştırma için ad: boşluk/BÜYÜK-küçük/Unicode biçimi önemsiz (aynı şarkı adı hep aynı renk). */
export function normTitle(title) {
  return String(title || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("tr");
}

/** İlk harf ya da rakam (büyük, Türkçe İ/ı doğru); hiçbiri yoksa "♪". */
export function coverLetter(title) {
  const match = /[\p{L}\p{N}]/u.exec(String(title || "").normalize("NFC").trim());
  return match ? match[0].toLocaleUpperCase("tr") : "♪";
}

/** {c1, c2, angle, glowX, glowY, letter, hue}: koyu temada okunur, yazı (büyük harf) ≥ 3:1 kontrast için koyu tonlar. */
export function autoCoverModel(title) {
  const key = normTitle(title);
  const h = hash32(key || "?");
  const hue = h % 360;
  const hue2 = (hue + 35 + ((h >>> 9) % 70)) % 360;
  const sat1 = 58 + ((h >>> 5) % 14);
  const sat2 = 62 + ((h >>> 13) % 14);
  return {
    hue,
    c1: `hsl(${hue} ${sat1}% 34%)`,
    c2: `hsl(${hue2} ${sat2}% 22%)`,
    angle: 120 + ((h >>> 17) % 60),
    glowX: 15 + ((h >>> 21) % 70),
    glowY: 12 + ((h >>> 26) % 60),
    letter: coverLetter(title),
  };
}

/** CSS `background` değeri (gradyan + yumuşak ışık). */
export function autoCoverCss(model) {
  return `radial-gradient(circle at ${model.glowX}% ${model.glowY}%, rgba(255,255,255,0.20), rgba(255,255,255,0) 58%), `
    + `linear-gradient(${model.angle}deg, ${model.c1}, ${model.c2})`;
}

/** Aynı kapağı canvas'a çizer (kilit ekranı resmi için). ctx: 2B bağlam, size: kenar (piksel). */
export function drawAutoCover(ctx, size, model) {
  const rad = ((model.angle - 90) * Math.PI) / 180;
  const cx = size / 2;
  const cy = size / 2;
  const dx = Math.cos(rad) * size * 0.7;
  const dy = Math.sin(rad) * size * 0.7;
  const base = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  base.addColorStop(0, model.c1);
  base.addColorStop(1, model.c2);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const glow = ctx.createRadialGradient(size * model.glowX / 100, size * model.glowY / 100, 0, size * model.glowX / 100, size * model.glowY / 100, size * 0.58);
  glow.addColorStop(0, "rgba(255,255,255,0.20)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `700 ${Math.round(size * 0.46)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(model.letter, cx, cy + size * 0.03);
}

// ------------------------------------------------------------------ boyut

/** En büyük kenar `max`'ı geçmesin (küçük resim büyütülmez); en az 1 piksel. */
export function fitSize(width, height, max = COVER_PX) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

// ------------------------------------------------------------------ MusicBrainz / Cover Art Archive (yalnız kullanıcı onayıyla)

// Tarayıcı User-Agent'ı JS'ten ayarlanamaz/ayarlansa da genel bir istemci adı yeter: kişisel bilgi, e-posta, depo adresi GİTMEZ.
export const MB_CLIENT = "StemMikser/1.0";
export const MB_MIN_INTERVAL_MS = 1100;      // MusicBrainz: saniyede en çok 1 istek
export const MB_MAX_CANDIDATES = 6;

/** "Sanatçı - Şarkı (Official Video)" -> {artist, title}. Parantez/köşeli ek notlar ve feat. atılır; arama alanları düzenlenebilir. */
export function searchTerms(rawTitle) {
  let text = String(rawTitle || "").normalize("NFC").replace(/\s+/g, " ").trim();
  text = text.replace(/\s*[(\[][^)\]]*[)\]]/g, " ").replace(/\s+(?:ft|feat)\.?\s.*$/i, "").replace(/\s+/g, " ").trim();
  const parts = text.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  return { artist: "", title: text };
}

function luceneEscape(text) {
  return String(text).replace(/[\\"]/g, " ").replace(/\s+/g, " ").trim();
}

/** MusicBrainz kayıt (recording) araması adresi; sanatçı boşsa yalnız şarkı adı. */
export function mbSearchUrl({ artist = "", title = "" }) {
  const name = luceneEscape(title);
  const by = luceneEscape(artist);
  if (!name) return null;
  const query = by ? `recording:"${name}" AND artist:"${by}"` : `recording:"${name}"`;
  return `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=12`;
}

/** Yanıttan en çok MB_MAX_CANDIDATES sürüm: [{releaseId, release, artist, title, date}] (aynı sürüm bir kez; "Official" önce). */
export function parseCandidates(json) {
  const recordings = json && Array.isArray(json.recordings) ? json.recordings : [];
  const seen = new Set();
  const out = [];
  for (const recording of recordings) {
    const artist = Array.isArray(recording["artist-credit"]) ? recording["artist-credit"].map((c) => c && c.name).filter(Boolean).join(", ") : "";
    for (const release of Array.isArray(recording.releases) ? recording.releases : []) {
      if (!release || typeof release.id !== "string" || !/^[0-9a-f-]{36}$/i.test(release.id) || seen.has(release.id)) continue;
      seen.add(release.id);
      out.push({
        releaseId: release.id, release: String(release.title || ""), artist, title: String(recording.title || ""),
        date: String(release.date || "").slice(0, 4), official: release.status === "Official",
      });
    }
  }
  out.sort((a, b) => Number(b.official) - Number(a.official));
  return out.slice(0, MB_MAX_CANDIDATES);
}

/** Cover Art Archive ön kapak adresi (250 / 500 / 1200). Yalnız geçerli sürüm kimliğiyle. */
export function caaFrontUrl(releaseId, size = 500) {
  if (!/^[0-9a-f-]{36}$/i.test(String(releaseId))) return null;
  const px = [250, 500, 1200].includes(size) ? size : 500;
  return `https://coverartarchive.org/release/${releaseId}/front-${px}`;
}

/** İstekler arası en az `intervalMs`. now/sleep dışarıdan (test). */
export class Throttle {
  constructor(intervalMs = MB_MIN_INTERVAL_MS, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.sleep = sleep;
    this.last = -Infinity;
  }

  async wait() {
    const gap = this.now() - this.last;
    if (gap < this.intervalMs) await this.sleep(this.intervalMs - gap);
    this.last = this.now();
  }
}

// ------------------------------------------------------------------ yönetici

/**
 * Şarkı başına kapak kaydı ve gömülü kapak kuyruğu.
 *   store: {getMany(ids) -> Map(id -> {source, blob?}), put(id, record) -> bool, delete(ids)}
 *   fetchEmbedded(id): Blob (kapak var) | null (dosyada kapak yok, 204) | undefined (bilinmiyor: ağ hatası, eski sunucu...)
 *   canFetch(): ağ/oturum uygun mu (çevrimdışı, sekme arkada vb. ise false)
 * onChange(ids): görünen kapağı değişen kimlikler.
 */
export class CoverManager {
  constructor({
    store, fetchEmbedded, canFetch = () => true, onChange = () => {},
    makeUrl = (blob) => URL.createObjectURL(blob), revokeUrl = (url) => URL.revokeObjectURL(url),
    concurrency = 2, gapMs = 150, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.store = store;
    this.fetchEmbedded = fetchEmbedded;
    this.canFetch = canFetch;
    this.onChange = onChange;
    this.makeUrl = makeUrl;
    this.revokeUrl = revokeUrl;
    this.concurrency = concurrency;
    this.gapMs = gapMs;
    this.sleep = sleep;
    this.records = new Map();      // id -> {source}
    this.urls = new Map();         // id -> nesne adresi (yalnız resimli kayıtlar)
    this.loaded = new Set();       // depodan okuması denenen kimlikler
    this.failed = new Set();       // bu oturumda gömülü kapak sorgusu başarısız olanlar (sonra yeniden denenir: yeni oturum)
    this.queue = [];
    this.queued = new Set();
    this.running = 0;
  }

  urlFor(id) {
    return this.urls.get(id) || null;
  }

  sourceOf(id) {
    const record = this.records.get(id);
    return record ? record.source : null;
  }

  hasImage(id) {
    return this.urls.has(id);
  }

  #setRecord(id, record) {
    const old = this.urls.get(id);
    if (old) {
      this.revokeUrl(old);
      this.urls.delete(id);
    }
    this.records.set(id, { source: record.source });
    if (record.blob) this.urls.set(id, this.makeUrl(record.blob));
  }

  /** Depodan okur (bir kez / kimlik). Değişen kimlikler için onChange. */
  async load(ids) {
    const need = [...new Set(ids)].filter((id) => !this.loaded.has(id));
    if (!need.length) return;
    let found = new Map();
    try {
      found = await this.store.getMany(need);
    } catch {
      found = new Map();           // depo yoksa/engelliyse otomatik kapaklarla devam
    }
    const changed = [];
    for (const id of need) {
      this.loaded.add(id);
      const record = found.get(id);
      if (record && SOURCES.includes(record.source)) {
        this.#setRecord(id, record);
        if (record.blob) changed.push(id);
      }
    }
    if (changed.length) this.onChange(changed);
  }

  /** Biten şarkılardan kaydı OLMAYANLAR için gömülü kapak sorgusunu kuyruğa alır (önce load() beklenmiş olmalı). */
  want(songs) {
    for (const song of songs) {
      const id = song && song.id;
      if (!id || song.state !== "done") continue;
      if (!this.loaded.has(id) || this.records.has(id) || this.failed.has(id) || this.queued.has(id)) continue;
      this.queued.add(id);
      this.queue.push(id);
    }
    this.#pump();
  }

  #pump() {
    while (this.running < this.concurrency && this.queue.length) {
      if (!this.canFetch()) return;
      const id = this.queue.shift();
      this.running += 1;
      this.#fetchOne(id).finally(() => {
        this.queued.delete(id);
        this.running -= 1;
        this.sleep(this.gapMs).then(() => this.#pump());
      });
    }
  }

  async #fetchOne(id) {
    let result;
    try {
      result = await this.fetchEmbedded(id);
    } catch {
      result = undefined;
    }
    if (this.records.has(id)) return;          // bu arada kullanıcı kendi resmini seçti
    if (result === undefined) {
      this.failed.add(id);
      return;
    }
    if (result === null) {
      this.records.set(id, { source: "none" });
      await this.#persist(id, { source: "none" });
      return;
    }
    this.#setRecord(id, { source: "embedded", blob: result });
    await this.#persist(id, { source: "embedded", blob: result });
    this.onChange([id]);
  }

  async #persist(id, record) {
    try {
      await this.store.put(id, { ...record, savedAt: Date.now() });
    } catch {
      /* depo yazılamadı: bu oturumda bellekte kalır, sonra yeniden istenir */
    }
  }

  /** Kullanıcının seçtiği ("user") ya da onayladığı bulunan ("found") resim: HER ZAMAN öncelikli. */
  async setImage(id, blob, source = "user") {
    const src = source === "found" ? "found" : "user";
    this.#setRecord(id, { source: src, blob });
    this.loaded.add(id);
    await this.#persist(id, { source: src, blob });
    this.onChange([id]);
  }

  /** Kullanıcı/bulunan kapağı kaldırır: gömülü kapak (varsa) sunucudan yeniden istenir, yoksa otomatik kapak. */
  async clear(id) {
    const old = this.urls.get(id);
    if (old) this.revokeUrl(old);
    this.urls.delete(id);
    this.records.delete(id);
    this.failed.delete(id);
    try {
      await this.store.delete([id]);
    } catch {
      /* yok say */
    }
    this.onChange([id]);
    this.queued.add(id);
    this.queue.push(id);
    this.#pump();
  }

  /** Silinen şarkıların kayıtlarını temizler. */
  async drop(ids) {
    const list = [...ids];
    for (const id of list) {
      const url = this.urls.get(id);
      if (url) this.revokeUrl(url);
      this.urls.delete(id);
      this.records.delete(id);
      this.loaded.delete(id);
      this.failed.delete(id);
    }
    try {
      await this.store.delete(list);
    } catch {
      /* yok say */
    }
  }

  /** Ağ geri geldi / sekme öne geldi: bekleyen sorgular sürsün. */
  resume() {
    this.#pump();
  }

  /** Kuyruğun boşalmasını bekler (test için). */
  async idle() {
    while (this.running || (this.queue.length && this.canFetch())) {
      await new Promise((resolve) => setTimeout(resolve, 0));     // gerçek makro görev: zamanlayıcılar işlesin
    }
  }
}
