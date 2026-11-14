// Eklenecekler mantığı (js/wishlist.js + Collection istek yöntemleri): bağlantı temizliği, paylaşılan metin, ad eşleştirme, Takeout CSV,
// kalıcılık / yedek / sürüm geçişinde veri güvenliği. Metinler SENTETİK (gerçek söz ya da çeviri yok).   node tests\wishlist_test.mjs

import {
  cleanUrl, videoIdOf, musicUrlOf, parseSharedText, tokens, matchScore, findMatches, wishKey, parseCsv, pickColumns, wishesFromCsv,
  importSummary, WISH_LIMIT, WISH_TITLE_MAX,
} from "../frontend/js/wishlist.js";
import { Collection, COLLECTION_KEY } from "../frontend/js/collection.js";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

// ---- bağlantı
check("cleanUrl: izleme parametreleri (si, utm_*) atılır, v kalır", cleanUrl("https://music.youtube.com/watch?v=abcdefghijk&si=IZ&utm_source=x&feature=share") === "https://music.youtube.com/watch?v=abcdefghijk");
check("cleanUrl: yalnız http/https (javascript:, data:, ftp:, mailto: reddedilir)", ["javascript:alert(1)", "data:text/html,x", "ftp://x.test/a", "mailto:a@b.c", "file:///c:/x", ""].every((u) => cleanUrl(u) === ""));
check("cleanUrl: kullanıcı adı/parola içeren adres reddedilir", cleanUrl("https://kullanici:parola@ornek.test/x") === "");
check("cleanUrl: uzun adres (>500) reddedilir, parça (#) atılır", cleanUrl(`https://ornek.test/${"a".repeat(600)}`) === "" && cleanUrl("https://ornek.test/a#bolum") === "https://ornek.test/a");
check("videoIdOf: music.youtube.com, youtube.com, youtu.be", videoIdOf("https://music.youtube.com/watch?v=abcdefghijk") === "abcdefghijk"
  && videoIdOf("https://www.youtube.com/watch?v=bcdefghijkl&list=PLx") === "bcdefghijkl" && videoIdOf("https://youtu.be/cdefghijklm?si=1") === "cdefghijklm"
  && videoIdOf("https://m.youtube.com/watch?v=defghijklmn") === "defghijklmn");
check("videoIdOf: başka site / bozuk kimlik -> boş", videoIdOf("https://ornek.test/watch?v=abcdefghijk") === "" && videoIdOf("https://youtu.be/kisa") === "" && videoIdOf("yok") === "");
check("musicUrlOf: yalnız adres üretir (kimlik doğrulanır)", musicUrlOf("abcdefghijk") === "https://music.youtube.com/watch?v=abcdefghijk" && musicUrlOf("../x") === "");

// ---- paylaşılan metin
let p = parseSharedText({ text: "Sentetik Şarkı • Sentetik Sanatçı https://music.youtube.com/watch?v=abcdefghijk&si=XX" });
check("paylaşım: 'Ad • Sanatçı bağlantı'", p.title === "Sentetik Şarkı" && p.artist === "Sentetik Sanatçı" && p.url === "https://music.youtube.com/watch?v=abcdefghijk" && p.vid === "abcdefghijk", JSON.stringify(p));
p = parseSharedText({ title: "Sentetik Şarkı", text: "Check out Sentetik Şarkı by Sentetik Sanatçı on YouTube Music\nhttps://music.youtube.com/watch?v=abcdefghijk" });
check("paylaşım: 'Check out Ad by Sanatçı on YouTube Music' kalıbı temizlenir", p.title === "Sentetik Şarkı" && p.artist === "Sentetik Sanatçı", JSON.stringify(p));
p = parseSharedText({ url: "https://youtu.be/abcdefghijk?si=1" });
check("paylaşım: yalnız bağlantı -> başlıksız istek", p.title === "" && p.url === "https://youtu.be/abcdefghijk" && p.vid === "abcdefghijk");
p = parseSharedText({ title: "Yalnız Ad" });
check("paylaşım: yalnız ad (bağlantı yok)", p.title === "Yalnız Ad" && p.url === "");
check("paylaşım: boş -> null", parseSharedText({}) === null && parseSharedText({ title: "  ", text: "\n" }) === null);
p = parseSharedText({ text: "dinle: javascript:alert(1)" });
check("paylaşım: http dışı bağlantı alınmaz", p.url === "");
p = parseSharedText({ text: "Ad - Sanatçı https://ornek.test/a." });
check("paylaşım: ' - ' belirsiz ayraç: hepsi ad; bağlantı sonu noktalaması atılır", p.title === "Ad - Sanatçı" && p.url === "https://ornek.test/a", JSON.stringify(p));
check("paylaşım: aşırı uzun ad kırpılır", parseSharedText({ title: "x".repeat(1000) }).title.length === WISH_TITLE_MAX);

