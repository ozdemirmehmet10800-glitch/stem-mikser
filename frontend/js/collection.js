// Kitaplık verisi: favoriler, etiketler (ve sonraki madde için çalma listeleri yeri). SAF mantık + depolama dışarıdan
// (localStorage benzeri nesne; testte sahtesi). node tests\collection_test.mjs
//
// TEK anahtar: `stem-mikser.collection`. Neden telefonda, neden bu anahtar:
//  - Önbelleği temizle yalnız Cache Storage + SW'yi siliyor; SW localStorage'a erişemez; kodda localStorage.clear yok;
//    mevcut removeItem'lar yalnız ÖNEKLİ anahtarlarda (meta., lyrics., translation., kicks., mix.). Bu anahtar hiçbir
//    önek döngüsüne uymuyor (tests/storage_safety_test.mjs kaynağı tarayıp bunu denetler).
//  - Kalıcı depolama izni zaten isteniyor (stemcache.requestPersistence): tarayıcı baskı altında atmaz.
//  - Kalan risk: site verisini elle silmek / uygulamayı kaldırmak -> Ayarlar'daki yedek (dışa/içe aktar).
//
// Belge (v1):  { v: 1, rev, updated,
//   songs: { "<şarkı kimliği>": { fav?: true, tags?: ["<etiket kimliği>"], t, miss? } },   // yalnız favorisi/etiketi olanlar
//   tags:  { "<etiket kimliği>": { name, t } },
//   lists: {} }                                                                            // çalma listeleri (sonraki madde)
// Bilinmeyen alanlar (üst düzeyde, şarkı kaydında) kaydederken AYNEN korunur: eski önbellekli bir sürüm, sonraki
// sürümün alanlarını silmesin. Etiketler kimlikle tutulur: yeniden adlandırma hiçbir şarkı kaydına dokunmaz.

import { fold } from "./songfilter.js";

export const COLLECTION_KEY = "stem-mikser.collection";
export const COLLECTION_BAD_KEY = "stem-mikser.collection.bad";
export const COLLECTION_VERSION = 1;
export const TAG_NAME_MAX = 24;
export const TAG_LIMIT = 60;
export const ORPHAN_MS = 30 * 24 * 60 * 60 * 1000;      // sunucu listesinde görünmeyen şarkının kaydı bu kadar sonra silinir
export const IMPORT_MAX_BYTES = 1024 * 1024;

const SONG_KNOWN = new Set(["fav", "tags", "t", "miss"]);
const SONG_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;     // "__proto__" gibi anahtarlar geçmez

export function cleanTagName(raw) {
  return String(raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, TAG_NAME_MAX).trim();
}

