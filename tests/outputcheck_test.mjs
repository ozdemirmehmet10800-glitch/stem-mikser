// Çıkış denetimi (frontend/js/outputcheck.js): "çalıyor ama sessiz" ayrımı. SENTETİK örnekler.
//
//     node tests\outputcheck_test.mjs

import { readFileSync } from "node:fs";
import { peakOf, outputVerdict, SILENT_PEAK } from "../frontend/js/outputcheck.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

check("tepe: mutlak değerin en büyüğü", peakOf(new Float32Array([0.1, -0.5, 0.2])) === 0.5 && peakOf([]) === 0);
const ok = { ctxState: "running", playing: true, audible: 4, masterGain: 1 };
check("çıkış var (tepe 0,2): sessiz DEĞİL, 'ses uygulamadan çıkıyor'", (() => { const v = outputVerdict({ ...ok, peaks: [0.2] }); return !v.silent && /uygulamadan çıkıyor/.test(v.text); })());
check("çıkış ~0 iki ölçümde de: SESSİZ (uygulama sessizlik üretiyor)", (() => { const v = outputVerdict({ ...ok, peaks: [0, 0] }); return v.silent && /çıkış sessiz görünüyor/.test(v.text) && /4 kanal/.test(v.text); })());
check("ilk ölçüm sessiz ama ikincide ses var (şarkının sessiz girişi): sessiz DEĞİL", !outputVerdict({ ...ok, peaks: [0, 0.05] }).silent);
check("eşik: SILENT_PEAK altı sessiz, üstü değil", outputVerdict({ ...ok, peaks: [SILENT_PEAK / 2] }).silent && !outputVerdict({ ...ok, peaks: [SILENT_PEAK * 2] }).silent);
check("ses bağlamı çalışmıyorsa (suspended) nedeni söyler", (() => { const v = outputVerdict({ ...ok, ctxState: "suspended", peaks: [0] }); return v.silent && /suspended/.test(v.text); })());
check("duyulur kanal yoksa sessizlik NORMAL (uyarı yok)", !outputVerdict({ ...ok, audible: 0, peaks: [0] }).silent);
check("ana ses sıfırsa nedeni söyler", (() => { const v = outputVerdict({ ...ok, masterGain: 0, peaks: [0] }); return v.silent && /Ana ses/.test(v.text); })());
check("çalmıyorsa uyarı yok", !outputVerdict({ ...ok, playing: false, peaks: [0] }).silent);
const source = readFileSync(new URL("../frontend/js/outputcheck.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
check("outputcheck.js: ağ / depolama / mikrofon / log yok", !/fetch\(|localStorage|sessionStorage|indexedDB|caches\.|getUserMedia|MediaRecorder|sendBeacon|XMLHttpRequest|console\./.test(source));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
