// Kitaplık verisi: favoriler + etiketler (frontend/js/collection.js). Sahte depo, gerçek şarkı adlarıyla.
//
//     node tests\collection_test.mjs

import {
  Collection, COLLECTION_KEY, COLLECTION_BAD_KEY, COLLECTION_VERSION, TAG_NAME_MAX, TAG_LIMIT, ORPHAN_MS, cleanTagName, safeStorage,
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

function fakeStorage(initial = {}, { failWrites = false } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    failWrites,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem(key, value) {
      if (this.failWrites) throw new DOMException("kota", "QuotaExceededError");
      data.set(key, String(value));
    },
    removeItem: (key) => { data.delete(key); },
  };
}
let tick = 1_000_000;
const make = (storage = fakeStorage(), extra = {}) => new Collection(storage, { now: () => (tick += 1000), random: (() => { let n = 0.1; return () => (n = (n * 7.3) % 1); })(), ...extra });

// --- boş başlangıç
let storage = fakeStorage();
let c = make(storage);
check("boş depo: status empty, hiçbir şey yazılmadı", c.status === "empty" && storage.data.size === 0 && c.stats().songs === 0);

// --- favoriler
check("setFav: favori olur ve KAYDEDİLİR (tek anahtar)", c.setFav(ZEUS, true).ok && c.isFav(ZEUS) && storage.data.has(COLLECTION_KEY)
  && JSON.parse(storage.data.get(COLLECTION_KEY)).songs[ZEUS].fav === true);
check("aynı değeri tekrar yazmak yazma yapmaz (noop, rev artmaz)", (() => {
  const rev = c.doc.rev;
  const r = c.setFav(ZEUS, true);
  return r.ok && r.noop && c.doc.rev === rev;
})());
check("toggleFav kapatır; kaydı kalmaz (yalnız favorisi/etiketi olanlar tutulur)", c.toggleFav(ZEUS).ok && !c.isFav(ZEUS) && !(ZEUS in c.doc.songs));
c.setFav(HAZBIN, true);
c.setFav(NEM, true);
check("favCount", c.favCount() === 2);
check("geçersiz şarkı kimliği reddedilir (__proto__, boş, çok uzun)", ["__proto__", "", "a".repeat(200), "x y"].every((id) => c.setFav(id, true).ok === false)
  && Object.keys(c.doc.songs).length === 2 && ({}).fav === undefined);

// --- etiketler
check("cleanTagName: boşluk toplanır, kırpılır, 24 karakter", cleanTagName("  Türkçe   cover  ") === "Türkçe cover" && cleanTagName("x".repeat(50)).length === TAG_NAME_MAX && cleanTagName("   ") === "");
let r = c.createTag("Prova");
check("createTag: yeni etiket", r.ok && r.created && c.tagName(r.id) === "Prova" && r.id.startsWith("t"));
const prova = r.id;
r = c.createTag("  prova ");
check("aynı ad (büyük/küçük harf, boşluk farkı) AYNI etiket: yenisi oluşmaz", r.ok && !r.created && r.id === prova && c.tagList().length === 1);
check("Türkçe katlama: 'İSTANBUL' ve 'istanbul' aynı etiket", (() => {
  const a = c.createTag("İstanbul");
  const b = c.createTag("ISTANBUL");
  const d = c.createTag("istanbul");
  return a.created && !b.created && !d.created && a.id === b.id;
})());
check("boş ad reddedilir", c.createTag("   ").ok === false && c.createTag("").error === "empty");
const istanbul = c.findTagByName("istanbul");
check("setTagOnSongs: iki şarkıya ekler, çift eklemez", c.setTagOnSongs([ZEUS, HAZBIN], prova, true).changed === 2
  && c.setTagOnSongs([ZEUS, HAZBIN], prova, true).noop === true && c.tagIdsOf(ZEUS).length === 1);
