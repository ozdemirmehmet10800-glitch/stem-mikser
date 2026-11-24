// Kapaktan renk çıkarma ve vurgu renkleri (js/palette.js): baskın ton, gri kapak, kontrast.   node tests\palette_test.mjs

import { dominantColor, themeColors, rgbToHsl, luminance, contrast, hslToRgb } from "../frontend/js/palette.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const fill = (n, [r, g, b, a = 255]) => { const px = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i += 1) px.set([r, g, b, a], i * 4); return px; };
const concat = (...arrs) => { const out = new Uint8ClampedArray(arrs.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

check("rgbToHsl: kırmızı 0, yeşil 120, mavi 240, gri s=0", Math.round(rgbToHsl(255, 0, 0).h) === 0 && Math.round(rgbToHsl(0, 255, 0).h) === 120 && Math.round(rgbToHsl(0, 0, 255).h) === 240 && rgbToHsl(120, 120, 120).s === 0);
let d = dominantColor(fill(400, [30, 90, 220]));
check("düz mavi kapak: ton ~220", d.hue !== null && Math.abs(d.hue - 220) <= 4 && d.sat > 0.6, JSON.stringify(d));
d = dominantColor(concat(fill(300, [220, 40, 40]), fill(100, [30, 90, 220])));
check("karışık: çoğunluktaki kırmızı kazanır", d.hue !== null && (d.hue <= 6 || d.hue >= 354), JSON.stringify(d));
d = dominantColor(concat(fill(380, [250, 250, 250]), fill(20, [220, 40, 40])));
check("çoğu beyaz, az kırmızı: sönük pikseller sayılmaz ama canlı olan bulunur (ya da nötr)", d.hue === null || d.hue <= 6 || d.hue >= 354, JSON.stringify(d));
d = dominantColor(fill(400, [128, 128, 128]));
check("gri kapak: ton yok (null)", d.hue === null);
d = dominantColor(concat(fill(200, [0, 0, 0]), fill(200, [255, 255, 255])));
check("siyah-beyaz kapak: ton yok (null)", d.hue === null);
d = dominantColor(fill(400, [200, 40, 40, 0]));
check("saydam pikseller atlanır, boş girdi güvenli", d.hue === null && dominantColor(new Uint8ClampedArray(0)).hue === null);
d = dominantColor(concat(fill(100, [220, 200, 20]), fill(100, [20, 200, 220])));
check("iki eşit canlı renk: ikisinden biri seçilir (karışmaz, ara ton olan yeşil çıkmaz)", d.hue !== null && (Math.abs(d.hue - 52) < 10 || Math.abs(d.hue - 183) < 10), String(d.hue));

// kontrast: koyu temada vurgu koyu zeminde, açık temada beyaz zeminde okunur; gradyan üstü yazı da
const bgDark = luminance(...hslToRgb(228, 25, 6));
const bgLight = luminance(244, 246, 250);
let darkOk = true, lightOk = true, onGradOk = true, minDark = 99, minLight = 99, minOn = 99;
for (let hue = 0; hue < 360; hue += 10) {
  const dk = themeColors({ hue, sat: 0.85 }, "dark");
  const lg = themeColors({ hue, sat: 0.85 }, "light");
  const parse = (s) => { const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(s); return hslToRgb(+m[1], +m[2], +m[3]); };
  const cd = contrast(luminance(...parse(dk.accent)), bgDark);
  const cl = contrast(luminance(...parse(lg.accent)), bgLight);
  minDark = Math.min(minDark, cd); minLight = Math.min(minLight, cl);
  if (cd < 4.5) darkOk = false;
  if (cl < 4.5) lightOk = false;
  // gradyanın iki ucu üstünde koyu (dark) / beyaz (light) yazı: >= 3:1 (büyük/kalın düğme yazısı)
  const dText = luminance(6, 18, 26);
  for (const c of [dk.accent, dk.accent2]) { const k = contrast(luminance(...parse(c)), dText); minOn = Math.min(minOn, k); if (k < 3) onGradOk = false; }
  for (const c of [lg.accent, lg.accent2]) { const k = contrast(luminance(...parse(c)), luminance(255, 255, 255)); minOn = Math.min(minOn, k); if (k < 3) onGradOk = false; }
}
check("koyu tema: vurgu rengi koyu zeminde >= 4,5:1 (tüm tonlar)", darkOk, minDark.toFixed(2));
check("aydınlık tema: vurgu rengi açık zeminde >= 4,5:1 (tüm tonlar)", lightOk, minLight.toFixed(2));
check("gradyan üstündeki düğme yazısı >= 3:1 (iki tema, tüm tonlar)", onGradOk, minOn.toFixed(2));

const n = themeColors({ hue: null, sat: 0 }, "dark");
check("gri kapak: varsayılan camgöbeği-mor palete döner (neutral)", n.neutral && /hsl\(195 /.test(n.accent));
check("modlar: onGrad koyu/beyaz, black = dark ile aynı vurgu", themeColors({ hue: 10, sat: 0.8 }, "light").onGrad === "#ffffff" && themeColors({ hue: 10, sat: 0.8 }, "dark").onGrad === "#06121a" && themeColors({ hue: 10, sat: 0.8 }, "black").accent === themeColors({ hue: 10, sat: 0.8 }, "dark").accent);
check("gradyan metni", /^linear-gradient\(135deg, hsl\(/.test(themeColors({ hue: 120, sat: 0.7 }).grad));
check("doygunluk 55-92 aralığına sıkışır", /hsl\(\d+ (55|56|57)%/.test(themeColors({ hue: 30, sat: 0.1 }).accent) && /hsl\(\d+ (91|92)%/.test(themeColors({ hue: 30, sat: 1 }).accent));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
