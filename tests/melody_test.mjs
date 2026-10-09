// Hedef melodi (frontend/js/melody.js): melody.bin okuma (SUNUCUDA üretilmiş örnek dosyayla), nota bölme, hedef arama, oktav katlama,
// değerlendirme (ton / "Plak gibi" kayması dahil), isabet sayacı. SENTETİK veri (gerçek şarkı / vokal / mikrofon YOK).
//
//     node tests\melody_test.mjs

import { readFileSync } from "node:fs";
import {
  decodeMelody, segmentNotes, NoteTrack, foldOctave, judge, Scoreboard, NOTE_MIN_FRAMES, HIT_CENTS,
} from "../frontend/js/melody.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- sunucunun ürettiği örnek dosya (backend/app.py::_melody_encode; test_melody_gate.py aynı baytları yeniden üretir)
const fixture = readFileSync(new URL("./fixtures/melody_sample.bin", import.meta.url));
const buffer = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
const melody = decodeMelody(buffer);
check("sunucu dosyası okunur: yöntem pyin, kaynak vocals, kare süresi, 36 kare", melody && melody.method === "pyin" && melody.source === "vocals" && melody.n === 36
  && near(melody.hopS, 0.02321995, 1e-9) && melody.frames.length === 36);
check("kareler birebir (int16 little-endian): sessiz 0, 69 = 6900, 57 = 5700", melody.frames[0] === 0 && melody.frames[2] === 6900 && melody.frames[14] === 5710 && melody.frames[26] === 7100);

// --- bozuk dosyalar
const bytes = new Uint8Array(buffer);
const mutate = (fn) => { const copy = bytes.slice(); fn(copy); return copy.buffer; };
check("bozuk: kesik / sihirli bayt / başlık uzunluğu / sürüm / boş / null", decodeMelody(buffer.slice(0, buffer.byteLength - 1)) === null
  && decodeMelody(mutate((b) => { b[0] = 0x58; })) === null
  && decodeMelody(mutate((b) => { b[4] = 0xff; b[5] = 0xff; b[6] = 0xff; b[7] = 0x7f; })) === null
  && decodeMelody(new TextEncoder().encode("MEL1\u0003\u0000\u0000\u0000{x}").buffer) === null
  && decodeMelody(new ArrayBuffer(0)) === null && decodeMelody(null) === null);

// --- nota bölme
const notes = segmentNotes(melody);
check("3 nota (MIDI 69, 57, 71); 2 karelik 6200 parçası nota sayılmadı", notes.length === 3 && notes.map((n) => n.midi).join() === "69,57,71", notes.map((n) => n.midi).join());
check("nota zamanları kare sınırlarında (t0 = kare x hop)", near(notes[0].t0, 2 * melody.hopS) && near(notes[0].t1, 10 * melody.hopS) && notes[1].frames === 8);
check("kısa parça (< 5 kare) nota sayılmaz", NOTE_MIN_FRAMES === 5 && segmentNotes({ frames: new Int16Array([6900, 6900, 6900, 6900, 0, 6900, 6900]), hopS: 0.02 }).length === 0);
check("aynı notadaki küçük titreme (vibrato ±40 cent) tek nota", segmentNotes({ frames: new Int16Array([6900, 6940, 6860, 6930, 6870, 6900, 6920]), hopS: 0.02 }).length === 1);
check("yarım ses atlayan iki nota ayrılır", segmentNotes({ frames: new Int16Array([6900, 6900, 6900, 6900, 6900, 7000, 7000, 7000, 7000, 7000]), hopS: 0.02 }).map((n) => n.midi).join() === "69,70");
check("sessizlik / boş", segmentNotes({ frames: new Int16Array(10), hopS: 0.02 }).length === 0 && segmentNotes({ frames: new Int16Array(0), hopS: 0.02 }).length === 0);

// --- hedef arama
const track = new NoteTrack(notes);
const t69 = notes[0].t0 + 0.05;
check("near: nota içindeyken o nota; çok uzaktayken yok", track.near(t69).length === 1 && track.near(t69)[0].midi === 69 && track.near(9.0).length === 0);
const lone = new NoteTrack([{ t0: 1, t1: 2, midi: 60, frames: 40 }]);
check("near: nota bitişinden hemen sonra zaman penceresi içinde (0,12 sn) hâlâ aday, daha sonra değil", lone.near(2.1).length === 1 && lone.near(2.2).length === 0 && lone.near(0.9).length === 1 && lone.near(0.8).length === 0);
const adjacent = new NoteTrack([{ t0: 0, t1: 1, midi: 60, frames: 40 }, { t0: 1, t1: 2, midi: 64, frames: 40 }]);
check("near: sınırda iki aday", adjacent.near(1.0).length === 2);
check("near: çok sayıda uzun nota arasında ikili arama doğru", (() => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ t0: i, t1: i + 0.8, midi: 50 + (i % 20), frames: 30 }));
  const t = new NoteTrack(many);
  return t.near(1000.4).length === 1 && t.near(1000.4)[0].midi === 50 + (1000 % 20) && t.near(5000).length === 0;
})());

