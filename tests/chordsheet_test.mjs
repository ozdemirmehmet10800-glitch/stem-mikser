// Akorlu söz sayfası (frontend/js/chordsheet.js): sadeleştirme, akor -> kelime eşlemesi, sözsüz bölümler, ızgara, ton, DOM kurulumu.
// SENTETİK akor ve satırlar (gerçek söz yok).
//
//     node tests\chordsheet_test.mjs

import {
  stripBass, halfBarSeconds, prepareChords, displayLabel, soundingAt, wordIndexFor, mapSheet, buildGrid, tokensOf,
  renderMain, renderGap, renderGrid, GAP_CHIPS_SHOWN, GRID_BARS_PER_ROW,
} from "../frontend/js/chordsheet.js";
import { FakeEl } from "./fakedom.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const chord = (start, end, label) => ({ start, end, label });
const labels = (list) => list.map((c) => c.label).join(" ");
const create = (tag) => new FakeEl(tag);
const textOf = (el) => (el.children.length ? el.children.map(textOf).join("") : el.textContent);

// --- bas notası
check("stripBass: Ab/C -> Ab; N ve bassızlar aynen", stripBass("Ab/C") === "Ab" && stripBass("Fm") === "Fm" && stripBass("N") === "N");

// --- yarım ölçü
check("halfBarSeconds: downbeat medyanı / 2", Math.abs(halfBarSeconds({ downbeats: [0, 2, 4, 6.1, 8] }) - 1) < 1e-9);
check("halfBarSeconds: downbeat yoksa 0,7", halfBarSeconds({}) === 0.7 && halfBarSeconds(null) === 0.7);

// --- sadeleştirme
const data = (chords, extra = {}) => ({ downbeats: [0, 2, 4, 6, 8, 10, 12, 14, 16], chords, ...extra });   // yarım ölçü = 1 sn
let prep = prepareChords(data([chord(0, 2, "Fm"), chord(2, 4, "Ab/C"), chord(4, 6, "Ab"), chord(6, 8, "C")]));
check("evrik bas düşer, ardışık aynı akor birleşir (Ab/C + Ab -> tek Ab)", labels(prep) === "Fm Ab C" && prep[1].start === 2 && prep[1].end === 6);
prep = prepareChords(data([chord(0, 2, "Fm"), chord(2, 4, "Ab/C"), chord(4, 6, "Ab")]), { showBass: true });
check("showBass: evrik korunur", labels(prep) === "Fm Ab/C Ab");
prep = prepareChords(data([chord(0, 4, "Fm"), chord(4, 4.8, "C"), chord(4.8, 8, "Fm")]));
check("A-B-A, B yarım ölçüden kısa: B, A'ya katılır (tek Fm, süre korunur)", labels(prep) === "Fm" && prep[0].start === 0 && prep[0].end === 8);
prep = prepareChords(data([chord(0, 4, "Fm"), chord(4, 5, "C"), chord(5, 8, "Fm")]));
check("B tam yarım ölçülükse (1 sn, tolerans içinde) o da titreşim sayılır", labels(prep) === "Fm");
prep = prepareChords(data([chord(0, 4, "Fm"), chord(4, 6, "C"), chord(6, 8, "Fm")]));
check("B yarım ölçüden uzunsa korunur", labels(prep) === "Fm C Fm");
prep = prepareChords(data([chord(0, 2, "Fm"), chord(2, 3, "C"), chord(3, 4, "Fm"), chord(4, 5, "C"), chord(5, 6, "Fm")]));
check("A-B-A-B-A gibi gerçek ikili değişim korunur", labels(prep) === "Fm C Fm C Fm");
prep = prepareChords(data([chord(0, 2, "Fm"), chord(2, 4, "N"), chord(4, 6, "Fm")]));
check("N listede kalır (ızgarada '·'), süre boşluğu olmaz", labels(prep) === "Fm N Fm" && prep[0].end === prep[1].start);
prep = prepareChords(data([chord(0, 2, "Fm"), { start: "x", end: 3, label: "C" }, null, chord(5, 4, "G"), chord(2, 4, "C")]));
check("geçersiz girdiler atılır", labels(prep) === "Fm C" && prep.every((c, i) => c.i === i));
check("boş / null girdi", prepareChords(null).length === 0 && prepareChords({}).length === 0);

// --- ton
check("displayLabel: 0 kayma aynen, N '·'", displayLabel("Fm", 0, "Fm") === "Fm" && displayLabel("N", 3, "Fm") === "·");
check("displayLabel: Fm tonunda +2: Ab -> Bb (yeni tona göre bemol), Fm -> Gm", displayLabel("Ab", 2, "Fm") === "Bb" && displayLabel("Fm", 2, "Fm") === "Gm");
check("displayLabel: ton bilinmiyorsa diyez", displayLabel("Ab", 2, null) === "A#");
check("displayLabel: slash her iki notayı kaydırır", displayLabel("Ab/C", 2, "Fm") === "Bb/D");

