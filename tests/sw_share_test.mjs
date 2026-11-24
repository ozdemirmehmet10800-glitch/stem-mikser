// Service worker paylaşım hedefi (Web Share Target): POST /share-target -> geçici cache -> 303 yönlendirme.
// sw.js sahte self + sahte Cache Storage içinde, gerçek Request/FormData/File ile çalışır.
//
//     node tests\sw_share_test.mjs

import { readFileSync } from "node:fs";
import { loadSw, fakeCaches } from "./sw_harness.mjs";
import * as share from "../frontend/js/share.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const ORIGIN = "https://example.test";
const TARGET = `${ORIGIN}/stem-mikser/share-target`;
const KEY = `${ORIGIN}/stem-mikser/share-pending/current`;

function post(files, { url = TARGET, extra = {} } = {}) {
  const form = new FormData();
  for (const file of files) form.append("audio", file, file.name);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new Request(url, { method: "POST", body: form });
}
const audio = (name, bytes = 1000, type = "audio/mpeg") => new File([new Uint8Array(bytes).fill(7)], name, { type });

// --- sabitler js/share.js ile aynı (sw.js klasik betik: iki yerde tanımlı, buradan eşitlik sınanıyor)
const code = readFileSync(new URL("../frontend/sw.js", import.meta.url), "utf8");
const pick = (re) => code.match(re)[1];
check("sabit: SHARE_CACHE sw.js == share.js", pick(/const SHARE_CACHE = "([^"]+)"/) === share.SHARE_CACHE);
check("sabit: SHARE_KEY sw.js == share.js", pick(/const SHARE_KEY = "([^"]+)"/) === share.SHARE_KEY);
check("sabit: SHARE_PARAM sw.js == share.js", pick(/const SHARE_PARAM = "([^"]+)"/) === share.SHARE_PARAM);
check("sabit: SHARE_VIDEO_MAX_BYTES sw.js == share.js (400 MB)", eval(pick(/const SHARE_VIDEO_MAX_BYTES = ([^;]+);/)) === share.SHARE_VIDEO_MAX_BYTES);
check("sabit: SHARE_MAX_BYTES sw.js == share.js (30 MB)", eval(pick(/const SHARE_MAX_BYTES = ([^;]+);/)) === share.SHARE_MAX_BYTES);
const manifest = JSON.parse(readFileSync(new URL("../frontend/manifest.json", import.meta.url), "utf8"));
const target = manifest.share_target;
check("manifest: share_target POST + multipart, action kapsam içinde (./share-target)",
  target && target.method === "POST" && target.enctype === "multipart/form-data" && target.action === "./share-target"
  && new URL(target.action, `${ORIGIN}/stem-mikser/`).href === TARGET && manifest.scope === "./");
const accepts = target.params.files[0].accept;
check("manifest: dosya (audio/* + bilinen uzantılar) VE metin alanları (title/text/url: YouTube Music paylaşımı -> Eklenecekler)",
  target.params.title === "title" && target.params.text === "text" && target.params.url === "url" && accepts.includes("audio/*")
  && share.AUDIO_EXTENSIONS.every((ext) => accepts.includes(`.${ext}`))
  && share.VIDEO_EXTENSIONS.every((ext) => accepts.includes(`.${ext}`)) && accepts.includes("video/mp4"));
check("manifest: kimlik alanları değişmedi (id yok, start_url ./)", !("id" in manifest) && manifest.start_url === "./");
check("kabuk listesinde share.js var", code.includes('"./js/share.js"'));

// --- normal paylaşım
let caches = fakeCaches();
let sw = await loadSw({ caches });
let out = await sw.fetch(post([audio("sarki.mp3", 1000)]));
check("ses dosyası: 303 ile ./?paylasim=1'e yönlendirir", out.responded && out.responded.status === 303
  && out.responded.headers.get("location") === `${ORIGIN}/stem-mikser/?paylasim=1`, out.responded && out.responded.headers.get("location"));
let entry = await (await caches.open("stem-mikser-share-v1")).match(KEY);
check("dosya geçici cache'te (içerik, tür, ad, boyut, zaman)", entry && (await entry.blob()).size === 1000
  && entry.headers.get("content-type") === "audio/mpeg" && decodeURIComponent(entry.headers.get("x-share-name")) === "sarki.mp3"
  && entry.headers.get("x-share-size") === "1000" && entry.headers.get("x-share-skipped") === "0"
  && Date.now() - Number(entry.headers.get("x-share-time")) < 5000 && entry.headers.get("x-share-state") === "ok");