// --- oktav katlama
check("foldOctave: hedefe en yakın oktav", foldOctave(57, 69) === 69 && foldOctave(81, 69) === 69 && foldOctave(69.3, 69) === 69.3 && near(foldOctave(56.8, 69), 68.8));

// --- değerlendirme
const at = (midi, shift = 0, extra = {}) => judge(midi, track, t69, { shift, ...extra });
let result = at(69.2);
check("doğru nota (+20 cent): isabet, fark ~+20", result.hit === true && near(result.diffCents, 20, 1e-6) && result.target === 69);
result = at(69.8);
check("+80 cent: kaçırdı", result.hit === false && near(result.diffCents, 80, 1e-6));
check("tolerans sınırı: 50 cent dahil, 51 değil", at(69.5).hit === true && at(69.51).hit === false && HIT_CENTS === 50);
result = at(57.1);
check("bir oktav aşağıdan söyleyen: oktav AÇIKKEN isabet (katlanmış, +10 cent)", result.hit === true && result.folded === true && near(result.diffCents, 10, 1e-6));
check("oktav KAPALIYKEN aynı ses isabet değil", at(57.1, 0, { octave: false }).hit === false);
check("iki oktav yukarı da katlanır", at(93.0).hit === true && at(93.0).folded === true);
result = at(null);
check("kullanıcı sessiz ama hedef var: kaçırdı (hit false), fark yok", result.hit === false && result.diffCents === null && result.target === 69);
check("hedef yokken (boşluk): hit null (puana girmez), kullanıcı konuşsa da", judge(60, track, 5.0, {}).hit === null && judge(null, track, 5.0, {}).hit === null);
check("ton +2 yarım ses: hedef 71'e kayar, 69'u söyleyen artık yanlış", at(71.0, 2).hit === true && at(69.0, 2).hit === false && at(71.0, 2).target === 71);
check("'Plak gibi' kesirli kayma (-2.83 yarım ses): hedef 66.17; 66.2 söyleyen isabet", at(66.2, -2.83).hit === true && near(at(66.2, -2.83).target, 66.17, 1e-9));
check("ton kayması + oktav katlama birlikte", at(54.2, -2.83).hit === true);
check("zaman penceresi: nota biterken hemen sonra söylenen (gecikme) hâlâ sayılır, uzakta puana girmez", judge(60, lone, 2.08, {}).hit === true && judge(60, lone, 2.3, {}).hit === null);
check("iki aday arasında perdeye en yakın seçilir (sınır)", (() => { const r = judge(64.1, adjacent, 1.0, {}); return r.hit === true && r.target === 64; })());

// --- isabet sayacı
{
  const board = new Scoreboard();
  board.add(0.5, true); board.add(1.0, true); board.add(1.5, false); board.add(2.5, null); board.add(3.0, true); board.add(3.5, undefined);
  check("sayaç: null/undefined kaydedilmez; toplam 4 kare, 3 isabet = %75", board.all().total === 4 && board.all().hits === 3 && board.all().percent === 75);
  check("aralık sorgusu [t0, t1)", board.range(0, 2).percent === 67 && board.range(2, 4).percent === 100 && board.range(10, 20).percent === null);
  board.reset();
  check("reset", board.all().total === 0);
  const big = new Scoreboard();
  for (let i = 0; i < 210000; i += 1) big.add(i * 0.02, i % 2 === 0);
  check("çok uzun oturumda sayaç sınırlı kalır (bellek)", big.times.length < 210000 && big.times.length === big.hits.length);
}

// --- bu dosyada mikrofon verisi / ağ / depolama yok
const source = readFileSync(new URL("../frontend/js/melody.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
check("melody.js: ağ / depolama / mikrofon API'si yok", !/fetch\(|localStorage|sessionStorage|indexedDB|caches\.|getUserMedia|MediaRecorder|sendBeacon|XMLHttpRequest|console\./.test(source));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
