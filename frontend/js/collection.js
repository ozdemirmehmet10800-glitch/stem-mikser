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
//   lists: { "<liste kimliği>": { name, t, cur?, items: [{ iid, song, miss? }] } } }                       // çalma listeleri (prova modu)
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
export const LIST_LIMIT = 30;                  // en çok liste
export const LIST_ITEMS_MAX = 100;             // liste başına en çok şarkı (aynı şarkı birden çok kez olabilir)
export const LIST_NAME_MAX = 40;

const SONG_KNOWN = new Set(["fav", "tags", "t", "miss"]);
const SONG_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;     // "__proto__" gibi anahtarlar geçmez

export function cleanTagName(raw) {
  return String(raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, TAG_NAME_MAX).trim();
}

export function cleanListName(raw) {
  return String(raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, LIST_NAME_MAX).trim();
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
    return {
      favs: this.favCount(), tags: Object.keys(this.doc.tags).length, songs: Object.keys(this.doc.songs).length,
      lists: Object.keys(this.doc.lists || {}).length,
    };
  }

  // ------------------------------------------------------ çalma listeleri (okuma)

  #listItems(list) {
    return Array.isArray(list && list.items)
      ? list.items.filter((item) => isObject(item) && typeof item.iid === "string" && typeof item.song === "string")
      : [];
  }

  /** Listeler: [{id, name, count, cur, t}] (oluşturulma sırası; eşitse ada göre). */
  listSummaries() {
    return Object.keys(this.doc.lists || {})
      .filter((lid) => isObject(this.doc.lists[lid]))
      .map((lid) => {
        const list = this.doc.lists[lid];
        return { id: lid, name: String(list.name || ""), count: this.#listItems(list).length, cur: list.cur || null, t: Number(list.t) || 0 };
      })
      .sort((a, b) => a.t - b.t || a.name.localeCompare(b.name, "tr"));
  }

  /** Tek liste: {id, name, cur, items: [{iid, song, miss}]} ya da null. Öğeler kopya (dışarıdan değiştirilemez). */
  getList(lid) {
    if (!has(this.doc.lists || {}, lid) || !isObject(this.doc.lists[lid])) return null;
    const list = this.doc.lists[lid];
    return {
      id: lid, name: String(list.name || ""), cur: list.cur || null,
      items: this.#listItems(list).map((item) => ({ iid: item.iid, song: item.song, miss: Number.isFinite(item.miss) ? item.miss : null })),
    };
  }

  findListByName(name) {
    const key = fold(cleanListName(name));
    if (!key) return null;
    return Object.keys(this.doc.lists || {}).find((lid) => isObject(this.doc.lists[lid]) && fold(String(this.doc.lists[lid].name || "")) === key) || null;
  }

  /** Şarkı bu listede kaç kez var? */
  listCount(lid, songId) {
    const list = this.getList(lid);
    return list ? list.items.filter((item) => item.song === songId).length : 0;
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

  // ------------------------------------------------ çalma listeleri (değiştirme)

  #newItemId(list) {
    const taken = new Set(this.#listItems(list).map((item) => item.iid));
    for (let i = 0; i < 20; i += 1) {
      const iid = `i${Math.floor(this.random() * 36 ** 5).toString(36).padStart(5, "0")}`;
      if (!taken.has(iid)) return iid;
    }
    return `i${this.now().toString(36)}${taken.size}`;
  }

  #newListId(doc) {
    for (let i = 0; i < 20; i += 1) {
      const lid = `l${Math.floor(this.random() * 36 ** 6).toString(36).padStart(5, "0")}`;
      if (!has(doc.lists, lid)) return lid;
    }
    return `l${this.now().toString(36)}`;
  }

  #list(doc, lid) {
    if (!isObject(doc.lists)) doc.lists = {};
    return has(doc.lists, lid) && isObject(doc.lists[lid]) ? doc.lists[lid] : null;
  }

  /** Liste oluşturur; aynı ad (harf katlamasıyla) varsa onu döner: {ok, id, created}. */
  createList(name) {
    const clean = cleanListName(name);
    if (!clean) return { ok: false, error: "empty" };
    const existing = this.findListByName(clean);
    if (existing) return { ok: true, id: existing, created: false };
    return this.#mutate((doc) => {
      if (!isObject(doc.lists)) doc.lists = {};
      if (Object.keys(doc.lists).length >= LIST_LIMIT) return { ok: false, error: "limit" };
      const id = this.#newListId(doc);
      doc.lists[id] = { name: clean, t: this.now(), items: [] };
      return { id, created: true };
    });
  }

  renameList(lid, name) {
    const clean = cleanListName(name);
    if (!clean) return { ok: false, error: "empty" };
    if (!this.getList(lid)) return { ok: false, error: "missing" };
    const clash = this.findListByName(clean);
    if (clash && clash !== lid) return { ok: false, error: "exists" };
    return this.#mutate((doc) => {
      const list = this.#list(doc, lid);
      if (list.name === clean) return { noop: true };
      list.name = clean;
      return {};
    });
  }

  deleteList(lid) {
    if (!this.getList(lid)) return { ok: false, error: "missing" };
    return this.#mutate((doc) => {
      delete doc.lists[lid];
      return {};
    });
  }

  /** Şarkıları listenin SONUNA, verilen sırayla ekler (aynı şarkı tekrar olabilir). {ok, added} | {ok:false, error}. */
  addToList(lid, songIds) {
    if (!this.getList(lid)) return { ok: false, error: "missing" };
    const valid = songIds.filter((id) => SONG_ID_RE.test(String(id)));
    if (!valid.length) return { ok: false, error: "id" };
    return this.#mutate((doc) => {
      const list = this.#list(doc, lid);
      if (!Array.isArray(list.items)) list.items = [];
      if (list.items.length + valid.length > LIST_ITEMS_MAX) return { ok: false, error: "full" };
      for (const song of valid) list.items.push({ iid: this.#newItemId(list), song });
      return { added: valid.length };
    });
  }

  removeItem(lid, iid) {
    const list = this.getList(lid);
    if (!list || !list.items.some((item) => item.iid === iid)) return { ok: false, error: "missing" };
    return this.#mutate((doc) => {
      const target = this.#list(doc, lid);
      target.items = target.items.filter((item) => !(isObject(item) && item.iid === iid));
      if (target.cur === iid) delete target.cur;
      return {};
    });
  }

  /** Öğeyi bir basamak yukarı (-1) / aşağı (+1) taşır. {ok, moved} (kenardaysa noop). */
  moveItem(lid, iid, delta) {
    const list = this.getList(lid);
    if (!list) return { ok: false, error: "missing" };
    const index = list.items.findIndex((item) => item.iid === iid);
    if (index < 0) return { ok: false, error: "missing" };
    const to = index + (delta < 0 ? -1 : 1);
    if (to < 0 || to >= list.items.length) return { ok: true, moved: false, noop: true };
    return this.#mutate((doc) => {
      const items = this.#list(doc, lid).items;
      const a = items.findIndex((item) => isObject(item) && item.iid === iid);
      const b = a + (delta < 0 ? -1 : 1);
      [items[a], items[b]] = [items[b], items[a]];
      return { moved: true };
    });
  }

  /** Son çalınan öğe (Devam): iid ya da null (temizle). Aynı değerse yazılmaz. */
  setCur(lid, iid) {
    const list = this.getList(lid);
    if (!list) return { ok: false, error: "missing" };
    if ((list.cur || null) === (iid || null)) return { ok: true, noop: true };
    if (iid && !list.items.some((item) => item.iid === iid)) return { ok: false, error: "missing" };
    return this.#mutate((doc) => {
      const target = this.#list(doc, lid);
      if (iid) target.cur = iid;
      else delete target.cur;
      return {};
    });
  }

  /** Silinen şarkıların kayıtları ve LİSTE ÖĞELERİ HEMEN gider (uygulamadan silme). */
  removeSongs(ids) {
    const gone = new Set(ids);
    const present = [...gone].filter((id) => has(this.doc.songs, id));
    const inLists = Object.values(this.doc.lists || {}).some((list) => this.#listItems(list).some((item) => gone.has(item.song)));
    if (!present.length && !inLists) return { ok: true, removed: 0, noop: true };
    return this.#mutate((doc) => {
      for (const id of present) delete doc.songs[id];
      let items = 0;
      for (const list of Object.values(doc.lists || {})) {
        if (!isObject(list) || !Array.isArray(list.items)) continue;
        const before = list.items.length;
        list.items = list.items.filter((item) => !(isObject(item) && gone.has(item.song)));
        items += before - list.items.length;
        if (list.cur && !list.items.some((item) => isObject(item) && item.iid === list.cur)) delete list.cur;
      }
      return { removed: present.length, items };
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
      // Liste öğeleri: şarkı görünmüyorsa "miss" damgası (listede soluk "bulunamadı", çalmada atlanır), 30 günden uzun
      // yoksa öğe silinir; tekrar görününce damga kalkar. (Liste, `songs` kayıtlarına bağlı DEĞİL.)
      for (const list of Object.values(doc.lists || {})) {
        if (!isObject(list) || !Array.isArray(list.items)) continue;
        const keep = [];
        for (const item of list.items) {
          if (!isObject(item) || typeof item.song !== "string") {
            keep.push(item);
            continue;
          }
          if (presentIds.has(item.song)) {
            if (item.miss !== undefined) {
              delete item.miss;
              changed += 1;
            }
            keep.push(item);
          } else if (!Number.isFinite(item.miss)) {
            item.miss = at;
            changed += 1;
            keep.push(item);
          } else if (at - item.miss > ORPHAN_MS) {
            changed += 1;                                  // atılır
            if (list.cur === item.iid) delete list.cur;
          } else {
            keep.push(item);
          }
        }
        if (keep.length !== list.items.length) list.items = keep;
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
      // Çalma listeleri: aynı adlı liste (harf katlamasıyla) BİRLEŞTİRİLİR; şarkı başına sayı dikkate alınır (yedekteki tekrar
      // sayısı mevcuttan fazlaysa eksik tekrarlar eklenir; ikinci yüklemede çoğalma olmaz). Öğeler yeni kimlik alır.
      let listsAdded = 0;
      let itemsAdded = 0;
      if (isObject(data.lists)) {
        if (!isObject(doc.lists)) doc.lists = {};
        for (const saved of Object.values(data.lists)) {
          if (!isObject(saved) || !Array.isArray(saved.items)) continue;
          const name = cleanListName(saved.name);
          if (!name) continue;
          let lid = this.findListByName(name);
          if (!lid) {
            if (Object.keys(doc.lists).length >= LIST_LIMIT) continue;
            lid = this.#newListId(doc);
            doc.lists[lid] = { name, t: this.now(), items: [] };
            listsAdded += 1;
          }
          const list = doc.lists[lid];
          if (!Array.isArray(list.items)) list.items = [];
          const have = {};
          for (const item of list.items) if (isObject(item) && typeof item.song === "string") have[item.song] = (have[item.song] || 0) + 1;
          const seen = {};
          for (const item of saved.items) {
            if (!isObject(item) || typeof item.song !== "string" || !SONG_ID_RE.test(item.song)) continue;
            seen[item.song] = (seen[item.song] || 0) + 1;
            if (seen[item.song] <= (have[item.song] || 0)) continue;
            if (list.items.length >= LIST_ITEMS_MAX) break;
            list.items.push({ iid: this.#newItemId(list), song: item.song });
            have[item.song] = (have[item.song] || 0) + 1;
            itemsAdded += 1;
          }
        }
      }
      return { tagsAdded, favsAdded, songsTouched, listsAdded, itemsAdded };
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
