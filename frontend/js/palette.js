// Kapaktan renk çıkarma ve şarkıya özel vurgu rengi: SAF mantık (canvas / DOM dışarıda). node tests\palette_test.mjs
//
// dominantColor: küçültülmüş piksellerden (RGBA dizisi) en canlı baskın RENK TONU (gri tonlu kapakta hue = null).
// themeColors: bu tondan koyu / aydınlık temaya uygun vurgu renkleri; koyu temada vurgu AÇIK (koyu zeminde okunur, gradyan üstü koyu yazı),
// aydınlık temada vurgu KOYU (açık zeminde okunur, gradyan üstü beyaz yazı).

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

export function rgbToHsl(r, g, b) {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === rf) h = ((gf - bf) / d) % 6;
  else if (max === gf) h = (bf - rf) / d + 2;
  else h = (rf - gf) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/**
 * pixels: Uint8ClampedArray (RGBA), adım 4. Dönen {hue (0-359) | null, sat (0-1), lightness (0-1), vivid (0-1)}.
 * Ağırlık = doygunluk x "orta parlaklık" (siyah/beyaz/gri pikseller sayılmaz); en ağırlıklı 15 derecelik dilim ve onun dairesel ortalaması.
 */
export function dominantColor(pixels) {
  const buckets = Array.from({ length: 24 }, () => ({ w: 0, sin: 0, cos: 0, s: 0, l: 0 }));
  let total = 0;
  let count = 0;
  let lightSum = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const { h, s, l } = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    count += 1;
    lightSum += l;
    const weight = s * (1 - Math.abs(2 * l - 1)) ** 1.5;
    if (weight < 0.02) continue;
    const bucket = buckets[Math.floor(h / 15) % 24];
    const rad = (h * Math.PI) / 180;
    bucket.w += weight;
    bucket.sin += Math.sin(rad) * weight;
    bucket.cos += Math.cos(rad) * weight;
    bucket.s += s * weight;
    bucket.l += l * weight;
    total += weight;
  }
  const meanLight = count ? lightSum / count : 0.5;
  if (!count || total < Math.max(count * 0.02, 0.5)) return { hue: null, sat: 0, lightness: meanLight, vivid: 0 };
  let best = buckets[0];
  for (const bucket of buckets) if (bucket.w > best.w) best = bucket;
  const hue = ((Math.atan2(best.sin, best.cos) * 180) / Math.PI + 360) % 360;
  return { hue: Math.round(hue), sat: best.s / best.w, lightness: best.l / best.w, vivid: clamp(total / count, 0, 1) };
}

const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;

const BG_DARK = 0.0035;          // #090b10 göreli parlaklığı (yaklaşık)
const BG_LIGHT = 0.92;           // #f4f6fa
const TEXT_ON_DARK_GRAD = 0.0075; // #06121a
const MIN_TEXT = 4.8;            // vurgu metni (zemin üstü)
const MIN_ON_GRAD = 3.2;         // gradyan üstündeki kalın düğme yazısı

/** Kontrast koşulu sağlanana dek parlaklığı kaydırır (koyu temada yukarı, aydınlıkta aşağı). */
function fitLightness(h, s, start, light) {
  let l = start;
  for (let i = 0; i < 60; i += 1) {
    const [r, g, b] = hslToRgb(h, s, l);
    const y = luminance(r, g, b);
    const ok = light
      ? contrast(y, BG_LIGHT) >= MIN_TEXT && contrast(y, 1) >= MIN_ON_GRAD
      : contrast(y, BG_DARK) >= MIN_TEXT && contrast(y, TEXT_ON_DARK_GRAD) >= MIN_ON_GRAD;
    if (ok) return l;
    l += light ? -1 : 1;
    if (l < 8 || l > 92) break;
  }
  return clamp(l, 8, 92);
}

/**
 * Vurgu renkleri. base: {hue (null = nötr), sat 0-1}; mode: "dark" | "light" | "black". Dönen:
 *   {accent, accent2, accentDim, grad, onGrad, c1, c2, neutral}
 * Gri tonlu kapakta (hue null) varsayılan camgöbeği-mor paletine DÖNÜLÜR (neutral: true). Parlaklık HER TON için kontrasta göre ayarlanır
 * (sarı/yeşil tonlar koyu temada daha açık değil, açık temada daha KOYU olmalı).
 */
export function themeColors(base, mode = "dark") {
  const light = mode === "light";
  const hue = base && base.hue !== null && base.hue !== undefined ? base.hue : null;
  const neutral = hue === null;
  const h = neutral ? 195 : hue;
  const sat = neutral ? 80 : clamp(((base && base.sat) || 0.7) * 100, 55, 92);
  const h2 = neutral ? 255 : h + 48;
  const s1 = light ? Math.min(sat, 80) : sat;
  const s2 = light ? Math.min(sat, 70) : Math.min(sat, 85);
  const accent = hsl(h, s1, fitLightness(((h % 360) + 360) % 360, s1, light ? 36 : 62, light));
  const accent2 = hsl(h2, s2, fitLightness(((h2 % 360) + 360) % 360, s2, light ? 42 : 66, light));
  return {
    accent,
    accent2,
    accentDim: light ? hsl(h, 60, 88) : hsl(h, 45, 26),
    grad: `linear-gradient(135deg, ${accent}, ${accent2})`,
    onGrad: light ? "#ffffff" : "#06121a",
    c1: hsl(h, Math.min(sat, 70), 34),
    c2: hsl(h2, Math.min(sat, 72), 22),
    neutral,
  };
}

/** Göreli parlaklık (WCAG) ve kontrast oranı: testler ve ayar denetimi için. */
export function luminance(r, g, b) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(l1, l2) {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** CSS hsl(h s% l%) metnini [r,g,b]'ye çevirir (test için). */
export function hslToRgb(h, s, l) {
  const sf = s / 100;
  const lf = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sf * Math.min(lf, 1 - lf);
  const f = (n) => lf - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
