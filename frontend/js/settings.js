// API adresi ve token'ı localStorage'da tutar.
// Kodda hiçbir sır yok; token yalnızca bu ekrandan giriliyor.

const KEY = "stem-mikser.settings";

// Esnetici seçimi ve formant telafisi de burada: cihaza özgü tercihler,
// sunucuyu ilgilendirmiyor. Varsayılan SoundTouch - Signalsmith gerçek
// şarkıda A/B ile kazanana kadar mevcut davranış değişmesin.
const DEFAULTS = { url: "", token: "", stretcher: "soundtouch", formants: false };

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
  };
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
}

export function isConfigured(settings) {
  return Boolean(settings.url && settings.token);
}
