// Söz çevirisi arayüz mantığı (saf). SENTETİK satırlar; gerçek söz yok.
//
//     node tests\translation_test.mjs

import {
  normKey, isTranslatable, buildMap, lookup, missingCount, hasAnyReading, defaultShow, readShow, writeShow, SHOW_KEY,
  subsFor, subsList, statusMessage, errorMessage, actionView, isRunning, readCache, writeCache, dropCache, CACHE_PREFIX, CACHE_LIMIT, BUSY_TEXT,
} from "../frontend/js/translation.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const store = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
};

const lines = [{ text: "Line one" }, { text: "Line  TWO" }, { text: "line one" }, { text: "Line three" }];
const server = [{ tr: "Bir", ro: "ichi" }, { tr: "İki" }, { tr: "Bir", ro: "ichi" }, null];

check("normKey: büyük/küçük ve boşluk", normKey("  Line   TWO ") === "line two" && normKey(null) === "");
check("diller: en/ja çevrilir, tr ve diğerleri değil", isTranslatable("en") && isTranslatable("ja") && !isTranslatable("tr") && !isTranslatable(null) && !isTranslatable("de"));

// --- eşleme
const map = buildMap(lines, server);
check("buildMap: metne göre (tekrar eden satır aynı kayıt)", map.size === 2 && map.get("line one").tr === "Bir" && map.get("line two").tr === "İki");
check("buildMap: ro korunur, null satır eklenmez", map.get("line one").ro === "ichi" && !map.has("line three"));
check("buildMap: satır sayısı tutmazsa null", buildMap(lines, server.slice(1)) === null && buildMap(null, server) === null);
check("lookup: büyük/küçük harf ve boşluktan bağımsız", lookup(map, "LINE  one").tr === "Bir" && lookup(map, "yok") === null && lookup(null, "x") === null);
check("missingCount: çevirisi olmayan SATIR sayısı", missingCount(lines, map) === 1 && missingCount(lines, null) === 4 && missingCount(null, map) === 0);
check("zamanlar/sıra değişse de çeviri doğru satırda", lookup(map, [...lines].reverse()[0].text) !== undefined && lookup(map, "Line three") === null);
const edited = [{ text: "Line one" }, { text: "Line two CHANGED" }, { text: "Line three" }];
check("metni değişen satır çevrilmedi, öteki korunur", missingCount(edited, map) === 2 && lookup(map, edited[0].text).tr === "Bir");
check("hasAnyReading", hasAnyReading(map) && !hasAnyReading(buildMap([{ text: "a" }], [{ tr: "A" }])) && !hasAnyReading(null));

// --- tercih
let s = store();
check("tercih: varsayılan ikisi de açık", JSON.stringify(readShow(s)) === JSON.stringify(defaultShow()) && readShow(s).tr && readShow(s).ro);
writeShow(s, { tr: false, ro: true });
check("tercih: yazılır/okunur (tüm şarkılar için tek anahtar)", JSON.stringify(readShow(s)) === '{"tr":false,"ro":true}' && s.getItem(SHOW_KEY) !== null);
s.setItem(SHOW_KEY, "{bozuk");
check("tercih: bozuk kayıt varsayılana düşer", readShow(s).tr === true && readShow(s).ro === true);
check("tercih: kota dolu patlamaz", (writeShow({ setItem() { throw new Error("kota"); } }, { tr: true, ro: true }), true));

// --- alt yazılar
const both = { tr: true, ro: true };
const entry = { tr: "Merhaba", ro: "konnichiwa" };
check("alt yazı: ja'da okunuş + çeviri", JSON.stringify(subsFor(entry, both, "ja")) === '{"ro":"konnichiwa","tr":"Merhaba"}');
check("alt yazı: en'de okunuş yok", subsFor(entry, both, "en").ro === "" && subsFor(entry, both, "en").tr === "Merhaba");
check("alt yazı: kapalıysa boş", subsFor(entry, { tr: false, ro: true }, "ja").tr === "" && subsFor(entry, { tr: true, ro: false }, "ja").ro === "");
check("alt yazı: kayıt yoksa boş", subsFor(null, both, "ja").tr === "" && subsFor({ tr: "x" }, both, "ja").ro === "");
const list = subsList(lines, map, both, "ja");
check("subsList: her satıra bir kayıt, çevrilmeyen boş", list.length === 4 && list[0].tr === "Bir" && list[3].tr === "" && list[2].ro === "ichi");

// --- durum
check("isRunning: taze evet, bayat hayır", isRunning({ state: "running", started: 1000 }, 1100) && !isRunning({ state: "running", started: 1000 }, 5000) && !isRunning({ state: "done" }, 0) && !isRunning(undefined));
check("hata iletisi: busy tam metin", statusMessage({ state: "error", code: "busy" }).text === BUSY_TEXT && BUSY_TEXT === "Çeviri servisi şu an meşgul, biraz sonra tekrar dene.");
check("hata iletisi: refused / auth / genel", /reddetti/.test(statusMessage({ state: "error", code: "refused" }).text)
  && /anahtarı/.test(statusMessage({ state: "error", code: "auth" }).text) && /Çeviri başarısız: x/.test(statusMessage({ state: "error", code: "invalid", message: "x" }).text)
  && /tekrar dene/.test(statusMessage({ state: "error" }).text));
