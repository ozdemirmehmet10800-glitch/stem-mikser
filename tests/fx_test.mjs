// Kanal şeridi, oda ve impuls yanıtı (saf mantık) + mikser hafızasının yeni alanları. SENTETİK, gerçek ses yok.
//
//     node tests\fx_test.mjs

import {
  EQ_BANDS, EQ_LIMIT, normalizeFx, neutralFx, isNeutralFx, composeFx, sameFx, DEFAULT_ROOM, ROOM_PRESETS, normalizeRoom,
  isDefaultRoom, roomPresetId, returnGain, makeImpulse, impulseLength, resample, impulseFor, mulberry32, IR_RATE, DECAY_MIN, DECAY_MAX,
} from "../frontend/js/fx.js";
import {
  DEFAULT_STEM, cleanStates, applyPreset, PRESETS, normalizeRecord, planRestore, isDefaultMix, snapshot, writeMix, readMix, writeLoop,
  effectiveFx, effectiveGain, MIX_PREFIX,
} from "../frontend/js/mixmemory.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const store = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
};

// --- şerit değerleri
check("nötr: pan 0, eq 0,0,0, send 0", isNeutralFx(neutralFx()) && isNeutralFx(null) && isNeutralFx({}) && isNeutralFx({ eq: [] }));
check("normalize: sınırlar (pan ±1, eq ±12, send 0..1)", JSON.stringify(normalizeFx({ pan: 5, eq: [99, -99, 3.14159], send: 7 })) === '{"pan":1,"eq":[12,-12,3.1],"send":1}'
  && JSON.stringify(normalizeFx({ pan: -2, send: -1 })) === '{"pan":-1,"eq":[0,0,0],"send":0}');
check("normalize: bozuk girdi nötre", isNeutralFx({ pan: "x", eq: "y", send: NaN }) && isNeutralFx(undefined) && isNeutralFx(42));
check("nötr değil: tek bantta 0,1 dB bile", !isNeutralFx({ eq: [0, 0.1, 0] }) && !isNeutralFx({ pan: 0.01 }) && !isNeutralFx({ send: 0.01 }));
check("EQ bantları: bas rafı 120 Hz, orta 1 kHz Q 0.9, tiz rafı 6 kHz", EQ_BANDS[0].type === "lowshelf" && EQ_BANDS[0].frequency === 120 && EQ_BANDS[1].type === "peaking"
  && EQ_BANDS[1].frequency === 1000 && EQ_BANDS[1].q === 0.9 && EQ_BANDS[2].type === "highshelf" && EQ_BANDS[2].frequency === 6000 && EQ_LIMIT === 12);
const c = composeFx({ pan: 0.8, eq: [10, 0, -5], send: 0.7 }, { pan: 0.5, eq: [5, 3, -9], send: 0.6 });
check("alt kanal = kendi + ana kanal (pan/send kırpılır, eq dB toplanır ve ±12'ye kırpılır)", c.pan === 1 && c.send === 1 && c.eq.join() === "12,3,-12");
check("ana kanal yoksa kendi değeri", sameFx(composeFx({ pan: 0.3 }, null), { pan: 0.3 }));
check("sameFx", sameFx({ pan: 0.3, eq: [1, 2, 3], send: 0.1 }, { pan: 0.3, eq: [1, 2, 3], send: 0.1 }) && !sameFx({ pan: 0.3 }, { pan: 0.31 }));

// --- oda
check("oda varsayılanı ve sınırlar", isDefaultRoom(DEFAULT_ROOM) && isDefaultRoom(null) && normalizeRoom({ decay: 99 }).decay === DECAY_MAX && normalizeRoom({ decay: 0 }).decay === DECAY_MIN
  && normalizeRoom({ size: 2, level: -1 }).size === 1 && normalizeRoom({ size: 2, level: -1 }).level === 0);
