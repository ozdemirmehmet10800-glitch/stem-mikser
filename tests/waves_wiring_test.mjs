// Dalga şeritleri: app.js bağlantısının KURALLARI kaynak taranarak güvence altında (DOM'suz test edilemeyen kısım):
//  1) tepe hesabı şarkı açılışını / liste geçişini uzatmaz: openSong onu BEKLEMEZ (await yok), gecikmeli ve dilimli başlar;
//  2) canvas kare başına çizilmez: rAF döngüsünde yalnız transform'lu çalma tonu (wavePlayed) vardır;
//  3) yeni modüller service worker kabuk listesinde; sürüm artmış;
//  4) kanal şeridi ve genel şerit yeni zaman ekseni bileşenini kullanır (7. ve 8. madde bu katmanlara oturacak).
//
//     node tests\waves_wiring_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const app = strip(read("../frontend/js/app.js"));
const sw = strip(read("../frontend/sw.js"));
const css = strip(read("../frontend/css/styles.css"));

const between = (text, from, to) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  return a >= 0 && b > a ? text.slice(a, b) : "";
};

// 1) açılışı uzatmama
const open = between(app, "async function openSong(", "function buildSubdivisionButtons");
check("openSong dalgayı BEKLEMEZ: schedulePeaks çağrısında await yok", /(^|[^\w])schedulePeaks\(song\.id, cacheKeyTag\)/.test(open) && !/await\s+schedulePeaks/.test(open));
check("dalga açılış BİTTİKTEN sonra planlanır (timer.done'dan sonra)", open.indexOf("schedulePeaks(") > open.indexOf('timer.done(cachedOk'));
const schedule = between(app, "function schedulePeaks(", "function mainChannelNames");
check("hesap setTimeout ile gecikmeli başlar", /setTimeout\([\s\S]*PEAK_START_DELAY_MS/.test(schedule));
const delay = Number((app.match(/const PEAK_START_DELAY_MS = (\d+)/) || [])[1]);
const slice = Number((app.match(/const PEAK_SLICE_MS = (\d+)/) || [])[1]);
check("başlangıç gecikmesi >= 250 ms (açılış / çalma başlangıcıyla yarışmaz)", delay >= 250, String(delay));
check("dilim bütçesi <= 8 ms (kare süresinin yarısını aşmaz)", slice > 0 && slice <= 8, String(slice));
const fill = between(app, "async function fillPeaks(", "function queueSubPeaks");
check("hesap dilimler arasında denetimi tarayıcıya bırakır (await nextSlice)", /job\.step\(PEAK_SLICE_MS\)[\s\S]*await nextSlice\(\)/.test(fill));
check("şarkı / kanal değişince hesap kendiliğinden vazgeçer (nesil + tampon denetimi)", /gen !== peakGen/.test(fill) && /live\.buffer !== buffer/.test(fill));
check("sonuç cihaz önbelleğine yazılır, önbellekte varsa hesaplanmaz", /peaksCache\.put\(/.test(app) && /peaksCache\.get\(/.test(app) && /peakSet\.has\(name\)\) continue/.test(fill));
check("silinen şarkıların ve 'çevrimdışı kopyaları sil'in dalga verisi de temizlenir", /peaksCache\.removeSongs\(gone\)/.test(app) && /peaksCache\.clear\(\)/.test(app));

// 2) kare başına çizim yok
const loop = between(app, "function startLoop()", "function handleSongEnded");
check("rAF döngüsünde çalma tonu var", /wavePlayed\(time\)/.test(loop));
check("rAF döngüsünde canvas çizimi / yeniden hesap YOK", !/setHeights|\.draw\(|refreshOverview|drawWaveLanes|overviewHeights|laneHeights/.test(loop));
const played = between(read("../frontend/js/timeline.js"), "setPlayed(t) {", "#relayout");
check("çalma tonu yalnız transform yazar (canvas'a dokunmaz)", /style\.transform/.test(played) && !/draw\(|getContext/.test(played));
const refresh = between(app, "function scheduleOverview()", "function wavePlayed");
check("mikser değişimi çizimi birleştirir (tek karede bir kez)", /if \(overviewQueued\) return/.test(refresh) && /queueFrame\(/.test(refresh));

// 3) kabuk ve sürüm
for (const file of ["peaks.js", "peakscache.js", "timeline.js"]) {
  check(`sw.js kabuğunda js/${file} var`, sw.includes(`./js/${file}`));
}
const version = Number((sw.match(/const VERSION = "v(\d+)"/) || [])[1]);
check("SW sürümü >= 57", version >= 57, String(version));

// 4) katmanlı zaman ekseni kullanılıyor
check("genel şerit ve kanal şeritleri Timeline bileşeni", /const overview = new Timeline\(/.test(app) && /new Timeline\(\{ root: lane/.test(app));
check("Dalga düğmesi varsayılan kapalı (tercih yoksa)", /function readWavesPref\(\) \{\s*try \{ return localStorage\.getItem\(WAVES_KEY\) === "1"/.test(app));
check("kanal şeritleri yalnız 'waves' sınıfıyla görünür (CSS)", /\.channel \.lane \{ display: none;/.test(css) && /\.channels\.waves \.channel \.lane \{ display: block; \}/.test(css));
check("seek girişi dalganın ÜSTÜNDE ve işaretçi katmanının altında (z-index sırası)", /\.seek-wrap \.seek \{[^}]*z-index: 5/.test(css) && /\.loop-handle \{[\s\S]*?z-index: 9/.test(css));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
