// "Plak gibi" kipi (Tempo/Ton paneli): SAF yardımcılar. node tests\vinyl_test.mjs
//
// Kipte tempo ve ton BAĞLI: kaynaklar yalnız `playbackRate = tempo oranı` ile çalar, perdeyi çalma hızı kendisi
// taşır (gerçek plak/teyp). ESNETİCİ KURULMAZ, gecikme (D) 0. Ton = 12·log2(oran) (yarım ses, kesirli).

export const INDEPENDENT_PITCH_LIMIT = 6;       // bağımsız ton kaydırıcısı ±6 (UI)
const CENT_NOTICE = 0.15;                       // 15 cent: bundan fazla sapmada "≈" gösterilir

/** Oranın (çalma hızı) doğurduğu perde kayması, yarım ses (kesirli). */
export function vinylPitch(rate) {
  const r = Number(rate);
  return r > 0 && Number.isFinite(r) ? 12 * Math.log2(r) : 0;
}

/** Kipi KAPATIRKEN bağımsız ton değeri: duyulan perdeye en yakın tam yarım ses, ±6'ya kırpılmış. */
export function nearestSemitone(rate, limit = INDEPENDENT_PITCH_LIMIT) {
  const value = Math.round(vinylPitch(rate));
  return Math.max(-limit, Math.min(limit, value)) || 0;     // -0 -> 0
}

/** Anahtar/akor şeridi için tam yarım ses ve yaklaşık mı (|cent sapması| > 15)? */
export function keyShift(rate) {
  const semis = vinylPitch(rate);
  const shift = Math.round(semis);
  return { shift: shift || 0, approx: Math.abs(semis - shift) > CENT_NOTICE };
}

/** "-2,8 yarım ses" biçimi (bir ondalık, işaretli). */
export function formatPitch(semis) {
  const value = Math.round(Number(semis) * 10) / 10;
  if (!value) return "orijinal ton";
  const text = Math.abs(value).toFixed(1).replace(".", ",");
  return `${value > 0 ? "+" : "-"}${text} yarım ses`;
}
