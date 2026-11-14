// Şarkı değişirken söz yüklemesi tutulur (app.js lyricsHold): kaynak taraması. Sözlü -> sözsüz geçişte, currentSong yeni şarkıya geçmeden
// eski şarkı için geç gelen bir tazeleme tam ekrana eski sözleri GERİ KOYMASIN. Hata yolunda tutma mutlaka kalkar.
//   node tests\lyrics_switch_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");
const open = app.slice(app.indexOf("async function openSong("), app.indexOf("function buildSubdivisionButtons"));
check("openSong bulundu", open.length > 1000);
const hold = open.indexOf("lyricsHold = true;");
const reset = open.indexOf("resetLyrics();");
const assign = open.indexOf("currentSong = { ...song, ...detail };");
const release = open.indexOf("lyricsHold = false;", assign);
check("tutma, eski sözler sıfırlanmadan ÖNCE başlar", hold > 0 && hold < reset);
check("tutma, currentSong yeni şarkıya geçince HEMEN kalkar", assign > reset && release > assign && release - assign < 120);
check("tutma ile bırakma arasında erken dönüş (return) yok", !/\breturn\b/.test(open.slice(hold, assign)));
const catchPart = open.slice(open.lastIndexOf("} catch (error) {"));
check("hata yolunda tutma kalkar (söz yüklemesi sonsuza dek kilitlenmez)", /currentSong = null;\s*lyricsHold = false;/.test(catchPart));
check("hızlı yol (aynı şarkı) tutmaya hiç girmez", open.indexOf("if (canReuseLoaded(song))") < hold && /return true;/.test(open.slice(open.indexOf("if (canReuseLoaded(song))"), hold)));
const load = /async function loadLyricsDoc\(\) \{\n([^\n]*)\n/.exec(app);
check("loadLyricsDoc tutma sürerken hiçbir şey yüklemez", Boolean(load) && /lyricsHold/.test(load[1]) && /return/.test(load[1]));
check("adoptDetail başka şarkının bilgisini açık şarkıya karıştırmaz (kimlik denetimi)", /function adoptDetail\(detail\) \{\n\s*if \([^\n]*detail\.status\.id !== currentSong\.id\) return;/.test(app));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