// ---- eşleştirme
check("tokens: parantez notları, gürültü, aksan atılır", JSON.stringify(tokens("Şarkı Adı (Official Video) [HD] ft. Biri")) === JSON.stringify(["sarki", "adi", "biri"]), JSON.stringify(tokens("Şarkı Adı (Official Video) [HD] ft. Biri")));
check("matchScore: tam ad geçiyor -> 1", matchScore({ title: "Sentetik Şarkı", artist: "" }, "Sentetik Sanatçı - Sentetik Şarkı (Official Video)") === 1);
check("matchScore: Türkçe harf/büyük-küçük farkı önemsiz", matchScore({ title: "ISPARTA Gülü" }, "isparta gulu") === 1);
check("matchScore: yarısı geçiyor -> eşik altı", matchScore({ title: "Uzun Bir Sarki Adi" }, "Uzun Baska") < 0.8);
check("matchScore: tek sözcüklü istek yalnız KISA ada (Hello != Hello Kitty Tema Müziği Çocuk)", matchScore({ title: "Hello" }, "Hello") === 1
  && matchScore({ title: "Hello" }, "Hello Kitty Tema Muzigi Cocuk Sarkisi") === 0);
check("matchScore: ad boşsa 0 (başlıksız istek eşleşmez)", matchScore({ title: "" }, "Herhangi") === 0);
const songs = [{ id: "a".repeat(64), title: "Sentetik Sanatçı - Sentetik Şarkı" }, { id: "b".repeat(64), title: "Tamamen Başka" }];
const wishes = [
  { id: "w1", title: "Sentetik Şarkı", artist: "Sentetik Sanatçı", done: "" },
  { id: "w2", title: "Olmayan Parça Adı", artist: "", done: "" },
  { id: "w3", title: "Sentetik Şarkı", artist: "", done: true },
];
const found = findMatches(wishes, songs);
check("findMatches: yalnız bekleyen ve eşleşen istek", found.length === 1 && found[0].id === "w1" && found[0].songId === "a".repeat(64));
check("wishKey: video kimliği önce, sonra ad+sanatçı; sıra/aksan/büyük harf farkı aynı", wishKey({ url: "https://youtu.be/abcdefghijk" }) === "yt:abcdefghijk"
  && wishKey({ title: "Şarkı Adı", artist: "Biri" }) === wishKey({ title: "sarki adi", artist: "BIRI" }) && wishKey({ title: "", url: "https://ornek.test/x" }) === "url:https://ornek.test/x");

