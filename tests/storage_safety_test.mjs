// Favori/etiket verisi (stem-mikser.collection) "Önbelleği temizle", SW güncellemesi, önek temelli silmeler ve LRU budamalarında
// SİLİNMEZ: kaynak taranarak güvence altına alınıyor. Biri ileride yanlışlıkla `localStorage.clear()` ya da bu anahtarı
// yakalayan bir önek ekleyemesin.
//
//     node tests\storage_safety_test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { COLLECTION_KEY, COLLECTION_BAD_KEY } from "../frontend/js/collection.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const dir = new URL("../frontend/js/", import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith(".js"));
const source = Object.fromEntries(files.map((name) => [name, readFileSync(new URL(name, dir), "utf8")]));
const sw = readFileSync(new URL("../frontend/sw.js", import.meta.url), "utf8");
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");   // yorumlar sayılmasın

// 1) Hiçbir yerde toplu silme yok
const clears = files.filter((name) => /(localStorage|sessionStorage)\s*\.\s*clear\s*\(/.test(strip(source[name])));
check("kodda localStorage.clear()/sessionStorage.clear() YOK", clears.length === 0, clears.join(", "));
check("clear() başka bir depo üzerinden de çağrılmıyor (storage.clear / store.clear)", files.every((name) => !/\b(storage|store|win\.localStorage)\s*\.\s*clear\s*\(/.test(strip(source[name]))));

// 2) Önek temelli silmeler: tüm "stem-mikser.xxx." önekleri; hiçbiri koleksiyon anahtarının öneki olmamalı
const prefixes = new Set();
for (const name of files) {
  for (const m of strip(source[name]).matchAll(/["'`](stem-mikser\.[a-z]+\.)["'`]/g)) prefixes.add(m[1]);
}
check("önek sabitleri bulundu (tarama çalışıyor: meta., mix., kicks., lyrics., translation.)", ["meta.", "mix.", "kicks.", "lyrics.", "translation."]
  .every((p) => prefixes.has(`stem-mikser.${p}`)), [...prefixes].join(" "));
const caught = [...prefixes].filter((prefix) => COLLECTION_KEY.startsWith(prefix) || COLLECTION_BAD_KEY.startsWith(prefix));
check("koleksiyon anahtarları (stem-mikser.collection, .collection.bad) HİÇBİR önek döngüsüne uymuyor", caught.length === 0, caught.join(", "));
check("anahtar adları: stem-mikser.collection / stem-mikser.collection.bad", COLLECTION_KEY === "stem-mikser.collection" && COLLECTION_BAD_KEY === "stem-mikser.collection.bad");

// 3) removeItem çağrıları: koleksiyon anahtarını doğrudan silen yok (collection.js dışında hiç anahtar adı geçmiyor)
const mentions = files.filter((name) => name !== "collection.js" && /stem-mikser\.collection/.test(strip(source[name])));
check("collection.js dışında koleksiyon anahtarı adı hiç geçmiyor (silme/değiştirme yalnız Collection sınıfından)", mentions.length === 0, mentions.join(", "));
const removals = [];
for (const name of files) {
  for (const m of strip(source[name]).matchAll(/localStorage\s*\.\s*removeItem\s*\(([^)]*)\)/g)) removals.push(`${name}: ${m[1].trim()}`);
}
check("localStorage.removeItem çağrıları yalnız türetilmiş anahtarlarla (metaKey/item.key/INDEX_KEY...), düz koleksiyon anahtarı yok",
  removals.every((entry) => !/collection/i.test(entry)), removals.join(" | "));
const collectionSource = strip(source["collection.js"]);
const storageRemovals = collectionSource.match(/\bstorage\s*\.\s*removeItem\s*\(/g) || [];
check("collection.js depoda yalnız TEK removeItem çağırıyor (safeStorage yoklaması); koleksiyon anahtarını silen yok (liste öğesi silen removeItem(lid, iid) yöntemi başka şey)",
  storageRemovals.length <= 1 && !/storage\s*\.\s*removeItem\s*\(\s*COLLECTION/.test(collectionSource), String(storageRemovals.length));

// 4) "Önbelleği temizle" işleyicisi yalnız Cache Storage + SW
const app = strip(source["app.js"]);
const start = app.indexOf('on("clear-cache"');
const body = app.slice(start, app.indexOf("\n});", start) + 4);
check('"Önbelleği temizle" işleyicisi bulundu', start > 0 && body.includes("caches"));
check('"Önbelleği temizle" localStorage/indexedDB\'ye DOKUNMUYOR (yalnız caches + serviceWorker)', !/localStorage|sessionStorage|indexedDB/.test(body)
  && /caches\.delete/.test(body) && /unregister/.test(body));
const stemClear = strip(source["stemcache.js"]);
const clearAt = stemClear.indexOf("async clear()");
const clearBody = stemClear.slice(clearAt, stemClear.indexOf("\n  }", clearAt) + 4);
check('"Çevrimdışı kopyaları sil" yalnız stem cache + kendi indeksini siliyor (koleksiyon değil)', clearAt > 0 && /INDEX_KEY/.test(clearBody) && !/collection/i.test(clearBody));

// 5) Service worker localStorage'a erişemez ve erişmiyor; activate yalnız kabuk cache'lerini siler
check("sw.js localStorage/indexedDB kullanmıyor", !/localStorage|sessionStorage|indexedDB/.test(strip(sw)));
check("sw.js activate yalnız stem-mikser-v<sayı> kabuk cache'lerini siler", /SHELL_CACHE_RE\.test\(key\)/.test(sw));

// 6) LRU budama yalnız kendi önekleriyle çalışır
check("pruneMeta yalnız META_PREFIX anahtarlarını budar", /key\.startsWith\(META_PREFIX\)/.test(app));

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
