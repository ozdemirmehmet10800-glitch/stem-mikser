// PWA
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { el, on } from "../dom.js";
import { formatSize as formatCacheSize, summarizeBySong } from "../cachelist.js";
import { melodyCache } from "../ui/trainerui.js";

let peaksCache, renderLibrary, stemCache, views, librarySongs;   // app.js'ten (bind)

export async function registerServiceWorker() {
  const state = el("sw-state") || { set textContent(value) { console.info("[sw]", value); } };
  if (!("serviceWorker" in navigator)) {
    state.textContent = "Bu tarayıcı service worker desteklemiyor.";
    return;
  }
  // file:// ile açıldığında kayıt zaten başarısız olur; kullanıcıya anlamlı
  // bir şey söylemek, konsolda sessizce patlamasından iyi.
  if (location.protocol === "file:") {
    state.textContent = "Dosyadan açıldı; service worker yalnızca http(s) ile çalışır.";
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("sw.js");
    state.textContent = `Service worker etkin (kapsam: ${registration.scope}).`;
  } catch (error) {
    state.textContent = `Service worker kaydedilemedi: ${error.message}`;
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export async function refreshStemCacheState() {
  const node = el("stem-cache-state");
  if (!node) return;
  if (!stemCache.available) {
    node.textContent = "Bu tarayıcı çevrimdışı kopyaları desteklemiyor.";
    return;
  }
  const usage = await stemCache.usage();
  const persisted = stemCache.persisted;
  const kalici = persisted === true ? "kalıcı" : persisted === false ? "geçici" : "bilinmiyor";
  node.textContent =
    `Çevrimdışı kopyalar: ${usage.songs} şarkı, ${usage.files} kanal, ` +
    `${formatBytes(usage.bytes)} / ${formatBytes(usage.limit)} (depolama: ${kalici}).`;
  renderCacheSongs();
}

// Cihazdaki şarkılar: şarkı başına boyut ve TEK TEK silme (yalnız sen basınca; hiçbir şey kendiliğinden silinmez).
function renderCacheSongs() {
  const box = el("cache-songs");
  if (!box) return;
  box.replaceChildren();
  const rows = summarizeBySong(stemCache.indexSnapshot());
  if (!rows.length) {
    box.textContent = "Cihazda kayıtlı şarkı yok.";
    return;
  }
  for (const row of rows) {
    const song = librarySongs().find((item) => item.id === row.songId);
    const line = document.createElement("div");
    line.className = "cache-song";
    const name = document.createElement("span");
    name.className = "cache-song-name";
    name.textContent = song ? (song.title || row.songId.slice(0, 12)) : `(kitaplıkta yok) ${row.songId.slice(0, 8)}`;
    const size = document.createElement("small");
    size.textContent = `${formatCacheSize(row.bytes)} · ${row.files} kanal`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-small";
    button.textContent = "Sil";
    button.setAttribute("aria-label", `Cihazdan sil: ${name.textContent}`);
    button.addEventListener("click", async () => {
      if (!window.confirm(`"${name.textContent}" cihazdan silinsin mi? (${formatCacheSize(row.bytes)}; sunucudaki şarkıya dokunulmaz, internet varken yeniden inebilir.)`)) return;
      button.disabled = true;
      await stemCache.removeSongs([row.songId]);
      peaksCache().removeSongs([row.songId]);
      await refreshStemCacheState();
      if (!views.library.hidden) renderLibrary(librarySongs());
    });
    line.append(name, size, button);
    box.append(line);
  }
}

export function bind(deps) {
  ({ peaksCache, renderLibrary, stemCache, views, librarySongs } = deps);

  on("clear-stems", "click", async () => {
    const node = el("stem-cache-state");
    node.textContent = "Siliniyor…";
    await stemCache.clear();
    peaksCache().clear();
    melodyCache.clear();
    await refreshStemCacheState();
  });

  on("clear-cache", "click", async () => {
    const state = el("sw-state");
    state.textContent = "Temizleniyor…";
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
      state.textContent = "Önbellek temizlendi, service worker kaldırıldı. Sayfayı yenile.";
    } catch (error) {
      state.textContent = `Temizlenemedi: ${error.message}`;
    }
  });
}