// ---- CSV
check("parseCsv: tırnak, kaçış, tırnak içi satır sonu, CRLF, BOM", JSON.stringify(parseCsv("\uFEFFa,b\r\n\"x,1\",\"y\"\"z\"\r\n\"satir\nikinci\",k\r\n")) === JSON.stringify([["a", "b"], ["x,1", "y\"z"], ["satir\nikinci", "k"]]));
check("parseCsv: noktalı virgül ve sekme ayraçları otomatik", JSON.stringify(parseCsv("a;b\n1;2")) === JSON.stringify([["a", "b"], ["1", "2"]]) && JSON.stringify(parseCsv("a\tb\n1\t2")) === JSON.stringify([["a", "b"], ["1", "2"]]));
check("parseCsv: boş satırlar atlanır, son satır sonu yok", JSON.stringify(parseCsv("a,b\n\n1,2")) === JSON.stringify([["a", "b"], ["1", "2"]]));
check("parseCsv: satır sınırı", parseCsv("a,b\n" + "1,2\n".repeat(50), 10).length <= 11);
const cols = pickColumns(["Song title", "Album title", "Artist name 1", "Artist name 2", "Video ID"]);
check("pickColumns: Song title / Artist name 1 / Video ID", cols.title === 0 && cols.artist === 2 && cols.id === 4);
check("pickColumns: başlık adlarına katı bağlı değil (Türkçe, Track Name)", pickColumns(["Şarkı adı", "Sanatçı"]).title === 0 && pickColumns(["Track Name", "Artist Name(s)", "Album"]).artist === 1);
const songsCsv = "Song title,Album title,Artist name 1,Artist name 2\nParça Bir,Albüm,Sanatçı Bir,\nParça Bir,Albüm,Sanatçı Bir,\n,Albüm,,\n\"Parça, İki\",Albüm,Sanatçı İki,Konuk\n";
let c = wishesFromCsv(songsCsv);
check("CSV (müzik kitaplığı): şarkı + sanatçı; boş başlık atlanır", c.kind === "songs" && c.entries.length === 3 && c.entries[2].title === "Parça, İki" && c.entries[2].artist === "Sanatçı İki", JSON.stringify(c.entries));
c = wishesFromCsv("Video ID,Playlist Video Creation Timestamp\nabcdefghijk,2024-01-02\nbcdefghijkl,2024-01-03\nkisa,x\n");
check("CSV (yalnız video kimliği): başlıksız, bağlantı üretilir, geçersiz kimlik atlanır", c.kind === "ids" && c.entries.length === 2 && c.untitled === 2
  && c.entries[0].url === "https://music.youtube.com/watch?v=abcdefghijk" && c.entries[0].title === "");
c = wishesFromCsv("Playlist ID,Playlist title,Playlist visibility\nPL1,Liste,Private\n");
check("CSV (liste üst verisi): şarkı SAYILMAZ", c.kind === "meta" && c.entries.length === 0);
c = wishesFromCsv("Foo,Bar\n1,2\n");
check("CSV (tanınmayan sütunlar): unknown, çökme yok", c.kind === "unknown" && c.entries.length === 0);
check("CSV: başlık satırı bile yoksa boş", wishesFromCsv("").kind === "unknown" && wishesFromCsv("tek").entries.length === 0);
c = wishesFromCsv("Video title,Video ID,Channel\nBir Video,abcdefghijk,Kanal Adı\n");
check("CSV: Video title + Video ID + kanal (sanatçı yedeği)", c.kind === "songs" && c.entries[0].title === "Bir Video" && c.entries[0].artist === "Kanal Adı" && c.entries[0].vid === "abcdefghijk");
check("importSummary: sayılar ve başlıksız uyarısı", /3 kayıt bulundu, 2 yeni eklendi, 1 zaten vardı/.test(importSummary({ files: 1, found: 3, added: 2, duplicate: 1, untitled: 0, limit: 0 }))
  && /başlık yok/.test(importSummary({ files: 1, found: 2, added: 2, duplicate: 0, untitled: 2, limit: 0 })) && /bulunamadı/.test(importSummary({ files: 2, found: 0 })));