// --- kelime indeksi
const line = (t, words, extra = {}) => ({ t, e: words[words.length - 1][1], text: words.map((w) => w[2]).join(" "), w: words, ...extra });
const L1 = line(10, [[10, 10.5, "bir"], [10.5, 11.5, "iki"], [12, 12.4, "üç"], [12.4, 13, "dört"]]);
check("wordIndexFor: kelimenin ilk %60'ında -> o kelime", wordIndexFor(L1, 10.2) === 0 && wordIndexFor(L1, 10.6) === 1);
check("wordIndexFor: kelimenin sonunda -> sıradaki kelime", wordIndexFor(L1, 11.3) === 2);
check("wordIndexFor: kelimeler arası boşlukta -> sıradaki", wordIndexFor(L1, 11.8) === 2);
check("wordIndexFor: satır başından hemen önce -> ilk kelime; satır sonu -> son kelime", wordIndexFor(L1, 9.95) === 0 && wordIndexFor(L1, 13.2) === 3);
check("wordIndexFor: son kelimenin ikinci yarısı son kelimede kalır", wordIndexFor(L1, 12.9) === 3);
check("wordIndexFor: kelime yoksa 0", wordIndexFor({ t: 1, e: 2, text: "x", w: [] }, 1.5) === 0);

// --- eşleme
const lines = [
  line(10, [[10, 10.5, "bir"], [10.5, 11.5, "iki"], [12, 12.4, "üç"], [12.4, 13, "dört"]]),    // 0
  line(14, [[14, 14.6, "beş"], [14.6, 15.4, "altı"], [15.4, 16, "yedi"]]),                     // 1  (boşluk 1 sn)
  line(30, [[30, 30.5, "sekiz"], [30.5, 31, "dokuz"]]),                                       // 2  (boşluk 14 sn: ara)
];
const chordsA = prepareChords({ downbeats: [], chords: [
  chord(0, 4, "Fm"), chord(4, 8, "N"), chord(8, 10.9, "Ab"), chord(10.9, 12.2, "C"), chord(12.2, 13.5, "Fm"),
  chord(13.5, 15.0, "Bb"),                                    // satırlar arası kısa boşlukta başlıyor -> satır 1'in ilk kelimesi
  chord(15.0, 20, "Gm"),                                      // satır 1 içinde
  chord(20, 24, "Cm"), chord(24, 29.8, "Db"),                 // ara (14 sn boşluk): iki akor
  chord(29.8, 40, "Fm"),                                      // satır 2'nin hemen öncesi (LEAD içinde)
] });
const map = mapSheet({ lines, chords: chordsA, duration: 45 });
const idx = (label) => chordsA.find((c) => c.label === label).i;
const anchorsOf = (i) => map.lines[i].anchors.map((a) => `${a.wi}${a.carry ? "c" : ""}:${chordsA[a.ci].label}`).join(" ");
check("satır 0: başta çalan Ab soluk (carry); C 'iki'nin ilk %60'ında (10.9) -> kelime 1; Fm 'üç'ün ilk %60'ında (12.2) -> kelime 2",
  anchorsOf(0) === "0c:Ab 1:C 2:Fm", anchorsOf(0));
check("satır 1: kısa boşlukta başlayan Bb ilk kelimeye, Gm içeride (15.0 -> 'yedi')", anchorsOf(1).startsWith("0:Bb") && anchorsOf(1).includes(":Gm"), anchorsOf(1));
check("N akoru kelimeye konmaz, hiçbir yerde 'N' yok", map.lines.every((l) => l.anchors.every((a) => chordsA[a.ci].label !== "N")));
check("sözsüz ara satırı: satır 2'nin ÖNCESİNDE, kind 'ara'", map.lines[2].pre && map.lines[2].pre.kind === "ara");
check("ara satırı: Cm ve Db akorları sırayla", map.lines[2].pre.chips.filter((c) => !c.carry).map((c) => chordsA[c.ci].label).join(" ") === "Cm Db");
check("ara satırı: başlangıçta çalan akor (Gm) soluk ilk akor olarak eklenir", map.lines[2].pre.chips[0].carry === true && chordsA[map.lines[2].pre.chips[0].ci].label === "Gm");
check("satır 2: satırdan 0,2 sn önce başlayan Fm ilk kelimeye (soluk değil), ara satırına DEĞİL", anchorsOf(2) === "0:Fm", anchorsOf(2));
check("kısa boşluk (<3 sn) sözsüz satır üretmez", map.lines[1].pre === null);

