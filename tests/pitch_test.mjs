// Perde algılama (frontend/js/pitch.js): YIN doğruluğu, sessizlik / gürültü, parça parça beslemeyle aynı sonuç, zaman damgaları,
// oktav hatasına dayanıklılık, ortanca süzgeç, hız. SENTETİK ses (gerçek ses / mikrofon YOK).
//
//     node tests\pitch_test.mjs

import {
  PITCH_FMIN, PITCH_FMAX, HOP, hzToMidi, midiToHz, nearestNote, noteName, yinDetect, PitchTracker, PitchSmoother,
} from "../frontend/js/pitch.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const cents = (hz, truth) => 1200 * Math.log2(hz / truth);

// deterministik gürültü
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

/** Harmonikli "ses": amplitudes[k] = (k+1). harmoniğin genliği. freqAt(t) ile kayan perde de olur. */
function voice(seconds, rate, freq, amplitudes = [1, 0.7, 0.5, 0.3, 0.2], gain = 0.3, noise = 0) {
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const f = typeof freq === "function" ? freq(i / rate) : freq;
    phase += (2 * Math.PI * f) / rate;
    let v = 0;
    for (let k = 0; k < amplitudes.length; k += 1) v += amplitudes[k] * Math.sin((k + 1) * phase);
    out[i] = gain * v / 2 + noise * rand();
  }
  return out;
}

function run(samples, rate, chunk = 0) {
  const tracker = new PitchTracker(rate);
  const frames = [];
  if (!chunk) frames.push(...tracker.push(samples));
  else for (let i = 0; i < samples.length; i += chunk) frames.push(...tracker.push(samples.subarray(i, Math.min(i + chunk, samples.length))));
  return { frames, tracker };
}

// --- nota yardımcıları
check("hzToMidi / midiToHz: A4 = 69, gidiş-dönüş", near(hzToMidi(440), 69, 1e-9) && near(midiToHz(69), 440, 1e-9) && near(midiToHz(hzToMidi(123.4)), 123.4, 1e-9));
check("nearestNote: sapma cent cinsinden, -50..+50", near(nearestNote(69.3).cents, 30, 1e-9) && nearestNote(69.3).note === 69 && near(nearestNote(68.7).cents, -30, 1e-9));
check("noteName: A4, C4, C#3, negatif güvenli", noteName(69) === "A4" && noteName(60) === "C4" && noteName(49) === "C#3" && noteName(-1) === "B-2");

// --- yinDetect (tek pencere)
{
  const rate = 12000;
  const x = new Float32Array(2000);
  for (let i = 0; i < x.length; i += 1) x[i] = Math.sin((2 * Math.PI * 200 * i) / rate);
  const found = yinDetect(x, 0, 512, 11, 185);
  check("yinDetect: 200 Hz sinüs (12 kHz'de) ±0,5 Hz, netlik > 0,95", found && near(rate / found.tau, 200, 0.5) && found.clarity > 0.95, found ? `${(rate / found.tau).toFixed(2)} Hz` : "null");
  const flat = new Float32Array(2000);
  check("yinDetect: sessizlik -> null", yinDetect(flat, 0, 512, 11, 185) === null || yinDetect(flat, 0, 512, 11, 185).clarity < 0.6);
}

