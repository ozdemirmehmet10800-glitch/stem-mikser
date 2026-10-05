// Kitaplık satırında rozet (Hi-Fi v2 ...) UZUN BAŞLIKTA kırpılmamalı. GERÇEK HATA (telefon, SW v54): `.song-name` nowrap + overflow:hidden
// idi ve rozet başlık metninin sonuna aynı kutuya eklenmişti; uzun başlık kutuyu doldurunca rozet taşıp kırpılıyordu.
// Kural: kırpma (ellipsis) YALNIZ başlık span'inde; kap esnek kutu, rozet küçülmez ve başlığın KARDEŞİ olur.
//
//     node tests\songrow_css_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const css = readFileSync(new URL("../frontend/css/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8");

const body = (selector) => {
  let found = null;
  for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (match[1].split(",").map((s) => s.trim()).includes(selector)) found = (found || "") + match[2];
  }
  return found;
};

const name = body(".song-name");
const title = body(".song-title");
const tag = body(".quality-tag");
check("kurallar var", Boolean(name && title && tag));
check(".song-name kırpmıyor (overflow:hidden / ellipsis YOK)", !/overflow\s*:\s*hidden/.test(name) && !/text-overflow/.test(name), name.trim());
check(".song-name esnek kutu (başlık küçülür, rozet yerinde)", /display\s*:\s*flex/.test(name) && /min-width\s*:\s*0/.test(name));
check(".song-title kendi içinde kısalır (…)", /text-overflow\s*:\s*ellipsis/.test(title) && /overflow\s*:\s*hidden/.test(title) && /white-space\s*:\s*nowrap/.test(title) && /min-width\s*:\s*0/.test(title));
check(".quality-tag küçülmez (flex:none)", /flex\s*:\s*none/.test(tag));

// app.js: başlık ve rozet AYNI kapta KARDEŞ (rozet başlık span'inin içine/üstüne metin olarak eklenmez)
check("app.js başlığı .song-title span'ine koyar", /title\.className\s*=\s*"song-title"/.test(app) && /name\.append\(title\)/.test(app));
check("app.js rozeti name.append(tag) ile kardeş ekler", /name\.append\(tag\)/.test(app));
const rowBlock = app.slice(app.indexOf('name.className = "song-name"'), app.indexOf('name.className = "song-name"') + 500);
check("kitaplık satırında başlık doğrudan name.textContent'e yazılmaz (rozet kırpılırdı)", rowBlock.includes("song-name") && !/name\.textContent\s*=/.test(rowBlock));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
