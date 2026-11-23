// Çevrimdışı kopya dökümü ve tanı raporu (js/cachelist.js).   node tests\cachelist_test.mjs

import { summarizeBySong, formatSize, buildReport } from "../frontend/js/cachelist.js";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const index = {
  "stems/a/vocals.m4a": { songId: "a", size: 3000000 },
  "stems/a/drums.m4a": { songId: "a", size: 2000000 },
  "stems/b/vocals.m4a": { songId: "b", size: 9000000 },
  bozuk: null,
  "stems/c/x": { size: 5 },
};
const rows = summarizeBySong(index);
check("şarkı başına toplam, büyükten küçüğe, bozuk girdiler atlanır", rows.length === 2 && rows[0].songId === "b" && rows[1].songId === "a" && rows[1].bytes === 5000000 && rows[1].files === 2, JSON.stringify(rows));
check("boş/null indeks", summarizeBySong(null).length === 0 && summarizeBySong({}).length === 0);
check("formatSize", formatSize(500) === "1 KB" && formatSize(2 * 1024 ** 2) === "2.0 MB" && formatSize(3 * 1024 ** 3) === "3.0 GB");
const report = buildReport([["Sürüm", ["SW v71", "", null]], ["Boş", []], ["Depolama", ["5 favori"]]]);
check("rapor: boş satır/bölüm atlanır", report === "== Sürüm ==\nSW v71\n== Depolama ==\n5 favori", JSON.stringify(report));

// uygulama kaynağı: rapor SIR içermemeli
const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");
const fn = /function fullReportText\(\) \{([\s\S]*?)\n\}\n/.exec(app);
check("fullReportText var", Boolean(fn));
const body = fn ? fn[1] : "";
check("rapor token / API adresi / söz / mikrofon alanı İÇERMEZ", !/settings\.token|settings\.url|\.token\b|lyricsDoc|translation|trainerMic|api\.url/.test(body));
check("rapor silme/temizleme çağrısı İÇERMEZ (salt okunur)", !/\.clear\(|removeSongs|removeItem|setItem/.test(body));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