// --- doğruluk: farklı perde ve örnek hızları
for (const rate of [48000, 32000, 44100]) {
  const errors = [];
  let voicedAll = true;
  for (const f0 of [82.41, 110, 196, 261.63, 440, 880]) {
    const { frames } = run(voice(1.2, rate, f0), rate);
    const sesli = frames.filter((frame) => frame.hz);
    if (sesli.length < frames.length * 0.9) voicedAll = false;
    const hz = sesli.map((frame) => frame.hz).sort((a, b) => a - b);
    errors.push(Math.abs(cents(hz[Math.floor(hz.length / 2)], f0)));
  }
  check(`${rate} Hz: 6 perde (82-880 Hz) medyan hata < 8 cent, kareler >%90 sesli`, voicedAll && Math.max(...errors) < 8, errors.map((e) => e.toFixed(1)).join(" / "));
}
{
  const low = run(voice(1.5, 48000, 65.41, [1, 0.9, 0.6, 0.4]), 48000).frames.filter((f) => f.hz);
  const med = low.map((f) => f.hz).sort((a, b) => a - b)[Math.floor(low.length / 2)];
  check("alt sınır: 65,4 Hz (C2) algılanır", low.length > 10 && Math.abs(cents(med, 65.41)) < 15, `${med && med.toFixed(1)} Hz`);
  const high = run(voice(1, 48000, 1000, [1, 0.4]), 48000).frames.filter((f) => f.hz);
  const medHigh = high.map((f) => f.hz).sort((a, b) => a - b)[Math.floor(high.length / 2)];
  check("üst sınır: 1000 Hz algılanır", high.length > 10 && Math.abs(cents(medHigh, 1000)) < 25, `${medHigh && medHigh.toFixed(1)} Hz`);
  check("aralık sabitleri", PITCH_FMIN === 65 && PITCH_FMAX === 1050);
}

// --- oktav hatasına dayanıklılık: temel zayıf, 2. ve 3. harmonik güçlü (ünlü sesler gibi)
{
  const { frames } = run(voice(1.5, 48000, 150, [0.35, 1, 0.8, 0.3, 0.2]), 48000);
  const sesli = frames.filter((f) => f.hz);
  const octaveUp = sesli.filter((f) => Math.abs(cents(f.hz, 300)) < 80).length;
  const right = sesli.filter((f) => Math.abs(cents(f.hz, 150)) < 30).length;
  check("zayıf temelli ses: oktav YUKARI hatası yok (150 Hz doğru, 300 Hz değil)", right > sesli.length * 0.85 && octaveUp === 0, `${right}/${sesli.length} doğru, ${octaveUp} oktav yukarı`);
  const sub = run(voice(1.5, 48000, 220, [1, 0.0, 0.0, 0.9, 0.0, 0.0, 0.8]), 48000).frames.filter((f) => f.hz);
  check("yalnız 3.,6. harmonikler: alt harmonik (oktav aşağı) hatası yok", sub.filter((f) => f.hz < 150).length <= sub.length * 0.1 || sub.length === 0);
}

// --- gürültü ve sessizlik
{
  const silent = run(new Float32Array(48000), 48000).frames;
  check("tam sessizlik: tüm kareler perde YOK, seviye düşük", silent.length > 40 && silent.every((f) => f.hz === null) && silent.every((f) => f.rmsDb < -100));
  const quiet = run(voice(1, 48000, 220, [1, 0.5], 1e-4), 48000).frames;
  check("çok kısık ses (-70 dBFS civarı, kapı altı): perde YOK", quiet.every((f) => f.hz === null));
  const noise = new Float32Array(96000);
  for (let i = 0; i < noise.length; i += 1) noise[i] = 0.2 * rand();
  const noisy = run(noise, 48000).frames;
  check("beyaz gürültü: kareler çoğunlukla perde YOK (<%10 sesli)", noisy.filter((f) => f.hz).length < noisy.length * 0.1, `${noisy.filter((f) => f.hz).length}/${noisy.length}`);
  const snr = run(voice(1.5, 48000, 196, [1, 0.6, 0.4], 0.3, 0.03), 48000).frames.filter((f) => f.hz);
  const within = snr.filter((f) => Math.abs(cents(f.hz, 196)) < 25).length;
  check("gürültülü ses (SNR ~20 dB): çoğu kare 25 cent içinde", snr.length > 40 && within > snr.length * 0.8, `${within}/${snr.length}`);
}

