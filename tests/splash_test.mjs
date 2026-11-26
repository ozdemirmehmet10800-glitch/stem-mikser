// Açılış ekranı (index.html #splash, css, js/look.js): tercih, paylaş menüsünde gösterilmeme, betiksiz kendiliğinden kalkma.
//
//     node tests\splash_test.mjs

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const require = createRequire(import.meta.url);
const look = require("../frontend/js/look.js");
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../frontend/index.html");
const css = read("../frontend/css/styles.css");
const app = read("../frontend/js/app.js");

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

// --- tercih
const s = store();
check("varsayılan AÇIK", look.readSplash(s) === true && look.readSplash(null) === true);
check("okunamazsa açık", look.readSplash({ getItem() { throw new Error("x"); } }) === true);
look.setSplash(false, s);
check("kapatılınca kapalı ('0')", look.readSplash(s) === false && s.getItem(look.SPLASH_KEY) === "0");
look.setSplash(true, s);
check("yeniden açılır", look.readSplash(s) === true);
check("yazılamazsa çökmez", look.setSplash(true, { setItem() { throw new Error("kota"); } }) === false);
check("paylaş menüsünden açılınca gösterilmez", look.wantsSplash("?paylasim=1", store()) === false && look.wantsSplash("?paylasim", store()) === false
  && look.wantsSplash("", store()) === true && look.wantsSplash("?klasik=0", store()) === true);

// --- işaretleme ve stil
const splash = html.slice(html.indexOf('<div class="splash" id="splash"'), html.indexOf("<svg width=\"0\""));
check("index.html'de, body'nin başında, ekran okuyucudan gizli", /<body>\s*(?:<!--[\s\S]*?-->\s*)?<div class="splash" id="splash" aria-hidden="true">/.test(html));
check("uygulama adı ve geliştiren adı", splash.includes("Stem Mikser") && /Geliştiren<\/span><strong>Berkay Özdemir<\/strong>/.test(splash));
check("betik olmadan da kalkar (CSS animasyonu, gecikmeli çıkış, görünmez olur)",
  /\.splash \{[^}]*animation: splash-out [\d.]+s [^;]*[\d.]+s forwards;/.test(css) && /@keyframes splash-out \{ to \{ opacity: 0;[^}]*visibility: hidden; \} \}/.test(css));
check("kapalıyken hiç görünmez", /html\.no-splash \.splash \{ display: none; \}/.test(css));
check("dokununca hızlı geçiş", /\.splash\.skip \{ animation: splash-out/.test(css));
check("azaltılmış hareket: giriş animasyonları yok", /@media \(prefers-reduced-motion: reduce\) \{\s*\.splash-glow[^}]*animation: none;/.test(css));
const motion = css.slice(css.indexOf("/* ---------- açılış ekranı"), css.length);
const kf = [...motion.matchAll(/@keyframes splash-[\w-]+ \{([^@]*?)\}\s*\}/g)].map((m) => m[1]).join(" ");
check("animasyonlar yalnız transform + opacity (+ çıkışta visibility)", !/(?:width|height|top|left|margin|padding|filter)\s*:/.test(kf), kf.slice(0, 80));
check("en üst katman (oturum sayfalarının üstünde)", /\.splash \{[^}]*z-index: 10000;/.test(css));

// --- Ayarlar
check("Ayarlar > Görünüm'de aç/kapa", /id="setting-splash" role="switch"/.test(html)
  && /el\("setting-splash"\)\.checked = Boolean\(globalThis\.StemLook && globalThis\.StemLook\.readSplash\(/.test(app)
  && /on\("setting-splash", "change"/.test(app) && /StemLook\.setSplash\(el\("setting-splash"\)\.checked/.test(app));

console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nhepsi geçti");
process.exit(failed ? 1 : 0);
