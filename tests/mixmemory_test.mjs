// Mikser hafizasi ve on ayarlar (saf mantik, DOM/ses yok).
//
//     node tests\mixmemory_test.mjs

import {
  audible, PRESETS, applyPreset, cleanStates, normalizeRecord, planRestore,
  isDefaultMix, snapshot, readMix, writeMix, removeMix, mixKey, MIX_PREFIX,
  MIX_LIMIT, writeLoop, validLoop,
} from "../frontend/js/mixmemory.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const ch = (o = {}) => ({ fader: 1, mute: false, solo: false, ...o });
const NAMES = ["vocals", "drums", "bass", "guitar", "piano", "other"];
const chans = (over = {}) => new Map(NAMES.map((n) => [n, ch(over[n])]));
const heard = (c) => NAMES.filter((n) => audible(c, n));
const preset = (id) => PRESETS.find((p) => p.id === id);

// --- solo + mute
check("hicbiri yok: hepsi duyulur", heard(chans()).length === 6);
check("yalniz mute: o susar",
  heard(chans({ drums: { mute: true } })).join() === "vocals,bass,guitar,piano,other");
check("yalniz solo: yalniz o duyulur",
  heard(chans({ bass: { solo: true } })).join() === "bass");
check("iki solo: ikisi duyulur",
  heard(chans({ bass: { solo: true }, drums: { solo: true } })).join() === "drums,bass");
check("ayni kanalda solo+mute: mute kazanir",
  !audible(chans({ bass: { solo: true, mute: true } }), "bass"));
check("solo+mute kanal tek solo ise digerleri de susar (solo sayilir)",
  heard(chans({ bass: { solo: true, mute: true } })).length === 0);
check("solo+mute: baska kanal solo ise o duyulur",
  heard(chans({ bass: { solo: true, mute: true }, drums: { solo: true } })).join() === "drums");
check("mute kalkinca solo geri gelir",
  heard(chans({ bass: { solo: true, mute: false } })).join() === "bass");
check("olmayan kanal duyulmaz", !audible(chans(), "kick"));

// --- kayit gidis-donus
const rt = chans({ bass: { solo: true, mute: true, fader: 0.5 }, vocals: { fader: 1.5 } });
const storage = new FakeStorage();
writeMix(storage, "abc", snapshot(rt), 80, 1000);
const rec = readMix(storage, "abc");
check("gidis-donus: solo ve mute BIRLIKTE saklanir",
  rec.stems.get("bass").solo && rec.stems.get("bass").mute);
check("gidis-donus: fader yuzde",
  rec.stems.get("bass").fader === 50 && rec.stems.get("vocals").fader === 150);
check("gidis-donus: master", rec.master === 80);
const raw = JSON.parse(storage.getItem(mixKey("abc")));
check("bicim: stem adi -> ayar, v=1",
  raw.v === 1 && typeof raw.stems.bass === "object" && raw.stems.bass.fader === 50);

// --- kimlik: anahtar yalniz sarki kimligi
check("anahtar yalniz kimlik (stems_version/pipeline yok)", mixKey("abc") === MIX_PREFIX + "abc");
writeMix(storage, "abc", snapshot(rt), 80, 2000);
check("ayni kimlik tek kayit", storage.length === 1);

// --- bilinmeyen / eksik adlar (Asama 10 alt kanallari)
const future = ["vocals", "drums", "kick", "snare", "bass"];
const plan = planRestore(rec, future);
check("kayitta olmayan yeni kanal varsayilan",
  plan.get("kick").fader === 100 && !plan.get("kick").mute && !plan.get("snare").solo);
check("sarkida olmayan kayit adi sessizce atlanir",
  !plan.has("guitar") && !plan.has("piano") && plan.size === 5);
check("bilinen ad uygulanir", plan.get("bass").mute && plan.get("bass").solo);
const old = normalizeRecord({ v: 1, master: 100, stems: { drums: { mute: true }, "yok-ad": { mute: true } } });
check("eski kayit yeni kanallarla bozulmaz",
  planRestore(old, future).get("drums").mute && planRestore(old, future).size === 5);