check("tagState: all / some / none", c.tagState(prova, [ZEUS, HAZBIN]) === "all" && c.tagState(prova, [ZEUS, USSEEWA]) === "some" && c.tagState(prova, [USSEEWA]) === "none" && c.tagState(prova, []) === "none");
check("tagList: sayım + Türkçe sıra (İstanbul, Prova)", JSON.stringify(c.tagList().map((t) => [t.name, t.count])) === '[["İstanbul",0],["Prova",2]]');
check("yeniden adlandırma: kimlik aynı, şarkı kayıtlarına dokunmaz", (() => {
  const before = JSON.stringify(c.doc.songs);
  const ok = c.renameTag(prova, "Prova listesi");
  return ok.ok && c.tagName(prova) === "Prova listesi" && JSON.stringify(c.doc.songs) === before && c.tagIdsOf(ZEUS)[0] === prova;
})());
check("yeniden adlandırma: başka etiketle çakışırsa reddedilir (harf katlamasıyla)", c.renameTag(prova, "ISTANBUL").error === "exists" && c.tagName(prova) === "Prova listesi");
check("yeniden adlandırma: yalnız büyük/küçük harf değişimi serbest", c.renameTag(istanbul, "ISTANBUL").ok && c.tagName(istanbul) === "ISTANBUL");
check("yeniden adlandırma: boş ad / olmayan etiket reddedilir", c.renameTag(prova, " ").error === "empty" && c.renameTag("tyok", "x").error === "missing");
check("setTagOnSongs olmayan etiket reddedilir", c.setTagOnSongs([ZEUS], "tyok", true).error === "missing");
c.setTagOnSongs([USSEEWA], istanbul, true);
check("setTagOnSongs çıkarma: etiketi kalmayan, favorisi olmayan şarkının kaydı silinir", c.setTagOnSongs([USSEEWA], istanbul, false).changed === 1 && !(USSEEWA in c.doc.songs));
check("etiket silme: tüm şarkılardan kalkar (kaç şarkı), kaydı boşalan şarkı kaydı gider, favori kalan kalır", (() => {
  const out = c.deleteTag(prova);
  return out.ok && out.removedFrom === 2 && c.tagIdsOf(ZEUS).length === 0 && !(ZEUS in c.doc.songs) && c.isFav(HAZBIN) && c.tagIdsOf(HAZBIN).length === 0;
})());
check("olmayan etiketi silmek hata", c.deleteTag("tyok").error === "missing");
check("etiket sınırı", (() => {
  const big = make();
  for (let i = 0; i < TAG_LIMIT; i += 1) big.createTag(`etiket ${i}`);
  return big.tagList().length === TAG_LIMIT && big.createTag("bir tane daha").error === "limit";
})());

// --- şarkı silme
c = make(fakeStorage());
c.setFav(ZEUS, true); c.setFav(HAZBIN, true);
const t1 = c.createTag("prova").id;
c.setTagOnSongs([ZEUS, USSEEWA], t1, true);
r = c.removeSongs([ZEUS, USSEEWA, "olmayan0"]);
check("removeSongs: kayıtlar HEMEN gider (favori + etiket), diğerleri kalır", r.ok && r.removed === 2 && !c.isFav(ZEUS) && c.tagIdsOf(USSEEWA).length === 0 && c.isFav(HAZBIN));
check("removeSongs: etiketin kendisi durur (0 şarkı)", c.tagList().length === 1 && c.tagList()[0].count === 0);
check("removeSongs: kaydı olmayanlar noop", c.removeSongs(["olmayan0"]).noop === true);

// --- kalıcılık: yeniden yükleme
storage = fakeStorage();
c = make(storage);
c.setFav(NEM, true);
const t2 = c.createTag("Türkçe cover").id;
c.setTagOnSongs([NEM, HAZBIN], t2, true);
const again = make(storage);
check("yeniden yükleme (uygulama kapat/aç): favori ve etiketler duruyor", again.status === "ok" && again.isFav(NEM) && again.tagName(t2) === "Türkçe cover"
  && again.tagIdsOf(HAZBIN)[0] === t2 && again.tagList()[0].count === 2);

// --- yetim kayıt (sunucu listesinde görünmeyen)
const T0 = 5_000_000_000;
c = make(fakeStorage());
c.setFav(ZEUS, true); c.setFav(HAZBIN, true);
check("sweep: BOŞ liste hiçbir şey yapmaz (kısmi/boş liste etiketleri silmesin)", c.sweep(new Set(), T0).noop === true && c.isFav(ZEUS) && !("miss" in c.doc.songs[ZEUS]));
c.sweep(new Set([HAZBIN]), T0);
check("sweep: listede olmayan şarkıya 'miss' damgası, SİLİNMEZ; olana damga yok", c.doc.songs[ZEUS].miss === T0 && c.isFav(ZEUS) && !("miss" in c.doc.songs[HAZBIN]));
c.sweep(new Set([HAZBIN]), T0 + ORPHAN_MS - 1000);
check("sweep: 30 günden önce hâlâ duruyor (damga ilk görüldüğü an kalır)", c.isFav(ZEUS) && c.doc.songs[ZEUS].miss === T0);
c.sweep(new Set([HAZBIN, ZEUS]), T0 + 1000);
check("sweep: şarkı tekrar görününce damga kalkar", !("miss" in c.doc.songs[ZEUS]) && c.isFav(ZEUS));
c.sweep(new Set([HAZBIN]), T0 + 2000);
c.sweep(new Set([HAZBIN]), T0 + 2000 + ORPHAN_MS + 5000);
check("sweep: 30 günden uzun yoksa kaydı silinir, görünen kalır", !c.isFav(ZEUS) && c.isFav(HAZBIN));