check("kabuk cache'ine (stem-mikser-v…) HİÇ yazılmadı", ![...caches.store.keys()].some((k) => /^stem-mikser-v\d+$/.test(k)));

// --- Türkçe/özel karakterli ad (WhatsApp, boşluklu)
caches = fakeCaches(); sw = await loadSw({ caches });
await sw.fetch(post([audio("Şarkı Adı (1) ğüş.opus", 500, "audio/ogg")]));
let pending = await share.readPending(caches, `${ORIGIN}/stem-mikser/`);
check("ad (Türkçe harf, boşluk) bozulmadan geri okunur ve File olur", pending.state === "ok" && pending.name === "Şarkı Adı (1) ğüş.opus"
  && pending.file instanceof File && pending.file.name === pending.name && pending.file.size === 500 && pending.type === "audio/ogg");

// --- birden çok dosya: ilki alınır, N atlandı
caches = fakeCaches(); sw = await loadSw({ caches });
out = await sw.fetch(post([audio("a.mp3", 300), audio("b.mp3", 400), audio("c.m4a", 500, "audio/mp4")]));
pending = await share.readPending(caches, `${ORIGIN}/stem-mikser/`);
check("3 dosya: ilki saklanır, 2 atlandı", pending.name === "a.mp3" && pending.size === 300 && pending.skipped === 2
  && out.responded.status === 303);
check("tek bekleyen kayıt (yalnız ilk dosya cache'te)", (await (await caches.open("stem-mikser-share-v1")).keys()).length === 1);
check("kart notu: '2 dosya atlandı (yalnız ilki alındı).'", share.classify(pending).note === "2 dosya atlandı (yalnız ilki alındı).");

// --- yeni paylaşım eskisinin yerine geçer
await sw.fetch(post([audio("yeni.wav", 800, "audio/wav")]));
pending = await share.readPending(caches, `${ORIGIN}/stem-mikser/`);
check("ikinci paylaşım birincinin yerine geçer (tek kayıt)", pending.name === "yeni.wav"
  && (await (await caches.open("stem-mikser-share-v1")).keys()).length === 1);

// --- dosyasız POST: metin/bağlantı -> Eklenecekler (YouTube Music paylaşımı)
caches = fakeCaches(); sw = await loadSw({ caches });
out = await sw.fetch(post([], { extra: { text: "Sentetik Şarkı • Sentetik Sanatçı https://music.youtube.com/watch?v=abcdefghijk&si=IZLEME", title: "Sentetik Şarkı" } }));
check("dosyasız POST (metin/bağlantı): ./?paylasim=metin'e yönlendirir", out.responded.status === 303
  && out.responded.headers.get("location").endsWith("?paylasim=metin"));
entry = await (await caches.open("stem-mikser-share-v1")).match(KEY);
check("metin paylaşımı: JSON gövde, state=text, zaman damgası", entry && entry.headers.get("x-share-state") === "text"
  && Date.now() - Number(entry.headers.get("x-share-time")) < 5000 && (await entry.json()).title === "Sentetik Şarkı");
pending = await share.readPending(caches, `${ORIGIN}/stem-mikser/`);
check("readPending: metin kaydı {state: text, title, text, url}", pending.state === "text" && pending.title === "Sentetik Şarkı"
  && pending.text.includes("music.youtube.com") && pending.url === "" && !pending.file);
const wishVerdict = share.classify(pending);
check("classify: metin -> wish; ad, sanatçı, izleme parametresiz bağlantı", wishVerdict.action === "wish" && wishVerdict.clear
  && wishVerdict.entry.title === "Sentetik Şarkı" && wishVerdict.entry.artist === "Sentetik Sanatçı"
  && wishVerdict.entry.url === "https://music.youtube.com/watch?v=abcdefghijk" && wishVerdict.entry.vid === "abcdefghijk", JSON.stringify(wishVerdict.entry));
check("metin paylaşımı yalnız bu tek kayda yazar (kabuk cache'ine dokunmaz)", ![...caches.store.keys()].some((k) => /^stem-mikser-v\d+$/.test(k))
  && (await (await caches.open("stem-mikser-share-v1")).keys()).length === 1);
