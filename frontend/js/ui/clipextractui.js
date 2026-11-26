// klipten ses ayıklama: ilerleme + iptal; yükleme sonrası kapak karesi + sahne klibi
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { CLIP_KEEP_KEY, clipStore, settingOn } from "../clipstore.js";
import { covers } from "../ui/coversui.js";
import { el, on } from "../dom.js";
import { formatSize } from "../share.js";
import { safeStorage } from "../collection.js";

let captureFrame, loadMp4Audio, refreshClipChip, refreshClipSummary, refreshInfoClip, currentSong;   // app.js'ten (bind)

let clipAbort = null;

export async function extractClipAudio(file, status) {
  const cancel = el("upload-cancel");
  clipAbort = new AbortController();
  status.hidden = false;
  if (cancel) cancel.hidden = false;
  const label = (ratio) => `${file.name}: klipten ses ayıklanıyor… %${Math.round(ratio * 100)}`;
  status.textContent = label(0);
  try {
    const { extractAudio } = await loadMp4Audio();
    return await extractAudio(file, { signal: clipAbort.signal, onProgress: (ratio) => { status.textContent = label(ratio); } });
  } catch (error) {
    console.warn("[klip] ayıklama", error);
    return { ok: false, reason: "unsupported" };
  } finally {
    clipAbort = null;
    if (cancel) cancel.hidden = true;
  }
}

/** Kapak karesi (klibin kendi kapağı yoksa ve şarkıda resimli kapak yoksa) + klibi sahne için saklama (ayar açıksa). Arka planda; hata vermez. */
export async function afterClipUpload(id, clipFile, meta, status) {
  const notes = [];
  try {
    if (!(meta && meta.hasCover)) {
      const frame = await captureFrame(clipFile);
      if (frame && await covers.setClipFrame(id, frame)) notes.push("kapak klipten alındı");
    }
    if (settingOn(safeStorage().storage, CLIP_KEEP_KEY)) {
      if (await clipStore.put(id, clipFile)) notes.push(`klip sahne modu için bu telefonda saklandı (${formatSize(clipFile.size)})`);
      else notes.push("klip saklanamadı (telefonda yer kalmamış olabilir)");
      refreshClipSummary();
    }
  } catch (error) {
    console.warn("[klip] yükleme sonrası", error);
  }
  if (notes.length && status && !status.hidden) {
    const text = notes.join("; ");
    status.textContent += ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }
  if (!el("info-sheet").hidden && currentSong() && currentSong().id === id) refreshInfoClip();
  if (currentSong() && currentSong().id === id) refreshClipChip();
}

export function bind(deps) {
  ({ captureFrame, loadMp4Audio, refreshClipChip, refreshClipSummary, refreshInfoClip, currentSong } = deps);

  on("upload-cancel", "click", () => {
    if (clipAbort) clipAbort.abort();
  });
}
