// Yeni görünümün kabuğu: alt sekme çubuğu + küçük oynatıcı. SAF mantık (DOM ve history'yi app.js bağlar); node ile test ediliyor:
//   node tests\shell_test.mjs

export const TABS = ["library", "lists", "settings"];

/** Ekran adından sekme: kitaplık -> library, listeler ve liste ayrıntısı -> lists, ayarlar -> settings; oynatıcı (mikser) hiçbiri. */
export function tabForView(view) {
  if (view === "library") return "library";
  if (view === "lists" || view === "list") return "lists";
  if (view === "settings") return "settings";
  return null;
}

/** Sekme çubuğu (ve küçük oynatıcı) yalnız sekme ekranlarında görünür; mikserde kendi alt çubuğu var. */
export function dockVisible(view) {
  return tabForView(view) !== null;
}

// Sekme ekranlarında açık olabilen, "geri" ile kapanan katmanlar (navstack adları): seçim modu, liste ayrıntısı, listeler, ayarlar ("view").
const ROOT_LAYERS = new Set(["select", "list", "lists", "view"]);

/**
 * Kitaplık köküne dönmek için kaç tane history.back() gerek? Katman yığınının ÜSTÜNDEN başlayıp ardışık kök-altı katmanları sayar;
 * başka bir katman (menü, alt sayfa, önizleme...) görünce durur (onları sekme çubuğu zaten örtüyor; sayı 0 dönmesi "dokunma" demek).
 */
export function layersToRoot(layers) {
  let count = 0;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    if (!ROOT_LAYERS.has(layers[i])) break;
    count += 1;
  }
  return count;
}

/** Hedef sekmeye geçiş planı: {pops, open} - önce `pops` kez geri, sonra `open` ekranı açılır (library için null). */
export function tabPlan(currentView, target, layers) {
  const current = tabForView(currentView);
  if (!TABS.includes(target)) return null;
  if (current === target) return { pops: 0, open: null, same: true };
  return { pops: layersToRoot(layers), open: target === "library" ? null : target, same: false };
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

/** m:ss (saat varsa h:mm:ss). Kitaplıktaki formatTime ile aynı biçim; burada bağımsız ki shell.js tek başına test edilsin. */
export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${twoDigits(m)}:${twoDigits(s)}` : `${m}:${twoDigits(s)}`;
}

/**
 * Küçük oynatıcının modeli. Görünür: açık bir şarkı var, sesi bellekte (loaded) ve sekme ekranındayız.
 * progress 0..1 (süre bilinmiyorsa 0); sub: "Çalıyor · 1:05 / 3:20" ya da "Duraklatıldı · ...".
 */
export function miniModel({ song, loaded, playing, view, position = 0, duration = 0 }) {
  const visible = Boolean(song && loaded && dockVisible(view));
  if (!visible) return { visible: false, title: "", sub: "", playing: false, progress: 0 };
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const raw = Math.max(Number(position) || 0, 0);
  const at = total ? Math.min(raw, total) : raw;
  const title = (song.title && String(song.title).trim()) || String(song.id || "").slice(0, 12) || "Şarkı";
  const state = playing ? "Çalıyor" : "Duraklatıldı";
  const sub = total ? `${state} · ${clock(at)} / ${clock(total)}` : state;
  return { visible: true, title, sub, playing: Boolean(playing), progress: total ? Math.min(at / total, 1) : 0 };
}

/**
 * Mikserden kütüphaneye dönünce çalma SÜRSÜN mü (yeni görünümde küçük oynatıcı çalan şarkıyı gösterir)?
 * Yalnız: yeni görünüm + şarkı çalıyor + açık şarkı var + çalma listesi dışında + mikrofon/antrenör kapalı.
 * Liste modunda eskisi gibi durur (sıradaki şarkıya geçiş kullanıcıyı kitaplık gezerken mikser ekranına çekmesin);
 * mikrofon açıkken durur (mikrofon oynatıcı ekranına bağlı, arka planda açık kalmasın).
 */
export function keepPlayingOnLeave({ newLook, playing, hasSong, inPlaylist, micActive, trainerOpen }) {
  return Boolean(newLook && playing && hasSong && !inPlaylist && !micActive && !trainerOpen);
}

/** Küçük oynatıcı ilerleme yoklaması gerekli mi? Yalnız çalarken, oynatıcı ekranı kapalıyken (oynatıcıdayken rAF döngüsü zaten var). */
export function needsMiniLoop({ newLook, playing, view, hasSong }) {
  return Boolean(newLook && playing && hasSong && view !== "player");
}

export const MINI_TICK_MS = 500;