check("aşırı uzun alan kırpılır (2000)", await (async () => {
  const c = fakeCaches(); const s = await loadSw({ caches: c });
  await s.fetch(post([], { extra: { text: "x".repeat(10000) } }));
  const p = await share.readPending(c, `${ORIGIN}/stem-mikser/`);
  return p.text.length === 2000;
})());
check("yeni dosya paylaşımı metin kaydının yerine geçer (tek kayıt)", await (async () => {
  await sw.fetch(post([audio("a.mp3", 100)]));
  const p = await share.readPending(caches, `${ORIGIN}/stem-mikser/`);
  return p.state === "ok" && p.name === "a.mp3" && (await (await caches.open("stem-mikser-share-v1")).keys()).length === 1;
})());
check("dosya + metin birlikte: dosya kazanır (metin atılır)", await (async () => {
  const c = fakeCaches(); const s = await loadSw({ caches: c });
  await s.fetch(post([audio("b.mp3", 100)], { extra: { text: "bir sey", title: "x" } }));
  const p = await share.readPending(c, `${ORIGIN}/stem-mikser/`);
  return p.state === "ok" && p.name === "b.mp3";
})());
check("metin kaydı bir saatten eskiyse stale", await (async () => {
  const p = await share.readPending(caches, `${ORIGIN}/stem-mikser/`, Date.now() + 2 * 60 * 60 * 1000);
  return p.state === "stale";
})());
check("yalnız bağlantı paylaşımı: başlıksız istek (ad boş, bağlantı var)", (() => {
  const v = share.classify({ state: "text", title: "", text: "", url: "https://youtu.be/abcdefghijk?si=x" });
  return v.action === "wish" && v.entry.title === "" && v.entry.url === "https://youtu.be/abcdefghijk" && v.entry.vid === "abcdefghijk";
})());
check("boş metin paylaşımı -> mesaj", share.classify({ state: "text", title: " ", text: "", url: "" }).kind === "nowish");
caches = fakeCaches(); sw = await loadSw({ caches });
out = await sw.fetch(post([], { extra: { text: "   ", title: "", url: "" } }));
check("dosyasız ve boş metin: ./?paylasim=bos, cache'e yazılmaz", out.responded.status === 303
  && out.responded.headers.get("location").endsWith("?paylasim=bos") && !caches.store.has("stem-mikser-share-v1"));
check("launchKind: bos -> empty, hata -> error, 1 -> file, metin -> text, yok -> null",
  share.launchKind("?paylasim=bos") === "empty" && share.launchKind("?paylasim=hata") === "error" && share.launchKind("?paylasim=metin") === "text"
  && share.launchKind("?paylasim=1") === "file" && share.launchKind("") === null && share.launchKind("?x=1") === null);

// --- büyük dosya: saklanmaz, yalnız ad/boyut
caches = fakeCaches(); sw = await loadSw({ caches });
out = await sw.fetch(post([audio("buyuk.wav", 31 * 1024 * 1024, "audio/wav")]));
entry = await (await caches.open("stem-mikser-share-v1")).match(KEY);
check("31 MB: dosya SAKLANMAZ (gövde boş), durum large + gerçek boyut", out.responded.status === 303 && entry
  && entry.headers.get("x-share-state") === "large" && Number(entry.headers.get("x-share-size")) === 31 * 1024 * 1024
  && (await entry.blob()).size === 0);
pending = await share.readPending(caches, `${ORIGIN}/stem-mikser/`);
let verdict = share.classify(pending);
check("büyük dosya: kart yok, net mesaj (31,0 MB, sınır 30,0 MB)", verdict.action === "message" && verdict.kind === "large"
  && /31,0 MB/.test(verdict.text) && /30,0 MB/.test(verdict.text) && verdict.clear === true, verdict.text);
caches = fakeCaches(); sw = await loadSw({ caches });
await sw.fetch(post([audio("sinirda.wav", 30 * 1024 * 1024, "audio/wav")]));
check("tam 30 MB sınırda KABUL (sunucu sınırı aşmaz)", share.classify(await share.readPending(caches, `${ORIGIN}/stem-mikser/`)).action === "card");

// --- ses olmayan dosya (crafted POST) ve genel MIME + ses uzantısı
caches = fakeCaches(); sw = await loadSw({ caches });
await sw.fetch(post([new File(["x"], "resim.png", { type: "image/png" })]));
verdict = share.classify(await share.readPending(caches, `${ORIGIN}/stem-mikser/`));
check("ses olmayan dosya: kart yok, 'ses dosyası gibi görünmüyor'", verdict.action === "message" && verdict.kind === "notaudio"
  && /resim\.png/.test(verdict.text));
caches = fakeCaches(); sw = await loadSw({ caches });
await sw.fetch(post([new File(["x"], "kayit.flac", { type: "application/octet-stream" })]));
check("genel MIME (octet-stream) + .flac uzantısı: kabul (kart)", share.classify(await share.readPending(caches, `${ORIGIN}/stem-mikser/`)).action === "card");
check("isAudio: audio/*, uzantı, büyük harf, ses dışı", share.isAudio({ type: "audio/x-m4a" }) && share.isAudio({ name: "A.MP3" })
  && share.isAudio({ name: "klip.mp4", type: "video/mp4" }) && share.isVideo({ name: "klip.MKV" }) && !share.isVideo({ name: "a.mp3" }) && !share.isAudio({ name: "belge.pdf" }) && !share.isAudio({ name: "resim.png", type: "image/png" }));

