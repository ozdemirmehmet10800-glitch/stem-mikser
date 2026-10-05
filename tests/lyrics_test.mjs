// Soz arayuzu mantigi (Asama 11): saf, DOM/ag yok. SENTETIK metin; gercek soz YOK.
//
//     node tests\lyrics_test.mjs

import {
  LANG_CHOICES, HOLD_SECONDS, GAP_CAP_SECONDS, GAP_TAIL_SECONDS, LYRICS_STALE_SECONDS,
  MAX_TEXT_LINES, MAX_TEXT_CHARS, CACHE_PREFIX, CACHE_LIMIT,
  isRunning, isStale, normalizeDoc, findLine, scrollTarget, lineLoop, linesToText, checkText,
  estimateLyrics, sectionView, LYRICS_MESSAGES, readCache, writeCache, dropCache, pruneCache,
} from "../frontend/js/lyrics.js";
import { minLoopLength } from "../frontend/js/loop.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const NOW = 1_000_000;
const L = (t, e, text = `satir ${t}`) => ({ t, e, text, w: [] });
// 0: 2-5, 1: 6-9, 2: 10-12 | uzun ara muzik | 3: 30-33, 4: 33-36
const lines = [L(2, 5), L(6, 9), L(10, 12), L(30, 33), L(33, 36)];

// --- dil secenekleri
check("dil secici: otomatik/tr/en/ja", LANG_CHOICES.map((c) => c[0]).join() === "auto,tr,en,ja");

// --- satir bulma
check("findLine: ilk satirdan once -1", findLine(lines, 0) === -1 && findLine(lines, 1.99) === -1);
check("findLine: tam baslangicta o satir", findLine(lines, 2) === 0 && findLine(lines, 6) === 1);
check("findLine: satir icinde", findLine(lines, 4.9) === 0 && findLine(lines, 11) === 2);
check("findLine: satir bitince sonraki baslayana kadar ayni satir (hold icinde)",
  findLine(lines, 5.5) === 0 && findLine(lines, 12 + HOLD_SECONDS - 0.01) === 2);
check("findLine: ara muzik (bitis + hold sonrasi) -1", findLine(lines, 12 + HOLD_SECONDS + 0.5) === -1
  && findLine(lines, 20) === -1);
check("findLine: ara muzik bitince yeni satir", findLine(lines, 30.2) === 3 && findLine(lines, 34) === 4);
check("findLine: son satirdan hold sonrasi -1", findLine(lines, 36 + HOLD_SECONDS + 1) === -1
  && findLine(lines, 36 + HOLD_SECONDS - 0.1) === 4);
check("findLine: bos liste / gecersiz zaman -1", findLine([], 3) === -1 && findLine(lines, NaN) === -1
  && findLine(null, 3) === -1);
check("findLine: negatif zaman -1", findLine(lines, -1) === -1);
// buyuk liste: ikili arama dogru
const many = Array.from({ length: 400 }, (_, i) => L(i * 3, i * 3 + 2));
check("findLine: 400 satirda dogru", findLine(many, 3 * 123 + 0.5) === 123 && findLine(many, 3 * 399 + 1) === 399);
// ayni baslangicli satirlar
const same = [L(1, 2), L(1, 3)];
check("findLine: ayni baslangic -> sonuncusu", findLine(same, 1.5) === 1);

// --- kaydirma hedefi
check("scrollTarget: sarki basinda ilk satir", scrollTarget(lines, 0) === 0);
check("scrollTarget: satir icinde o satir", scrollTarget(lines, 7) === 1);
check("scrollTarget: ara muzikte siradaki satir", scrollTarget(lines, 20) === 3);
check("scrollTarget: sondan sonra son satir", scrollTarget(lines, 100) === 4);
check("scrollTarget: bos -> -1", scrollTarget([], 5) === -1);

