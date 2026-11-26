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

// nabız seviyesi (js/stage.js pulseLevel) ve kelime parlaması / analizör kaynak denetimi
{
  const { pulseLevel } = await import("../frontend/js/stage.js");
  const ok = pulseLevel(0, 0) === 0 && pulseLevel(0.1, 0) > 0.29 && pulseLevel(1, 0) === 1 && pulseLevel(5, 0) === 1 && pulseLevel(-1, 0) === 0 && pulseLevel(NaN, 0.5) < 0.5
    && Math.abs(pulseLevel(0, 1) - 0.88) < 1e-9 && Math.abs(pulseLevel(0.3, 0.2) - 0.9) < 1e-9;
  console.log(`${ok ? "ok  " : "FAIL"} pulseLevel: sınırlar, hızlı yükseliş, yavaş düşüş`);
  const src = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");
  const open = /function stageAnalyserOpen\(\) \{([\s\S]*?)\n\}\n/.exec(src);
  const close = /function stageAnalyserClose\(\) \{([\s\S]*?)\n\}\n/.exec(src);
  const closeStage = /function closeStageDom\(\) \{([\s\S]*?)\n\}\n/.exec(src);
  const ok2 = Boolean(open && close && closeStage) && /createAnalyser/.test(open[1]) && /disconnect\(stageAnalyser\)/.test(close[1]) && /stageAnalyserClose\(\)/.test(closeStage[1])
    && /if \(now - stagePulseAt < 66\) return;/.test(src) && !/stageAnalyserOpen\(\);[\s\S]{0,80}setInterval/.test(src);
  console.log(`${ok2 ? "ok  " : "FAIL"} analizör yalnız sahne açıkken bağlanır, kapanınca sökülür, ~15 Hz ile okunur (ek döngü yok)`);
  const ok3 = /wordIndexFor\(lines\[state\.li\], time\)/.test(src) && /stageWords\.forEach/.test(src);
  console.log(`${ok3 ? "ok  " : "FAIL"} kelime kelime parlama: kelime zamanlaması (line.w) kullanılır`);
  if (!ok || !ok2 || !ok3) process.exit(1);
}

// Sahnede satırın okunuşu ve çevirisi (2026-11-26): söz panelindeki düğmelere uyar, satır değişince ve çeviri gelince yenilenir.
{
  const src = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");
  const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../frontend/css/styles.css", import.meta.url), "utf8");
  const checks = [
    ["sahne: okunuş ve çeviri satırları sözün altında, başta gizli",
      /id="stage-line"><\/div>\s*<div class="stage-sub stage-ro" id="stage-ro" hidden><\/div>\s*<div class="stage-sub stage-tr" id="stage-tr" hidden><\/div>/.test(html)],
    ["sahne: alt yazılar söz panelinin seçimiyle (trShow) ve aynı kaynaktan (subsList)",
      /function stageRenderSubs\(index\) \{[\s\S]{0,300}TR\.subsList\(\[line\], trMap, trShow, trLang\(\)\)/.test(src)],
    ["sahne: satır değişince yenilenir", /stageRenderLine\(state\.li >= 0 \? lines\[state\.li\] : null\);\s*stageRenderSubs\(state\.li\);/.test(src)],
    ["sahne: çeviri gelince / düğmeye basınca yenilenir", /function refreshLyricSubs[\s\S]{0,900}if \(stageOpen\) stageRenderSubs\(stageLast\.li\);/.test(src)],
    ["sahne: boş alt yazı gizli kalır", /\.stage-sub\[hidden\] \{ display: none; \}/.test(css)],
    ["sahne: tam klipte alt yazılar küçülür", /\.stage\.clip-full \.stage-sub \{ font-size:/.test(css)],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) bad += 1;
  }
  if (bad) process.exit(1);
}
