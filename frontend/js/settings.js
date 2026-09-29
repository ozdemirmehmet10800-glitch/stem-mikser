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
//   "high" = hız zorlaması yok (cihazın doğal hızı), mono indirme yok.
//   "save" = eski davranış: AudioContext 32 kHz + stem'ler mono'ya indiriliyor.
//
// VARSAYILAN "high" (2026-09-29 telefon ölçümünden sonra). Ölçülenler
// (S24 FE, 8 GB, Chrome):
//   - cihazın doğal hızı 48 kHz; Yüksek kipte 48 kHz / 2 kanal / 6 stem
//   - 9.1 dakikalık şarkı (yükleme sınırı 10 dk) sorunsuz: çökme, takılma,
//     kesilme yok - yani ~1.25 GB PCM bu cihazda sorun değilmiş
//   - hiza testi tamamen geçti (metronom 0.0 / +0.1 ms, esnetici 119.9-120.0 ms)
//   - kulakla kalite belirgin şekilde daha iyi, stereo doğrulandı, cızırtı yok
// Eski varsayılanı (32 kHz mono) doğuran 508 MB hesabı ölçümle ÇÜRÜDÜ; ayar
// yedek olarak duruyor, çünkü başka bir cihaz aynı payı vermeyebilir.
// Masaüstünde bu ayarın etkisi YOK: orada zaten tam kalite çalışıyor.
export const AUDIO_SAVE = "save";
export const AUDIO_HIGH = "high";

// Kaç stem aynı anda getirilip çözülsün? GEÇİCİ DENEY AYARI.
// Chrome decodeAudioData'yı worker havuzunda koşturuyor (base_audio_context.cc
// -> worker_pool::PostTask), yani çağrılar gerçekten paralel. Bedeli bellek:
// her çözme arka planda bir AudioBus üretiyor, sonra ana iş parçacığında
// AudioBuffer'a KOPYALANIYOR; kopya bitene kadar ikisi birden bellekte.
// Ayrıntılı hesap PLAN.md'de.
export const DECODE_PARALLEL = [2, 3, 6];

const DEFAULTS = {
  url: "", token: "", stretcher: "signalsmith", formants: false,
  mobileAudio: AUDIO_HIGH, decodeParallel: 2,
};

export function normalizeParallel(value) {
  const number = Number(value);
  return DECODE_PARALLEL.includes(number) ? number : DEFAULTS.decodeParallel;
}

// ELLE SEÇİLMİŞ TERCİH KORUNUYOR: kayıtta açıkça "save" yazıyorsa varsayılan
// devreye girmiyor. Yalnızca tanınmayan/boş değer varsayılana düşüyor - yoksa
// varsayılanı değiştirmek, Tasarruf'u bilerek seçmiş bir cihazı sessizce
// Yüksek'e çevirirdi.
export function normalizeAudioMode(value) {
  if (value === AUDIO_HIGH) return AUDIO_HIGH;
  if (value === AUDIO_SAVE) return AUDIO_SAVE;
  return DEFAULTS.mobileAudio;
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
      decodeParallel: normalizeParallel(parsed.decodeParallel),
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
    decodeParallel: normalizeParallel(merged.decodeParallel),
  };
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
}

export function isConfigured(settings) {
  return Boolean(settings.url && settings.token);
}