check("hazır odalar: küçük/orta/büyük/salon, süre artar", ROOM_PRESETS.map((p) => p.id).join() === "small,medium,large,hall"
  && ROOM_PRESETS.every((p, i) => i === 0 || (p.decay > ROOM_PRESETS[i - 1].decay && p.size > ROOM_PRESETS[i - 1].size)));
check("hazır oda tanıma (boyut+süre)", roomPresetId({ size: 0.7, decay: 2.2, level: 0.1 }) === "large" && roomPresetId({ size: 0.71, decay: 2.2 }) === null);
check("dönüş kazancı = seviye", returnGain(0.5) === 0.5 && returnGain(2) === 1 && returnGain(-1) === 0);

// --- impuls yanıtı
const small = makeImpulse(0.15, 0.6);
const hall = makeImpulse(1, 3);
check("uzunluk: süre x 1,15 + 0,05 sn (en çok 3,5 sn), 44100 Hz", small.left.length === impulseLength(0.6) && hall.left.length === Math.round(3.5 * IR_RATE) && small.rate === IR_RATE
  && impulseLength(0.6) === Math.round(0.74 * IR_RATE));
const energy = (a) => a.reduce((sum, v) => sum + v * v, 0);
check("kanal başına BİRİM enerji (sunucu ile aynı ölçek)", near(energy(small.left), 1, 1e-3) && near(energy(small.right), 1, 1e-3) && near(energy(hall.left), 1, 1e-3));
let corr = 0;
for (let i = 0; i < small.left.length; i += 1) corr += small.left[i] * small.right[i];
check("iki kanal ilintisiz (|r| < 0,1)", Math.abs(corr) < 0.1, corr.toFixed(4));
const again = makeImpulse(0.15, 0.6);
check("DETERMİNİSTİK: aynı parametre = aynı dizi (bit bit)", again.left.every((v, i) => v === small.left[i]) && again.right.every((v, i) => v === small.right[i]));
const other = makeImpulse(0.16, 0.6);
check("boyut değişince dizi değişir", other.left.some((v, i) => v !== small.left[i]));
// sunucu ile eşitlik için sabit parmak izi: ilk örnekler + toplam
const fingerprint = (a) => `${a.length}:${[0, 1000, 5000, 10000, 20000].map((i) => a[i].toExponential(5)).join(",")}`;
console.log("     parmak izi (size 0.5, decay 1.6) sol:", fingerprint(makeImpulse(0.5, 1.6).left));
check("zarf söner: ilk %10 enerjisi son %50'den çok büyük (RT60 sönümü)", (() => {
  const a = makeImpulse(0.5, 1.2).left;
  const first = energy(a.slice(0, Math.floor(a.length * 0.1)));
  const last = energy(a.slice(Math.floor(a.length * 0.5)));
  return first > 20 * last;
})());
check("ön gecikmeden önce sessizlik (küçük oda 4-16 ms)", small.left.slice(0, Math.floor(0.004 * IR_RATE) - 1).every((v) => v === 0));
check("erken yansımalar: ilk 100 ms'de belirgin tepe örnekleri var", (() => {
  const a = small.left.slice(0, Math.floor(0.1 * IR_RATE));
  const peak = Math.max(...a.map(Math.abs));
  return peak > 0.01;
})());
check("mulberry32 sabit dizi", (() => { const r = mulberry32(1); return near(r(), 0.6270739405881613, 1e-12); })());

// --- yeniden örnekleme
const ramp = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 20));
const up = resample(ramp, 44100, 48000);
check("yeniden örnekleme: uzunluk oranı ve enerji korunur", up.length === Math.round((4410 * 48000) / 44100) && near(energy(up), energy(ramp), energy(ramp) * 1e-3));
check("aynı hızda aynı dizi", resample(ramp, 44100, 44100) === ramp);
const a1 = impulseFor(0.5, 1.6, 48000);
check("impulseFor: bağlam hızında ve önbellekte", a1.left.length === Math.round(impulseLength(1.6) * 48000 / 44100) && impulseFor(0.5, 1.6, 48000) === a1);

