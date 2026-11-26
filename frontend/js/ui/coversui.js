// kapaklar (Görsel yenileme 2; mantık js/cover.js)
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { COVER_PX, CoverManager, autoCoverCss, autoCoverModel, fitSize } from "../cover.js";
import { attachClipPreview } from "../ui/clippreview.js";
import { coverStore } from "../coverstore.js";
import { el } from "../dom.js";
import { isConfigured } from "../settings.js";
import { isOffline } from "../ui/offlineui.js";

let repaintCovers, api, settings;   // app.js'ten (bind)

// Sıra: kullanıcının seçtiği / onayladığı resim > dosyanın gömülü kapağı > şarkı adından üretilen renkli kapak. Resimler YALNIZ bu
// telefonda (IndexedDB); sunucuya yüklenmez. Gömülü kapak sunucudan salt okunur GET ile (GPU yok) ve şarkı başına bir kez istenir.

/** Resmi COVER_PX'e küçültüp JPEG yapar (kayıt ve kilit ekranı için yeter). Çözülemezse atar. */
export async function shrinkImage(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const { w, h } = fitSize(bitmap.width, bitmap.height, COVER_PX);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!out) throw new Error("resim kodlanamadı");
    return out;
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

export const covers = new CoverManager({
  store: coverStore,
  fetchEmbedded: async (id) => {
    try {
      const blob = await api().getCover(id);          // null: dosyada kapak yok (204)
      if (!blob) return null;
      return blob.size > 150000 ? await shrinkImage(blob).catch(() => blob) : blob;
    } catch {
      return undefined;                              // ağ hatası / eski sunucu (404): "kapak yok" DİYE KAYDEDİLMEZ
    }
  },
  canFetch: () => isConfigured(settings()) && !isOffline() && !document.hidden && el("overlay").hidden,
  onChange: (ids) => repaintCovers(ids),
});

/** Kapağı bir düğüme çizer: resim varsa o, yoksa şarkı adından üretilen renkli kapak (senkron, bellekten). */
export function paintCover(node, id, title) {
  if (!node) return;
  const url = covers.urlFor(id);
  if (url) {
    node.classList.remove("auto-cover");
    node.classList.add("has-cover");
    node.style.backgroundImage = `url("${url}")`;
    node.textContent = "";
    attachClipPreview(node, id);
    return;
  }
  const model = autoCoverModel(title);
  node.classList.remove("has-cover");
  node.classList.add("auto-cover");
  node.style.backgroundImage = autoCoverCss(model);
  node.textContent = model.letter;
  attachClipPreview(node, id);
}

export function bind(deps) {
  ({ repaintCovers, api, settings } = deps);
}
