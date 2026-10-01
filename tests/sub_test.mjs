// Alt parca arayuz mantigi (saf, DOM/ag yok).
//
//     node tests\sub_test.mjs

import {
  subView, estimateSub, isRunning, subVersion, SUB_NAMES, SUB_GROUPS, SUB_STALE_SECONDS,
} from "../frontend/js/sub.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const NOW = 1_000_000;
const view = (over = {}) => subView({ duration: 158, nowSec: NOW, ...over });

check("adlar ve grup", SUB_NAMES.join() === "lead,backing" && SUB_GROUPS.vocals.join() === "lead,backing");

// --- tahmin
const e = estimateSub(158);
check("tahmin: Zeus 158 sn ~2 dk, ~$0.016", e.minutes === 2 && Math.abs(e.usd - 0.016) < 0.003, e.text);
check("tahmin: metin dk ve $ icerir", /dk/.test(e.text) && /\$/.test(e.text));
check("tahmin: uzun sarki daha pahali", estimateSub(600).usd > estimateSub(158).usd);
check("tahmin: gecersiz sure patlamaz", estimateSub(undefined).minutes >= 1 && estimateSub(-5).usd >= 0);

// --- hic istenmemis
let v = view({});
check("yok: 'Alt parçaları ayır' düğmesi", v.kind === "none" && v.button === "Alt parçaları ayır");
check("yok: maliyet ipucu metinde", /dk/.test(v.text) && /\$/.test(v.text));
check("yok: ok yok, pasif degil", v.arrow === null && v.disabled === false);
v = view({ offline: true });
check("yok + cevrimdisi: dugme pasif, neden yazili", v.disabled && v.hint === "İnternet yok");

// --- calisiyor
v = view({ sub: { state: "running", started: NOW - 30 } });
check("running: ayriliyor metni, dugme yok, pasif", v.kind === "running" && v.button === null && v.disabled);
v = view({ sub: { state: "running", started: NOW - SUB_STALE_SECONDS - 5 } });
check("takilmis running: yeniden denenebilir (dugme geri)", v.kind === "none" && v.button === "Alt parçaları ayır");
check("isRunning sinirlari", isRunning({ state: "running", started: NOW - 10 }, NOW)
  && !isRunning({ state: "done" }, NOW) && !isRunning(undefined, NOW)
  && !isRunning({ state: "running" }, NOW));
v = view({ starting: true });
check("istek gidiyor: running gorunur", v.kind === "running" && v.disabled);

// --- mesajlar
v = view({ sub: { state: "no_vocals" } });
check("vokal yok mesaji", v.kind === "no_vocals" && v.text === "Bu şarkıda vokal yok" && v.button === null && v.arrow === null);
v = view({ sub: { state: "unreliable" } });
check("ayrilamadi mesaji", v.kind === "unreliable" && v.text === "Bu şarkıda ana vokal ayrılamadı" && v.arrow === null);
v = view({ sub: { state: "error" } });
check("hata: tekrar dene", v.kind === "none" && v.button === "Tekrar dene" && /başarısız/.test(v.text));

// --- hazir
v = view({ sub: { state: "done", reliability: "ok", version: 5 }, cached: true });
check("done/ok: ok kapali, rozet yok, acilabilir", v.kind === "ready" && v.arrow === "closed" && v.badge === null && v.canExpand && !v.disabled);
v = view({ sub: { state: "done", reliability: "warn", version: 5 }, cached: true });
check("done/warn: guvenilmez olabilir rozeti", v.badge === "Ayrım güvenilmez olabilir" && v.canExpand);
v = view({ sub: { state: "done", reliability: "warn", version: 5 }, expanded: true });
check("acik: ok acik, rozet duruyor", v.kind === "expanded" && v.arrow === "open" && v.badge !== null && !v.disabled);
v = view({ sub: { state: "done", version: 5 }, busy: true });
check("acma suruyor: ok pasif", v.disabled && v.canExpand);

// --- cevrimdisi
v = view({ sub: { state: "done", version: 5 }, offline: true, cached: false });
check("cevrimdisi + cihazda yok: acma pasif, neden", v.disabled && !v.canExpand && /cihazda yok/.test(v.hint));
v = view({ sub: { state: "done", version: 5 }, offline: true, cached: true });
check("cevrimdisi + cihazda var: acilabilir", !v.disabled && v.canExpand);
v = view({ sub: { state: "done", version: 5 }, offline: true, cached: false, expanded: true });
check("zaten acik: cevrimdisi kapatmayi engellemez", !v.disabled);

// --- uzun sarki (telefon)
v = view({ sub: { state: "done", version: 5 }, mobile: true, thresholdSec: 360, duration: 500, cached: true });
check("uzun sarki + telefon: acma pasif, bellek uyarisi", v.disabled && !v.canExpand && /Uzun şarkı/.test(v.hint));
v = view({ sub: { state: "done", version: 5 }, mobile: false, thresholdSec: 360, duration: 500, cached: true });
check("uzun sarki + masaustu: izin var", !v.disabled && v.canExpand);
v = view({ sub: { state: "done", version: 5 }, mobile: true, thresholdSec: Infinity, duration: 9999, cached: true });
check("esik sonsuz (8 GB telefon): izin var", !v.disabled);
v = view({ sub: { state: "done", version: 5 }, mobile: true, thresholdSec: 360, duration: 500, expanded: true });
check("uzun sarkida zaten aciksa kapatilabilir", !v.disabled);

// --- surum
check("subVersion", subVersion({ state: "done", version: 77 }) === 77 && subVersion({ state: "running" }) === 0 && subVersion(undefined) === 0);

console.log(failed ? `\n${failed} HATA` : "\nhepsi gecti");
process.exit(failed ? 1 : 0);
