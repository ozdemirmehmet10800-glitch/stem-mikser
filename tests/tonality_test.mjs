// Ön yüz ton/akor transpoze testleri.  Çalıştırma:  node tests/tonality_test.mjs
//
// Bu mantık arka uçtaki _key_uses_flats / _chord_label'ın ikizi; ikisi
// ayrışırsa akor şeridi ton değişince yanlış yazım gösterir.

import {
  keyUsesFlats, parseKey, keyName, transposeKey,
  namesForKey, transposeLabel, transposeChords,
} from "../frontend/js/tonality.js";

let passed = 0;
const failures = [];

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${what}: beklenen ${e}, gelen ${a}`);
}

// --- bemol/diyez seçimi ---------------------------------------------------
eq(keyUsesFlats(0, false), false, "C majör diyez tarafı");
eq(keyUsesFlats(5, false), true, "F majör bemollü");
eq(keyUsesFlats(5, true), true, "Fm -> Ab -> bemollü");
eq(keyUsesFlats(9, true), false, "Am -> C -> diyez tarafı");
eq(keyUsesFlats(6, false), false, "F# majör diyezli (6 diyez)");
eq(keyUsesFlats(1, false), true, "Db majör bemollü");

// --- ton adı ayrıştırma ve yazımı ----------------------------------------
eq(parseKey("Fm"), { tonic: 5, minor: true }, "Fm ayrıştırma");
eq(parseKey("C#"), { tonic: 1, minor: false }, "C# ayrıştırma");
eq(parseKey("Bb"), { tonic: 10, minor: false }, "Bb ayrıştırma");
eq(parseKey(""), null, "boş ton");
eq(parseKey("Hm"), null, "geçersiz ton adı");
eq(parseKey(undefined), null, "tanımsız ton");

eq(keyName(3, false), "Eb", "3 majör -> Eb");
eq(keyName(3, true), "D#m", "3 minör -> D#m (F# tarafı)");
eq(keyName(8, true), "G#m", "8 minör -> G#m");
eq(keyName(10, false), "Bb", "10 majör -> Bb");

// --- ton transpozesi ------------------------------------------------------
eq(transposeKey("Fm", 0), "Fm", "Fm +0");
eq(transposeKey("Fm", 2), "Gm", "Fm +2 -> Gm");
eq(transposeKey("Cm", 1), "C#m", "Cm +1 -> C#m (planda verilen örnek)");
eq(transposeKey("Fm", -1), "Em", "Fm -1 -> Em");
eq(transposeKey("Fm", 6), "Bm", "Fm +6 -> Bm");
eq(transposeKey("Fm", -6), "Bm", "Fm -6 de Bm (oktav sarması)");
eq(transposeKey("C", 5), "F", "C +5 -> F");
eq(transposeKey("bilinmiyor", 2), null, "geçersiz tonda null");

// --- akor etiketi transpozesi --------------------------------------------
// Fm +2 = Gm, Gm bemollü (rel. Bb) -> Bb/Eb tarafı.
const gmNames = namesForKey("Fm", 2);
eq(transposeLabel("Ab", 2, gmNames), "Bb", "Ab +2 -> Bb (A# DEĞİL)");
eq(transposeLabel("Fm", 2, gmNames), "Gm", "Fm +2 -> Gm");
eq(transposeLabel("Ab/C", 2, gmNames), "Bb/D", "slash akor +2");
eq(transposeLabel("Db/F", 2, gmNames), "Eb/G", "slash akor bemollü kalıyor");
eq(transposeLabel("N", 2, gmNames), "N", "akor yok işareti korunuyor");
eq(transposeLabel("", 2, gmNames), "", "boş etiket");
eq(transposeLabel("Dbmaj7", 2, gmNames), "Dbmaj7", "tanınmayan etiket dokunulmuyor");

// Cm +1 = C#m, C#m diyezli (rel. E) -> diyez yazımı.
const csmNames = namesForKey("Cm", 1);
eq(transposeLabel("Eb", 1, csmNames), "E", "Eb +1 -> E");
eq(transposeLabel("Ab", 1, csmNames), "A", "Ab +1 -> A");
eq(transposeLabel("Bb", 1, csmNames), "B", "Bb +1 -> B");
eq(transposeLabel("Cm", 1, csmNames), "C#m", "Cm +1 -> C#m");

// Ton bilinmiyorsa diyez tarafı (arka ucun varsayılanı).
eq(namesForKey(null, 2)[1], "C#", "ton bilinmiyorsa diyez");
eq(namesForKey("Fm", 0)[1], "Db", "Fm'de bemol yazımı korunuyor");

// --- liste transpozesi ----------------------------------------------------
const chords = [
  { start: 0, end: 2, label: "Fm" },
  { start: 2, end: 4, label: "Ab/C" },
  { start: 4, end: 6, label: "N" },
];
const moved = transposeChords(chords, 2, "Fm");
eq(moved.map((c) => c.label), ["Gm", "Bb/D", "N"], "liste +2");
eq(moved[0].start, 0, "zaman alanları korunuyor");
eq(transposeChords(chords, 0, "Fm") === chords, true, "0 yarım seste aynı dizi");

// --- oktav sarması her yönde --------------------------------------------
for (let semis = -6; semis <= 6; semis += 1) {
  const label = transposeLabel("C", semis, namesForKey("C", semis));
  const back = transposeLabel(label, -semis, namesForKey("C", 0));
  eq(back, "C", `C ${semis >= 0 ? "+" : ""}${semis} sonra geri -> C`);
}

// -------------------------------------------------------------------------
if (failures.length) {
  console.error(`${failures.length} test BAŞARISIZ (${passed} geçti):`);
  for (const line of failures) console.error("  - " + line);
  process.exit(1);
}
console.log(`${passed}/${passed} test geçti.`);