const emptyDoc = () => ({ v: COLLECTION_VERSION, rev: 0, updated: 0, songs: {}, tags: {}, lists: {} });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export class Collection {
  /**
   * storage: {getItem, setItem, removeItem} (localStorage). options: {now, random}.
   * status (load sonrası): "empty" | "ok" | "corrupt" (okunamadı, ham kopya .bad'e taşındı) | "newer" (daha yeni sürüm: SALT OKUNUR).
   */
  constructor(storage, { now = Date.now, random = Math.random } = {}) {
    this.storage = storage;
    this.now = now;
    this.random = random;
    this.doc = emptyDoc();
    this.status = "empty";
    this.readOnly = false;
    this.load();
  }

  load() {
    this.readOnly = false;
    let raw = null;
    try {
      raw = this.storage.getItem(COLLECTION_KEY);
    } catch {
      raw = null;
    }
    if (raw === null || raw === undefined) {
      this.doc = emptyDoc();
      this.status = "empty";
      return this.status;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isObject(parsed) || !Number.isFinite(parsed.v) || (parsed.songs !== undefined && !isObject(parsed.songs))
        || (parsed.tags !== undefined && !isObject(parsed.tags))) {
      // Okunamadı: sessizce sıfırlama. Ham kopyayı ayır; ilk değişiklikte yeni belge yazılır, eskisi .bad'de kalır.
      try {
        this.storage.setItem(COLLECTION_BAD_KEY, raw);
      } catch {
        /* kota: ham kopya da saklanamadı; yine de asıl anahtara dokunmuyoruz (ilk değişikliğe kadar) */
      }
      this.doc = emptyDoc();
      this.status = "corrupt";
      return this.status;
    }
    if (parsed.v > COLLECTION_VERSION) {
      this.doc = parsed;
      this.doc.songs = isObject(parsed.songs) ? parsed.songs : {};
      this.doc.tags = isObject(parsed.tags) ? parsed.tags : {};
      this.readOnly = true;
      this.status = "newer";
      return this.status;
    }
    this.doc = parsed;
    this.doc.songs = isObject(parsed.songs) ? parsed.songs : {};
    this.doc.tags = isObject(parsed.tags) ? parsed.tags : {};
    if (!isObject(this.doc.lists)) this.doc.lists = {};
    if (!Number.isFinite(this.doc.rev)) this.doc.rev = 0;
    this.status = "ok";
    return this.status;
  }

  // ---------------------------------------------------------------- okuma

  isFav(id) {
    return Boolean(has(this.doc.songs, id) && this.doc.songs[id].fav);
  }

  favCount() {
    return Object.values(this.doc.songs).filter((entry) => entry && entry.fav).length;
  }

  tagName(tid) {
    return has(this.doc.tags, tid) ? String(this.doc.tags[tid].name || "") : "";
  }

  /** Şarkının (var olan) etiket kimlikleri. */
  tagIdsOf(id) {
    if (!has(this.doc.songs, id)) return [];
    const list = this.doc.songs[id].tags;
    return Array.isArray(list) ? list.filter((tid) => has(this.doc.tags, tid)) : [];
  }

  /** Tüm etiketler: [{id, name, count}] (ada göre, Türkçe sıralı). */
  tagList() {
    const counts = {};
    for (const id of Object.keys(this.doc.songs)) {
      for (const tid of this.tagIdsOf(id)) counts[tid] = (counts[tid] || 0) + 1;
    }
    return Object.keys(this.doc.tags)
      .map((tid) => ({ id: tid, name: this.tagName(tid), count: counts[tid] || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }

  findTagByName(name) {
    const key = fold(cleanTagName(name));
    if (!key) return null;
    return Object.keys(this.doc.tags).find((tid) => fold(this.tagName(tid)) === key) || null;
  }

  /** Bir etiketin, verilen şarkılardaki durumu: "all" | "some" | "none". */
  tagState(tid, ids) {
    if (!ids.length) return "none";
    const count = ids.filter((id) => this.tagIdsOf(id).includes(tid)).length;
    return count === 0 ? "none" : count === ids.length ? "all" : "some";
  }

  stats() {
    return { favs: this.favCount(), tags: Object.keys(this.doc.tags).length, songs: Object.keys(this.doc.songs).length };
  }

  // ------------------------------------------------------------ değiştirme

  #save() {
    try {
      this.storage.setItem(COLLECTION_KEY, JSON.stringify(this.doc));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * fn(doc) belgeyi değiştirir ve {ok:false, error} ya da bir sonuç nesnesi döner. Hata ya da kayıt başarısızlığında
   * bellekteki belge ESKİ hâline döner (arayüz "kaydedildi" sanmasın). fn {noop: true} dönerse yazılmaz.
   */
  #mutate(fn) {
    if (this.readOnly) return { ok: false, error: "readonly" };
    const before = JSON.stringify(this.doc);
    const result = fn(this.doc) || {};
    if (result.ok === false) {
      this.doc = JSON.parse(before);
      return result;
    }
    if (result.noop) return { ok: true, ...result };
    this.doc.rev = (Number(this.doc.rev) || 0) + 1;
    this.doc.updated = this.now();
    if (!this.#save()) {
      this.doc = JSON.parse(before);
      return { ok: false, error: "save" };
    }
    return { ok: true, ...result };
  }

  #entry(doc, id) {
    if (!has(doc.songs, id) || !isObject(doc.songs[id])) doc.songs[id] = { t: this.now() };
    return doc.songs[id];
  }

  #tidy(doc, id) {
    const entry = doc.songs[id];
    if (!entry) return;
    if (Array.isArray(entry.tags) && !entry.tags.length) delete entry.tags;
    const extra = Object.keys(entry).some((key) => !SONG_KNOWN.has(key));
    if (!entry.fav && !entry.tags && !extra) delete doc.songs[id];
  }

  #newTagId(doc) {
    for (let i = 0; i < 20; i += 1) {
      const tid = `t${Math.floor(this.random() * 36 ** 6).toString(36).padStart(5, "0")}`;
      if (!has(doc.tags, tid)) return tid;
    }
    return `t${this.now().toString(36)}`;
  }

  setFav(id, on) {
    if (!SONG_ID_RE.test(String(id))) return { ok: false, error: "id" };
    return this.#mutate((doc) => {
      if (Boolean(on) === this.isFav(id)) return { noop: true };
      const entry = this.#entry(doc, id);
      if (on) entry.fav = true;
      else delete entry.fav;
      entry.t = this.now();
      this.#tidy(doc, id);
      return {};
    });
  }

  toggleFav(id) {
    return this.setFav(id, !this.isFav(id));
  }

  /** Etiket oluşturur; aynı ad (harf katlamasıyla) varsa onu döner: {ok, id, created}. */
  createTag(name) {
    const clean = cleanTagName(name);
    if (!clean) return { ok: false, error: "empty" };
    const existing = this.findTagByName(clean);
    if (existing) return { ok: true, id: existing, created: false };
    return this.#mutate((doc) => {
      if (Object.keys(doc.tags).length >= TAG_LIMIT) return { ok: false, error: "limit" };
      const id = this.#newTagId(doc);
      doc.tags[id] = { name: clean, t: this.now() };
      return { id, created: true };
    });
  }

  renameTag(tid, name) {
    const clean = cleanTagName(name);
    if (!clean) return { ok: false, error: "empty" };
    if (!has(this.doc.tags, tid)) return { ok: false, error: "missing" };
    const clash = this.findTagByName(clean);
    if (clash && clash !== tid) return { ok: false, error: "exists" };
    return this.#mutate((doc) => {
      if (doc.tags[tid].name === clean) return { noop: true };
      doc.tags[tid].name = clean;
      doc.tags[tid].t = this.now();
      return {};
    });
  }

  deleteTag(tid) {
    if (!has(this.doc.tags, tid)) return { ok: false, error: "missing" };
    return this.#mutate((doc) => {
      let removedFrom = 0;
      delete doc.tags[tid];
      for (const id of Object.keys(doc.songs)) {
        const entry = doc.songs[id];
        if (Array.isArray(entry.tags) && entry.tags.includes(tid)) {
          entry.tags = entry.tags.filter((other) => other !== tid);
          entry.t = this.now();
          removedFrom += 1;
          this.#tidy(doc, id);
        }
      }
      return { removedFrom };
    });
  }

  /** Etiketi verilen şarkılara ekler/çıkarır. {ok, changed}. */
  setTagOnSongs(ids, tid, on) {
    if (!has(this.doc.tags, tid)) return { ok: false, error: "missing" };
    const valid = [...new Set(ids)].filter((id) => SONG_ID_RE.test(String(id)));
    return this.#mutate((doc) => {
      let changed = 0;
      for (const id of valid) {
        const has_ = this.tagIdsOf(id).includes(tid);
        if (Boolean(on) === has_) continue;
        const entry = this.#entry(doc, id);
        const list = Array.isArray(entry.tags) ? entry.tags.filter((other) => other !== tid) : [];
        if (on) list.push(tid);
        entry.tags = list;
        entry.t = this.now();
        this.#tidy(doc, id);
        changed += 1;
      }
      return changed ? { changed } : { noop: true, changed: 0 };
    });
  }

  /** Silinen şarkıların kayıtları HEMEN gider (uygulamadan silme). */
  removeSongs(ids) {
    const present = [...new Set(ids)].filter((id) => has(this.doc.songs, id));
    if (!present.length) return { ok: true, removed: 0, noop: true };
    return this.#mutate((doc) => {
      for (const id of present) delete doc.songs[id];
      return { removed: present.length };
    });
  }

  /**
   * Yetim kaydı: SUNUCUDAN taze ve BOŞ OLMAYAN liste geldiğinde çağrılır (presentIds: görünen kimlikler). Listede
   * olmayan şarkının kaydına "miss" damgası, tekrar görününce damga kalkar, ORPHAN_MS'den uzun süredir yoksa silinir.
   * (GET /songs bir şarkıyı geçici atlayabilir: boş/kısmi liste etiketleri hemen silmesin.)
   */
  sweep(presentIds, at = this.now()) {
    if (!presentIds || !presentIds.size) return { ok: true, noop: true };
    return this.#mutate((doc) => {
      let changed = 0;
      for (const id of Object.keys(doc.songs)) {
        const entry = doc.songs[id];
        if (presentIds.has(id)) {
          if (entry.miss !== undefined) {
            delete entry.miss;
            changed += 1;
            this.#tidy(doc, id);
          }
        } else if (!Number.isFinite(entry.miss)) {
          entry.miss = at;
          changed += 1;
        } else if (at - entry.miss > ORPHAN_MS) {
          delete doc.songs[id];
          changed += 1;
        }
      }
      return changed ? { changed } : { noop: true };
    });
  }

  // -------------------------------------------------------- yedek (dışa/içe)

  exportData() {
    return {
      v: COLLECTION_VERSION, kind: "stem-mikser-collection", exported: new Date(this.now()).toISOString(),
      tags: JSON.parse(JSON.stringify(this.doc.tags)),
      songs: JSON.parse(JSON.stringify(this.doc.songs)),
      lists: JSON.parse(JSON.stringify(this.doc.lists || {})),
    };
  }

  exportJson() {
    return JSON.stringify(this.exportData(), null, 2);
  }

  /**
   * Yedeği BİRLEŞTİRİR (üzerine yazmaz): etiketler ada göre eşlenir (yoksa eklenir), favoriler VEYA, etiketler birleşim.
   * Dönen: {ok, tagsAdded, favsAdded, songsTouched} ya da {ok:false, error: "size" | "json" | "format" | "readonly" | "save"}.
   */
  importJson(text) {
    if (typeof text !== "string" || text.length > IMPORT_MAX_BYTES) return { ok: false, error: "size" };
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: "json" };
    }
    if (!isObject(data) || data.v !== COLLECTION_VERSION || !isObject(data.tags) || !isObject(data.songs)) {
      return { ok: false, error: "format" };
    }
    return this.#mutate((doc) => {
      let tagsAdded = 0;
      let favsAdded = 0;
      let songsTouched = 0;
      const map = new Map();
      for (const [oldId, tag] of Object.entries(data.tags)) {
        const name = cleanTagName(isObject(tag) ? tag.name : "");
        if (!name) continue;
        const existing = this.findTagByName(name);
        if (existing) {
          map.set(oldId, existing);
        } else if (Object.keys(doc.tags).length < TAG_LIMIT) {
          const id = this.#newTagId(doc);
          doc.tags[id] = { name, t: this.now() };
          map.set(oldId, id);
          tagsAdded += 1;
        }
      }
      for (const [id, saved] of Object.entries(data.songs)) {
        if (!SONG_ID_RE.test(id) || !isObject(saved)) continue;
        const wantFav = saved.fav === true;
        const wantTags = (Array.isArray(saved.tags) ? saved.tags : []).map((tid) => map.get(tid)).filter(Boolean);
        if (!wantFav && !wantTags.length) continue;
        const entry = this.#entry(doc, id);
        let touched = false;
        if (wantFav && !entry.fav) {
          entry.fav = true;
          favsAdded += 1;
          touched = true;
        }
        const list = Array.isArray(entry.tags) ? entry.tags.filter((tid) => has(doc.tags, tid)) : [];
        for (const tid of wantTags) {
          if (!list.includes(tid)) {
            list.push(tid);
            touched = true;
          }
        }
        if (list.length) entry.tags = list;
        if (touched) {
          entry.t = this.now();
          songsTouched += 1;
        }
        this.#tidy(doc, id);
      }
      return { tagsAdded, favsAdded, songsTouched };
    });
  }
}

/** localStorage'a erişim bile patlayabilir (gizli mod): güvenli sarmalayıcı; yoksa bellekte (kalıcı DEĞİL) sahte depo. */
export function safeStorage(win = globalThis) {
  try {
    const storage = win.localStorage;
    const probe = "stem-mikser.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return { storage, persistent: true };
  } catch {
    const memory = new Map();
    return {
      persistent: false,
      storage: {
        getItem: (key) => (memory.has(key) ? memory.get(key) : null),
        setItem: (key, value) => { memory.set(key, String(value)); },
        removeItem: (key) => { memory.delete(key); },
      },
    };
  }
}
