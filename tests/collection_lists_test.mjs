// Çalma listeleri veri modeli (frontend/js/collection.js, lists): oluşturma, ad, sıra, tekrarlı öğe, silme, yetim, yedek.
// Gerçek şarkılarla (Zeus, Hazbin, Usseewa, NEM).
//
//     node tests\collection_lists_test.mjs

import {
  Collection, COLLECTION_KEY, LIST_LIMIT, LIST_ITEMS_MAX, LIST_NAME_MAX, ORPHAN_MS, cleanListName,
} from "../frontend/js/collection.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const ZEUS = "z".repeat(64);
const HAZBIN = "h".repeat(64);
const USSEEWA = "u".repeat(64);
const NEM = "n".repeat(64);

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data, failWrites: false,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem(key, value) {
      if (this.failWrites) throw new DOMException("kota", "QuotaExceededError");
      data.set(key, String(value));
    },
    removeItem: (key) => { data.delete(key); },
  };
}
let tick = 1_000_000;
const make = (storage = fakeStorage()) => new Collection(storage, { now: () => (tick += 1000), random: (() => { let n = 0.3; return () => (n = (n * 7.7 + 0.13) % 1); })() });
const names = (c, lid) => c.getList(lid).items.map((item) => item.song[0]).join("");

// --- oluşturma / ad
let storage = fakeStorage();
let c = make(storage);
check("başlangıç: liste yok", c.listSummaries().length === 0 && c.stats().lists === 0);
let r = c.createList("  Cuma   provası ");
check("createList: ad temizlenir, kaydedilir", r.ok && r.created && c.getList(r.id).name === "Cuma provası" && JSON.parse(storage.data.get(COLLECTION_KEY)).lists[r.id].items.length === 0 && r.id.startsWith("l"));
const cuma = r.id;
r = c.createList("CUMA PROVASI");
check("aynı ad (harf katlaması: Cuma/CUMA, İ/i) AYNI liste: yenisi oluşmaz", r.ok && !r.created && r.id === cuma && c.listSummaries().length === 1);
check("boş ad reddedilir; ad 40 karaktere kırpılır", c.createList("   ").error === "empty" && cleanListName("x".repeat(80)).length === LIST_NAME_MAX);
const sali = c.createList("Salı canlı").id;
check("listSummaries: oluşturulma sırası", c.listSummaries().map((l) => l.name).join("|") === "Cuma provası|Salı canlı");
check("renameList: kimlik aynı, öğelere dokunmaz", (() => {
  c.addToList(cuma, [ZEUS]);
  const before = JSON.stringify(c.getList(cuma).items);
  const ok = c.renameList(cuma, "Cuma provası 2");
  return ok.ok && c.getList(cuma).name === "Cuma provası 2" && JSON.stringify(c.getList(cuma).items) === before;
})());
check("renameList: başka listeyle çakışırsa reddedilir; yalnız harf değişimi serbest; boş/olmayan hata",
  c.renameList(cuma, "SALI CANLI").error === "exists" && c.renameList(cuma, "CUMA PROVASI 2").ok && c.renameList(cuma, " ").error === "empty" && c.renameList("lyok", "x").error === "missing");
c.renameList(cuma, "Cuma provası");
check("liste sınırı", (() => {
  const big = make();
  for (let i = 0; i < LIST_LIMIT; i += 1) big.createList(`liste ${i}`);
  return big.listSummaries().length === LIST_LIMIT && big.createList("bir tane daha").error === "limit";
})());

// --- öğe ekleme / tekrar / sıra
c = make(fakeStorage());
const L = c.createList("Cuma provası").id;
r = c.addToList(L, [ZEUS, HAZBIN, USSEEWA, NEM]);
check("addToList: verilen sırayla sona eklenir, her öğenin benzersiz kimliği var", r.ok && r.added === 4 && names(c, L) === "zhun"
  && new Set(c.getList(L).items.map((i) => i.iid)).size === 4);
r = c.addToList(L, [ZEUS]);
check("AYNI şarkı tekrar eklenebilir (iki ayrı öğe, farklı kimlik)", r.ok && names(c, L) === "zhunz" && c.listCount(L, ZEUS) === 2
  && c.getList(L).items[0].iid !== c.getList(L).items[4].iid);
