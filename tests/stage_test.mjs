// Sahne modu mantığı (js/stage.js).   node tests\stage_test.mjs

import { stageState, stageProgress, holdUnlocks, LOCK_HOLD_MS } from "../frontend/js/stage.js";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const chords = [
  { i: 0, start: 0, end: 4, label: "C" },
  { i: 1, start: 4, end: 8, label: "N" },
  { i: 2, start: 8, end: 12, label: "Am" },
  { i: 3, start: 12, end: 16, label: "F" },
];
const lines = [{ t: 2, text: "bir" }, { t: 10, text: "iki" }, { t: 20, text: "üç" }];

let s = stageState({ chords, lines, time: 1 });
check("başta: C çalıyor, sıradaki akor Am ('N' atlanır), söz henüz yok", s.ci === 0 && s.next === 2 && s.li === -1 && s.nextLi === 0, JSON.stringify(s));
s = stageState({ chords, lines, time: 10.5 });
check("ortada: Am çalıyor, sıradaki F; söz satırı 1, sıradaki 2", s.ci === 2 && s.next === 3 && s.li === 1 && s.nextLi === 2, JSON.stringify(s));
s = stageState({ chords, lines, time: 5 });
check("'N' bölümünde akor yok (-1), sıradaki Am", s.ci === -1 && s.next === 2, JSON.stringify(s));
s = stageState({ chords, lines, time: 14 });
check("son akorda sıradaki yok", s.ci === 3 && s.next === -1);
s = stageState({ chords, lines, time: 30 });
check("son söz satırında sıradaki yok", s.li === 2 && s.nextLi === -1);
check("akor ve söz yoksa her şey -1 (çökme yok)", JSON.stringify(stageState({ time: 3 })) === JSON.stringify({ ci: -1, next: -1, li: -1, nextLi: -1 }));
check("yalnız akor / yalnız söz çalışır", stageState({ chords, time: 1 }).ci === 0 && stageState({ lines, time: 11 }).li === 1);
const same = [{ i: 0, start: 0, end: 4, label: "C" }, { i: 1, start: 4, end: 8, label: "C" }, { i: 2, start: 8, end: 12, label: "G" }];
check("sıradaki akor AYNI akor değil (tekrar atlanır)", stageState({ chords: same, time: 1 }).next === 2);

check("stageProgress: sınırlar ve geçersiz süre", stageProgress(5, 10) === 0.5 && stageProgress(-1, 10) === 0 && stageProgress(20, 10) === 1 && stageProgress(5, 0) === 0 && stageProgress(5, NaN) === 0);
check("kilit: yeterince basılı tutulunca açılır, kısa dokunuş açmaz", holdUnlocks(LOCK_HOLD_MS) && !holdUnlocks(LOCK_HOLD_MS - 1) && !holdUnlocks(NaN) && LOCK_HOLD_MS >= 500);

// kaynak: sahne kapanırken kilit ve ekran uyanıklığı BIRAKILIR; kilitliyken geri tuşu yutulur
const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");
const closeFn = /function closeStageDom\(\) \{([\s\S]*?)\n\}\n/.exec(app);
check("closeStageDom var ve kilidi + uyanıklığı bırakır", Boolean(closeFn) && /nav\.unblock\("stage-lock"\)/.test(closeFn[1]) && /releasePlaybackWake\(\)/.test(closeFn[1]));
check("kilitlenince geri tuşu engellenir (nav.block)", /nav\.block\("stage-lock"\)/.test(app));
check("sahne açıkken ek rAF döngüsü YOK (mevcut oynatıcı döngüsüne bağlanır)", !/function stageTick[\s\S]{0,400}requestAnimationFrame/.test(app));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
