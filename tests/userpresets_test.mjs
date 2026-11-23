// Kendi ön ayarların ve adlı döngüler (js/userpresets.js) + mixmemory ile uyum.   node tests\userpresets_test.mjs

import {
  cleanName, readPresets, writePresets, makePreset, addPreset, removePreset, presetRecord, readLoops, writeLoops, addLoop, removeLoop, dropLoops,
  PRESET_LIMIT, LOOP_LIMIT, NAME_MAX, PRESETS_KEY, loopsKey,
} from "../frontend/js/userpresets.js";
import { normalizeRecord, planRestore } from "../frontend/js/mixmemory.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const store = (seed = {}) => { const d = { ...seed }; return { d, getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: (k) => { delete d[k]; } }; };

check("cleanName: boşluk toplanır, 16 karakter", cleanName("  Bas   çalış  ") === "Bas çalış" && cleanName("x".repeat(40)).length === NAME_MAX && cleanName(null) === "");

const states = new Map([
  ["vocals", { fader: 40, mute: false, solo: false, pan: 0.5, eq: [0, -3, 2], send: 0.2 }],
  ["drums", { fader: 100, mute: true, solo: false, pan: 0, eq: [0, 0, 0], send: 0 }],
]);
const p = makePreset("Karaoke 2", states, null, "p1");
check("makePreset: ad temiz, kanallar var", p && p.name === "Karaoke 2" && p.stems.vocals.fader === 40 && p.stems.drums.mute === true && p.room === null);
check("makePreset: boş ad / boş durum null", makePreset("  ", states, null, "x") === null && makePreset("a", new Map(), null, "x") === null);
check("makePreset: aralık dışı değerler sıkıştırılır", (() => {
  const q = makePreset("a", new Map([["x", { fader: 999, pan: 9, eq: [50, -50, 0], send: 5, mute: "evet" }]]), null, "i");
  return q.stems.x.fader === 150 && q.stems.x.pan === 1 && q.stems.x.eq[0] === 12 && q.stems.x.eq[1] === -12 && q.stems.x.send === 1 && q.stems.x.mute === false;
})());

let list = [];
let r = addPreset(list, p); list = r.list;
check("addPreset ekler", list.length === 1 && !r.error);
r = addPreset(list, makePreset("KARAOKE 2", states, null, "p9"));
check("aynı ad (büyük-küçük farksız): ÜSTÜNE yazar, kimlik korunur", r.replaced && r.list.length === 1 && r.list[0].id === "p1");
let full = [];
for (let i = 0; i < PRESET_LIMIT; i += 1) full = addPreset(full, makePreset(`Ad ${i}`, states, null, `i${i}`)).list;
check(`limit ${PRESET_LIMIT}`, addPreset(full, makePreset("Fazla", states, null, "z")).error === "limit");
check("removePreset", removePreset(full, "i0").length === PRESET_LIMIT - 1);

const s = store();
check("yaz/oku kalıcı", writePresets(s, list) && readPresets(s).length === 1 && readPresets(s)[0].stems.vocals.pan === 0.5);
check("bozuk depo / geçersiz kayıt güvenli", readPresets(store({ [PRESETS_KEY]: "{x" })).length === 0 && readPresets(store({ [PRESETS_KEY]: JSON.stringify([null, { id: 1 }, { id: "a", name: "", stems: {} }, { id: "b", name: "ok", stems: { "../x": { fader: 1 } } }]) })).length === 0);
check("yazma hatası false", writePresets({ setItem() { throw new Error("kota"); } }, list) === false);

// mixmemory ile uyum: kayıt normalize edilir ve YENİ şarkının kanallarına uygulanır (olmayan kanal atlanır)
const rec = normalizeRecord(presetRecord(list[0], 100));
check("presetRecord: mixmemory.normalizeRecord kabul eder", rec && rec.stems.get("vocals").fader === 40 && rec.master === 100);
const plan = planRestore(rec, ["vocals", "bass"]);
check("planRestore: şarkıda olmayan kanal (drums) atlanır, olmayan ayar (bass) temiz başlangıç", plan.get("vocals").fader === 40 && !plan.has("drums") && plan.get("bass").fader === 100);

// adlı döngüler
const SONG = "a".repeat(64);
let loops = [];
let lr = addLoop(loops, { name: "Nakarat", a: 40.123, b: 65.9 }, "l1", 200); loops = lr.list;
check("addLoop: ad, 2 ondalık", loops.length === 1 && loops[0].name === "Nakarat" && loops[0].a === 40.12 && loops[0].b === 65.9);
check("addLoop: ad boşsa 'Döngü N'", addLoop(loops, { name: "", a: 1, b: 5 }, "l2", 200).list[1].name === "Döngü 2");
check("addLoop: çok kısa / aralık dışı / geçersiz reddedilir", addLoop(loops, { a: 1, b: 1.2 }, "x", 200).error === "short" && addLoop(loops, { a: -1, b: 5 }, "x", 200).error === "range" && addLoop(loops, { a: 1, b: 500 }, "x", 200).error === "range" && addLoop(loops, { a: NaN, b: 5 }, "x", 200).error === "range");
let many = [];
for (let i = 0; i < LOOP_LIMIT; i += 1) many = addLoop(many, { a: i, b: i + 2 }, `m${i}`, 500).list;
check(`addLoop: limit ${LOOP_LIMIT}`, addLoop(many, { a: 100, b: 102 }, "z", 500).error === "limit");
const ls = store();
check("writeLoops/readLoops: kalıcı, şarkı kimliğine bağlı", writeLoops(ls, SONG, loops) && readLoops(ls, SONG).length === 1 && readLoops(ls, "b".repeat(64)).length === 0);
check("readLoops: bozuk kayıt süzülür", readLoops(store({ [loopsKey(SONG)]: JSON.stringify([{ id: "x", a: 1, b: 1.1 }, { id: "y", a: -2, b: 4 }, null, { id: "ok", name: "N", a: 2, b: 9 }]) }), SONG).length === 1);
check("readLoops/writeLoops: tehlikeli kimlik reddedilir", readLoops(ls, "../x").length === 0 && writeLoops(ls, "../x", loops) === false);
check("removeLoop", removeLoop(loops, "l1").length === 0);
writeLoops(ls, SONG, []);
check("boş liste anahtarı siler", !(loopsKey(SONG) in ls.d));
writeLoops(ls, SONG, loops); ls.d["stem-mikser.collection"] = "{}";
dropLoops(ls, [SONG]);
check("dropLoops yalnız o şarkının anahtarını siler (collection'a dokunmaz)", !(loopsKey(SONG) in ls.d) && ls.d["stem-mikser.collection"] === "{}");

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