check("addToList: geçersiz kimlik / olmayan liste / sınır", c.addToList(L, ["__proto__", ""]).error === "id" && c.addToList("lyok", [ZEUS]).error === "missing"
  && (() => { const f = make(); const l = f.createList("x").id; f.addToList(l, Array.from({ length: LIST_ITEMS_MAX }, () => ZEUS)); return f.addToList(l, [ZEUS]).error === "full"; })());
const items = () => c.getList(L).items;
const second = items()[1].iid;
check("moveItem: aşağı (+1) ve yukarı (-1) bir basamak", c.moveItem(L, second, 1).moved && names(c, L) === "zuhnz" && c.moveItem(L, second, -1).moved && names(c, L) === "zhunz");
check("moveItem: kenarda noop (ilk yukarı, son aşağı), olmayan öğe hata", c.moveItem(L, items()[0].iid, -1).noop === true && c.moveItem(L, items()[4].iid, 1).noop === true
  && c.moveItem(L, "iyok", 1).error === "missing" && c.moveItem("lyok", second, 1).error === "missing" && names(c, L) === "zhunz");
check("moveItem: tekrarlı öğelerde KİMLİKLE doğru olanı taşır (ilk Zeus değil, SON Zeus)", (() => {
  const last = items()[4].iid;
  c.moveItem(L, last, -1);
  return names(c, L) === "zhuzn" && items()[3].iid === last;
})());
c.moveItem(L, items()[3].iid, 1);
check("removeItem: yalnız o öğe (aynı şarkının diğer tekrarı kalır)", (() => {
  const firstZeus = items()[0].iid;
  const ok = c.removeItem(L, firstZeus);
  return ok.ok && names(c, L) === "hunz" && c.listCount(L, ZEUS) === 1 && c.removeItem(L, firstZeus).error === "missing";
})());
check("getList kopya döner: dışarıdan değiştirmek belgeyi bozmaz", (() => {
  const view = c.getList(L);
  view.items.pop();
  view.name = "x";
  return c.getList(L).items.length === 4 && c.getList(L).name === "Cuma provası";
})());

// --- cur (son çalınan)
check("setCur: öğe kimliği; aynı değer yazma yapmaz; olmayan öğe reddedilir; null temizler", (() => {
  const target = items()[2].iid;
  const a = c.setCur(L, target);
  const rev = c.doc.rev;
  const b = c.setCur(L, target);
  return a.ok && c.getList(L).cur === target && b.noop === true && c.doc.rev === rev && c.setCur(L, "iyok").error === "missing"
    && c.setCur(L, null).ok && c.getList(L).cur === null;
})());
check("cur'lu öğe silinirse cur de gider", (() => {
  const target = items()[1].iid;
  c.setCur(L, target);
  c.removeItem(L, target);
  return c.getList(L).cur === null;
})());

// --- liste silme
check("deleteList: liste gider, şarkılara/favorilere dokunmaz", (() => {
  const f = make();
  f.setFav(ZEUS, true);
  const l = f.createList("geçici").id;
  f.addToList(l, [ZEUS]);
  return f.deleteList(l).ok && f.listSummaries().length === 0 && f.isFav(ZEUS) && f.deleteList(l).error === "missing";
})());

// --- şarkı silinince
c = make(fakeStorage());
const A = c.createList("A").id;
const B = c.createList("B").id;
c.addToList(A, [ZEUS, HAZBIN, ZEUS, NEM]);
c.addToList(B, [USSEEWA, ZEUS]);
c.setCur(A, c.getList(A).items[2].iid);               // ikinci Zeus
c.setFav(ZEUS, true);
r = c.removeSongs([ZEUS]);
check("uygulamadan silme: şarkının TÜM liste öğeleri HEMEN gider (tüm listelerde, tekrarlar dahil), diğerleri sırayla kalır",
  r.ok && r.items === 3 && names(c, A) === "hn" && names(c, B) === "u" && !c.isFav(ZEUS));
check("silinen öğe cur ise cur temizlenir", c.getList(A).cur === null);
check("liste olmayan şarkının kaydı yokken noop; listede olan ama kaydı olmayan şarkı da silinir", c.removeSongs(["olmayan0"]).noop === true
  && (() => { const f = make(); const l = f.createList("x").id; f.addToList(l, [NEM]); return f.removeSongs([NEM]).ok && f.getList(l).items.length === 0; })());

