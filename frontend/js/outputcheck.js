// Çıkış denetimi (SW v64): uygulama "çalıyorum" derken ses çıkışı gerçekten SESSİZ mi? Telefonda "süre ilerliyor ama ses yok" şikâyetini
// ayırt etmek için: uygulama örnek üretiyor ama cihaz / kulaklık susuyorsa buradaki tepe seviye NORMAL çıkar (sorun cihazda); tepe ~0 ise
// uygulama sessizlik üretiyordur (sorun uygulamada: kanal / kazanç / bağlam). SAF mantık (DOM, ses, ağ, depolama YOK):
// node tests\outputcheck_test.mjs
//
// GİZLİLİK: yalnız şarkı çıkışının (engine.output) tepe seviyesi; mikrofon ile ilgisi yok, hiçbir şey saklanmaz / gönderilmez.

export const SILENT_PEAK = 1e-4;            // ~ -80 dBFS: bunun altı "sessiz"
export const CHECK_DELAY_MS = 2500;         // çalma başladıktan sonra ilk ölçüm
export const CHECK_WINDOW_MS = 1000;
export const RECHECK_AFTER_MS = 4000;       // sessiz çıktıysa şarkının sessiz bir yerinde olabilir: bir kez daha

/** Tepe seviyesi (analyser zaman alanı örneklerinden). */
export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * Karar. peaks: ölçümlerin tepe değerleri (en çok iki). Dönen {silent, text}. silent yalnız TÜM ölçümler sessizse ve neden uygulamadaysa true;
 * "duyulur kanal yok" / "ana ses sıfır" da uygulama tarafı nedenler olarak söylenir.
 */
export function outputVerdict({ peaks, ctxState, playing, audible, masterGain = 1 }) {
  if (!playing) return { silent: false, text: "çalmıyor" };
  if (ctxState !== "running") return { silent: true, text: `Ses bağlamı çalışmıyor (${ctxState}); sayfayı yenileyip tekrar dene.` };
  if (!(audible > 0)) return { silent: false, text: "duyulur kanal yok (hepsi kapalı / sessiz): çıkış sessiz olması normal" };
  if (masterGain < 0.01) return { silent: true, text: "Ana ses sıfıra yakın: Ana ses kaydırıcısını yükselt." };
  const best = Math.max(0, ...(peaks || [0]));
  if (best < SILENT_PEAK) {
    return {
      silent: true,
      text: `Uygulama çalıyor ama çıkış sessiz görünüyor (tepe ${best.toExponential(1)}; ${audible} kanal duyulur, ses bağlamı çalışıyor). Mikser / Ana ses ayarlarını ve "Ses olayları"nı kontrol et.`,
    };
  }
  return { silent: false, text: `çıkış seviyesi tamam (tepe ${best.toFixed(3)}): ses uygulamadan çıkıyor` };
}