check("hata iletisi: hata yoksa null", statusMessage({ state: "done" }) === null && statusMessage(undefined) === null);
check("api hata: çevrimdışı / ağ / token", /İnternet yok/.test(errorMessage({ kind: "offline" })) && /ulaşılamadı/.test(errorMessage({ kind: "network" })) && /Token/.test(errorMessage({ kind: "auth" })));
check("api hata: 400 Türkçe / dil", /Türkçe/.test(errorMessage({ status: 400, message: "Turkce sozler cevrilmez" })) && /dildeki/.test(errorMessage({ status: 400, message: "Bu dil" })));
check("api hata: 409 hazırlanıyor / önce sözler / genel", /hazırlanırken/.test(errorMessage({ status: 409, message: "Sozler hazirlanirken cevrilemez" }))
  && /Önce sözler/.test(errorMessage({ status: 409, message: "Once sozler gerekli" })) && /biraz sonra/.test(errorMessage({ status: 409, message: "?" })));

// --- düğme görünümü
const base = { lang: "en", hasDoc: true, record: undefined, map: null, lines, offline: false, starting: false, nowSec: 5000 };
check("Türkçe şarkıda hiçbir şey görünmez", actionView({ ...base, lang: "tr" }).kind === "hidden" && actionView({ ...base, lang: null }).kind === "hidden");
check("söz yoksa gizli", actionView({ ...base, hasDoc: false }).kind === "hidden");
let v = actionView(base);
check("çeviri yok: 'Çevir', aç/kapa yok", v.kind === "translate" && v.label === "Çevir" && !v.showTr && !v.showRo);
check("çevrimdışı: 'Çevir' pasif + ipucu", actionView({ ...base, offline: true }).disabled && actionView({ ...base, offline: true }).hint === "İnternet yok");
v = actionView({ ...base, map });
check("kısmi: 'Güncelle (1)', çeviri anahtarı görünür", v.kind === "update" && v.label === "Güncelle (1)" && v.showTr && !v.showRo);
v = actionView({ ...base, lang: "ja", map });
check("ja + okunuş verisi: iki anahtar", v.showTr && v.showRo);
v = actionView({ ...base, lines: lines.slice(0, 3).filter((l) => l.text !== "Line three"), map });
check("hepsi çevrili: düğme yok, anahtarlar var", v.kind === "hidden" && v.showTr);
v = actionView({ ...base, starting: true });
check("istek giderken: running + not", v.kind === "running" && /hazırlanıyor/.test(v.note.text));
v = actionView({ ...base, record: { state: "running", started: 4900 }, map });
check("sunucuda sürerken running (eldeki çeviri görünmeye devam)", v.kind === "running" && v.showTr);
v = actionView({ ...base, record: { state: "running", started: 100 } });
check("bayat running: yeniden denenebilir", v.kind === "translate");
v = actionView({ ...base, record: { state: "error", code: "busy" } });
check("meşgul hatası: 'Tekrar dene' + uyarı metni", v.kind === "retry" && v.label === "Tekrar dene" && v.note.text === BUSY_TEXT && v.note.tone === "warn");
v = actionView({ ...base, record: { state: "error", code: "busy" }, map });
check("hata + kısmi çeviri: 'Güncelle (1)'", v.label === "Güncelle (1)" && v.showTr);

// --- önbellek
s = store();
check("önbellek: yaz-oku (metne göre)", writeCache(s, "a", map, 9, "en") && readCache(s, "a").map.get("line one").tr === "Bir" && readCache(s, "a").version === 9 && readCache(s, "a").lang === "en");
check("önbellek: ro korunur", readCache(s, "a").map.get("line one").ro === "ichi");
check("önbellek: yok/bozuk -> null", readCache(s, "yok") === null && (s.setItem(CACHE_PREFIX + "x", "{b"), readCache(s, "x") === null));
s.setItem(CACHE_PREFIX + "y", JSON.stringify({ v: 2, items: { a: { tr: "x" } } }));
check("önbellek: uyumsuz sürüm -> null", readCache(s, "y") === null);
dropCache(s, ["a"]);
check("önbellek: silme", readCache(s, "a") === null);
s = store();
for (let i = 0; i < CACHE_LIMIT + 6; i += 1) writeCache(s, `s${i}`, map, 1, "en", 1000 + i);
let n = 0;
for (let i = 0; i < s.length; i += 1) if (s.key(i).startsWith(CACHE_PREFIX)) n += 1;
check("önbellek: en çok 40 şarkı (en eskiler gider)", n === CACHE_LIMIT && readCache(s, "s0") === null && readCache(s, `s${CACHE_LIMIT + 5}`) !== null);
check("önbellek: kota dolu false", writeCache({ setItem() { throw new Error("k"); }, getItem() { return null; } }, "a", map, 1, "en") === false);

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
