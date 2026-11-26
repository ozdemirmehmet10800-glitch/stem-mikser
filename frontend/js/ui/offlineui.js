// çevrimdışı
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { cacheTag } from "../stemcache.js";
import { el } from "../dom.js";
import { isConfigured } from "../settings.js";
import { isDefinitelyOffline } from "../api.js";
import { refreshExportAvailability } from "../ui/exportui.js";
import { renderShareCard } from "../ui/shareui.js";

let readMeta, refreshLibrary, renderLibrary, runPrefetch, showMessage, stemCache, views, librarySongs, settings;   // app.js'ten (bind)

//
// İki ayrı kusur vardı ve ikisi de yerelde tekrar üretildi:
//   1. İnternet yokken uygulama yeniden açılınca kitaplık BOMBOŞ geliyordu -
//      liste yalnız ağdan (`GET /songs`). Yani sesi cihazda duran şarkıya bile
//      ulaşılamıyordu.
//   2. Cihazda kopyası olmayan bir şarkı açılınca uzun uzun bekleyip alakasız
//      "antivirüs / VPN / ALLOWED_ORIGINS" tanı metnini gösteriyor, sonra boş
//      mikserde kalıyordu.
//
// Çözüm sırası: listeyi cihazda tut, isteklere zaman aşımı koy (api.js),
// çevrimdışıyken neyin açılabileceğini kitaplıkta GÖSTER.

const LIBRARY_KEY = "stem-mikser.library";

export function readLibraryCache() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && Array.isArray(parsed.songs) ? parsed.songs : null;
  } catch {
    return null;
  }
}

export function writeLibraryCache(songs) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({
      songs, savedAt: Date.now(),
    }));
  } catch {
    // Kota dolduysa önemli değil: çevrimdışı açılış kötüleşir, uygulama değil.
  }
}

// Sunucuya ulaşılabiliyor mu? navigator.onLine yalnız NEGATİF yönde güvenilir
// (internetsiz Wi-Fi'da da true diyebiliyor), o yüzden son isteğin sonucunu da
// hesaba katıyoruz.
export let serverReachable = true;

export function isOffline() {
  return isDefinitelyOffline() || !serverReachable;
}

/** Bu şarkı ağ olmadan açılabilir mi? (bilgi + bütün stem'ler cihazda) */
export function isOfflineReady(song, index = null) {
  const meta = readMeta(song.id);
  const stems = meta && meta.status && meta.status.stems;
  if (!stems || !stems.length) return false;
  const version = Number(song.stems_version || (meta.status.stems_version || 0));
  const tag = cacheTag(version, song.pipeline || meta.status.pipeline);
  return stemCache.indexHas(song.id, stems, tag, index);
}

/** Ağ gerektiren bir işlemden önce: çevrimdışıysak tek cümleyle söyle. */
export function requireOnline(node, what) {
  if (!isOffline()) return true;
  showMessage(node, `İnternet yok, ${what} için bağlantı gerekiyor.`, "warn");
  return false;
}

export function markOnlineState(reachable) {
  const changed = serverReachable !== reachable;
  serverReachable = reachable;
  if (changed && !views.library.hidden) renderLibrary(librarySongs());
  syncOfflineUi();
}

// Yükleme düğmesi çevrimdışıyken kapalı: dosya seçtirip sonra hata vermek
// kullanıcıyı boşuna uğraştırırdı.
export function syncOfflineUi() {
  const offline = isOffline();
  refreshExportAvailability();
  renderShareCard();
  const label = el("upload-label");
  if (label) {
    label.classList.toggle("disabled", offline);
    const input = el("upload-input");
    if (input) input.disabled = offline;
    label.title = offline ? "İnternet yok" : "";
  }
}

export function bind(deps) {
  ({ readMeta, refreshLibrary, renderLibrary, runPrefetch, showMessage, stemCache, views, librarySongs, settings } = deps);

  // Tarayıcı ağ durumunu bildirince kitaplığı hemen tazele: "online" olduğunda
  // listeyi de yenilemek gerekiyor, çevrimdışıyken eskimiş olabilir.
  window.addEventListener("online", () => {
    serverReachable = true;
    syncOfflineUi();
    runPrefetch();
    if (!views.library.hidden && isConfigured(settings())) refreshLibrary();
    else if (!views.library.hidden) renderLibrary(librarySongs());
  });
  window.addEventListener("offline", () => {
    markOnlineState(false);
  });
}
