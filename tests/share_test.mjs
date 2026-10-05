// Paylaşım hedefi: uygulama tarafı saf mantık (frontend/js/share.js). SW ile birlikte akış: tests/sw_share_test.mjs
//
//     node tests\share_test.mjs

import {
  SHARE_CACHE, SHARE_MAX_BYTES, SHARE_MAX_AGE_MS, MESSAGES, formatSize, formatDuration, isAudio, launchKind, keyUrl,
  readPending, clearPending, classify, durationWarning, cardView,
} from "../frontend/js/share.js";
import { fakeCaches } from "./sw_harness.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const BASE = "https://example.test/stem-mikser/index.html";

// --- biçimler
check("formatSize: KB / MB (virgül)", formatSize(2048) === "2 KB" && formatSize(31 * 1024 * 1024) === "31,0 MB"
  && formatSize(1) === "1 KB" && formatSize(-1) === "" && formatSize("x") === "");
check("formatDuration: m:ss, geçersiz boş", formatDuration(187) === "3:07" && formatDuration(59.6) === "1:00"
  && formatDuration(0) === "" && formatDuration(NaN) === "" && formatDuration(null) === "");
check("keyUrl: sayfa adresi (index.html) ve SW adresi (sw.js) AYNI anahtarı üretir",
  keyUrl(BASE) === keyUrl("https://example.test/stem-mikser/sw.js") && keyUrl(BASE) === "https://example.test/stem-mikser/share-pending/current");

// --- ses mi
const cases = [
  [{ name: "a.mp3", type: "audio/mpeg" }, true], [{ name: "a", type: "audio/x-m4a" }, true], [{ name: "WA.OPUS", type: "" }, true],
  [{ name: "x.flac", type: "application/octet-stream" }, true], [{ name: "kayit.ogg", type: "application/ogg" }, true],
  [{ name: "x.wav" }, true], [{ name: "x.aac" }, true], [{ name: "video.mp4", type: "video/mp4" }, false],
  [{ name: "belge.pdf", type: "application/pdf" }, false], [{ name: "", type: "" }, false], [{}, false],
  [{ name: "mp3", type: "" }, false], [{ name: "sarki.mp3.exe" }, false],
];
for (const [file, want] of cases) check(`isAudio ${JSON.stringify(file)} = ${want}`, isAudio(file) === want);

// --- sınıflandırma
const ok = { state: "ok", name: "a.mp3", size: 1000, type: "audio/mpeg", skipped: 0, time: Date.now() };
check("ok + 0 atlanan: kart, not yok", JSON.stringify(classify(ok)) === JSON.stringify({ action: "card", note: "" }));
check("ok + 1 atlanan: '1 dosya atlandı (yalnız ilki alındı).'", classify({ ...ok, skipped: 1 }).note === "1 dosya atlandı (yalnız ilki alındı).");
check("ok ama ses değil: mesaj + silinir", (() => {
  const v = classify({ ...ok, name: "x.png", type: "image/png" });
  return v.action === "message" && v.kind === "notaudio" && v.clear && v.text.includes("x.png");
})());
check("large: mesaj boyutu ve sınırı söyler, silinir", (() => {
  const v = classify({ ...ok, state: "large", size: 45 * 1024 * 1024, name: "b.wav" });
  return v.kind === "large" && v.text.includes("45,0 MB") && v.text.includes("30,0 MB") && v.clear;
})());
check("stale/yok: 'bulunamadı' mesajı", classify({ ...ok, state: "stale" }).text === MESSAGES.gone && classify(null).kind === "gone");
check("mesajlar: dosyasız önerilen metin", MESSAGES.empty === "Dosya gelmedi. Bağlantı ya da metin eklenemez; bir ses dosyasını paylaş.");

// --- süre uyarısı
check("durationWarning: 10 dk içinde boş, üstünde uyarır, bilinmiyorsa boş", durationWarning(600) === "" && durationWarning(null) === ""
  && /10 dakikadan uzun/.test(durationWarning(601)) && durationWarning(601).includes("10:01"));

// --- launchKind
check("launchKind", launchKind("?paylasim=1") === "file" && launchKind("?paylasim=bos") === "empty" && launchKind("?paylasim=hata") === "error"
  && launchKind("") === null && launchKind(undefined) === null && launchKind("?baska=1") === null);

// --- onay kartı görünümü: paylaşım YOKKEN kart görünmez, düğme pasif (hata: boş kart görünüyordu)
const file = new File(["12345"], "a.mp3", { type: "audio/mpeg" });
const none = cardView({});
check("paylaşım yok (hiç argüman): kart GİZLİ, Yükle pasif, ad/meta boş", none.hidden === true && none.goDisabled === true
  && none.name === "" && none.meta === "" && none.note === "");
