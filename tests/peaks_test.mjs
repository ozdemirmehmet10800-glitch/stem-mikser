// Dalga şeritleri için tepe verisi (frontend/js/peaks.js): niceleme, artımlı hesap, karışım zarfı, ölçek, önbellek biçimi.
// SENTETİK sinyal (gerçek ses yok).
//
//     node tests\peaks_test.mjs

import {
  PEAK_RATE, expectedBins, quantize, linear, PeakJob, PeakSet, mixLinear, heightsOf, overviewHeights, laneHeights, encodePeaks, decodePeaks, channelsOf,
} from "../frontend/js/peaks.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- kutu sayısı / niceleme
check("expectedBins: süre x 20, yukarı yuvarlanır; geçersiz 0", expectedBins(10) === 200 && expectedBins(10.01) === 201 && expectedBins(0) === 0 && expectedBins(NaN) === 0 && expectedBins(-3) === 0);
check("quantize: 0 -> 0, 1 -> 255, 1'den büyük kırpılır, negatif/NaN 0", quantize(0) === 0 && quantize(1) === 255 && quantize(3) === 255 && quantize(-1) === 0 && quantize(NaN) === 0);
check("karekök sıkıştırma: 0,0001 (-80 dB) bile 0'dan ayrışır; geri çevirme yaklaşık", quantize(0.0001) >= 2 && near(linear(quantize(0.25)), 0.25, 0.01) && near(linear(255), 1));

// --- artımlı hesap
const RATE = 1000;                           // 1000 örnek/sn -> kutu = 50 örnek
const signal = (seconds) => new Float32Array(RATE * seconds);
const mono = signal(2);                      // 40 kutu
mono[10] = 0.5;                              // kutu 0
mono[75] = -1;                               // kutu 1 (negatif tepe de sayılır)
mono[1999] = 0.25;                           // son kutu (39)
let job = new PeakJob([mono], RATE, expectedBins(2));
while (!job.step(1000)) { /* tek seferde biter */ }
check("tepe kutuya doğru düşer: |örnek| en büyüğü, negatif dahil", job.out[0] === quantize(0.5) && job.out[1] === 255 && job.out[39] === quantize(0.25) && job.out[2] === 0);
const stereo = [signal(2), signal(2)];
stereo[0][10] = 0.2; stereo[1][12] = 0.9;
job = new PeakJob(stereo, RATE, expectedBins(2));
job.step(1000);
check("stereo: kanalların en büyüğü", job.out[0] === quantize(0.9));

// bütçeli adımlar: sahte saat her çağrıda 1 ms ilerler; sonuç tek seferdekiyle AYNI olmalı
const long = signal(30);
for (let i = 0; i < long.length; i += 37) long[i] = Math.sin(i) * 0.7;
const whole = new PeakJob([long], RATE, expectedBins(30));
whole.step(1e9);
let ticks = 0;
const fakeNow = () => (ticks += 1);
const sliced = new PeakJob([long], RATE, expectedBins(30));
let steps = 0;
while (!sliced.step(2, fakeNow)) steps += 1;
check("dilimli hesap tek seferdekiyle birebir aynı sonucu verir", Buffer.compare(Buffer.from(whole.out), Buffer.from(sliced.out)) === 0);
check("dilimli hesap gerçekten parçalandı (birden çok adım) ve ilerleme 1'e ulaştı", steps > 3 && sliced.progress === 1 && sliced.done && sliced.slices === steps + 1);
check("bitmiş işte step yeniden çağrılabilir, bozmaz", sliced.step(1) === true && Buffer.compare(Buffer.from(whole.out), Buffer.from(sliced.out)) === 0);

// kesirli örnek/kutu (22050 / 20 = 1102,5): hiçbir örnek kaçmaz, tek kutuya düşer
const odd = new Float32Array(22050 * 2);
let allCovered = true;
for (const index of [0, 1101, 1102, 1103, 2204, 2205, 22049, 44099]) {
  odd.fill(0);
  odd[index] = 1;
  const j = new PeakJob([odd], 22050, expectedBins(2));
  j.step(1e9);
  const hit = [...j.out].map((v, b) => (v ? b : -1)).filter((b) => b >= 0);
  if (hit.length !== 1) allCovered = false;
}
check("kesirli kutu sınırlarında her örnek tam bir kutuya girer (kaçak / çift sayım yok)", allCovered);
const nan = new Float32Array(200);
nan[3] = NaN; nan[60] = 0.5;
const jn = new PeakJob([nan], RATE, expectedBins(0.2));
jn.step(1e9);
check("NaN örnek yok sayılır, hesap bozulmaz", jn.out[0] === 0 && jn.out[1] === quantize(0.5));
const short = new PeakJob([new Float32Array(100)], RATE, 10);
short.step(1e9);
check("tampon bitişten kısaysa kalan kutular 0 (taşma yok)", short.done && short.out[9] === 0);