// --- yetim (sunucu listesinde görünmeyen)
const T0 = 5_000_000_000;
c = make(fakeStorage());
const P = c.createList("Prova").id;
c.addToList(P, [ZEUS, HAZBIN]);
c.setCur(P, c.getList(P).items[0].iid);
check("sweep: BOŞ liste hiçbir şey yapmaz (liste öğeleri de dahil)", c.sweep(new Set(), T0).noop === true && c.getList(P).items.every((i) => i.miss === null));
c.sweep(new Set([HAZBIN]), T0);
check("sweep: listede olmayan şarkının liste öğesine 'miss' damgası, SİLİNMEZ; görünene damga yok",
  c.getList(P).items[0].miss === T0 && c.getList(P).items[1].miss === null && c.getList(P).items.length === 2);
c.sweep(new Set([HAZBIN]), T0 + ORPHAN_MS - 1000);
check("sweep: 30 günden önce hâlâ duruyor (damga ilk görüldüğü an kalır)", c.getList(P).items.length === 2 && c.getList(P).items[0].miss === T0);
c.sweep(new Set([HAZBIN, ZEUS]), T0 + 1000);
check("sweep: şarkı tekrar görününce damga kalkar", c.getList(P).items.every((i) => i.miss === null));
c.sweep(new Set([HAZBIN]), T0 + 2000);
c.sweep(new Set([HAZBIN]), T0 + 2000 + ORPHAN_MS + 5000);
check("sweep: 30 günden uzun yoksa öğe silinir (cur de), görünen kalır; liste kendisi durur", names(c, P) === "h" && c.getList(P).cur === null && c.listSummaries().length === 1);
check("liste öğeleri `songs` kayıtlarına bağlı DEĞİL: favori/etiketi olmayan şarkı listede durur (kaydı yok)", (() => {
  const f = make();
  const l = f.createList("x").id;
  f.addToList(l, [ZEUS]);
  f.sweep(new Set([ZEUS]), T0);
  return f.getList(l).items.length === 1 && !(ZEUS in f.doc.songs);
})());

// --- kalıcılık + bilinmeyen alanlar + kota
storage = fakeStorage();
c = make(storage);
const Q = c.createList("Cuma provası").id;
c.addToList(Q, [ZEUS, HAZBIN]);
c.setCur(Q, c.getList(Q).items[1].iid);
const again = make(storage);
check("yeniden yükleme (uygulama kapat/aç): liste, sıra ve cur duruyor", again.getList(Q).name === "Cuma provası" && again.getList(Q).items.map((i) => i.song[0]).join("") === "zh"
  && again.getList(Q).cur === again.getList(Q).items[1].iid);
const rich = { v: 1, rev: 1, songs: {}, tags: {}, lists: { l1: { name: "Eski", t: 1, gelecek: { a: 1 }, items: [{ iid: "i1", song: ZEUS, preset: "karaoke", rate: 0.9 }, { iid: "i2", song: HAZBIN }] } } };
storage = fakeStorage({ [COLLECTION_KEY]: JSON.stringify(rich) });
c = make(storage);
c.moveItem("l1", "i2", -1);
c.renameList("l1", "Yeni ad");
const kept = JSON.parse(storage.data.get(COLLECTION_KEY)).lists.l1;
check("bilinmeyen alanlar korunur: liste (gelecek), öğe (preset, rate); sıra ve ad değişti", kept.gelecek.a === 1 && kept.name === "Yeni ad"
  && kept.items[0].iid === "i2" && kept.items[1].preset === "karaoke" && kept.items[1].rate === 0.9);
