// "Şarkı söyleme" paneli açıkken oynat / duraklat ERİŞİLEBİLİR kalmalı (telefon hatası, SW v59: panel yüksekti, alt çubuk ekran dışına itildi,
// kullanıcı çalmayı başlatamadı). Node'da gerçek yerleşim yok; bu test kaynaktaki KURALLARI sabitler. Gerçek ölçüm tarayıcı panelinde
// (375x812, panel açık: oynat düğmesi 738-794 px, ekran içinde) PLAN.md'de kayıtlı.
//
//     node tests\trainer_layout_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const css = read("../frontend/css/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const html = read("../frontend/index.html");
const appRaw = read("../frontend/js/app.js");
const app = strip(appRaw);
const region = strip(appRaw.slice(appRaw.indexOf("// TRAINER-BAŞLANGIÇ"), appRaw.indexOf("// TRAINER-BİTİŞ")));

function rulesFor(selector) {
  const out = [];
  for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (match[1].split(",").map((s) => s.trim()).includes(selector)) out.push(match[2]);
  }
  return out.join(";");
}

// --- panel oynatıcı sütununa SIĞAR ve kendi içinde kayar (alt çubuğu itmez)
const trainerCss = rulesFor(".trainer");
check("panel: flex ile küçülebilir (flex: 0 1 auto) ve min-height: 0", /flex:\s*0 1 auto/.test(trainerCss) && /min-height:\s*0/.test(trainerCss), trainerCss.replace(/\s+/g, " ").slice(0, 160));
check("panel: kendi içinde kayar (overflow-y: auto)", /overflow-y:\s*auto/.test(trainerCss));
check("oynatıcı sütunu sabit yükseklikte flex sütunu (alt çubuk dışarı itilmesin diye kanallar kayar)", /\.view\s*\{[^}]*height:\s*100%[^}]*flex-direction:\s*column/.test(css.replace(/\s+/g, " ")) && /\.channels\s*\{[^}]*overflow-y:\s*auto/.test(css.replace(/\s+/g, " ")));
for (const cls of [".chordstrip", ".lyrics", ".mix-bar", ".channels", ".loop-bar"]) {
  check(`panel açıkken ${cls} gizlenir (yer panele ayrılır)`, new RegExp(`#view-player\\.trainer-on ${cls.replace(".", "\\.")}[,\\s{]`).test(css) || css.includes(`#view-player.trainer-on ${cls}`));
}
check("panel açıkken alt çubuk (.transport) GİZLENMEZ", !/trainer-on[^{]*\.transport/.test(css));
check("başlık yapışkan: panel kayarken oynat / kapat düğmeleri görünür", /\.trainer-head\s*\{[^}]*position:\s*sticky/.test(css.replace(/\s+/g, " ")));

// --- panel içi oynat / duraklat
const head = html.slice(html.indexOf('<div class="trainer-head">'), html.indexOf("</div>", html.indexOf('<div class="trainer-head">')));
check("panel başlığında oynat düğmesi (#tr-play) ve kapat var", /id="tr-play"/.test(head) && /id="trainer-close"/.test(head));
check("#tr-play, ana düğmeyle AYNI işleve bağlı (togglePlayback)", /on\("tr-play", "click", togglePlayback\)/.test(app) && /on\("play", "click", togglePlayback\)/.test(app));
check("oynatma durumu değişince (setPlayIcon) panel düğmesi de güncellenir", /function setPlayIcon\([\s\S]*?paintTrainerPlay\(playing\)/.test(app));
check("panel açılınca / kapanınca / şarkı değişince trainer-on sınıfı eklenir / kalkar", /function openTrainer\(\) \{[\s\S]*?classList\.add\("trainer-on"\)/.test(region) && /function closeTrainer\(\) \{[\s\S]*?classList\.remove\("trainer-on"\)/.test(region) && /function trainerReset\(\) \{[\s\S]*?classList\.remove\("trainer-on"\)/.test(region));

// --- mikrofon açmak / kalibrasyon çalmayı BAŞLATMAZ, DURDURMAZ, engellemez
const startFn = region.slice(region.indexOf("async function startTrainerMic()"), region.indexOf("function stopTrainerMic("));
check("startTrainerMic çalmayı durdurmaz / başlatmaz (stopPlayback, startPlayback, engine.play/pause YOK)", !/stopPlayback|startPlayback|engine\.(play|pause)\(/.test(startFn));
const calibFns = region.slice(region.indexOf("function beginTrainerCalibration()"), region.indexOf("function handleGateEvent"));
check("kalibrasyon çalmayı durdurmaz / başlatmaz", !/stopPlayback|startPlayback|engine\.(play|pause)\(|\.suspend\(|\.close\(/.test(calibFns));
check("mikrofon açıkken çalma başlamazsa (2,5 sn) nedeni (ses bağlamı durumu) panelde söylenir", /function watchTrainerPlayStart\(\)[\s\S]*?ses bağlamı: \$\{engine\.ctx \? engine\.ctx\.state/.test(region) && /watchTrainerPlayStart\(\);\s*await engine\.play\(\)/.test(app));

// --- kalibrasyon durumu belirgin
check("ölçüm sürerken geri sayım, bitince 'Ölçüm bitti ✓' yazısı", /Ortam ölçülüyor… \$\{left\} sn sessiz kal/.test(region) && /Ölçüm bitti ✓ · şarkıyı başlat \(▶ Çal\) ve söyle/.test(region) && /Ölçüm bitti ✓ · söyle!/.test(region));
check("durum şeridi (#tr-state) panelde, rol=status", /id="tr-state"[^>]*role="status"/.test(html));
check("ölçüm bitince durum şeridi güncellenir (finishTrainerCalibration -> paintTrainerState)", /function finishTrainerCalibration\(\)[\s\S]*?paintTrainerState\(\)/.test(region));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
