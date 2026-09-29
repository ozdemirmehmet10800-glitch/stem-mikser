// API adresi ve token'ı localStorage'da tutar.
// Kodda hiçbir sır yok; token yalnızca bu ekrandan giriliyor.

const KEY = "stem-mikser.settings";

// Esnetici seçimi ve formant telafisi de burada: cihaza özgü tercihler,
// sunucuyu ilgilendirmiyor.
//
// Varsayılan Signalsmith: telefonda gerçek şarkıyla yapılan A/B'yi açık ara
// kazandı. Nesnel karşılığı hiza saçılması (±0.1 ms, SoundTouch ±8-17 ms)
// ve gerçek topolojide 3.6 kat düşük CPU. Formant telafisi varsayılan
// KAPALI - A/B'de kapalısı daha iyi geldi.
//
// KAYITLI TERCİH KORUNUYOR: parsed.stretcher varsa ona dokunulmuyor, yani
// daha önce elle SoundTouch seçmiş bir cihaz öyle kalıyor.
// Mobil ses kalitesi:
//   "save" = bugünkü davranış, AudioContext 32 kHz + stem'ler mono'ya
//            indiriliyor (bellek için, bkz. engine.js).
//   "high" = hız zorlaması yok (cihazın doğal hızı), mono indirme yok.
// Varsayılan "save": 32 kHz mono kararı ölçüme değil hesaba dayanıyordu ama
// "high"ın telefonda AÇILDIĞI da ölçülmedi. Ölçüm yapılana kadar varsayılanı
// değiştirmek, kanıtsız kararı ters yöne çevirmek olurdu.
// Masaüstünde bu ayarın etkisi YOK: orada zaten tam kalite çalışıyor.
export const AUDIO_SAVE = "save";
export const AUDIO_HIGH = "high";

const DEFAULTS = {
  url: "", token: "", stretcher: "signalsmith", formants: false,
  mobileAudio: AUDIO_SAVE,
};

export function normalizeAudioMode(value) {
  return value === AUDIO_HIGH ? AUDIO_HIGH : AUDIO_SAVE;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      url: parsed.url || "",
      token: parsed.token || "",
      stretcher: parsed.stretcher || DEFAULTS.stretcher,
      formants: Boolean(parsed.formants),
      mobileAudio: normalizeAudioMode(parsed.mobileAudio),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(next) {
  const current = loadSettings();
  const merged = { ...current, ...next };
  const clean = {
    url: (merged.url || "").trim().replace(/\/+$/, ""),
    token: (merged.token || "").trim(),
    stretcher: merged.stretcher || DEFAULTS.stretcher,
    formants: Boolean(merged.formants),
    mobileAudio: normalizeAudioMode(merged.mobileAudio),
  };
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
}

export function isConfigured(settings) {
  return Boolean(settings.url && settings.token);
}