// --- uzun basma: satiri A-B dongusune cevir
const min = minLoopLength(null);
let loop = lineLoop(lines, 0, 200, min);
check("lineLoop: A = satir basi, B = sonraki satirin basi", loop && loop.a === 2 && loop.b === 6, JSON.stringify(loop));
loop = lineLoop(lines, 4, 200, min);
check("lineLoop: son satir B = satir bitisi", loop && loop.a === 33 && loop.b === 36, JSON.stringify(loop));
loop = lineLoop(lines, 2, 200, min);
check("lineLoop: sonraki satir cok uzaksa (ara muzik) B = bitis + kisa pay (sessizlikte donmesin)",
  loop && loop.a === 10 && loop.b === 12 + GAP_TAIL_SECONDS && 30 - 12 > GAP_CAP_SECONDS, JSON.stringify(loop));
const tight = [L(0, 0.1), L(0.15, 1)];
loop = lineLoop(tight, 0, 200, min);
check("lineLoop: minLoopLength'ten kisa satir uzatilir", loop && loop.b - loop.a >= min - 1e-6
  && loop.a === 0, JSON.stringify(loop) + ` min=${min}`);
loop = lineLoop([L(198.9, 199.0)], 0, 199.1, min);
check("lineLoop: sarki sonunda minLoopLength sigmiyorsa A one cekilir",
  loop && loop.b === 199.1 && loop.b - loop.a >= min - 1e-6 && loop.a < 198.9, JSON.stringify(loop));
check("lineLoop: sarki minLoopLength'ten kisaysa null", lineLoop([L(0, 0.1)], 0, 0.2, min) === null);
check("lineLoop: gecersiz dizin null", lineLoop(lines, 9, 200, min) === null && lineLoop(lines, -1, 200, min) === null);
loop = lineLoop([L(10, 12), L(11, 11.2)], 0, 200, min);
check("lineLoop: bir sonraki satir cakisiyorsa (B < A+min) minLen'e uzatilir",
  loop && loop.b - loop.a >= min - 1e-6, JSON.stringify(loop));
loop = lineLoop(lines, 0, 4, min);
check("lineLoop: B sarki suresini asmaz", loop && loop.b <= 4, JSON.stringify(loop));

// --- belge dogrulama
const goodDoc = { schema: 1, version: 7, source: "pasted", language: "ja", duration: 100,
  lines: [{ t: 5, e: 8, text: " ikinci ", w: [[5, 6, "a"]] }, { t: 1, e: 3, text: "birinci" },
    { t: 9, e: 8, text: "bitis<baslangic" }, { t: -1, e: 0, text: "negatif" }, { t: 10, e: 11, text: "   " },
    { t: "x", e: 1, text: "gecersiz" }, null, { t: 12, e: 13 }] };
const doc = normalizeDoc(goodDoc);
check("normalizeDoc: sirali, kirpilmis, gecersizler atilir",
  doc && doc.lines.map((l) => l.text).join("|") === "birinci|ikinci|bitis<baslangic", JSON.stringify(doc && doc.lines.map((l) => l.text)));
check("normalizeDoc: bitis < baslangic ise bitis = baslangic", doc.lines[2].e === doc.lines[2].t);
check("normalizeDoc: ust alanlar", doc.version === 7 && doc.source === "pasted" && doc.language === "ja" && doc.duration === 100);
check("normalizeDoc: bilinmeyen dil null, bilinmeyen kaynak auto",
  normalizeDoc({ lines: [{ t: 1, e: 2, text: "x" }], language: "ko", source: "?" }).language === null
  && normalizeDoc({ lines: [{ t: 1, e: 2, text: "x" }], source: "?" }).source === "auto");
check("normalizeDoc: bozuk girdi null", normalizeDoc(null) === null && normalizeDoc({}) === null
  && normalizeDoc({ lines: [] }) === null && normalizeDoc({ lines: "x" }) === null && normalizeDoc("x") === null);

// --- metin kutusu
check("linesToText: satirlar alt alta", linesToText([L(1, 2, "bir"), L(3, 4, "iki")]) === "bir\niki");
check("linesToText: bos", linesToText([]) === "" && linesToText(null) === "");
let r = checkText("  bir   iki \n\n\r\n ucuncu\t dorduncu  \n");
check("checkText: bosluklar sadelesir, bos satir atilir", !r.error && r.lines.join("|") === "bir iki|ucuncu dorduncu", JSON.stringify(r));
check("checkText: bos metin hata", checkText("  \n \n").error !== null && checkText("").error !== null);
check("checkText: karakter siniri", checkText("a".repeat(MAX_TEXT_CHARS + 1)).error !== null
  && checkText("a".repeat(MAX_TEXT_CHARS)).error === null);