// --- karışım zarfı ve ölçek
const set = new PeakSet(4);
set.set("a", Uint8Array.from([quantize(0.5), quantize(0.5), 0, quantize(0.1)]));
set.set("b", Uint8Array.from([quantize(0.5), 0, quantize(1), quantize(0.1)]));
const unity = mixLinear(set, [{ name: "a", gain: 1 }, { name: "b", gain: 1 }]);
check("karışım: bağımsız kaynaklarda güç toplanır (0,5 ve 0,5 -> 0,707)", near(unity[0], Math.SQRT1_2, 0.01) && near(unity[1], 0.5, 0.01) && near(unity[2], 1, 0.01));
const muted = mixLinear(set, [{ name: "a", gain: 0 }, { name: "b", gain: 1 }]);
check("kazancı 0 olan (susturulmuş / solo dışı) kanal karışıma girmez", near(muted[0], 0.5, 0.01) && near(muted[1], 0, 0.01));
const half = mixLinear(set, [{ name: "a", gain: 0.5 }]);
check("fader kazancı zarfı ölçekler", near(half[0], 0.25, 0.01));
check("bilinmeyen kanal / kazanç NaN atlanır", mixLinear(set, [{ name: "yok", gain: 1 }, { name: "a", gain: NaN }]).every((v) => v === 0));
set.fixReferences(["a", "b"]);
check("referanslar: karışım tepesi ~1 (kutu 2), kanal tepesi 1", near(set.mixRef, 1, 0.01) && near(set.laneRef, 1, 0.01));
const full = overviewHeights(set, [{ name: "a", gain: 1 }, { name: "b", gain: 1 }]);
const onlyA = overviewHeights(set, [{ name: "a", gain: 1 }]);
check("genel şerit: kanal kapatılınca yükseklik DÜŞER (ölçek sabit, yeniden normalleşmez)", full[2] > onlyA[2] && onlyA[2] === 0 && onlyA[0] < full[0]);
check("yükseklikler 0..1 aralığında", [...full, ...onlyA].every((v) => v >= 0 && v <= 1));
check("kanal şeridi: ortak ölçek, bilinmeyen kanal null", laneHeights(set, "a")[0] > 0 && laneHeights(set, "yok") === null && laneHeights(set, "b")[2] === 1);
check("heightsOf: ref 0 ise hepsi 0 (bölme yok)", heightsOf(Float32Array.from([0.3]), 0)[0] === 0);

// --- önbellek biçimi
set.mixRef = 0.8; set.laneRef = 0.9;
const buf = encodePeaks(set, "1790000000.hifi_v2");
const back = decodePeaks(buf);
check("kodlama gidiş-dönüş: kutu, hız, kanal adları, veri, ölçekler", back && back.bins === 4 && back.rate === PEAK_RATE && back.names().join() === "a,b"
  && Buffer.compare(Buffer.from(back.data.get("b")), Buffer.from(set.data.get("b"))) === 0 && back.mixRef === 0.8 && back.laneRef === 0.9);
check("küçük dosya: 8 bayt + başlık + kanal x kutu", buf.byteLength > 8 + 2 * 4 && buf.byteLength < 400);
const bytes = new Uint8Array(buf);
check("kesik dosya reddedilir", decodePeaks(buf.slice(0, buf.byteLength - 1)) === null && decodePeaks(buf.slice(0, 5)) === null);
const bad = bytes.slice(); bad[0] = 0x58;
check("sihirli bayt yanlışsa reddedilir", decodePeaks(bad.buffer) === null);
const trailing = new Uint8Array(buf.byteLength + 3); trailing.set(bytes);
check("fazla bayt (bozuk uzunluk) reddedilir", decodePeaks(trailing.buffer) === null);
const hdr = new TextDecoder().decode(bytes.subarray(8, 8 + new DataView(buf).getUint32(4, true)));
const other = new TextEncoder().encode(hdr.replace('"v":1', '"v":2'));
const wrongVersion = new Uint8Array(8 + other.length + 8); wrongVersion.set(bytes.subarray(0, 4)); new DataView(wrongVersion.buffer).setUint32(4, other.length, true); wrongVersion.set(other, 8);
check("sürüm farkı reddedilir (ileride biçim değişirse eski dosya yeniden hesaplanır)", decodePeaks(wrongVersion.buffer) === null);
check("rastgele / boş girdi patlamaz", decodePeaks(new ArrayBuffer(0)) === null && decodePeaks(null) === null && decodePeaks("x") === null);

// --- AudioBuffer benzeri
const fakeBuffer = { numberOfChannels: 2, getChannelData: (i) => (i === 0 ? mono : stereo[1]) };
check("channelsOf: kanalları kopyalamadan verir", channelsOf(fakeBuffer).length === 2 && channelsOf(fakeBuffer)[0] === mono);

// --- ölçek: 4 dk x 6 stem (48 kHz mono): süre ve boyut sağlaması
{
  const data = new Float32Array(48000 * 240);
  for (let i = 0; i < data.length; i += 997) data[i] = 0.5;
  const t0 = performance.now();
  const total = new PeakSet(expectedBins(240));
  let maxSlice = 0;
  for (let s = 0; s < 6; s += 1) {
    const j = new PeakJob([data], 48000, total.bins);
    while (!j.step(4)) { /* dilimler */ }
    maxSlice = Math.max(maxSlice, j.maxSliceMs);
    total.set(`s${s}`, j.out);
  }
  const size = encodePeaks(total).byteLength;
  console.log(`bilgi: 4 dk x 6 stem hesap ${Math.round(performance.now() - t0)} ms, en uzun dilim ${maxSlice.toFixed(1)} ms, önbellek dosyası ${size} bayt`);
  check("4 dk x 6 stem dosyası 30 KB civarı", size > 25000 && size < 35000, String(size));
  check("hiçbir dilim bütçeyi (4 ms) çok aşmaz (masaüstü, <12 ms)", maxSlice < 12, maxSlice.toFixed(1));
}

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