// giriş ve çıkış
const mapIO = mapSheet({
  lines: [line(8, [[8, 8.5, "a"], [8.5, 9, "b"]])],
  chords: prepareChords({ downbeats: [], chords: [chord(0, 2, "N"), chord(2, 4, "Fm"), chord(4, 6, "C"), chord(6, 8, "Fm"), chord(8, 20, "G"), chord(20, 24, "Am"), chord(24, 30, "F")] }),
  duration: 30,
});
check("giriş satırı (ilk söze 8 sn var): kind intro, N atlanır, Fm C Fm", mapIO.lines[0].pre.kind === "intro" && mapIO.lines[0].pre.chips.length === 3 && mapIO.lines[0].pre.chips.every((c) => !c.carry));
check("çıkış satırı: son satırdan sonra (post), kind outro, Am F; başta çalan G soluk", mapIO.lines[0].post.kind === "outro"
  && mapIO.lines[0].post.chips.length === 3 && mapIO.lines[0].post.chips[0].carry === true);
const mapShortTail = mapSheet({ lines: [line(5, [[5, 5.5, "a"], [5.5, 6, "b"]])], chords: prepareChords({ downbeats: [], chords: [chord(0, 6, "Fm"), chord(6.8, 8, "C")] }), duration: 8 });
check("kısa çıkış (<3 sn): sözsüz satır yok, akor son kelimeye", mapShortTail.lines[0].post === null && mapShortTail.lines[0].anchors.some((a) => a.wi === 1 && !a.carry));
check("satır ya da akor yoksa boş eşleme", mapSheet({ lines: [], chords: chordsA, duration: 9 }).lines.length === 0
  && mapSheet({ lines, chords: [], duration: 9 }).lines.every((l) => !l.anchors.length && !l.pre && !l.post));
check("soundingAt: aralık içi / dışı / N", soundingAt(chordsA, 1) === idx("Fm") && soundingAt(chordsA, 5) === -1 && soundingAt(chordsA, 100) === -1);

// --- ızgara
const gridChords = prepareChords({ downbeats: [0, 2, 4, 6, 8, 10, 12], chords: [chord(0, 3, "Fm"), chord(3, 4, "N"), chord(4, 9, "Ab"), chord(9, 12, "C")] });
const rows = buildGrid({ chords: gridChords, downbeats: [0, 2, 4, 6, 8, 10, 12], duration: 12 });
check(`ızgara: 6 ölçü -> ${GRID_BARS_PER_ROW}'er ölçülük satırlar (4 + 2)`, rows.length === 2 && rows[0].bars.length === GRID_BARS_PER_ROW && rows[1].bars.length === 2);
check("ızgara: 2. ölçüde (2-4) Fm devam (soluk) + N hücresi, 3. ölçü Ab", rows[0].bars[1].chips.length === 2 && rows[0].bars[1].chips[0].carry === true && gridChords[rows[0].bars[1].chips[1].ci].label === "N"
  && gridChords[rows[0].bars[2].chips[0].ci].label === "Ab" && !rows[0].bars[2].chips[0].carry);
check("ızgara: ölçü ortasında başlayan akor yeni hücre değil, aynı ölçüde ikinci akor", rows[1].bars[0].chips.length === 2 && rows[1].bars[0].chips[1].carry === false);
check("ızgara: downbeat yoksa her akor kendi hücresi", buildGrid({ chords: gridChords, downbeats: [], duration: 12 }).reduce((a, r) => a + r.bars.length, 0) === gridChords.length);
check("ızgara: akor yoksa boş", buildGrid({ chords: [], downbeats: [0, 2], duration: 4 }).length === 0);

// --- kelime parçaları
check("tokensOf: parçalar metinle uyuşur", tokensOf(lines[0], "tr").tokens.length === 4 && tokensOf(lines[0], "tr").joiner === " ");
check("tokensOf: Japonca ekleyici boş", tokensOf({ text: "てすと", w: [[1, 2, "て"], [2, 3, "す"], [3, 4, "と"]] }, "ja").joiner === "");
check("tokensOf: uyuşmazsa / kelime yoksa / boş parça varsa null",
  tokensOf({ text: "başka bir şey", w: [[1, 2, "x"]] }, "tr") === null && tokensOf({ text: "x", w: [] }, "tr") === null
  && tokensOf({ text: "a b", w: [[1, 2, "a"], [2, 3, " "], [3, 4, "b"]] }, "tr") === null);

