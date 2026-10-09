// Mikrofon GİZLİLİĞİ (Mikrofon paketi 9): kaynak taranarak güvence altında. Mikrofon sesi hiçbir koşulda diske, loga ya da sunucuya gitmez.
// Kurallar: kayıt (MediaRecorder), ağ (fetch / sendBeacon / XHR / WebSocket / WebRTC), depolama (localStorage / IndexedDB / Cache Storage), log (console / diag),
// dosya (Blob / FileReader / createObjectURL) mikrofon kodunda YOK; ses örnekleri yalnız perde işlemcisine girer ve ondan yalnız 4 SAYI çıkar
// ({t, hz, clarity, rmsDb}); kullanıcı tercihleri dışında hiçbir şey saklanmaz.
//
//     node tests\mic_privacy_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const FORBIDDEN = [
  ["MediaRecorder", /MediaRecorder/], ["fetch", /\bfetch\s*\(/], ["sendBeacon", /sendBeacon/], ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket", /WebSocket/], ["RTCPeerConnection", /RTCPeerConnection/], ["localStorage", /localStorage/], ["sessionStorage", /sessionStorage/],
  ["indexedDB", /indexedDB/], ["Cache Storage", /\bcaches\s*\./], ["console", /console\./], ["diag", /\bdiag\./],
  ["createMediaStreamDestination", /createMediaStreamDestination/], ["captureStream", /captureStream/],
  ["Blob / dosya", /\bnew Blob\b|createObjectURL|FileReader|\bnew File\b/],
  ["ham örnek okuma (AnalyserNode / getChannelData)", /createAnalyser|getFloatTimeDomainData|getByteTimeDomainData|getChannelData|ScriptProcessor/],
];

const micFiles = { "pitch.js": "../frontend/js/pitch.js", "pitch-processor.js": "../frontend/js/pitch-processor.js", "mic.js": "../frontend/js/mic.js", "melody.js": "../frontend/js/melody.js" };
const sources = Object.fromEntries(Object.entries(micFiles).map(([name, path]) => [name, strip(read(path))]));
for (const [file, code] of Object.entries(sources)) {
  for (const [name, pattern] of FORBIDDEN) check(`${file}: ${name} YOK`, !pattern.test(code));
}

