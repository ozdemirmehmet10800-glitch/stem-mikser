// StemCache.removeSongs testi - sarki silinince cihazdaki seslerin de
// gitmesi gerekiyor, yoksa depolama bosuna sisiyor.
//
// Calistirma:
//     node tests\stemcache_test.mjs
//
// Tarayici API'leri taklit ediliyor: Cache Storage anahtarlari MUTLAK URL'e
// donusuyor, indeks anahtarlari ise goreli - asil incelik bu, cunku iki
// tarafi ayni kefeye koymayan bir temizlik ya dosyayi birakir ya iki kez
// sayar.

import { StemCache, keyFor, cacheTag } from "../frontend/js/stemcache.js";

const ORIGIN = "https://ornek.test/";

class FakeResponse {
  constructor(body) {
    this.body = body;
  }
  async arrayBuffer() {
    return this.body;
  }
}

class FakeCache {
  constructor() {
    this.store = new Map();
  }
  #url(key) {
    return typeof key === "string" ? ORIGIN + key : key.url;
  }
  async put(key, response) {
    this.store.set(this.#url(key), response);
  }
  async match(key) {
    return this.store.get(this.#url(key)) || undefined;
  }
  async delete(key) {
    return this.store.delete(this.#url(key));
  }
  async keys() {
    return [...this.store.keys()].map((url) => ({ url }));
  }
}

let cache = new FakeCache();
const store = new Map();

globalThis.window = {};                       // stemcache: "caches" in window
// node 24'te navigator salt okunur bir getter; removeSongs onu hic
// kullanmiyor (yalniz usage/requestPersistence kullaniyor), o yuzden
// dokunmuyoruz.
globalThis.Response = FakeResponse;
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.caches = {
  open: async () => cache,
  delete: async () => {
    cache = new FakeCache();
    return true;
  },
};
globalThis.window.caches = globalThis.caches;

const passed = [];
const failed = [];

function check(name, condition, detail = "") {
  (condition ? passed : failed).push(name);
  const mark = condition ? "OK  " : "HATA";
  console.log(`[${mark}] ${name}${detail ? `  -> ${detail}` : ""}`);
}

const A = "a".repeat(64);
const B = "b".repeat(64);
const buffer = (size) => new Uint8Array(size).buffer;

function indexKeys() {
  return Object.keys(JSON.parse(store.get("stem-mikser.stemcache") || "{}"));
}

async function cacheKeys() {
  return (await cache.keys()).map((item) => item.url.replace(ORIGIN, ""));
}

async function reset() {
  cache = new FakeCache();
  store.clear();
}

async function testRemovesOneSong() {
  await reset();
  const stems = new StemCache();
  await stems.put(A, "vocals", buffer(1000), 2);
  await stems.put(A, "drums", buffer(2000), 2);
  await stems.put(A, "bass", buffer(3000), 2);
  await stems.put(B, "vocals", buffer(500), 0);

  check("baslangicta 4 kayit", indexKeys().length === 4, String(indexKeys().length));

  const report = await stems.removeSongs([A]);
  check("3 dosya silindi", report.removed === 3, String(report.removed));
  check("6000 bayt yer acildi", report.bytes === 6000, String(report.bytes));
  check("indekste yalniz B kaldi",
        indexKeys().length === 1 && indexKeys()[0].includes(B),
        indexKeys().join(","));
  const left = await cacheKeys();
  check("cache'te yalniz B kaldi",
        left.length === 1 && left[0].includes(B), left.join(","));
  check("A'nin sesi artik yok", (await stems.get(A, "vocals", 2)) === null);
  check("B'nin sesi duruyor", (await stems.get(B, "vocals", 0)) !== null);
}

async function testVersionedKeys() {
  await reset();
  const stems = new StemCache();
  // Yeni surum yazilinca eski surum put'ta zaten supuruluyor (pruneSuperseded),
  // yani 0 ve 3 birlikte DURMAZ: yalniz en yeni 2 dosya kalir ve ikisi de gitmeli.
  await stems.put(A, "vocals", buffer(100), 0);
  await stems.put(A, "vocals", buffer(100), 3);
  await stems.put(A, "drums", buffer(100), 3);
  check("put eski surumu supurdu", indexKeys().length === 2, String(indexKeys().length));
  const report = await stems.removeSongs([A]);
  check("surumlu anahtarlar silindi",
        report.removed === 2 && indexKeys().length === 0, String(report.removed));
  check("cache bosaldi", (await cacheKeys()).length === 0);
}

async function testOnlyInCacheStorage() {
  await reset();
  const stems = new StemCache();
  // localStorage silinmis ama Cache Storage dolu: indekse bakan bir temizlik
  // burada dosyayi birakir ve kullanici neden yer acilmadigini anlamaz.
  await cache.put(keyFor(A, "vocals", 4), new FakeResponse(buffer(10)));
  const report = await stems.removeSongs([A]);
  check("indekste olmayan kayit da silindi", report.removed === 1,
        String(report.removed));
  check("cache bosaldi", (await cacheKeys()).length === 0);
}

async function testOnlyInIndex() {
  await reset();
  const stems = new StemCache();
  // Tersi: Cache Storage sistem tarafindan bosaltilmis, indeks kalmis.
  store.set("stem-mikser.stemcache", JSON.stringify({
    [keyFor(A, "vocals", 1)]: { size: 42, lastUsed: 1, songId: A },
  }));
  const report = await stems.removeSongs([A]);
  check("olu indeks kaydi temizlendi",
        report.removed === 1 && report.bytes === 42 && indexKeys().length === 0,
        JSON.stringify(report));
}

async function testNoopCases() {
  await reset();
  const stems = new StemCache();
  await stems.put(B, "vocals", buffer(700), 0);

  let report = await stems.removeSongs([]);
  check("bos liste hicbir sey silmiyor", report.removed === 0);
  report = await stems.removeSongs(null);
  check("null guvenli", report.removed === 0);
  report = await stems.removeSongs(["c".repeat(64)]);
  check("bilinmeyen kimlik hicbir seye dokunmuyor",
        report.removed === 0 && indexKeys().length === 1, String(report.removed));
  check("B'nin sesi hala yerinde", (await stems.get(B, "vocals", 0)) !== null);
}

async function testMultipleSongs() {
  await reset();
  const stems = new StemCache();
  const C = "c".repeat(64);
  await stems.put(A, "vocals", buffer(100), 0);
  await stems.put(B, "vocals", buffer(200), 0);
  await stems.put(C, "vocals", buffer(400), 0);
  const report = await stems.removeSongs([A, C]);
  check("coklu silme", report.removed === 2 && report.bytes === 500,
        JSON.stringify(report));
  check("dokunulmayan sarki kaldi",
        indexKeys().length === 1 && indexKeys()[0].includes(B),
        indexKeys().join(","));
}

async function testIndexHas() {
  await reset();
  const stems = new StemCache();
  const names = ["vocals", "drums", "bass"];
  check("bos onbellekte false", stems.indexHas(A, names, 5) === false);
  await stems.put(A, "vocals", buffer(10), 5);
  await stems.put(A, "drums", buffer(10), 5);
  check("eksik stem varken false", stems.indexHas(A, names, 5) === false);
  await stems.put(A, "bass", buffer(10), 5);
  check("hepsi varken true", stems.indexHas(A, names, 5) === true);
  // Surum onemli: Hi-Fi'a yukseltilmis sarkinin ESKI kopyasi sayilmamali.
  check("baska surumde false", stems.indexHas(A, names, 6) === false);
  check("baska sarkida false", stems.indexHas(B, names, 5) === false);
  check("isim listesi bossa false", stems.indexHas(A, [], 5) === false);
  check("kimlik yoksa false", stems.indexHas("", names, 5) === false);
  await stems.removeSongs([A]);
  check("silindikten sonra false", stems.indexHas(A, names, 5) === false);
}

// Boru hatti surumu (hifi_v2) anahtara giriyor; eski surum ve eski boru hatti
// birlikte, yalniz en yenisi kalir.
async function testPipelineTag() {
  await reset();
  const stems = new StemCache();
  check("cacheTag: pipeline yoksa duz sayi", cacheTag(7, undefined) === 7 && cacheTag(7, "") === 7);
  check("cacheTag: pipeline varsa metin", cacheTag(7, "hifi_v2") === "7.hifi_v2");
  check("cacheTag: surum yoksa pipeline yok sayilir", cacheTag(0, "hifi_v2") === 0);
  check("cacheTag: gecersiz ad yok sayilir", cacheTag(7, "../x") === 7);
  check("anahtar: pipeline anahtarda",
    keyFor(A, "piano", cacheTag(7, "hifi_v2")) === `stems/${A}/piano@7.hifi_v2.m4a`);
  check("anahtar: pipeline farkli -> farkli anahtar",
    keyFor(A, "piano", cacheTag(7, "hifi_v2")) !== keyFor(A, "piano", cacheTag(7, undefined)));

  const cache = await caches.open("stem-mikser-stems-v1");
  for (const tag of [cacheTag(5), cacheTag(9, "hifi_v2")]) {
    await stems.put(A, "drums", buffer(10), tag);
  }
  check("eski surum yazimda silinir, yeni kalir",
    indexKeys().length === 1 && indexKeys()[0] === keyFor(A, "drums", "9.hifi_v2"),
    JSON.stringify(indexKeys()));
  check("indexHas: ayni pipeline true",
    stems.indexHas(A, ["drums"], cacheTag(9, "hifi_v2")) === true);
  check("indexHas: pipeline yoksa (eski anahtar) false",
    stems.indexHas(A, ["drums"], cacheTag(9)) === false);
  void cache;
}

for (const test of [testRemovesOneSong, testVersionedKeys, testOnlyInCacheStorage,
                    testOnlyInIndex, testNoopCases, testMultipleSongs,
                    testIndexHas, testPipelineTag]) {
  console.log(`\n--- ${test.name} ---`);
  await test();
}

console.log(`\n${"=".repeat(60)}`);
console.log(`gecen: ${passed.length}   basarisiz: ${failed.length}`);
for (const name of failed) console.log(`  BASARISIZ: ${name}`);
process.exit(failed.length ? 1 : 0);