// ---- Collection: istek yöntemleri
function store(seed = {}) {
  const data = { ...seed };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
}
let seq = 0;
const make = (s, clock = { t: 1000 }) => new Collection(s, { now: () => (clock.t += 1), random: () => ((seq += 1) * 0.1234567) % 1 });
const s1 = store();
const col = make(s1);
let r = col.addWishes([{ title: "Sentetik Şarkı", artist: "Sentetik Sanatçı", url: "https://youtu.be/abcdefghijk?si=1" }, { title: "Yalnız Ad" }, { title: "" }, null, { url: "javascript:x" }], { src: "share" });
check("addWishes: geçerli kayıtlar eklenir, boş/geçersiz atlanır", r.ok && r.added === 2 && col.wishList().length === 2);
const list = col.wishList();
check("kayıt temiz: bağlantı izlemesiz, kimlik, src", list.some((w) => w.title === "Sentetik Şarkı" && w.url === "https://youtu.be/abcdefghijk" && w.vid === "abcdefghijk" && w.src === "share"));
r = col.addWishes([{ title: "sentetik şarkı", artist: "SENTETİK SANATÇI", url: "https://music.youtube.com/watch?v=abcdefghijk" }]);
check("aynı video ya da aynı ad+sanatçı tekrar eklenmez", r.added === 0 && r.duplicate === 1 && col.wishList().length === 2);
r = col.addWishes([{ title: "Yalnız Ad", url: "https://ornek.test/a" }]);
check("tekrarda eksik bağlantı mevcut kayda tamamlanır", r.duplicate === 1 && col.wishList().find((w) => w.title === "Yalnız Ad").url === "https://ornek.test/a");
const reloaded = make(s1);
check("kalıcı: yeniden yükleyince aynı (collection belgesinde, tek anahtar)", reloaded.wishList().length === 2 && Object.keys(s1.data).join() === COLLECTION_KEY);
const wid = col.wishList()[0].id;
r = col.setWishDone(wid, true);
check("setWishDone(true): eklendi", r.ok && col.wishList().find((w) => w.id === wid).done === true && col.wishCounts().done === 1 && col.wishCounts().pending === 1);
col.setWishDone(wid, false);
check("setWishDone(false): geri alınır", col.wishList().find((w) => w.id === wid).done === "" && col.wishCounts().done === 0);
r = col.applyWishMatches([{ id: wid, songId: "a".repeat(64) }, { id: "yok", songId: "b".repeat(64) }]);
const marked = col.wishList().find((w) => w.id === wid);
check("applyWishMatches: eşleşen işaretlenir (done = şarkı kimliği, auto), olmayan kimlik yok sayılır", r.marked === 1 && marked.done === "a".repeat(64) && marked.auto === true);
check("elle işaret auto bayrağını siler", (() => { col.setWishDone(wid, false); col.setWishDone(wid, true); return col.wishList().find((w) => w.id === wid).auto === false; })());
r = col.applyWishMatches([{ id: wid, songId: "c".repeat(64) }]);
check("zaten eklendi olana otomatik eşleşme dokunmaz", r.marked === 0 && col.wishList().find((w) => w.id === wid).done === true);
check("removeWish / olmayan kimlik", col.removeWish(wid).ok && col.wishList().length === 1 && col.removeWish("yok").error === "missing");
col.addWishes([{ title: "A1" }, { title: "A2" }]);
const ids = col.wishList().map((w) => w.id);
col.setWishDone(ids[0], true); col.setWishDone(ids[1], true);
r = col.clearDoneWishes();
check("clearDoneWishes: yalnız eklendi olanlar silinir", r.removed === 2 && col.wishList().length === ids.length - 2);

// sınır
const big = make(store());
r = big.addWishes(Array.from({ length: WISH_LIMIT + 50 }, (_, i) => ({ title: `Parça ${i}` })));
check(`üst sınır ${WISH_LIMIT}: fazlası eklenmez ve sayılır`, r.added === WISH_LIMIT && r.limit === 50 && big.wishList().length === WISH_LIMIT);

