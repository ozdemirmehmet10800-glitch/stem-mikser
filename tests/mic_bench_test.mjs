// Mikrofon denemesi (bench.html "0c", Mikrofon paketi 0. adım): GİZLİLİK kuralları kaynak taranarak güvence altında.
// Mikrofon sesi hiçbir koşulda kaydedilmez, saklanmaz, gönderilmez, loga yazılmaz; yalnız anlık seviye çubuğu gösterilir.
// (Bu test ileride antrenör mikrofon modüllerine de uygulanacak ayrı bir tarama testine temel olur.)
//
//     node tests\mic_bench_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const js = readFileSync(new URL("../frontend/js/bench.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../frontend/bench.html", import.meta.url), "utf8");
const start = js.indexOf("// MIC-BAŞLANGIÇ");
const end = js.indexOf("// MIC-BİTİŞ");
check("mikrofon bölümü işaretli", start > 0 && end > start);
const region = js.slice(start, end);
const code = region.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");     // yorumlar sayılmasın

// --- yasaklı API'ler: kayıt / depolama / ağ / ek işleme
const forbidden = [
  ["MediaRecorder", /MediaRecorder/], ["fetch", /\bfetch\s*\(/], ["sendBeacon", /sendBeacon/], ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket", /WebSocket/], ["RTCPeerConnection", /RTCPeerConnection/], ["localStorage", /localStorage/], ["sessionStorage", /sessionStorage/],
  ["indexedDB", /indexedDB/], ["Cache Storage", /\bcaches\s*\./], ["ScriptProcessor", /ScriptProcessor/], ["AudioWorkletNode", /AudioWorkletNode/],
  ["createMediaStreamDestination", /createMediaStreamDestination/], ["captureStream", /captureStream/], ["postMessage", /postMessage/],
  ["Blob / dosya", /\bnew Blob\b|createObjectURL|FileReader|\bnew File\b/],
];
for (const [name, pattern] of forbidden) check(`mikrofon kodunda ${name} YOK`, !pattern.test(code));

// --- örnekler yalnız seviye için okunur, tek yerde, hiçbir yere aktarılmaz
const reads = code.match(/getFloatTimeDomainData|getByteTimeDomainData|getChannelData/g) || [];
const musicReads = (code.match(/noise\.getChannelData\(0\)/g) || []).length;       // sentetik "hi-hat" gürültüsü (mikrofon DEĞİL)
check("mikrofon örneği yalnız bir yerde okunur (getFloatTimeDomainData, seviye çubuğu)", reads.length - musicReads === 1 && /getFloatTimeDomainData/.test(code), String(reads));
const meter = code.slice(code.indexOf("function micMeterStart"), code.indexOf("async function micOpen"));
check("seviye döngüsünde örnek dizisi (buffer) yalnız okunur ve toplanır: log/say/push/set/slice/from yok",
  meter.length > 0 && !meter.split("\n").some((line) => /\bbuffer\b/.test(line) && /log\(|say\(|console|\.push\(|\.set\(|\.slice\(|Array\.from|JSON\./.test(line)));
check("log / say çağrılarına ses değeri (buffer, rms, db, seviye) GİRMEZ", !code.split("\n").some((line) => /\b(log|say)\(/.test(line) && /\b(buffer|rms|sum|db|fraction|level)\b/i.test(line.replace(/mic-level/g, ""))));
check("console çağrısı yok (mikrofon bölümünde)", !/console\./.test(code));
check("analizör sessiz yoldan hedefe bağlanır (kazanç 0): hoparlöre mikrofon sesi gitmez", /sink\.gain\.value = 0/.test(code) && /analyser\.connect\(mic\.sink\)/.test(code));

// --- kısıtlar ve yaşam döngüsü
const audio = (code.match(/const MIC_AUDIO = \{([^}]*)\}/) || [])[1] || "";
check("kısıtlar: echoCancellation / noiseSuppression / autoGainControl KAPALI, tek kanal",
  /echoCancellation: false/.test(audio) && /noiseSuppression: false/.test(audio) && /autoGainControl: false/.test(audio) && /channelCount: 1/.test(audio));
check("sayfa gizlenince mikrofon kapanır", /visibilitychange[\s\S]{0,120}micClose/.test(js));
check("kapatınca tüm izler durdurulur (track.stop) ve düğümler ayrılır", /track\.stop\(\)/.test(code) && /mic\.source\.disconnect\(\)/.test(code) && /clearInterval\(mic\.timer\)/.test(code));
check("mikrofon yalnız kullanıcı düğmesiyle açılır (otomatik açılış yok)", (js.match(/getUserMedia/g) || []).length === 1 && /mic-open-default[\s\S]{0,80}micOpen/.test(js));

// --- aygıt etiketi tahmini
const literal = (name) => {
  const text = (code.match(new RegExp(`const ${name} = (/.+/[a-z]*);`)) || [])[1];
  return text ? new Function(`return ${text}`)() : null;
};
const bluetooth = literal("BLUETOOTH_LABEL");
const builtin = literal("BUILTIN_LABEL");
check("etiket kuralları okundu", bluetooth instanceof RegExp && builtin instanceof RegExp);
check("Bluetooth kulaklık etiketleri Bluetooth sayılır (Soundcore Space Q45, Headset, Buds, AirPods)",
  ["Soundcore Space Q45", "Headset earpiece", "Galaxy Buds2", "AirPods Pro", "Bluetooth Mic", "Hands-Free"].every((label) => bluetooth.test(label)));
check("dahili mikrofon etiketleri Bluetooth SAYILMAZ ve dahili sayılır (Built-in, Telefon mikrofonu, Phone microphone)",
  ["Built-in Mic", "Telefon mikrofonu", "Phone microphone", "Dahili mikrofon"].every((label) => !bluetooth.test(label) && builtin.test(label)));

// --- sayfa
for (const id of ["mic-music-start", "mic-music-stop", "mic-list", "mic-open-default", "mic-open-builtin", "mic-close", "mic-level", "mic-level-text", "mic-s-device", "mic-s-applied", "mic-devices"]) {
  check(`bench.html'de #${id} var`, html.includes(`id="${id}"`));
}
check("bench.html mikrofon sesinin kaydedilmediğini açıkça söyler", /kaydedilmez, saklanmaz, gönderilmez, loga yazılmaz/.test(html));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