// --- bozuk girdi
check("v uyumsuz -> yok sayilir", normalizeRecord({ v: 2, stems: {} }) === null);
check("stems yok -> null", normalizeRecord({ v: 1 }) === null);
check("null/cop -> null", normalizeRecord(null) === null && normalizeRecord("x") === null);
const bad = normalizeRecord({ v: 1, master: "x", stems: {
  a: { fader: 999, mute: "evet" }, b: { fader: -5 }, c: { fader: "yarim" }, d: 7,
} });
check("fader sinirlanir", bad.stems.get("a").fader === 150 && bad.stems.get("b").fader === 0);
check("gecersiz fader/mute guvenli", bad.stems.get("c").fader === 100 && bad.stems.get("a").mute === false);
check("stem olmayan girdi atlanir, bozuk master 100", !bad.stems.has("d") && bad.master === 100);
const s2 = new FakeStorage();
s2.setItem(mixKey("zz"), "{bozuk json");
check("bozuk JSON -> null (cokmez)", readMix(s2, "zz") === null);
s2.setItem(mixKey("v2"), JSON.stringify({ v: 2, stems: { a: {} } }));
readMix(s2, "v2");
check("uyumsuz surum SILINMEZ", s2.getItem(mixKey("v2")) !== null);
check("__proto__ adi guvenli", (() => {
  const r = normalizeRecord(JSON.parse('{"v":1,"stems":{"__proto__":{"mute":true}}}'));
  return r.stems.get("__proto__").mute === true && ({}).mute === undefined;
})());

// --- varsayilan = kayit yok
const s3 = new FakeStorage();
writeMix(s3, "id1", snapshot(chans({ drums: { mute: true } })), 100, 1);
check("degisiklik yazilir", s3.length === 1);
writeMix(s3, "id1", snapshot(chans()), 100, 2);
check("varsayilana donunce kayit silinir", s3.length === 0);
writeMix(s3, "id2", snapshot(chans()), 90, 3);
check("master degisirse kayit tutulur", s3.length === 1);
check("isDefaultMix", isDefaultMix(snapshot(chans()), 100) && !isDefaultMix(snapshot(chans()), 99));

// --- ileride "loop" alani korunur
const s4 = new FakeStorage();
s4.setItem(mixKey("lp"), JSON.stringify({ v: 1, savedAt: 1, master: 100,
  stems: { drums: { fader: 100, mute: true, solo: false } }, loop: { a: 1.5, b: 9 } }));
writeMix(s4, "lp", snapshot(chans({ bass: { mute: true } })), 100, 5);
check("loop alani yeniden yazimda korunur", JSON.parse(s4.getItem(mixKey("lp"))).loop.b === 9);
writeMix(s4, "lp", snapshot(chans()), 100, 6);
check("loop varken varsayilan mikser kaydi silmez", s4.getItem(mixKey("lp")) !== null);