// --- bayat kayıt
caches = fakeCaches(); sw = await loadSw({ caches });
await sw.fetch(post([audio("eski.mp3")]));
const later = Date.now() + share.SHARE_MAX_AGE_MS + 1000;
pending = await share.readPending(caches, `${ORIGIN}/stem-mikser/`, later);
verdict = share.classify(pending);
check("1 saatten eski kayıt: bayat -> 'bulunamadı' mesajı + silinir", pending.state === "stale" && verdict.kind === "gone" && verdict.clear);
await share.clearPending(caches);
check("clearPending: kayıt silinir, sonra readPending null", (await share.readPending(caches, `${ORIGIN}/stem-mikser/`)) === null);

// --- bozuk gövde -> hata yönlendirmesi
caches = fakeCaches(); sw = await loadSw({ caches });
out = await sw.fetch(new Request(TARGET, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "bozuk" }));
check("bozuk multipart: ./?paylasim=hata'ya yönlendirir (patlamaz)", out.responded && out.responded.status === 303
  && out.responded.headers.get("location").endsWith("?paylasim=hata"));

// --- başka isteklere karışılmaz
caches = fakeCaches(); sw = await loadSw({ caches });
const ignored = [
  ["başka yola POST", post([audio("a.mp3")], { url: `${ORIGIN}/stem-mikser/baska` })],
  ["başka origin'e POST", post([audio("a.mp3")], { url: "https://api.example.test/stem-mikser/share-target" })],
  ["share-target'a GET", new Request(TARGET)],
  ["API'ye POST", new Request("https://api.example.test/songs", { method: "POST", body: "x" })],
];
for (const [label, request] of ignored) {
  const result = await sw.fetch(request);
  check(`karışılmaz: ${label} (respondWith çağrılmadı)`, result.responded === undefined || label === "share-target'a GET" && result.responded !== undefined && result.responded.status !== 303);
}

// --- manifest.json önce ağ, çevrimdışıyken cache
let netCalls = 0;
caches = fakeCaches();
sw = await loadSw({ caches, fetch: async () => { netCalls += 1; return new Response('{"name":"yeni"}', { status: 200 }); } });
await (await caches.open(`stem-mikser-${code.match(/VERSION = "(v\d+)"/)[1]}`)).put(`${ORIGIN}/stem-mikser/manifest.json`, new Response('{"name":"eski"}'));
out = await sw.fetch(new Request(`${ORIGIN}/stem-mikser/manifest.json`));
check("manifest.json: önce ağ (yeni içerik döner, eski cache değil)", netCalls === 1 && (await out.responded.text()) === '{"name":"yeni"}');
sw = await loadSw({ caches, fetch: async () => { throw new TypeError("offline"); } });
out = await sw.fetch(new Request(`${ORIGIN}/stem-mikser/manifest.json`));
check("manifest.json: çevrimdışıyken cache'ten", out.responded && (await out.responded.text()) === '{"name":"yeni"}');

// --- paylaşım cache'i activate'te silinmez
caches = fakeCaches({ "stem-mikser-v1": 1 });
await sw.fetch(post([audio("k.mp3")]));
sw = await loadSw({ caches });
await sw.fetch(post([audio("k.mp3")]));
await sw.fire("activate");
check("activate: bekleyen paylaşım korunur, eski kabuk silinir", (await caches.keys()).includes("stem-mikser-share-v1") && !(await caches.keys()).includes("stem-mikser-v1"));

// --- klip (mp4) paylaşımı: kabul edilir, kartta "yalnız sesi alınır" notu
caches = fakeCaches(); sw = await loadSw({ caches });
await sw.fetch(post([new File([new Uint8Array(500).fill(1)], "Klip Adı.mp4", { type: "video/mp4" })]));
const clip = share.classify(await share.readPending(caches, `${ORIGIN}/stem-mikser/`));
check("mp4 klip paylaşımı: kart açılır, not 'yalnız sesi alınır'", clip.action === "card" && /yalnız sesi alınır/.test(clip.note), JSON.stringify(clip));
const nonMedia = share.classify({ state: "ok", name: "resim.png", type: "image/png", size: 10, skipped: 0, time: Date.now() });
check("resim reddedilir, mesaj ses ya da video der", nonMedia.action === "message" && /ses ya da video/.test(nonMedia.text));

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