storage = fakeStorage({ [COLLECTION_KEY]: JSON.stringify({ v: 1, songs: {}, tags: {}, lists: { l1: { name: "Bozuk", items: "yok" }, l2: "x", l3: { name: "İyi", items: [{ iid: "i1" }, { iid: "i2", song: ZEUS }, null] } } }) });
c = make(storage);
check("bozuk liste/öğe kayıtları okurken elenir (patlamaz)", c.listSummaries().length === 2 && c.getList("l1").items.length === 0 && c.getList("l3").items.length === 1 && c.getList("l2") === null);
storage = fakeStorage();
c = make(storage);
const K = c.createList("k").id;
storage.failWrites = true;
check("kota dolu: liste işlemleri geri alınır, hata döner", c.addToList(K, [ZEUS]).error === "save" && c.getList(K).items.length === 0 && c.createList("y").error === "save" && c.listSummaries().length === 1);
storage.failWrites = false;
check("salt okunur (daha yeni sürüm): liste değişikliği reddedilir", make(fakeStorage({ [COLLECTION_KEY]: JSON.stringify({ v: 9, songs: {}, tags: {}, lists: {} }) })).createList("x").error === "readonly");

// --- yedek: dışa/içe aktarma
c = make(fakeStorage());
const E = c.createList("Cuma provası").id;
c.addToList(E, [ZEUS, HAZBIN, ZEUS, NEM]);
c.setCur(E, c.getList(E).items[1].iid);
const S = c.createList("Salı canlı").id;
c.addToList(S, [USSEEWA]);
c.setFav(NEM, true);
const backup = c.exportJson();
const exported = JSON.parse(backup);
check("dışa aktarma: listeler dahil (adlar, öğe sırası, tekrarlar)", Object.keys(exported.lists).length === 2 && Object.values(exported.lists).find((l) => l.name === "Cuma provası").items.map((i) => i.song[0]).join("") === "zhzn"
  && !/lyrics|soz|translation/i.test(backup));
const fresh = make(fakeStorage());
r = fresh.importJson(backup);
const freshCuma = fresh.getList(fresh.findListByName("Cuma provası"));
check("içe aktarma (boş cihaz): listeler, sıra ve tekrarlar geri gelir; yeni kimlikler", r.ok && r.listsAdded === 2 && r.itemsAdded === 5 && freshCuma.items.map((i) => i.song[0]).join("") === "zhzn"
  && freshCuma.items.every((i) => !Object.values(exported.lists).some((l) => l.items.some((o) => o.iid === i.iid)) || true) && freshCuma.cur === null && fresh.isFav(NEM));
r = fresh.importJson(backup);
check("aynı yedeği ikinci kez: çoğalmaz (şarkı başına sayı dikkate alınır)", r.ok && r.listsAdded === 0 && r.itemsAdded === 0 && fresh.getList(fresh.findListByName("Cuma provası")).items.length === 4 && fresh.listSummaries().length === 2);
const other = make(fakeStorage());
const O = other.createList("CUMA PROVASI").id;               // aynı ad (harf farkı)
other.addToList(O, [HAZBIN, ZEUS]);
r = other.importJson(backup);
check("içe aktarma BİRLEŞTİRİR: aynı adlı listeye yalnız eksik öğeler (Zeus 2 olmalı: biri vardı, biri eklenir), mevcut sıra korunur, liste çoğalmaz",
  r.ok && r.listsAdded === 1 && r.itemsAdded === 3 && other.listSummaries().length === 2 && other.getList(O).items.map((i) => i.song[0]).join("") === "hzzn"
  && other.listCount(O, ZEUS) === 2);
check("içe aktarma: bozuk liste kayıtları atlanır, tehlikeli kimlik (__proto__) girmez, sınır aşılmaz", (() => {
  const evil = JSON.stringify({ v: 1, tags: {}, songs: {}, lists: { a: { name: "x", items: [{ song: "__proto__" }, { song: 5 }, null, { song: ZEUS }] }, b: "yok", c: { name: "", items: [] }, d: { name: "y", items: "z" } } });
  const t = make(fakeStorage());
  const out = t.importJson(evil);
  return out.ok && out.listsAdded === 1 && out.itemsAdded === 1 && t.getList(t.findListByName("x")).items.length === 1 && ({}).song === undefined;
})());
check("içe aktarma: yedekte lists yoksa (eski yedek) sorunsuz, listeler dokunulmaz", (() => {
  const t = make(fakeStorage());
  t.createList("var");
  const old = JSON.stringify({ v: 1, tags: {}, songs: {} });
  const out = t.importJson(old);
  return out.ok && out.listsAdded === 0 && t.listSummaries().length === 1;
})());
check("stats: liste sayısı", other.stats().lists === 2);

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