// --- bozuk veri sessizce SIFIRLANMAZ
const bad = "{bozuk json";
storage = fakeStorage({ [COLLECTION_KEY]: bad });
c = make(storage);
check("bozuk JSON: status corrupt, ham kopya .bad'e taşındı, asıl anahtara DOKUNULMADI", c.status === "corrupt" && storage.data.get(COLLECTION_BAD_KEY) === bad
  && storage.data.get(COLLECTION_KEY) === bad && c.stats().songs === 0);
c.setFav(ZEUS, true);
check("bozuk veri: ilk değişiklikte yeni belge yazılır, eski ham kopya .bad'de kalır", JSON.parse(storage.data.get(COLLECTION_KEY)).songs[ZEUS].fav === true && storage.data.get(COLLECTION_BAD_KEY) === bad);
storage = fakeStorage({ [COLLECTION_KEY]: JSON.stringify({ v: 1, songs: [1, 2], tags: {} }) });
check("şekli bozuk belge (songs dizi): corrupt", make(storage).status === "corrupt");
storage = fakeStorage({ [COLLECTION_KEY]: "null" });
check("'null' içerik: corrupt", make(storage).status === "corrupt");

// --- daha yeni sürüm: salt okunur, veri korunur
const future = { v: COLLECTION_VERSION + 1, rev: 9, songs: { [ZEUS]: { fav: true, yeniAlan: 1 } }, tags: {}, lists: { l1: { name: "x" } }, yeni: "alan" };
storage = fakeStorage({ [COLLECTION_KEY]: JSON.stringify(future) });
c = make(storage);
check("daha yeni sürüm: status newer, okunabilir, değiştirmek REDDEDİLİR, depo aynen", c.status === "newer" && c.isFav(ZEUS)
  && c.setFav(HAZBIN, true).error === "readonly" && c.createTag("x").error === "readonly" && storage.data.get(COLLECTION_KEY) === JSON.stringify(future));

// --- bilinmeyen alanlar korunur
const known = { v: 1, rev: 3, updated: 1, songs: { [ZEUS]: { fav: true, t: 1, gelecek: { a: 1 } } }, tags: {}, lists: { l1: { name: "Prova", items: [{ song: ZEUS }] } }, ekstra: [1, 2] };
storage = fakeStorage({ [COLLECTION_KEY]: JSON.stringify(known) });
c = make(storage);
c.setFav(HAZBIN, true);
c.setFav(ZEUS, false);
const saved = JSON.parse(storage.data.get(COLLECTION_KEY));
check("bilinmeyen alanlar korunur: üst düzey (ekstra), lists, şarkı kaydındaki (gelecek)", JSON.stringify(saved.ekstra) === "[1,2]" && saved.lists.l1.items[0].song === ZEUS
  && saved.songs[ZEUS] && saved.songs[ZEUS].gelecek.a === 1 && !saved.songs[ZEUS].fav && saved.songs[HAZBIN].fav === true && saved.rev === 5);

// --- kota dolu: kaydedilemezse geri alınır ve HATA döner (sessiz kayıp YOK)
storage = fakeStorage();
c = make(storage);
c.setFav(ZEUS, true);
storage.failWrites = true;
r = c.setFav(HAZBIN, true);
check("kota dolu: {ok:false, error:'save'}, bellek ESKİ hâline döner (arayüz 'kaydedildi' sanmaz)", r.ok === false && r.error === "save" && !c.isFav(HAZBIN) && c.isFav(ZEUS));
check("kota dolu: etiket oluşturma/silme de aynı (geri alınır)", c.createTag("prova").error === "save" && c.tagList().length === 0);
storage.failWrites = false;
check("kota düzelince tekrar çalışır", c.setFav(HAZBIN, true).ok && JSON.parse(storage.data.get(COLLECTION_KEY)).songs[HAZBIN].fav === true);
check("depo getItem patlarsa boş başlar", new Collection({ getItem() { throw new Error("x"); }, setItem() {}, removeItem() {} }).status === "empty");

