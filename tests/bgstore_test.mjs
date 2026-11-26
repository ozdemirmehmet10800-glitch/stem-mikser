// Tam ekran söz arka planı (js/bgstore.js): ŞARKI BAŞINA dosya, kendi dosyası olmayan şarkıda varsayılan (eski tek kayıt).
// Küçük bir sahte IndexedDB ile; gerçek dosya yok.   node tests\bgstore_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

// ---- sahte IndexedDB (yalnız bgstore'un kullandığı kadar)
const databases = new Map();
function fakeIndexedDB() {
  return {
    open(name) {
      const request = {};
      setTimeout(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name);
        const db = {
          createObjectStore(store) { stores.set(store, new Map()); },
          transaction(store, mode) {
            const data = stores.get(store);
            const tx = {};
            const objectStore = {
              get(key) { const r = { result: data.get(key) }; return r; },
              put(value, key) { if (mode !== "readwrite") throw new Error("salt okunur"); data.set(key, value); return { result: key }; },
              delete(key) { if (mode !== "readwrite") throw new Error("salt okunur"); data.delete(key); return { result: undefined }; },
            };
            tx.objectStore = () => objectStore;
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
            return tx;
          },
          close() {},
        };
        request.result = db;
        if (fresh && request.onupgradeneeded) request.onupgradeneeded();
        request.onsuccess && request.onsuccess();
      }, 0);
      return request;
    },
  };
}
globalThis.indexedDB = fakeIndexedDB();

const { getBackground, putBackground, clearBackground, dropBackgrounds } = await import("../frontend/js/bgstore.js");
const file = (name) => ({ name, type: "image/jpeg", size: name.length * 1000 });

check("hiçbir şey yokken null", (await getBackground("a")) === null && (await getBackground()) === null);

// eski kullanıcı: tek (varsayılan) kayıt
await putBackground(file("eski.jpg"));
let r = await getBackground("a");
check("eski tek kayıt, kendi dosyası olmayan şarkıda varsayılan olarak görünür", r && r.name === "eski.jpg" && r.scope === "all");

// iki Rusça şarkıya farklı resim (hatanın senaryosu)
await putBackground(file("rus1.jpg"), "rus1");
await putBackground(file("rus2.jpg"), "rus2");
const r1 = await getBackground("rus1");
const r2 = await getBackground("rus2");
check("her şarkı KENDİ resmini gösterir (biri diğerini ezmez)", r1.name === "rus1.jpg" && r2.name === "rus2.jpg" && r1.scope === "song" && r2.scope === "song");
check("başka şarkı hâlâ varsayılanı görür", (await getBackground("baska")).name === "eski.jpg");
check("şarkı yokken (Ayarlar) varsayılan", (await getBackground(null)).name === "eski.jpg");

// Kaldır: önce şarkınınki, sonra varsayılana düşer
check("Kaldır: şarkının kendi dosyası silinir", (await clearBackground("rus1")) === "song");
r = await getBackground("rus1");
check("...ve şarkı varsayılana düşer", r && r.name === "eski.jpg" && r.scope === "all");
check("diğer şarkının resmi duruyor", (await getBackground("rus2")).name === "rus2.jpg");
check("kendi dosyası yokken Kaldır varsayılanı siler", (await clearBackground("rus1")) === "all" && (await getBackground("rus1")) === null);
check("varsayılan silinince şarkıya özel olan kalır", (await getBackground("rus2")).name === "rus2.jpg");

// şarkı silinince kendi dosyası da gider
await dropBackgrounds(["rus2"]);
check("silinen şarkının dosyası gider", (await getBackground("rus2")) === null);
check("boş liste sorun değil", (await dropBackgrounds([])) === true);

// IndexedDB yoksa çökmez
delete globalThis.indexedDB;
check("IndexedDB yoksa: get null, put false, clear null", (await getBackground("x")) === null && (await putBackground(file("a"), "x")) === false
  && (await clearBackground("x")) === null);

// ---- arayüz bağlantısı (kaynak)
const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8");
check("seçilen dosya açık şarkıya kaydedilir", /putBackground\(file, bgSongId\(\)\)/.test(app));
check("tam ekran açılırken bu şarkının dosyası okunur", /getBackground\(bgSongId\(\)\)/.test(app) && /async function openLyricsScreen\(\) \{[\s\S]{0,200}await refreshBgInfo\(\)/.test(app));
check("Kaldır açık şarkıya göre", /clearBackground\(bgSongId\(\)\)/.test(app));
check("şarkı silinince söz arka planı da silinir", /dropBackgrounds\(gone\)/.test(app));
check("Ayarlar açılınca not güncellenir", /el\("setting-wordglow"\)\.checked = wordGlowOn;\s*refreshBgInfo\(\);/.test(app));

console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nhepsi geçti");
process.exit(failed ? 1 : 0);
