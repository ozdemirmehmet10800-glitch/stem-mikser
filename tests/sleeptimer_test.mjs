// Uyku zamanlayıcısı (js/sleeptimer.js): süre, kısma, bitiş, şarkı sonu kipi, geçersiz değerler.   node tests\sleeptimer_test.mjs

import { SleepTimer, FADE_MS, formatRemaining, SLEEP_MINUTES, MAX_MINUTES } from "../frontend/js/sleeptimer.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const t = new SleepTimer();
check("başlangıçta kapalı, çarpan 1", !t.active && t.tick(0).gain === 1 && !t.tick(0).expired);
check("15 dk başlar, kalan süre doğru", t.startMinutes(15, 1000) && t.active && t.tick(1000).remainingMs === 15 * 60000);
check("kısma başlamadan önce çarpan 1", t.tick(1000 + 15 * 60000 - FADE_MS - 1).gain === 1);
const mid = t.tick(1000 + 15 * 60000 - FADE_MS / 2);
check("son 20 sn'de doğrusal kısılır (yarıda 0,5)", Math.abs(mid.gain - 0.5) < 1e-9 && mid.active && !mid.expired, String(mid.gain));
const done = t.tick(1000 + 15 * 60000);
check("süre dolunca expired + kapanır (bir kez)", done.expired && !t.active && !t.tick(1000 + 20 * 60000).expired);
check("iptal", (() => { t.startMinutes(30, 0); t.cancel(); return !t.active; })());
check("geçersiz dakika reddedilir, durum bozulmaz", !t.startMinutes(0, 0) && !t.startMinutes(-5, 0) && !t.startMinutes(NaN, 0) && !t.startMinutes(MAX_MINUTES + 1, 0) && !t.active);
t.startAtEnd();
const end = t.tick(999999);
check("şarkı sonu kipi: etkin, süre yok, kısma yok, süreyle dolmaz", end.active && end.atEnd && end.remainingMs === null && end.gain === 1 && !end.expired && t.atEnd);
t.startMinutes(15, 0);
check("dakika kipine geçince şarkı sonu kalkar", !t.atEnd && t.active);
check("formatRemaining", formatRemaining(0) === "0:00" && formatRemaining(61000) === "1:01" && formatRemaining(59001) === "1:00" && formatRemaining(-5) === "0:00" && formatRemaining(NaN) === "0:00");
check("seçenekler 15/30/60", JSON.stringify(SLEEP_MINUTES) === "[15,30,60]");

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
