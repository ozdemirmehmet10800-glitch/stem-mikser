// Mikrofon akışı (frontend/js/mic.js): YALNIZ dahili / Bluetooth olmayan aygıt, varsayılan aygıt ASLA müzik için açılmaz, izin adımı,
// beklenmeyen / Bluetooth aygıt açılırsa hemen kapatma, kısıtlar, sızıntı hükmü. Sahte mediaDevices / izin / bağlam (gerçek mikrofon YOK).
//
//     node tests\mic_flow_test.mjs

import {
  BLUETOOTH_LABEL, BUILTIN_LABEL, MIC_CONSTRAINTS, pickInternalMic, constraintsFor, leakVerdict, isBluetoothLabel, Mic,
} from "../frontend/js/mic.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

// --- aygıt seçimi (telefondaki gerçek etiketler: dahili "Speakerphone", kulaklık "Soundcore Space Q45")
const dev = (label, deviceId, kind = "audioinput") => ({ kind, label, deviceId });
const phone = [dev("Speakerphone", "aaaa1111"), dev("Headset earpiece", "bbbb2222"), dev("Soundcore Space Q45", "cccc3333"), dev("Default - Soundcore Space Q45", "default"), dev("Hoparlör", "out1", "audiooutput")];
check("telefon: 'Speakerphone' seçilir (Bluetooth / varsayılan DEĞİL)", pickInternalMic(phone).id === "aaaa1111" && pickInternalMic(phone).label === "Speakerphone");
check("etiketler boş (izin yok): reason no-labels, id YOK", (() => { const r = pickInternalMic([dev("", ""), dev("", "")]); return r.id === null && r.reason === "no-labels"; })());
check("hiç mikrofon yok: no-devices", pickInternalMic([]).reason === "no-devices" && pickInternalMic([dev("x", "o", "audiooutput")]).reason === "no-devices" && pickInternalMic(null).reason === "no-devices");
check("yalnız Bluetooth görünüyorsa: no-internal (açılmaz) + etiketler listelenir", (() => {
  const r = pickInternalMic([dev("Soundcore Space Q45", "x1"), dev("Default - Soundcore Space Q45", "default")]);
  return r.id === null && r.reason === "no-internal" && r.candidates.length === 2;
})());
check("'default' ve 'communications' kimlikleri hiçbir koşulda seçilmez (etiketi dahili gibi olsa da)", (() => {
  const r = pickInternalMic([dev("Default - Built-in Microphone", "default"), dev("Communications - Built-in Microphone", "communications")]);
  return r.id === null && r.reason === "no-internal";
})());
check("kablolu kulaklık mikrofonu ve USB mikrofon 'dahili' sayılmaz (yalnız dahili kararı)", pickInternalMic([dev("Wired Headset", "w1")]).id === null && pickInternalMic([dev("USB Audio Device", "u1")]).id === null);
check("Türkçe / İngilizce dahili etiketler seçilir", ["Built-in Mic", "Telefon mikrofonu", "Phone microphone", "Dahili mikrofon", "Internal Microphone"].every((label) => pickInternalMic([dev(label, "id1")]).id === "id1"));
check("Bluetooth etiketleri (Soundcore, Space Q45, Buds, AirPods, Hands-Free) eleniyor", ["Soundcore Space Q45", "Galaxy Buds2 Pro", "AirPods", "Hands-Free AG", "Bluetooth Mic", "Headset earpiece"].every(isBluetoothLabel)
  && !isBluetoothLabel("Speakerphone") && !isBluetoothLabel("Built-in Mic") && BLUETOOTH_LABEL instanceof RegExp && BUILTIN_LABEL instanceof RegExp);
check("kısıtlar: yankı / gürültü / otomatik kazanç KAPALI, tek kanal, deviceId EXACT", (() => {
  const c = constraintsFor("abc").audio;
  return c.echoCancellation === false && c.noiseSuppression === false && c.autoGainControl === false && c.channelCount === 1 && c.deviceId.exact === "abc"
    && Object.isFrozen(MIC_CONSTRAINTS);
})());

// --- sızıntı hükmü
check("sızıntı: müzik +20 dB yükseltiyor -> sızıntı", leakVerdict(-70, -45).leak === true && /Kulaklık/.test(leakVerdict(-70, -45).text));
check("sızıntı: fark küçük -> sızıntı yok; orta -> hafif", leakVerdict(-60, -58).leak === false && /Sızıntı yok/.test(leakVerdict(-60, -58).text) && /Hafif/.test(leakVerdict(-60, -55).text) && leakVerdict(-60, -55).leak === false);
check("sızıntı: müzik çok kısık (< -62 dBFS) ise fark büyük olsa da sızıntı sayılmaz", leakVerdict(-100, -80).leak === false);

