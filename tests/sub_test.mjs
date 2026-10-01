// Alt parca arayuz mantigi (saf, DOM/ag yok).
//
//     node tests\sub_test.mjs

import {
  subView, estimateSub, isRunning, subVersion, SUB_GROUPS, SUB_STALE_SECONDS, GROUP_ORDER,
  SUB_KEYS, SUB_LABELS, WARN_BADGES, subNames, subOf, groupThresholdSec,
} from "../frontend/js/sub.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const NOW = 1_000_000;
const view = (over = {}) => subView({ duration: 158, nowSec: NOW, ...over });

check("adlar ve gruplar", subNames("vocals").join() === "lead,backing"
  && SUB_GROUPS.drums.join() === "kick,snare,toms,hihat,cymbals" && GROUP_ORDER.join() === "vocals,drums");
check("davul 5 kanal (drumsother YOK)", SUB_GROUPS.drums.length === 5 && !SUB_GROUPS.drums.includes("drumsother"));
check("durum anahtarlari: vokal 'sub' (eski ad), davul 'sub_drums'", SUB_KEYS.vocals === "sub" && SUB_KEYS.drums === "sub_drums");
check("arayuz adlari: Kick, Snare, Tom, Hi-hat, Zil",
  ["kick", "snare", "toms", "hihat", "cymbals"].map((n) => SUB_LABELS[n]).join() === "Kick,Snare,Tom,Hi-hat,Zil");
check("subOf: gruba gore status alani", subOf({ sub: { state: "done" }, sub_drums: { state: "running" } }, "drums").state === "running"
  && subOf({ sub: { state: "done" } }, "vocals").state === "done" && subOf({}, "drums") === undefined && subOf(undefined, "drums") === undefined);

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

// --- DAVUL grubu ---------------------------------------------------------
{
  const dv = (over = {}) => subView({ group: "drums", duration: 158, nowSec: NOW, ...over });
  let v = dv();
  check("davul: yok -> 'Alt parçaları ayır' + davul tahmini", v.kind === "none" && v.button === "Alt parçaları ayır" && /dk/.test(v.text));
  const ed = estimateSub(158, "drums"), ev = estimateSub(158, "vocals");
  check("davul tahmini: Zeus 158 sn ~1-2 dk, ~$0.0125 (vokaldan ucuz)", ed.minutes <= 2 && Math.abs(ed.usd - 0.0125) < 0.002 && ed.usd < ev.usd, ed.text);
  v = dv({ sub: { state: "no_drums" } });
  check("davul yok mesaji", v.kind === "no_drums" && v.text === "Bu şarkıda davul yok" && v.arrow === null);
  v = subView({ group: "vocals", sub: { state: "no_drums" }, nowSec: NOW });
  check("vokal grubu no_drums durumunu gostermez (kendi durumu)", v.kind === "none" && v.button !== null);
  v = dv({ sub: { state: "done", reliability: "ok", version: 3 }, cached: true });
  check("davul hazir: ok kapali, metin 5 kanal, rozet yok", v.kind === "ready" && v.arrow === "closed" && v.badge === null
    && v.text === "Kick / Snare / Tom / Hi-hat / Zil");
  v = dv({ sub: { state: "done", reliability: "warn", version: 3 }, cached: true });
  check("davul warn rozeti: 'Tom kanalına başka enstrüman sızmış olabilir'",
    v.badge === "Tom kanalına başka enstrüman sızmış olabilir" && v.badge === WARN_BADGES.drums && v.canExpand);
  v = subView({ group: "vocals", sub: { state: "done", reliability: "warn", version: 3 }, cached: true, nowSec: NOW });
  check("vokal warn rozeti AYRI metin", v.badge === "Ayrım güvenilmez olabilir");
  v = dv({ sub: { state: "running", started: NOW - 5 } });
  check("davul running", v.kind === "running" && v.disabled);
  v = dv({ sub: { state: "unreliable" } });
  check("davul 'ayrilamadi' metni davula ozel", v.text === "Bu şarkıda davul ayrılamadı");
  v = dv({ sub: { state: "error" } });
  check("davul hata: tekrar dene", v.button === "Tekrar dene");
}

// --- grup basina uzun sarki esigi ------------------------------------------
{
  const base = 480;      // 4 GB telefon
  const vocals = groupThresholdSec(base, 0, 2);
  const drums = groupThresholdSec(base, 0, 5);
  const toDrums = groupThresholdSec(base, 2, 5);     // vokal acikken davula gecis
  const toVocals = groupThresholdSec(base, 5, 2);
  check("esik: vokal 6/8", Math.abs(vocals - 360) < 1e-9, String(vocals));
  check("esik: davul 6/11", Math.abs(drums - 480 * 6 / 11) < 1e-9, drums.toFixed(1));
  check("esik: gecis 6/13", Math.abs(toDrums - 480 * 6 / 13) < 1e-9 && Math.abs(toVocals - 480 * 6 / 13) < 1e-9);
  check("esik: davul < vokal, gecis en siki", drums < vocals && toDrums < drums);
  check("esik: sonsuz taban sonsuz kalir (8 GB+)", groupThresholdSec(Infinity, 2, 5) === Infinity);
  const long = (group, duration, nOpen) => subView({
    group, sub: { state: "done", version: 1 }, mobile: true, duration, cached: true,
    thresholdSec: groupThresholdSec(base, nOpen, SUB_GROUPS[group].length), nowSec: NOW,
  });
  check("300 sn: vokal acilir", long("vocals", 300, 0).canExpand);
  check("300 sn: davul ACILMAZ (esik ~262)", !long("drums", 300, 0).canExpand && /Uzun şarkı/.test(long("drums", 300, 0).hint));
  check("250 sn: davul acilir", long("drums", 250, 0).canExpand);
  check("250 sn: vokal aciksa davula gecis ACILMAZ (esik ~221)", !long("drums", 250, 2).canExpand);
  check("200 sn: gecis acilir", long("drums", 200, 2).canExpand);
}

console.log(failed ? `\n${failed} HATA` : "\nhepsi gecti");
process.exit(failed ? 1 : 0);