check("checkText: satir siniri", checkText(Array(MAX_TEXT_LINES + 1).fill("x").join("\n")).error !== null
  && checkText(Array(MAX_TEXT_LINES).fill("x").join("\n")).error === null);
check("checkText: metin degil hata", checkText(null).error !== null && checkText(5).error !== null);
check("checkText: Japonca korunur", checkText("テスト行 1\nテスト行 2").lines.length === 2);

// --- tahmin
const est = estimateLyrics(158);
check("tahmin: metinde dk ve $", /dk/.test(est.text) && /\$/.test(est.text), est.text);
check("tahmin: uzun sarki daha pahali, gecersiz sure patlamaz",
  estimateLyrics(600).usd >= estimateLyrics(158).usd && estimateLyrics(undefined).minutes >= 1 && estimateLyrics(-5).usd >= 0);

// --- durum: calisiyor / bayat / takilmis
check("isRunning: taze running", isRunning({ state: "running", started: NOW - 10 }, NOW));
check("isRunning: takilmis (>40 dk) degil", !isRunning({ state: "running", started: NOW - LYRICS_STALE_SECONDS - 1 }, NOW));
check("isRunning: done/yok degil", !isRunning({ state: "done" }, NOW) && !isRunning(undefined, NOW));
check("isStale: ayni ayristirma degil", !isStale({ stems_version: 5, lyrics: { state: "done", parent_stems_version: 5 } }));
check("isStale: ana sarki yeniden islendi -> eski", isStale({ stems_version: 6, lyrics: { state: "done", parent_stems_version: 5 } }));
check("isStale: done degilse / alan yoksa degil",
  !isStale({ stems_version: 6, lyrics: { state: "running", parent_stems_version: 5 } })
  && !isStale({ stems_version: 6, lyrics: { state: "done" } }) && !isStale({ stems_version: 6 }) && !isStale(undefined));

// --- bolum gorunumu
const base = { duration: 158, nowSec: NOW };
let v = sectionView({ ...base, status: {} });
check("yok: cikar + yapistir, duzenle yok", v.kind === "none" && v.canExtract && v.canPaste && !v.canEdit && !v.disabled);
check("yok: maliyet tahmini", /dk/.test(v.estimate) && /\$/.test(v.estimate));
v = sectionView({ ...base, status: {}, offline: true });
check("yok + cevrimdisi: dugmeler pasif, 'Internet yok'", v.disabled && v.hint === "İnternet yok");
v = sectionView({ ...base, status: {}, starting: true });
check("istek gidiyor: running, dugme yok", v.kind === "running" && !v.canExtract && !v.canPaste && v.text === LYRICS_MESSAGES.running);
v = sectionView({ ...base, status: { lyrics: { state: "running", started: NOW - 5 } } });
check("sunucuda calisiyor: running", v.kind === "running" && !v.canEdit);
v = sectionView({ ...base, status: { lyrics: { state: "running", started: NOW - 99999 } } });
check("takilmis running: yeniden denenebilir", v.kind === "none" && v.canExtract);
v = sectionView({ ...base, status: { lyrics: { state: "no_vocals" } } });
check("vokal yok: mesaj, hicbir dugme", v.kind === "no_vocals" && v.text === "Bu şarkıda vokal yok"
  && !v.canExtract && !v.canPaste && !v.canEdit);
v = sectionView({ ...base, status: { lyrics: { state: "error" } } });
check("hata: tekrar dene (cikar + yapistir)", v.kind === "error" && v.canExtract && v.canPaste);
v = sectionView({ ...base, status: { lyrics: { state: "no_lyrics" } } });
check("sonuc yok: yalniz yapistir", v.kind === "no_lyrics" && v.canPaste && !v.canExtract && v.text === LYRICS_MESSAGES.noLyrics);
const doneStatus = (over = {}, root = {}) => ({ stems_version: 5, lyrics: { state: "done", source: "auto", language: "tr",
  version: 9, parent_stems_version: 5, ...over }, ...root });
