// API adresi ve token'ı localStorage'da tutar.
// Kodda hiçbir sır yok; token yalnızca bu ekrandan giriliyor.

const KEY = "stem-mikser.settings";

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { url: "", token: "" };
    const parsed = JSON.parse(raw);
    return { url: parsed.url || "", token: parsed.token || "" };
  } catch {
    return { url: "", token: "" };
  }
}

export function saveSettings({ url, token }) {
  const clean = { url: (url || "").trim().replace(/\/+$/, ""), token: (token || "").trim() };
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
}

export function isConfigured(settings) {
  return Boolean(settings.url && settings.token);
}