// --- perde işlemcisi: ana iş parçacığına yalnız dört sayı
const processor = sources["pitch-processor.js"];
const posts = [...processor.matchAll(/postMessage\(([\s\S]*?)\);/g)];
check("işlemci tam BİR postMessage çağrısı yapar", posts.length === 1);
const payload = posts.length ? posts[0][1] : "";
const keys = [...payload.matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort().join();
check("postMessage yükü yalnız {t, hz, clarity, rmsDb}", keys === "clarity,hz,rmsDb,t", keys);
check("yükte dizi / tampon / örnek referansı yok (channel, inputs, buffer, samples, Float32Array, slice, subarray)", !/channel|inputs|buffer|samples|Float32Array|slice|subarray|\[/.test(payload), payload.replace(/\s+/g, " "));
check("işlemci örnekleri yalnız tracker.push'a verir (başka bir yere aktarmaz)", (processor.match(/\bchannel\b/g) || []).length === 4 && /this\.tracker\.push\(channel\)/.test(processor));
check("işlemcinin çıkışı yok (sessiz): outputs / çıkış yazılmaz", !/outputs/.test(processor));
check("PitchTracker örnekleri yalnız kendi iç tamponunda tutar; dışarı yalnız sayı döner", /return \{ hz: null, clarity: 0, rmsDb, centerSample \}/.test(sources["pitch.js"]) && /return \{ hz: this\.rate \/ found\.tau, clarity: found\.clarity, rmsDb, centerSample \}/.test(sources["pitch.js"]));

// --- mic.js: getUserMedia yalnız iki yerde, doğru kısıtlarla
const micCode = sources["mic.js"];
check("mic.js: getUserMedia tam İKİ çağrı (izin adımı + exact deviceId)", (micCode.match(/getUserMedia\(/g) || []).length === 2);
check("mic.js: izin adımı yalnız requestPermission içinde ve {audio: true}", /async requestPermission\(\)[\s\S]*?getUserMedia\(\{ audio: true \}\)/.test(micCode));
check("mic.js: başlatma constraintsFor(device.id) ile (exact deviceId + işleme kapalı)", /getUserMedia\(constraintsFor\(device\.id\)\)/.test(micCode));
check("mic.js: varsayılan / communications / Bluetooth aygıt start'ta reddedilir", /device\.id === "default"/.test(micCode) && /device\.id === "communications"/.test(micCode) && /isBluetoothLabel\(device\.label\)/.test(micCode));
check("mic.js: mesaj işleyicisi alanları tek tek SAYI olarak süzer (ham veri geçemez)", /typeof data\.t !== "number"/.test(micCode) && /typeof data\.hz === "number"/.test(micCode) && /typeof data\.clarity === "number"/.test(micCode) && /typeof data\.rmsDb === "number"/.test(micCode));

// --- app.js antrenör bölümü
const app = read("../frontend/js/app.js");
const region = strip(app.slice(app.indexOf("// TRAINER-BAŞLANGIÇ"), app.indexOf("// TRAINER-BİTİŞ")));
check("antrenör bölümü işaretli ve boş değil", region.length > 2000);
for (const [name, pattern] of FORBIDDEN.filter(([name]) => !["localStorage", "console"].includes(name))) {
  check(`antrenör bölümünde ${name} YOK`, !pattern.test(region));
}
check("antrenör bölümünde console / diag yok", !/console\.|\bdiag\./.test(region));
const storageLines = region.split("\n").filter((line) => /localStorage/.test(line));
check("localStorage yalnız antrenör TERCİHLERİ için (TRAINER_PREFS_KEY), başka anahtar yok", storageLines.length === 2 && storageLines.every((line) => /TRAINER_PREFS_KEY/.test(line)), storageLines.join(" | "));
check("saklanan tek şey { octave, latencyMs }", /JSON\.stringify\(\{ octave: trainer\.octave, latencyMs: trainer\.latencyTouched \? trainer\.latencyMs : undefined \}\)/.test(region));
const apiCalls = [...new Set([...region.matchAll(/\bapi\.(\w+)/g)].map((m) => m[1]))].sort().join();
check("ağ çağrıları yalnız getMelody / startMelody / getSong (mikrofon verisi taşıyan çağrı yok)", apiCalls === "getMelody,getSong,startMelody", apiCalls);
check("mikrofon yalnız hazırlanan DAHİLİ aygıtla açılır (trainerMic.start(..., prepared.device))", /trainerMic\.start\(engine\.ctx, onTrainerFrame, prepared\.device\)/.test(region)
  && (region.match(/trainerMic\.start\(/g) || []).length === 1);
check("kareler yalnız onTrainerFrame'e gider; kare nesnesi başka yere yazılmaz / gönderilmez", !/JSON\.stringify\(frame|\.push\(frame\)|log\(frame/.test(region) && /trainer\.collect\.push\(frame\.rmsDb\)/.test(region));
check("sayfa gizlenince mikrofon kapanır; panel kapanınca ve şarkı değişince de", /visibilitychange[\s\S]{0,160}stopTrainerMic/.test(region) && /function closeTrainer\(\) \{\s*stopTrainerMic\(\)/.test(region) && /function trainerReset\(\) \{\s*stopTrainerMic\(\)/.test(region));
check("mikrofon yalnız kullanıcı düğmesiyle başlar (açılışta / otomatik başlatma yok)", /on\("trainer-mic", "click"/.test(region) && (region.match(/startTrainerMic\(\)/g) || []).length === 3);
check("ses bağlamı değişirse mikrofon durdurulur", /trainerMic\.ctx !== engine\.ctx[\s\S]{0,80}stopTrainerMic/.test(region));

// --- ön yüzün geri kalanında mikrofon kodu yok (yalnız mic.js üzerinden)
const others = ["engine.js", "api.js", "lyrics.js", "peaks.js", "chordsheet.js", "timeline.js", "stemcache.js", "media.js"];
check("getUserMedia yalnız mic.js (ve bench denemesi) içinde", others.every((file) => !/getUserMedia/.test(read(`../frontend/js/${file}`))) && !/getUserMedia/.test(strip(app)));
check("sunucu API istemcisinde mikrofon verisi gönderen yöntem yok (yalnız startMelody / getMelody)", (() => {
  const api = strip(read("../frontend/js/api.js"));
  return /async startMelody\(/.test(api) && /async getMelody\(/.test(api) && !/mic|pitch|hz\b/i.test(api.slice(api.indexOf("async startMelody"), api.indexOf("async setLyricTimes")).replace(/Mikrofon/g, ""));
})());

// --- service worker kabuğu
const sw = strip(read("../frontend/sw.js"));
for (const file of ["pitch.js", "pitch-processor.js", "mic.js", "melody.js", "melodycache.js"]) check(`sw.js kabuğunda js/${file} var`, sw.includes(`./js/${file}`));
check("SW sürümü >= 58", Number((sw.match(/const VERSION = "v(\d+)"/) || [])[1]) >= 58);

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