check("paylaşım yok (pending null): kart GİZLİ, Yükle ve Vazgeç pasif", (() => {
  const v = cardView({ pending: null, offline: false, configured: true });
  return v.hidden && v.goDisabled && v.cancelDisabled && v.qualityDisabled;
})());
check("dosyasız kayıt ({name, size} ama file yok): kart GİZLİ, Yükle pasif", (() => {
  const v = cardView({ pending: { name: "x.mp3", size: 5, note: "" } });
  return v.hidden && v.goDisabled;
})());
check("her durumda kart yoksa Yükle pasif (çevrimiçi/ayarlı/meşgul değil)", [true, false].every((offline) => [true, false].every((configured) => {
  const v = cardView({ pending: null, offline, configured, busy: false });
  return v.hidden && v.goDisabled;
})));
const ready = cardView({ pending: { file, name: "a.mp3", size: 5, note: "2 dosya atlandı (yalnız ilki alındı)." }, seconds: 187 });
check("geçerli kayıt: kart görünür; ad, boyut ve süre dolu; not; Yükle AÇIK", !ready.hidden && ready.name === "a.mp3"
  && ready.meta === "1 KB · 3:07" && ready.note === "2 dosya atlandı (yalnız ilki alındı)." && !ready.goDisabled
  && !ready.cancelDisabled && ready.goLabel === "Yükle ve ayır");
check("süre bilinmiyorsa meta yalnız boyut", cardView({ pending: { file, name: "a.mp3", size: 2048 } }).meta === "2 KB");
check("süre 10 dk üstü: not uyarı içerir", /10 dakikadan uzun/.test(cardView({ pending: { file, name: "a", size: 1, note: "" }, seconds: 700 }).note));
check("çevrimdışı: Yükle pasif, neden yazar", (() => {
  const v = cardView({ pending: { file, name: "a", size: 1 }, offline: true });
  return !v.hidden && v.goDisabled && /İnternet yok/.test(v.hint);
})());
check("ayar yok: Yükle pasif, neden yazar", (() => {
  const v = cardView({ pending: { file, name: "a", size: 1 }, configured: false });
  return !v.hidden && v.goDisabled && /Ayarlar/.test(v.hint);
})());
check("yükleniyor: Yükle/Vazgeç/Kalite pasif, düğme 'Yükleniyor…'", (() => {
  const v = cardView({ pending: { file, name: "a", size: 1 }, busy: true });
  return v.goDisabled && v.cancelDisabled && v.qualityDisabled && v.goLabel === "Yükleniyor…";
})());

// --- cache yardımcıları
async function put(caches, { state = "ok", name = "a.mp3", size = 5, type = "audio/mpeg", skipped = 0, time = Date.now(), body = "12345" } = {}) {
  const cache = await caches.open(SHARE_CACHE);
  await cache.put(keyUrl(BASE), new Response(state === "large" ? null : body, { headers: {
    "content-type": type, "x-share-state": state, "x-share-name": encodeURIComponent(name), "x-share-size": String(size),
    "x-share-skipped": String(skipped), "x-share-time": String(time) } }));
}
let caches = fakeCaches();
check("kayıt yokken readPending null", (await readPending(caches, BASE)) === null && (await readPending(null, BASE)) === null);
await put(caches);
let pending = await readPending(caches, BASE);
check("readPending: File (ad, tür, boyut)", pending.state === "ok" && pending.file.name === "a.mp3" && pending.file.type === "audio/mpeg"
  && pending.file.size === 5 && pending.size === 5 && pending.skipped === 0);
await put(caches, { type: "application/octet-stream", name: "kayit.flac" });
pending = await readPending(caches, BASE);
check("octet-stream: File türü boş bırakılır (yükleme adı uzantıyı taşır)", pending.file.type === "" && pending.file.name === "kayit.flac");
await put(caches, { time: Date.now() - SHARE_MAX_AGE_MS - 5 });
check("1 saatten eski: stale, dosya okunmaz", (await readPending(caches, BASE)).state === "stale" && !(await readPending(caches, BASE)).file);
await put(caches, { time: 0 });
check("zaman başlığı yoksa/0: stale (belirsiz kayıt tutulmaz)", (await readPending(caches, BASE)).state === "stale");
await put(caches, { state: "large", size: 99 * 1024 * 1024, name: "dev.wav" });
pending = await readPending(caches, BASE);
check("large: dosya yok, gerçek boyut", pending.state === "large" && !pending.file && pending.size === 99 * 1024 * 1024);
await put(caches, { name: "%E0%A4%A" });          // bozuk yüzde kodlaması
check("bozuk ad kodlaması patlatmaz", (await readPending(caches, BASE)).name.length > 0);
await put(caches, { name: "" });
check("ad boş: varsayılan ad", (await readPending(caches, BASE)).name === "paylasilan-ses");
await clearPending(caches);
check("clearPending sonrası kayıt yok; null cache'le patlamaz", (await readPending(caches, BASE)) === null && (await clearPending(null)) === undefined);
check("sınır sabitleri: 30 MB ve 1 saat", SHARE_MAX_BYTES === 30 * 1024 * 1024 && SHARE_MAX_AGE_MS === 3600000);

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