// --- parça parça besleme = tek seferde (worklet 128'lik parçalar)
{
  const samples = voice(1.0, 48000, 330);
  const whole = run(samples, 48000).frames;
  const chunked = run(samples, 48000, 128).frames;
  const odd = run(samples, 48000, 77).frames;
  const same = (a, b) => a.length === b.length && a.every((f, i) => f.hz === b[i].hz && f.centerSample === b[i].centerSample && f.rmsDb === b[i].rmsDb);
  check("128'lik ve 77'lik parçalar tek seferdekiyle BİREBİR aynı", same(whole, chunked) && same(whole, odd), `${whole.length} kare`);
}

// --- zaman damgaları
{
  const { frames, tracker } = run(voice(2, 48000, 220), 48000);
  const steps = frames.slice(1).map((f, i) => f.centerSample - frames[i].centerSample);
  check("kareler arası ham örnek = HOP x indirgeme (21,3 ms)", steps.every((s) => s === HOP * tracker.d), `${steps[0]} örnek = ${(steps[0] / 48 ).toFixed(1)} ms`);
  const first = frames[0].centerSample;
  check("ilk karenin merkezi pencerenin ortasında (~21 ms + süzgeç payı)", first > 700 && first < 2200, String(first));
  check("2 sn'de ~90 kare", frames.length > 80 && frames.length < 100, String(frames.length));
}

// --- kayan perde (glide) takibi
{
  const rate = 48000;
  const f0 = (t) => 200 * 2 ** (t * 0.5);                  // 200 Hz -> 400 Hz / 2 sn
  const { frames } = run(voice(2, rate, f0), rate);
  const errors = frames.filter((f) => f.hz).map((f) => Math.abs(cents(f.hz, f0(f.centerSample / rate))));
  errors.sort((a, b) => a - b);
  check("kayan perde: merkez zamanına göre medyan hata < 15 cent, p90 < 40", errors.length > 60 && errors[Math.floor(errors.length / 2)] < 15 && errors[Math.floor(errors.length * 0.9)] < 40,
    `medyan ${errors[Math.floor(errors.length / 2)].toFixed(1)} p90 ${errors[Math.floor(errors.length * 0.9)].toFixed(1)}`);
}

// --- ortanca süzgeç
{
  const smoother = new PitchSmoother();
  const seq = [220, 220, 220, 440, 220, 220].map((hz) => smoother.push(hz));
  check("tek karelik oktav sıçraması yok sayılır (tutulur)", seq.every((m) => near(m, hzToMidi(220), 0.01)), seq.map((m) => m && m.toFixed(1)).join(","));
  const jump = new PitchSmoother();
  [220, 220, 220].forEach((hz) => jump.push(hz));
  const afterOne = jump.push(440);
  const afterTwo = jump.push(440);
  check("iki karelik sıçrama gerçek nota değişimi sayılır", near(afterOne, hzToMidi(220), 0.01) && near(afterTwo, hzToMidi(440), 0.01));
  const nulls = new PitchSmoother();
  nulls.push(220); nulls.push(220);
  check("tek boş kare tutar (null döner), iki boş kare sıfırlar", nulls.push(null) === null && nulls.last !== null && (nulls.push(null), nulls.last === null));
  const median = new PitchSmoother();
  [220, 223, 217].forEach((hz) => median.push(hz));
  check("küçük titreme ortancaya yakınsar (3'lü)", near(median.last, hzToMidi(220), 0.2));
}

// --- hız (worklet bütçesi): 30 sn ses
{
  const samples = voice(30, 48000, 247);
  const t0 = performance.now();
  const { frames } = run(samples, 48000, 128);
  const ms = performance.now() - t0;
  console.log(`bilgi: 30 sn @48 kHz perde algılama ${ms.toFixed(0)} ms (${(ms / 30).toFixed(2)} ms / sn ses; ${frames.length} kare)`);
  check("hız: saniyede ses başına < 25 ms (masaüstü node)", ms / 30 < 25, `${(ms / 30).toFixed(2)} ms/sn`);
}

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