// --- yedek: dışa aktar -> içe aktar
c = make(fakeStorage());
c.setFav(NEM, true); c.setFav(HAZBIN, true);
const tTr = c.createTag("Türkçe cover").id; const tPr = c.createTag("Prova").id;
c.setTagOnSongs([HAZBIN, ZEUS], tTr, true); c.setTagOnSongs([ZEUS], tPr, true);
const backup = c.exportJson();
const parsed = JSON.parse(backup);
check("dışa aktarma: v1, tür, tarih, etiketler, şarkılar (sözler/çeviri YOK)", parsed.v === 1 && parsed.kind === "stem-mikser-collection" && /^\d{4}-\d\d-\d\dT/.test(parsed.exported)
  && Object.keys(parsed.tags).length === 2 && parsed.songs[NEM].fav === true && !/lyrics|soz|translation/i.test(backup));
const fresh = make(fakeStorage());
r = fresh.importJson(backup);
check("içe aktarma (boş cihaz): etiket, favori ve eşlemeler geri gelir", r.ok && r.tagsAdded === 2 && r.favsAdded === 2 && r.songsTouched === 3
  && fresh.isFav(NEM) && fresh.isFav(HAZBIN) && fresh.tagList().length === 2
  && fresh.tagIdsOf(ZEUS).map((tid) => fresh.tagName(tid)).sort().join() === "Prova,Türkçe cover");
r = fresh.importJson(backup);
check("aynı yedeği ikinci kez: değişmez (birleştirme, çoğaltma yok)", r.ok && r.tagsAdded === 0 && r.favsAdded === 0 && r.songsTouched === 0 && fresh.tagList().length === 2);
const other = make(fakeStorage());
other.setFav(USSEEWA, true);
const tLocal = other.createTag("PROVA").id;               // aynı ad (harf farkı): yedekteki 'Prova' buna eşlenir
other.setTagOnSongs([USSEEWA], tLocal, true);
r = other.importJson(backup);
check("içe aktarma BİRLEŞTİRİR: var olan favori/etiket kalır, yedek eklenir, aynı adlı etiket eşlenir (çoğalmaz)", r.ok && other.isFav(USSEEWA) && other.isFav(NEM)
  && other.tagList().length === 2 && other.tagIdsOf(ZEUS).includes(tLocal) && other.tagIdsOf(USSEEWA).includes(tLocal));
check("içe aktarma: bozuk JSON / yanlış biçim / çok büyük reddedilir, veri değişmez", (() => {
  const before = JSON.stringify(other.doc);
  return other.importJson("{x").error === "json" && other.importJson('{"v":2}').error === "format" && other.importJson('{"v":1,"tags":[],"songs":{}}').error === "format"
    && other.importJson("x".repeat(1024 * 1024 + 1)).error === "size" && other.importJson(null).error === "size" && JSON.stringify(other.doc) === before;
})());
check("içe aktarma: tehlikeli kimlikler (__proto__) atlanır, belge bozulmaz", (() => {
  const evil = JSON.stringify({ v: 1, tags: { a: { name: "x" } }, songs: { "__proto__": { fav: true }, [ZEUS]: { fav: true, tags: ["a", "olmayan"] } } });
  const t = make(fakeStorage());
  const out = t.importJson(evil);
  return out.ok && t.isFav(ZEUS) && ({}).fav === undefined && Object.keys(t.doc.songs).join() === ZEUS && t.tagIdsOf(ZEUS).length === 1;
})());
check("içe aktarma: salt okunur belgede reddedilir", make(fakeStorage({ [COLLECTION_KEY]: JSON.stringify(future) })).importJson(backup).error === "readonly");

// --- safeStorage
check("safeStorage: çalışan depo kalıcı", safeStorage({ localStorage: fakeStorage() }).persistent === true);
const broken = safeStorage({ get localStorage() { throw new Error("engelli"); } });
broken.storage.setItem("a", "1");
check("safeStorage: localStorage engelliyse bellek deposu (kalıcı DEĞİL), yine çalışır", broken.persistent === false && broken.storage.getItem("a") === "1");

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