// --- loop alani (Madde 1): kaydedilir, okunur, silinince alan da silinir
{
  const s6 = new FakeStorage();
  writeLoop(s6, "L1", { a: 12.5, b: 20 }, 10);
  const rec1 = readMix(s6, "L1");
  check("loop yazilir ve okunur", rec1 && rec1.loop.a === 12.5 && rec1.loop.b === 20);
  check("yalniz loop: mikser varsayilan", isDefaultMix(planRestore(rec1, NAMES), rec1.master));
  writeMix(s6, "L1", snapshot(chans({ drums: { mute: true } })), 90, 20);
  const rec2 = readMix(s6, "L1");
  check("mikser yazimi loop'u korur", rec2.loop.b === 20 && rec2.stems.get("drums").mute && rec2.master === 90);
  writeLoop(s6, "L1", null, 30);
  const rec3 = readMix(s6, "L1");
  check("loop silinince alan gider, mikser kalir", rec3 && rec3.loop === undefined && rec3.stems.get("drums").mute);
  writeLoop(s6, "L2", { a: 1, b: 3 }, 40);
  writeLoop(s6, "L2", null, 50);
  check("loop silinince mikser de varsayilansa kayit tamamen silinir", s6.getItem(mixKey("L2")) === null);
  writeLoop(s6, "yok", null, 60);
  check("kayit yokken loop silmek kayit yaratmaz", s6.getItem(mixKey("yok")) === null);
  writeLoop(s6, "L3", { a: 5, b: 5 }, 70);
  check("gecersiz loop (b <= a) yazilmaz", s6.getItem(mixKey("L3")) === null);
  s6.setItem(mixKey("fut"), JSON.stringify({ v: 2, stems: {}, loop: { a: 1, b: 2 } }));
  writeLoop(s6, "fut", null, 80);
  check("uyumsuz surumlu kayda dokunulmaz", JSON.parse(s6.getItem(mixKey("fut"))).v === 2);
  check("validLoop", validLoop({ a: 1, b: 2 }).b === 2 && validLoop({ a: -1, b: 2 }) === undefined &&
    validLoop({ a: 3, b: 2 }) === undefined && validLoop({ a: "x", b: 2 }) === undefined &&
    validLoop(null) === undefined && validLoop("x") === undefined);
  const bad = normalizeRecord({ v: 1, master: 100, stems: {}, loop: { a: 9, b: 1 } });
  check("kayittaki gecersiz loop yok sayilir", bad && bad.loop === undefined);
  check("stems_version/pipeline anahtarda yok: loop sarki kimligine bagli",
    mixKey("L1") === MIX_PREFIX + "L1");
}

// --- LRU
const s5 = new FakeStorage();
s5.setItem("stem-mikser.meta.keep", "{}");
for (let i = 0; i < MIX_LIMIT + 5; i += 1) {
  writeMix(s5, `s${i}`, snapshot(chans({ drums: { mute: true } })), 100, 1000 + i);
}
const mixKeys = [...s5.map.keys()].filter((k) => k.startsWith(MIX_PREFIX));
check(`LRU ${MIX_LIMIT} ile sinirli`, mixKeys.length === MIX_LIMIT, String(mixKeys.length));
check("en eskiler gitti, yeniler kaldi", !s5.map.has(mixKey("s0")) && s5.map.has(mixKey("s44")));
check("meta kayitlarina dokunmaz", s5.map.has("stem-mikser.meta.keep"));

// --- silme
removeMix(s5, ["s44", "yok"]);
check("silinen sarkinin kaydi gider", !s5.map.has(mixKey("s44")));

// --- on ayarlar
const karaoke = applyPreset(preset("karaoke"), NAMES);
check("Karaoke: yalniz vokal susar", NAMES.every((n) => karaoke.get(n).mute === (n === "vocals")));
const drumless = applyPreset(preset("no-drums"), NAMES);
check("Davulu ben calıyorum: yalniz davul susar", drumless.get("drums").mute && !drumless.get("bass").mute);
const vo = applyPreset(preset("vocals-only"), NAMES);
check("Yalniz vokal: vokal solo", vo.get("vocals").solo && !vo.get("drums").solo);
check("on ayar tum kanallari temiz baslangica ceker", karaoke.get("bass").fader === 100);
check("hedef kanal yoksa null (dugme pasif)", applyPreset(preset("karaoke"), ["drums", "bass"]) === null);
check("alt kanalli sarkida calisir, bilinmeyen adlar atlanir",
  applyPreset(preset("no-drums"), ["drums", "kick", "snare"]).get("kick").mute === false);
check("cleanStates varsayilan", isDefaultMix(cleanStates(NAMES), 100));

console.log(failed ? `\n${failed} HATA` : "\nhepsi gecti");
process.exit(failed ? 1 : 0);