v = sectionView({ ...base, status: doneStatus(), hasDoc: true });
check("hazir: duzenle var, uyari yok, hizala yok", v.kind === "ready" && v.canEdit && v.notices.length === 0
  && !v.canRealign && !v.canExtract);
v = sectionView({ ...base, status: doneStatus({ warning: "text_mismatch", source: "pasted" }), hasDoc: true });
check("uyari: 'Metin sesle uyuşmuyor olabilir'", v.notices.some((n) => n.text === "Metin sesle uyuşmuyor olabilir"));
v = sectionView({ ...base, status: doneStatus({ parent_stems_version: 4 }), hasDoc: true });
check("eski ayristirma: oneri + yeniden hizala", v.notices.some((n) => n.text === "Sözler eski ayrıştırmadan, yeniden hizala")
  && v.canRealign);
v = sectionView({ ...base, status: doneStatus({ parent_stems_version: 4 }), hasDoc: false });
check("eski ayristirma ama metin cihazda yok: hizala yok", !v.canRealign);
v = sectionView({ ...base, status: doneStatus({ last_attempt: { state: "error" } }), hasDoc: true });
check("son deneme basarisiz: onceki duruyor notu", v.notices.some((n) => /önceki sözler duruyor/.test(n.text)) && v.canEdit);
v = sectionView({ ...base, status: doneStatus({ last_attempt: { state: "no_lyrics" } }), hasDoc: true });
check("son deneme sonuc yok notu", v.notices.some((n) => n.text === LYRICS_MESSAGES.noLyrics));
v = sectionView({ ...base, status: doneStatus(), hasDoc: true, offline: true });
check("hazir + cevrimdisi: gorunur ama duzenle pasif", v.kind === "ready" && v.disabled && v.hint === "İnternet yok");
v = sectionView({ ...base, status: { lyrics: { state: "running", started: NOW - 5, previous: { state: "done" } } }, hasDoc: true });
check("yeniden hizalanirken: running (eski metin gosterilebilir)", v.kind === "running");
v = sectionView({ ...base, status: undefined, hasDoc: true });
check("durum yok ama cihazda metin: hazir (cevrimdisi acilis)", v.kind === "ready" && v.canEdit);

// --- cihaz onbellegi
class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
const store = new FakeStorage();
const sample = { schema: 1, version: 3, source: "auto", language: "en", duration: 30,
  lines: [{ t: 1, e: 2, text: "a" }, { t: 3, e: 4, text: "b" }] };
check("onbellek: yaz-oku", writeCache(store, "s1", sample, 3, 1000)
  && readCache(store, "s1").version === 3 && readCache(store, "s1").doc.lines.length === 2);
check("onbellek: olmayan kimlik null", readCache(store, "yok") === null);
store.setItem(CACHE_PREFIX + "bozuk", "{{{");
check("onbellek: bozuk kayit null (cokmez)", readCache(store, "bozuk") === null);
store.setItem(CACHE_PREFIX + "bos", JSON.stringify({ version: 1, doc: { lines: [] } }));
check("onbellek: satirsiz kayit null", readCache(store, "bos") === null);
dropCache(store, ["s1"]);
check("onbellek: silme", readCache(store, "s1") === null);
for (let i = 0; i < CACHE_LIMIT + 7; i += 1) writeCache(store, `song${i}`, sample, 1, 5000 + i);
const keys = [...store.map.keys()].filter((k) => k.startsWith(CACHE_PREFIX) && !/bozuk|bos$/.test(k));
check("onbellek: sinir asilinca en eskiler silinir", keys.length <= CACHE_LIMIT, String(keys.length));
check("onbellek: en yeni kayit kaldi, en eskisi gitti", readCache(store, `song${CACHE_LIMIT + 6}`) !== null
  && readCache(store, "song0") === null);
const failing = { getItem() { throw new Error("x"); }, setItem() { throw new Error("kota"); }, removeItem() { throw new Error("x"); },
  key() { return null; }, length: 0 };
check("onbellek: depolama hata verirse patlamaz", writeCache(failing, "a", sample, 1) === false
  && readCache(failing, "a") === null && pruneCache(failing) === 0);
dropCache(failing, ["a"]);

console.log(failed ? `\n${failed} HATA` : "\nhepsi gecti");
process.exit(failed ? 1 : 0);