// --- mikser hafızası: yeni alanlar
check("varsayılan kanal: pan/eq/send nötr", DEFAULT_STEM.pan === 0 && DEFAULT_STEM.send === 0 && DEFAULT_STEM.eq.join() === "0,0,0" && isDefaultMix(cleanStates(["a", "b"])));
check("cleanStates her çağrıda KOPYA eq (paylaşılan dizi yok)", (() => { const s = cleanStates(["a", "b"]); s.get("a").eq[0] = 5; return s.get("b").eq[0] === 0; })());
const oldRecord = { v: 1, savedAt: 5, master: 100, stems: { vocals: { fader: 80, mute: true, solo: false }, drums: { fader: 100, mute: false, solo: false } } };
const parsed = normalizeRecord(oldRecord);
check("ESKİ kayıt (fx alanı yok) bozulmadan okunur: nötr fx, fader/mute korunur", parsed.stems.get("vocals").fader === 80 && parsed.stems.get("vocals").mute === true
  && isNeutralFx(parsed.stems.get("vocals")) && parsed.room === undefined);
const rich = normalizeRecord({ v: 1, master: 100, stems: { guitar: { fader: 100, pan: -1, eq: [2, 0, -3], send: 0.4 } }, room: { size: 0.7, decay: 2.2, level: 0.8 } });
check("yeni alanlar okunur ve normalize edilir", rich.stems.get("guitar").pan === -1 && rich.stems.get("guitar").eq.join() === "2,0,-3" && rich.stems.get("guitar").send === 0.4 && rich.room.decay === 2.2);
check("bozuk fx alanı nötre", isNeutralFx(normalizeRecord({ v: 1, master: 100, stems: { a: { pan: "x", eq: 5, send: null } } }).stems.get("a")));
const plan = planRestore(rich, ["guitar", "piano"]);
check("planRestore: kayıtlı fx uygulanır, kayıtsız kanal nötr", plan.get("guitar").pan === -1 && isNeutralFx(plan.get("piano")));
check("isDefaultMix fx'i de görür: pan/EQ/gönderim varsa varsayılan DEĞİL", !isDefaultMix(plan) && !isDefaultMix(cleanStates(["a"]), 100, { size: 0.9, decay: 2, level: 0.5 }) && isDefaultMix(cleanStates(["a"]), 100, DEFAULT_ROOM));
const ch = new Map([["guitar", { fader: 1, mute: false, solo: false, pan: -1, eq: [0, 0, 6], send: 0.2 }], ["piano", { fader: 1, mute: false, solo: false }]]);
const snap = snapshot(ch);
check("snapshot: motor kanalındaki fx dahil, alanı olmayan kanal nötr", snap.get("guitar").pan === -1 && snap.get("guitar").eq[2] === 6 && isNeutralFx(snap.get("piano")));

let s = store();
writeMix(s, "song", snap, 100, 10);
const back = readMix(s, "song");
check("yaz-oku: gitar sola, EQ ve gönderim geri gelir", back.stems.get("guitar").pan === -1 && back.stems.get("guitar").eq.join() === "0,0,6" && back.stems.get("guitar").send === 0.2);
writeMix(s, "song", cleanStates(["guitar", "piano"]), 100, 11);
check("hepsi nötre dönünce kayıt SİLİNİR (rozet boşuna çıkmaz)", s.getItem(MIX_PREFIX + "song") === null);
writeMix(s, "song2", cleanStates(["guitar"]), 100, 12, { room: { size: 0.9, decay: 2, level: 0.5 } });
check("yalnız oda varsayılan değilse kayıt yazılır ve oda geri gelir", readMix(s, "song2").room.size === 0.9 && readMix(s, "song2").room.decay === 2);
writeMix(s, "song2", cleanStates(["guitar"]), 100, 13);
check("oda verilmeyince eski kayıttaki oda KORUNUR", readMix(s, "song2").room.size === 0.9);
writeMix(s, "song2", cleanStates(["guitar"]), 100, 14, { room: DEFAULT_ROOM });
check("oda varsayılana dönünce (ve başka şey yoksa) kayıt silinir", s.getItem(MIX_PREFIX + "song2") === null);
writeMix(s, "song3", cleanStates(["guitar"]), 100, 15, { room: { size: 0.9, decay: 2, level: 0.5 } });
writeLoop(s, "song3", { a: 1, b: 5 }, 16);
writeLoop(s, "song3", null, 17);
check("döngü silinince oda kaydı kalır", readMix(s, "song3") && readMix(s, "song3").room.size === 0.9);