// yedek: dışa/içe, birleştirme
const exp = JSON.parse(col.exportJson());
check("yedek: wishes dışa aktarılır, favori/etiket/liste yerinde", exp.wishes && Object.keys(exp.wishes).length === col.wishList().length && exp.v === 1 && exp.songs && exp.tags && exp.lists);
const other = make(store());
other.addWishes([{ title: "Sentetik Şarkı", artist: "Sentetik Sanatçı", url: "https://youtu.be/abcdefghijk" }, { title: "Yerel Parça" }]);
r = other.importJson(col.exportJson());
check("yedek içe aktarma BİRLEŞTİRİR: aynı istek çoğalmaz, yeni eklenir, yerel korunur", r.ok && other.wishList().some((w) => w.title === "Yerel Parça") && other.wishList().filter((w) => w.title === "Sentetik Şarkı").length === 1 && r.wishesAdded >= 0);
const before = other.wishList().length;
other.importJson(col.exportJson());
check("aynı yedeği ikinci kez yüklemek çoğaltmaz", other.wishList().length === before);
const done = make(store());
done.addWishes([{ title: "Bitti" }]);
done.setWishDone(done.wishList()[0].id, "d".repeat(64));
const third = make(store());
third.importJson(done.exportJson());
check("yedekten 'eklendi' işareti taşınmaz (şarkı kimliği başka cihazda geçerli olmayabilir)", third.wishList()[0].done === "");
check("yedek: bozuk istek kayıtları atlanır, çökme yok", (() => {
  const evil = JSON.stringify({ v: 1, tags: {}, songs: {}, wishes: { a: null, b: "x", c: { title: "<img src=x onerror=1>", url: "javascript:alert(1)" }, __proto__: { title: "p" } } });
  const t = make(store());
  const out = t.importJson(evil);
  const item = t.wishList()[0];
  return out.ok && t.wishList().length === 1 && item.url === "" && ({}).title === undefined;
})());

// sürüm geçişi: istek alanı OLMAYAN eski belge aynen çalışır; bilinmeyen alanlar korunur
const legacyDoc = { v: 1, rev: 5, updated: 1, songs: { [`${"e".repeat(64)}`]: { fav: true, t: 1 } }, tags: {}, lists: {}, gelecek: { x: 1 } };
const ls = store({ [COLLECTION_KEY]: JSON.stringify(legacyDoc) });
const legacy = make(ls);
check("eski belge (wishes yok): okunur, favori korunur, istek listesi boş", legacy.status === "ok" && legacy.isFav("e".repeat(64)) && legacy.wishList().length === 0);
legacy.addWishes([{ title: "Yeni" }]);
const saved = JSON.parse(ls.data[COLLECTION_KEY]);
check("istek eklenince eski veriler ve bilinmeyen üst düzey alan AYNEN korunur", saved.songs["e".repeat(64)].fav === true && saved.gelecek.x === 1 && saved.rev === 6 && Object.keys(saved.wishes).length === 1);
// eski uygulama sürümü wishes'i silmesin: 'eski kod' yalnız songs/tags/lists'e dokunur, bilinmeyen alan this.doc içinde kalır (aynı sınıfla simüle)
const roundTrip = make(ls);
roundTrip.setFav("f".repeat(64), true);
check("başka bir işlem (favori) istekleri silmez", Object.keys(JSON.parse(ls.data[COLLECTION_KEY]).wishes).length === 1);
check("salt okunur (daha yeni sürüm) belgede istek eklenmez", (() => {
  const fut = make(store({ [COLLECTION_KEY]: JSON.stringify({ v: 2, songs: {}, tags: {} }) }));
  return fut.addWishes([{ title: "x" }]).error === "readonly";
})());
check("depolama dolu (setItem atar): istek eklenmez, bellek eski haline döner", (() => {
  const s = store();
  const t = make(s);
  s.setItem = () => { throw new Error("kota"); };
  const out = t.addWishes([{ title: "Sığmaz" }]);
  return out.ok === false && out.error === "save" && t.wishList().length === 0;
})());

// kaynak taraması: gizlilik
const lib = readFileSync(new URL("../frontend/js/wishlist.js", import.meta.url), "utf8");
const zr = readFileSync(new URL("../frontend/js/zipread.js", import.meta.url), "utf8");
check("wishlist.js / zipread.js: ağ isteği yok (fetch, XMLHttpRequest, sendBeacon, WebSocket)", !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|importScripts/.test(lib + zr));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");

// arayüz: uzun liste sayfa sayfa çizilir (Takeout binlerce kayıt getirebilir)
{
  const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8");
  const ok = /const WISH_PAGE = \d+;/.test(app) && /shown\.slice\(0, wishLimit\)/.test(app) && /Daha fazla göster/.test(app);
  console.log(`${ok ? "ok  " : "FAIL"} Eklenecekler ekranı sayfalı çizilir (hepsi birden değil)`);
  if (!ok) process.exit(1);
}
