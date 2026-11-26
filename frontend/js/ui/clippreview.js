// kitaplıkta klip önizlemesi (mantık js/crossfade.js)
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { PREVIEW_KEY, PREVIEW_SECONDS, pickPlaying, previewStart } from "../crossfade.js";
import { clipStore, settingOn } from "../clipstore.js";
import { safeStorage } from "../collection.js";

// Klibi saklı şarkının kitaplık kapağında birkaç saniyelik sessiz döngü. Yalnız ekrandaki satırlarda, en çok 3 tanesi aynı anda oynar;
// video öğesi şarkı başına bir kez kurulur, liste yeniden çizilince yeni kapağa taşınır (yeniden yüklenmez).

const clipPreviews = new Map();        // id -> {video, url, start, visible, top}
let previewIds = new Set();
let previewObserver = null;

function previewsOn() {
  return settingOn(safeStorage().storage, PREVIEW_KEY);
}

function schedulePreviews() {
  const visible = [...clipPreviews.entries()].filter(([, item]) => item.visible).map(([id, item]) => ({ id, top: item.top }));
  const allowed = new Set(previewsOn() && !document.hidden ? pickPlaying(visible) : []);
  for (const [id, item] of clipPreviews) {
    if (allowed.has(id)) item.video.play().catch(() => {});
    else item.video.pause();
  }
}

function previewObserverFor() {
  if (previewObserver || typeof IntersectionObserver === "undefined") return previewObserver;
  previewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const item = clipPreviews.get(entry.target.dataset.clip);
      if (!item) continue;
      item.visible = entry.isIntersecting;
      item.top = entry.boundingClientRect.top;
    }
    schedulePreviews();
  });
  return previewObserver;
}

async function makeClipPreview(id) {
  const record = await clipStore.get(id);
  if (!record || clipPreviews.has(id)) return clipPreviews.get(id) || null;
  const preview = document.createElement("video");
  preview.className = "thumb-clip";
  preview.muted = true;
  preview.playsInline = true;
  preview.loop = false;
  preview.preload = "metadata";
  preview.setAttribute("aria-hidden", "true");
  preview.tabIndex = -1;
  preview.disablePictureInPicture = true;
  preview.dataset.clip = id;
  const item = { video: preview, url: URL.createObjectURL(record.blob), start: 1, visible: false, top: 0 };
  preview.addEventListener("loadedmetadata", () => {
    item.start = previewStart(preview.duration);
    preview.currentTime = item.start;
  });
  preview.addEventListener("timeupdate", () => {
    if (preview.currentTime > item.start + PREVIEW_SECONDS || preview.currentTime < item.start - 0.5) preview.currentTime = item.start;
  });
  preview.src = item.url;
  clipPreviews.set(id, item);
  const observer = previewObserverFor();
  if (observer) observer.observe(preview);
  return item;
}

export function attachClipPreview(node, id) {
  // Yalnız liste satırı kapakları (kimliksiz .song-thumb); oynatıcı/küçük oynatıcı/bilgi kapakları (#player-cover vb.) hariç.
  // Kapak, satıra eklenmeden ÖNCE boyanabildiği için .song-row atasına bakılmaz.
  if (!node || node.id || !node.classList || !node.classList.contains("song-thumb") || !previewIds.has(id) || !previewsOn()) return;
  const item = clipPreviews.get(id);
  if (item) {
    if (item.video.parentNode !== node) node.append(item.video);
    return;
  }
  makeClipPreview(id).then((made) => {
    if (made && node.isConnected && made.video.parentNode !== node) node.append(made.video);
  }).catch(() => {});
}

function dropClipPreview(id) {
  const item = clipPreviews.get(id);
  if (!item) return;
  clipPreviews.delete(id);
  if (previewObserver) previewObserver.unobserve(item.video);
  item.video.pause();
  item.video.removeAttribute("src");
  item.video.remove();
  URL.revokeObjectURL(item.url);
}

/** Klip listesi değişince (ekleme/silme/ayar) önizlemeleri günceller. */
export async function refreshClipPreviews() {
  const list = await clipStore.list();
  previewIds = new Set(previewsOn() ? list.map((item) => item.id) : []);
  for (const id of [...clipPreviews.keys()]) if (!previewIds.has(id)) dropClipPreview(id);
  for (const thumb of document.querySelectorAll(".song-row[data-id] .song-thumb")) {
    attachClipPreview(thumb, thumb.closest(".song-row").dataset.id);
  }
  schedulePreviews();
}

export function bind() {
  document.addEventListener("visibilitychange", () => schedulePreviews());
  refreshClipPreviews();
}
