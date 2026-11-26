// Karaoke kelime vurgusu (karaoke.js) + tam ekran sözlere ve oynatıcıya bağlantısı. SENTETİK satırlar; gerçek söz yok.
//
//     node tests\karaoke_test.mjs

import { sungIndex, wordClass, WordGlow, readWordGlow, writeWordGlow, WORDGLOW_KEY } from "../frontend/js/karaoke.js";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const line = { t: 10, e: 13, text: "bir iki üç", w: [[10, 10.5, "bir"], [10.6, 11.2, " iki"], [11.4, 12.9, " üç"]] };

// --- zaman -> kelime
check("ilk kelimeden önce -1", sungIndex(line.w, 9.9) === -1);
check("kelime başında o kelime", sungIndex(line.w, 10) === 0 && sungIndex(line.w, 10.6) === 1 && sungIndex(line.w, 11.4) === 2);
check("kelimeler arası boşlukta son başlayan kalır", sungIndex(line.w, 11.3) === 1);
check("satır sonundan sonra son kelime", sungIndex(line.w, 20) === 2);
check("bozuk/boş kelime listesi", sungIndex(null, 5) === -1 && sungIndex([], 5) === -1 && sungIndex([[NaN, 1, "x"]], 5) === -1);
check("sınıflar", wordClass(0, 1) === "kw done" && wordClass(1, 1) === "kw now" && wordClass(2, 1) === "kw" && wordClass(0, -1) === "kw");

// --- tercih (varsayılan AÇIK)
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const s1 = store();
check("varsayılan açık", readWordGlow(s1) === true && readWordGlow(null) === true);
writeWordGlow(s1, false);
check("kapatılınca kapalı kalır", readWordGlow(s1) === false && s1.getItem(WORDGLOW_KEY) === "0");
check("depolama atarsa çökmez", writeWordGlow({ setItem() { throw new Error("kota"); } }, true) === false
  && readWordGlow({ getItem() { throw new Error("x"); } }) === true);

// --- DOM parlatıcı (küçük sahte düğüm)
function node(tag) {
  return {
    tag, className: "", children: [], _text: "",
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text; },
    set textContent(v) { this.children = []; this._text = String(v); },
    append(...items) { this.children.push(...items); },
  };
}
const main = node("span");
main.textContent = line.text;
const glow = new WordGlow(node);
check("bağlanınca kelimelere bölünür, metin aynı kalır", glow.attach(main, line, "tr") === true && main.children.length === 3
  && main.textContent === "bir iki üç", main.textContent);
glow.update(10.7);
check("update: önceki done, şimdiki now, sonraki sönük", main.children.map((c) => c.className).join("|") === "kw done|kw now|kw");
let writes = 0;
for (const c of main.children) {
  let v = c.className;
  Object.defineProperty(c, "className", { get: () => v, set: (x) => { writes += 1; v = x; } });
}
glow.update(10.9);
check("aynı kelimede DOM'a yazmaz", writes === 0);
glow.update(11.5);
check("kelime değişince yalnız değişenler yazılır", writes === 2, String(writes));
glow.detach();
check("ayrılınca düz metne döner", main.children.length === 0 && main.textContent === "bir iki üç" && !glow.active);
const edited = { ...line, text: "tamamen başka metin" };
check("kelimeler metinle uyuşmazsa bölmez (düz kalır)", glow.attach(main, edited, "tr") === false && main.textContent === "bir iki üç");
check("kelime zamanı yoksa bölmez", glow.attach(main, { text: "a b", w: [] }, "en") === false);
const ja = { text: "夜の街", w: [[1, 1.4, "夜"], [1.4, 1.6, "の"], [1.6, 2, "街"]] };
const jaMain = node("span");
jaMain.textContent = ja.text;
check("Japoncada boşluksuz birleşir", glow.attach(jaMain, ja, "ja") === true && jaMain.textContent === "夜の街");
glow.forget();
check("forget düğüme dokunmaz", jaMain.children.length === 3 && !glow.active);

// --- bağlantılar (kaynak metin)
const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8");
const screen = readFileSync(new URL("../frontend/js/lyricsscreen.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("../frontend/sw.js", import.meta.url), "utf8");
check("Ayarlar'da aç/kapa anahtarı", /id="setting-wordglow" role="switch"/.test(html) && /on\("setting-wordglow", "change"/.test(app)
  && /el\("setting-wordglow"\)\.checked = wordGlowOn/.test(app));
check("tercih, tam ekran sözler kurulmadan ÖNCE tanımlı (yoksa açılışta ReferenceError)",
  app.indexOf("let wordGlowOn") > 0 && app.indexOf("let wordGlowOn") < app.indexOf("new LyricsScreen("));
check("oynatıcı: akorlu sayfa açıkken bölmez, satır değişince bağlanır, karede günceller",
  /if \(!wordGlowOn \|\| sheetRendered/.test(app) && /lyricsIndex = index;\s*attachPlayerGlow\(index\);/.test(app)
  && /if \(playerGlow\.active\) playerGlow\.update\(probe\)/.test(app));
check("liste ya da akor sayfası yeniden kurulunca eski düğümler unutulur",
  /playerGlow\.forget\(\);\s*\/\/ düğümler baştan/.test(app) && /playerGlow\.forget\(\);\s*\/\/ satır düğümleri yeniden/.test(app));
check("tam ekran: ayarla açılır, tick'te güncellenir, kapanınca ayrılır",
  /wordGlow = false/.test(screen) && /if \(this\.glow\.active\) this\.glow\.update\(probe\)/.test(screen) && /setWordGlow\(on\)/.test(screen)
  && /this\.isOpen = false;\s*this\.glow\.detach\(\);/.test(screen));
check("modül çevrimdışı kabukta", sw.includes('"./js/karaoke.js"'));

console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nhepsi geçti");
process.exit(failed ? 1 : 0);