// --- sahte ortam
function makeEnv({ devices = phone, permission = "prompt", labelsAfterPermission = true, openLabel = null, openDeviceId = null, failOpen = null } = {}) {
  const log = { getUserMedia: [], stopped: 0, nodes: [], connected: [] };
  let granted = permission === "granted";
  const mediaDevices = {
    enumerateDevices: async () => (granted || !labelsAfterPermission ? devices : devices.map((d) => ({ ...d, label: "", deviceId: d.deviceId === "default" ? "default" : "" }))),
    getUserMedia: async (constraints) => {
      log.getUserMedia.push(constraints);
      if (failOpen) throw Object.assign(new Error("x"), { name: failOpen });
      granted = true;
      const exact = constraints.audio && constraints.audio.deviceId && constraints.audio.deviceId.exact;
      const chosen = exact ? devices.find((d) => d.deviceId === exact) : devices.find((d) => d.deviceId === "default");
      const track = {
        label: openLabel !== null ? openLabel : (chosen ? chosen.label : ""),
        getSettings: () => ({ deviceId: openDeviceId !== null ? openDeviceId : (exact || "default"), echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1, latency: 0.045 }),
        stop: () => { log.stopped += 1; },
      };
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    },
  };
  const permissions = { query: async () => ({ state: granted ? "granted" : permission }) };
  const port = {};
  const node = { port, connect: (target) => log.connected.push(["node", target && target.kind]), disconnect: () => log.connected.push(["node-off"]) };
  const ctx = {
    destination: { kind: "destination" },
    audioWorklet: { addModule: async (url) => { log.module = url; } },
    createMediaStreamSource: () => ({ connect: (n) => log.connected.push(["source", n === node ? "node" : "?"]), disconnect: () => log.connected.push(["source-off"]) }),
    createGain: () => ({ gain: { value: 1 }, connect: (target) => log.connected.push(["sink", target.kind]), disconnect: () => log.connected.push(["sink-off"]), kind: "gain" }),
  };
  const mic = new Mic({ mediaDevices, permissions, makeNode: () => node, workletUrl: "js/pitch-processor.js" });
  return { mic, log, ctx, node, port };
}

// prepare(): HİÇBİR mikrofonu açmaz
{
  const env = makeEnv({ permission: "prompt" });
  const state = await env.mic.prepare();
  check("izin yokken prepare: needs-permission, getUserMedia ÇAĞRILMADI", state.status === "needs-permission" && env.log.getUserMedia.length === 0);
  const env2 = makeEnv({ permission: "granted" });
  const ready = await env2.mic.prepare();
  check("izin varken prepare: ready + dahili aygıt, yine getUserMedia YOK", ready.status === "ready" && ready.device.id === "aaaa1111" && env2.log.getUserMedia.length === 0);
  const env3 = makeEnv({ permission: "denied" });
  check("izin reddedilmiş: denied, aygıt listesine bile bakılmaz", (await env3.mic.prepare()).status === "denied");
  const env4 = makeEnv({ permission: "granted", devices: [dev("Soundcore Space Q45", "x"), dev("Default - Soundcore Space Q45", "default")] });
  const none = await env4.mic.prepare();
  check("yalnız Bluetooth mikrofon varsa: no-internal (AÇILMAZ), getUserMedia yok", none.status === "no-internal" && env4.log.getUserMedia.length === 0);
  const env5 = new Mic({ mediaDevices: null, permissions: null });
  check("getUserMedia yoksa unsupported", (await env5.prepare()).status === "unsupported" && env5.supported === false);
  const env6 = makeEnv({ permission: "granted" });
  env6.mic.permissions = null;
  check("Permissions API yoksa (null) yine de etiketlerle ready olabilir", (await env6.mic.prepare()).status === "ready");
}

// izin adımı: varsayılanı KISACA açıp hemen kapatır; sonra dahili seçilir
{
  const env = makeEnv({ permission: "prompt" });
  const result = await env.mic.requestPermission();
  check("izin adımı: varsayılan aygıt BİR kez açıldı ({audio:true}) ve HEMEN durduruldu", result.ok === true && env.log.getUserMedia.length === 1
    && env.log.getUserMedia[0].audio === true && env.log.stopped === 1);
  const after = await env.mic.prepare();
  check("izinden sonra etiketler görünür: ready + dahili", after.status === "ready" && after.device.id === "aaaa1111");
  const denied = makeEnv({ failOpen: "NotAllowedError" });
  check("izin reddedilirse hata adı döner, akış açık kalmaz", (await denied.mic.requestPermission()).error === "NotAllowedError" && denied.log.stopped === 0);
}

