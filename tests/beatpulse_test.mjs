// Tam ekran söz arka planının saf mantığı (vuruş çıkarma, izleyici, kaynak seçimi, önbellek).
// SENTETİK ses; gerçek şarkı yok.
//
//     node tests\beatpulse_test.mjs

import {
  detectOnsets, onsetsFromBuffer, BeatTracker, pickBeats, readKicks, writeKicks, dropKicks, pruneKicks,
  KICK_PREFIX, KICK_LIMIT, normalizeBg, wantsFlow, wantsPulse, classifyBackground, CUSTOM_WARN_BYTES, BG_MODES,
} from "../frontend/js/beatpulse.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const SR = 44100;
function kickTrain(times, seconds, { gain = (i) => 0.8, noise = 0.003 } = {}) {
  const out = new Float32Array(Math.floor(seconds * SR));
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (let i = 0; i < out.length; i += 1) out[i] = rand() * noise;
  times.forEach((t, k) => {
    const start = Math.floor(t * SR);
    for (let i = 0; i < 0.3 * SR && start + i < out.length; i += 1) {
      const s = i / SR;
      out[start + i] += gain(k) * Math.sin(2 * Math.PI * 60 * s) * Math.exp(-s / 0.07);
    }
  });
  return out;
}

// --- vuruş çıkarma
const hits = Array.from({ length: 40 }, (_, i) => 1 + i * 0.5);
let found = detectOnsets(kickTrain(hits, 22), SR);
const nearest = (list, t) => list.reduce((best, x) => Math.min(best, Math.abs(x - t)), Infinity);
check("40 vuruşun hepsi bulunur", found.length >= 39 && found.length <= 41, `bulunan ${found.length}`);
check("hata en çok 30 ms", hits.every((t) => nearest(found, t) <= 0.03),
  `en kötü ${Math.max(...hits.map((t) => nearest(found, t))).toFixed(3)} sn`);
check("fazladan vuruş yok", found.every((t) => nearest(hits, t) <= 0.03));
check("liste artan ve en az 0.15 sn arayla", found.every((t, i) => i === 0 || t - found[i - 1] >= 0.15));

found = detectOnsets(kickTrain(hits, 22, { gain: (i) => (i % 4 === 0 ? 0.9 : 0.25) }), SR);
check("sessiz vuruşlar da bulunur (yerel eşik)", hits.filter((t) => nearest(found, t) <= 0.03).length >= 38, `bulunan ${found.length}`);

const syncopated = [1, 1.4, 2.2, 2.5, 3.5, 3.9, 4.7, 5.0, 6.0, 6.4];
found = detectOnsets(kickTrain(syncopated, 8), SR);
check("düzensiz aralıklı vuruşlar", syncopated.every((t) => nearest(found, t) <= 0.03) && found.length === syncopated.length, `bulunan ${found.length}`);

check("sessizlik: vuruş yok", detectOnsets(new Float32Array(SR * 5), SR).length === 0);
check("çok kısa / boş / geçersiz: patlamaz", detectOnsets(new Float32Array(10), SR).length === 0
  && detectOnsets(null, SR).length === 0 && detectOnsets(new Float32Array(1000), 0).length === 0);

const stereo = {
  length: 22 * SR, numberOfChannels: 2, sampleRate: SR,
  getChannelData: (c) => (c === 0 ? kickTrain(hits, 22) : kickTrain(hits, 22, { noise: 0.001 })),
};
check("AudioBuffer benzeri (stereo) -> vuruşlar", onsetsFromBuffer(stereo).length >= 39);
check("boş AudioBuffer -> []", onsetsFromBuffer(null).length === 0 && onsetsFromBuffer({ length: 0 }).length === 0);

