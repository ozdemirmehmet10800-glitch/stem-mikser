// Şarkılar arası yumuşak geçiş ve kitaplıkta klip önizlemesi: SAF karar mantığı (DOM/ses yok).   node tests\crossfade_test.mjs
//
// Geçiş: çalma listesinde / sırada sonraki şarkı varken şarkı son `seconds` saniyede kısılarak biter (motorun geçiş kazancı, engine.fadeOutput),
// sonraki şarkı açılınca yavaşça yükselir. İki şarkı aynı anda belleğe alınmaz (6 kanal x 2 şarkı telefonda ~1 GB olurdu); arada sonraki
// şarkının açılma süresi kadar kısa bir sessizlik olur.

export const CROSSFADE_KEY = "stem-mikser.crossfade";       // saniye: "0" kapalı
export const CROSSFADE_CHOICES = [0, 3, 5, 8];
export const CROSSFADE_DEFAULT = 5;
export const PREVIEW_KEY = "stem-mikser.clippreview";        // "0": kitaplıkta klip önizlemesi kapalı
export const PREVIEW_MAX_PLAYING = 3;                        // aynı anda en çok bu kadar önizleme oynar (pil)
export const PREVIEW_SECONDS = 4;                            // önizleme döngüsü uzunluğu
export const PREVIEW_AT = 0.35;                              // klibin bu oranından başlar (intro atlanır)

export function readCrossfade(storage) {
  let raw = null;
  try {
    raw = storage ? storage.getItem(CROSSFADE_KEY) : null;
  } catch {
    raw = null;
  }
  const value = raw === null ? CROSSFADE_DEFAULT : Number(raw);
  return CROSSFADE_CHOICES.includes(value) ? value : CROSSFADE_DEFAULT;
}

/**
 * Her karede ne yapılsın? remaining: şarkının kalan süresi (saniye, şarkı zamanı), rate: çalma hızı, fading: kısma başladı mı.
 * Dönen: {action: "start", seconds} (kısmaya başla, gerçek saniye) | {action: "cancel"} (geri sarıldı/döngü/durdu: sesi geri aç) | null.
 */
export function crossfadeStep({ seconds = 0, remaining = Infinity, rate = 1, fading = false, playing = false, hasNext = false, looping = false } = {}) {
  const real = remaining / (rate > 0 ? rate : 1);
  if (fading) {
    if (looping || real > seconds + 0.75) return { action: "cancel" };
    return null;
  }
  if (!seconds || !playing || looping || !hasNext) return null;
  if (real <= seconds && real > 0.05) return { action: "start", seconds: real };
  return null;
}

/** Sonraki şarkı başlarken sesin yükselme süresi (saniye). */
export function fadeInSeconds(seconds) {
  return Math.min(2.5, Math.max(0.6, seconds / 2));
}

/** Önizleme başlangıcı (saniye): sürenin %35'i; süre bilinmiyorsa 1 sn. */
export function previewStart(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  if (duration <= PREVIEW_SECONDS + 1) return 0;
  return Math.min(duration * PREVIEW_AT, duration - PREVIEW_SECONDS - 0.5);
}

/** Görünür önizlemelerden hangileri oynasın (en çok PREVIEW_MAX_PLAYING, ekranda en üstte olanlar önce). */
export function pickPlaying(visible, max = PREVIEW_MAX_PLAYING) {
  return [...visible].sort((a, b) => a.top - b.top).slice(0, max).map((item) => item.id);
}