// start(): yalnız exact deviceId
{
  const env = makeEnv({ permission: "granted" });
  const frames = [];
  const info = await env.mic.start(env.ctx, (f) => frames.push(f), { id: "aaaa1111", label: "Speakerphone" });
  const constraints = env.log.getUserMedia[0].audio;
  check("start: getUserMedia yalnız deviceId EXACT + üç işleme KAPALI + tek kanal", env.log.getUserMedia.length === 1 && constraints.deviceId.exact === "aaaa1111"
    && constraints.echoCancellation === false && constraints.noiseSuppression === false && constraints.autoGainControl === false && constraints.channelCount === 1);
  check("start: işlemci modülü yüklendi, düğümler bağlandı (kaynak -> işlemci -> sessiz kazanç -> hedef)", env.log.module === "js/pitch-processor.js"
    && env.log.connected.some((c) => c[0] === "source") && env.log.connected.some((c) => c[0] === "sink" && c[1] === "destination"));
  check("start: bilgi (etiket, uygulanan ayarlar, gecikme 45 ms)", info.label === "Speakerphone" && info.echoCancellation === false && info.latencyMs === 45 && info.sampleRate === 48000 && env.mic.active);
  // işlemciden gelen mesajlar: yalnız sayılar
  env.port.onmessage({ data: { t: 1.5, hz: 220.5, clarity: 0.93, rmsDb: -30 } });
  env.port.onmessage({ data: { t: 1.52, hz: null, clarity: 0.2, rmsDb: -70 } });
  env.port.onmessage({ data: { t: "x", hz: 3 } });
  env.port.onmessage({ data: null });
  env.port.onmessage({ data: { t: 2, hz: -5, clarity: "y", rmsDb: {} , samples: new Float32Array(128) } });
  check("kareler yalnız {t, hz, clarity, rmsDb} (sayılar); bozuk / ekstra alanlı mesaj süzülür", frames.length === 3 && frames[0].hz === 220.5 && frames[1].hz === null
    && frames[2].hz === null && frames[2].clarity === 0 && frames[2].rmsDb === -120 && frames.every((f) => Object.keys(f).sort().join() === "clarity,hz,rmsDb,t"));
  let rejected = false;
  try { await env.mic.start(env.ctx, () => {}, { id: "aaaa1111", label: "Speakerphone" }); } catch (error) { rejected = error.message === "mic-already-open"; }
  check("ikinci start reddedilir (iki akış açılmaz)", rejected && env.log.getUserMedia.length === 1);
  env.mic.stop();
  check("stop: izler durduruldu, düğümler ayrıldı, mesaj işleyici bırakıldı, etkin değil", env.log.stopped === 1 && env.mic.active === false && env.port.onmessage === null
    && env.log.connected.some((c) => c[0] === "source-off") && env.log.connected.some((c) => c[0] === "sink-off"));
  env.mic.stop();
  check("stop iki kez çağrılabilir (zararsız)", env.log.stopped === 1);
}
for (const [name, bad] of [["kimlik yok", { id: null, label: "x" }], ["default", { id: "default", label: "Default" }], ["communications", { id: "communications", label: "Comm" }],
  ["Bluetooth etiketi", { id: "z", label: "Soundcore Space Q45" }], ["aygıt hiç verilmedi", null]]) {
  const env = makeEnv({ permission: "granted" });
  let error = null;
  try { await env.mic.start(env.ctx, () => {}, bad); } catch (e) { error = e; }
  check(`start reddedilir ve HİÇ getUserMedia çağrılmaz: ${name}`, error && env.log.getUserMedia.length === 0 && env.mic.active === false, error && error.message);
}
{
  const env = makeEnv({ permission: "granted", openLabel: "Soundcore Space Q45" });
  let error = null;
  try { await env.mic.start(env.ctx, () => {}, { id: "aaaa1111", label: "Speakerphone" }); } catch (e) { error = e; }
  check("açılan aygıt Bluetooth çıkarsa HEMEN kapatılır ve hata verilir (müzik bozulmasın)", error && error.message === "mic-bluetooth" && env.log.stopped === 1 && env.mic.active === false);
  const env2 = makeEnv({ permission: "granted", openDeviceId: "baska" });
  let error2 = null;
  try { await env2.mic.start(env2.ctx, () => {}, { id: "aaaa1111", label: "Speakerphone" }); } catch (e) { error2 = e; }
  check("beklenen aygıt açılmadıysa (deviceId farklı) hemen kapatılır", error2 && error2.message === "mic-unexpected-device" && env2.log.stopped === 1);
  const env3 = makeEnv({ permission: "granted", failOpen: "OverconstrainedError" });
  let error3 = null;
  try { await env3.mic.start(env3.ctx, () => {}, { id: "aaaa1111", label: "Speakerphone" }); } catch (e) { error3 = e; }
  check("aygıt kaybolmuşsa (Overconstrained) hata, SESSİZCE varsayılana düşülmez", error3 && /mic-open-failed:OverconstrainedError/.test(error3.message) && env3.log.getUserMedia.length === 1);
  const env4 = makeEnv({ permission: "granted" });
  env4.ctx.audioWorklet.addModule = async () => { throw new Error("modul yok"); };
  let error4 = null;
  try { await env4.mic.start(env4.ctx, () => {}, { id: "aaaa1111", label: "Speakerphone" }); } catch (e) { error4 = e; }
  check("işlemci yüklenemezse akış kapatılır (açık mikrofon kalmaz)", error4 && env4.log.stopped === 1 && env4.mic.active === false);
}

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