// --- etkin değer (alt kanal)
const group = new Map([
  ["vocals", { fader: 1, mute: false, solo: false, pan: 0.3, eq: [2, 0, 0], send: 0.2, children: ["lead", "backing"] }],
  ["lead", { fader: 1, mute: false, solo: false, pan: 0.4, eq: [1, 0, 0], send: 0.1, parent: "vocals" }],
  ["backing", { fader: 1, mute: false, solo: false, pan: 0, eq: [0, 0, 0], send: 0, parent: "vocals" }],
]);
check("effectiveFx: alt kanal = kendi + ana (lead: pan 0.7, eq bas +3, gönderim 0.3)", (() => { const f = effectiveFx(group, "lead"); return near(f.pan, 0.7) && f.eq[0] === 3 && near(f.send, 0.3); })());
check("effectiveFx: backing yalnız ana kanalı alır", (() => { const f = effectiveFx(group, "backing"); return near(f.pan, 0.3) && f.eq[0] === 2 && near(f.send, 0.2); })());
check("effectiveFx: olmayan kanal nötr", isNeutralFx(effectiveFx(group, "yok")));

// --- ön ayarlar
const names = ["vocals", "drums", "bass", "guitar", "piano", "other"];
const slowed = PRESETS.find((p) => p.id === "slowed-reverb");
const sl = applyPreset(slowed, names);
check("Slowed + reverb: kapalı grupta TÜM kanallara gönderim, vokal daha fazla; mute/solo yok", sl.get("drums").send === 0.5 && sl.get("vocals").send === 0.65 && names.every((n) => !sl.get(n).mute && !sl.get(n).solo));
check("Slowed + reverb: oda büyük ve plak gibi hız 0.85 ön ayarda", slowed.room.decay === 2.2 && slowed.tempo.vinyl === true && slowed.tempo.rate === 0.85);
const slOpen = applyPreset(slowed, ["vocals", "lead", "backing", "drums"]);
check("açık grupta gönderim ALT kanallara yazılır (ana kanal çift sayılmasın)", slOpen.get("vocals").send === 0 && slOpen.get("lead").send === 0.65 && slOpen.get("backing").send === 0.65 && slOpen.get("drums").send === 0.5);
check("eski ön ayarlar fx'e dokunmaz (hepsi nötr)", ["karaoke", "no-drums", "vocals-only"].every((id) => {
  const st = applyPreset(PRESETS.find((p) => p.id === id), names);
  return st && [...st.values()].every((x) => isNeutralFx(x));
}));
check("yeni ön ayar listesinde ve etiketi 'Slowed + reverb'", PRESETS.some((p) => p.label === "Slowed + reverb"));
check("ön ayar temiz başlangıç: önceki fx silinir (cleanStates)", (() => {
  const st = applyPreset(PRESETS.find((p) => p.id === "no-drums"), names);
  return st.get("guitar").pan === 0 && st.get("guitar").send === 0;
})());
check("effectiveGain etkilenmez (fx alanları gain kuralını bozmaz)", effectiveGain(new Map([["a", { fader: 0.5, mute: false, solo: false, pan: 1, eq: [12, 12, 12], send: 1 }]]), "a") === 0.5);

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