// --- DOM: renderMain
const label = (ci) => displayLabel(chordsA[ci].label, 0, "Fm");
let main = new FakeEl("span");
let placed = renderMain({ create, main, line: lines[0], anchors: map.lines[0].anchors, language: "tr", label });
const units = main.children.filter((c) => c.className === "cw");
check("renderMain: akorlu her kelime bir .cw birimi (akor üstte .ccs, kelime .wd)", units.length === new Set(map.lines[0].anchors.map((a) => a.wi)).size
  && units.every((u) => u.children[0].className === "ccs" && u.children[1].className === "wd"));
check("renderMain: tüm kelimeler sırayla ve araları boşlukla korunur (akorsuz parçalar düz metin)", textOf(main).replace(/Ab|C|Fm/g, "").replace(/\s+/g, " ").trim() === "bir iki üç dört");
check("renderMain: yerleştirilen akor sayısı = anchor sayısı, data-ci var", placed.length === map.lines[0].anchors.length && placed.every((p) => p.el.dataset.ci === String(p.ci)));
check("renderMain: soluk (carry) akor sınıfı", placed.some((p) => p.el.className.includes("carry")) === map.lines[0].anchors.some((a) => a.carry));
main = new FakeEl("span");
placed = renderMain({ create, main, line: lines[0], anchors: [], language: "tr", label });
check("renderMain: akor yoksa düz metin", main.textContent === lines[0].text && placed.length === 0);
main = new FakeEl("span");
placed = renderMain({ create, main, line: { t: 1, e: 3, text: "tamamen farklı metin", w: [[1, 2, "x"]] }, anchors: [{ wi: 0, ci: 0, carry: false }], language: "tr", label });
check("renderMain: kelime parçaları metinle uyuşmuyorsa akorlar satırın üstünde ayrı akor satırı, metin bozulmaz",
  main.children[0].className === "chord-line" && main.children[1].textContent === "tamamen farklı metin" && placed.length === 1);
const jaLine = { t: 1, e: 4, text: "てすと", w: [[1, 2, "て"], [2, 3, "す"], [3, 4, "と"]] };
main = new FakeEl("span");
renderMain({ create, main, line: jaLine, anchors: [{ wi: 1, ci: 0, carry: false }], language: "ja", label });
check("renderMain: Japoncada araya boşluk girmez, yalnız akorlu karakter birim olur", textOf(main).replace(/Fm|Ab|C/g, "") === "てすと" && main.children.filter((c) => c.className === "cw").length === 1
  && !main.children.some((c) => c.className === "sp"));
main = new FakeEl("span");
renderMain({ create, main, line: lines[0], anchors: [{ wi: 1, ci: idx("Ab"), carry: false }, { wi: 1, ci: idx("C"), carry: false }], language: "tr", label });
check("renderMain: aynı kelimeye iki akor -> aynı .ccs içinde yan yana", main.children.find((c) => c.className === "cw").children[0].children.length === 2);

// --- DOM: sözsüz satır ve ızgara
const gap = renderGap({ create, gap: map.lines[2].pre, chords: chordsA, label });
check("renderGap: başlık 'Ara', akorlar tıklanınca gidilecek zaman data-t'de, carry soluk", gap.row.children[0].textContent === "Ara" && gap.placed.length === 3 && gap.placed[0].el.className.includes("carry")
  && gap.placed.every((p) => Number.isFinite(Number(p.el.dataset.t))));
const many = { kind: "outro", chips: Array.from({ length: GAP_CHIPS_SHOWN + 5 }, (_, k) => ({ ci: k % chordsA.length, carry: false })) };
let expanded = 0;
const gapMany = renderGap({ create, gap: many, chords: chordsA, label, onExpand: () => { expanded += 1; } });
const moreButton = gapMany.row.children[gapMany.row.children.length - 1];
check(`renderGap: ${GAP_CHIPS_SHOWN}'den fazla akor '+N' düğmesinin arkasında`, gapMany.placed.length === GAP_CHIPS_SHOWN && moreButton.textContent === "+5");
moreButton.fire("click", { stopPropagation() {} });
check("'+N' düğmesi açma işleyicisini çağırır", expanded === 1);
check("renderGap: genişletilmiş hâlde hepsi görünür, düğme yok", renderGap({ create, gap: many, chords: chordsA, label, expanded: true }).placed.length === many.chips.length);
const grid = renderGrid({ create, rows, chords: gridChords, label: (ci) => displayLabel(gridChords[ci].label, 0, "Fm") });
check("renderGrid: satır / ölçü / akor sayıları", grid.el.children.length === 2 && grid.el.children[0].children.length === 4 && grid.placed.length === rows.reduce((a, r) => a + r.bars.reduce((b, bar) => b + bar.chips.length, 0), 0));
check("renderGrid: N hücresi '·' yazar", grid.placed.some((p) => p.el.textContent === "·"));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