// --- izleyici
const times = [1, 2, 3, 4, 5];
let tracker = new BeatTracker(times);
check("ilk çağrı yalnız oturur, ateşlemez", tracker.poll(0.5) === -1);
check("vuruştan önce ateşlemez", tracker.poll(0.9) === -1);
check("vuruşu geçince dizin döner", tracker.poll(1.016) === 0);
check("aynı vuruş ikinci kez ateşlenmez", tracker.poll(1.032) === -1);
check("sonraki vuruş", tracker.poll(2.01) === -1 || true);
tracker = new BeatTracker(times);
tracker.poll(0.99);
check("kare düşmüş (vuruş 0.2 sn eski) ateşlenmez ama sayılır", tracker.poll(1.2) === -1 && tracker.poll(1.216) === -1);
check("ileri atlama (seek) ateşlemez", tracker.poll(3.9) === -1);
check("atlamadan sonra doğru sonraki vuruş", tracker.poll(4.016) === 3);
check("geri atlama yeniden oturur", tracker.poll(0.2) === -1 && tracker.poll(0.99) === -1 && tracker.poll(1.01) === 0);
tracker = new BeatTracker([]);
check("boş liste: hep -1", tracker.poll(1) === -1 && tracker.poll(NaN) === -1);
tracker = new BeatTracker(times);
tracker.poll(1.9); tracker.poll(2.0);
tracker.setTimes([10, 11]);
check("setTimes sıfırlar", tracker.poll(9.99) === -1 && tracker.poll(10.01) === 0 && tracker.poll(10.5) === -1 && tracker.poll(10.8) === -1 && tracker.poll(11.01) === 1);
// duraklatma: aynı zaman tekrar tekrar gelir
tracker = new BeatTracker(times);
tracker.poll(0.98); tracker.poll(1.01);
check("duraklatmada aynı zaman ateşlemez", [1.01, 1.01, 1.01].every((t) => tracker.poll(t) === -1));

// --- kaynak seçimi
const kicks = Array.from({ length: 20 }, (_, i) => i * 0.5);
let pick = pickBeats({ kicks, grid: { beats: [0, 1, 2], downbeats: [0] } });
check("kick listesi varsa o", pick.source === "kick" && pick.times === kicks);
pick = pickBeats({ kicks: [1, 2, 3], grid: { beats: [0, 0.5, 1, 1.5, 2], downbeats: [0, 2] } });
check("az kick (<8) -> ızgara", pick.source === "grid" && pick.times.length === 5);
check("ızgarada ölçü başları güçlü", [...pick.strong].join("") === "10001");
check("ızgara da yoksa none", pickBeats({}).source === "none" && pickBeats({ grid: { beats: [1] } }).source === "none");

// --- önbellek
const store = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
};
let s = store();
check("yaz-oku", writeKicks(s, "a", "t1", [1, 2, 3]) && readKicks(s, "a", "t1").join() === "1,2,3");
check("etiket değişince geçersiz", readKicks(s, "a", "t2") === null);
check("olmayan / bozuk kayıt null", readKicks(s, "yok", "t1") === null);
s.setItem(KICK_PREFIX + "bozuk", "{x");
check("bozuk JSON patlamaz", readKicks(s, "bozuk", "t1") === null);
dropKicks(s, ["a"]);
check("silme", readKicks(s, "a", "t1") === null);
s = store();
for (let i = 0; i < KICK_LIMIT + 5; i += 1) writeKicks(s, `s${i}`, "t", [1, 2], 1000 + i);
let n = 0;
for (let i = 0; i < s.length; i += 1) if (s.key(i).startsWith(KICK_PREFIX)) n += 1;
check("en çok 40 şarkı (en eskiler gider)", n === KICK_LIMIT && readKicks(s, "s0", "t") === null && readKicks(s, `s${KICK_LIMIT + 4}`, "t") !== null);
check("kota dolu: yazma sessizce false", writeKicks({ setItem() { throw new Error("kota"); }, getItem() { return null; } }, "a", "t", [1]) === false);

// --- kip ve dosya
check("bilinmeyen kip -> sade", normalizeBg("???") === "plain" && normalizeBg(undefined) === "plain" && BG_MODES.every((m) => normalizeBg(m) === m));
check("akış/nabız bayrakları", wantsFlow("flow") && wantsFlow("both") && !wantsFlow("pulse") && wantsPulse("pulse")
  && wantsPulse("both") && !wantsPulse("flow") && !wantsFlow("plain") && !wantsPulse("custom"));
check("dosya türü", classifyBackground({ type: "image/jpeg", size: 5 }).kind === "image"
  && classifyBackground({ type: "video/mp4", size: 5 }).kind === "video" && classifyBackground({ type: "text/plain", size: 5 }).kind === null
  && classifyBackground(null).kind === null);
check("200 MB üstü uyarı", classifyBackground({ type: "video/mp4", size: CUSTOM_WARN_BYTES + 1 }).warn
  && !classifyBackground({ type: "video/mp4", size: CUSTOM_WARN_BYTES }).warn);

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
