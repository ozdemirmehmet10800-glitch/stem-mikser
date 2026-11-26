// paylaş menüsünden ekleme (Web Share Target)
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { MESSAGES as SHARE_MESSAGES, SHARE_PARAM, cardView, classify, clearPending, launchKind, readPending } from "../share.js";
import { el } from "../dom.js";
import { isConfigured } from "../settings.js";

let addSharedWish, collection, handleUpload, isOffline, matchWishes, refreshWishCard, showMessage, lastUploadedId, librarySongs, settings;   // app.js'ten (bind)

//
// sw.js POST /share-target'ı yakalayıp ilk dosyayı geçici cache'e koyuyor ve ?paylasim=1 ile buraya yolluyor. Dosya
// önce BU KARTTA görünür; sunucuya (ve GPU'ya) yalnız "Yükle ve ayır"a basınca gidilir. "Şarkı ekle" düğmesi
// bugünkü gibi dosyayı seçince doğrudan yükler (kart yalnız paylaşılan dosyada).

export let sharePending = null;      // {file, name, size, note, seconds}
let shareBusy = false;

// Kalite seçicisi: kitaplıktaki seçimin kopyası (aynı seçenekler, aynı seçili değer). Kart açılmadan da dolu kalır.
export function fillShareQuality() {
  const select = el("share-quality");
  const source = el("upload-quality");
  if (!select || !source) return;
  select.replaceChildren(...[...source.options].map((option) => {
    const copy = document.createElement("option");
    copy.value = option.value;
    copy.textContent = option.textContent;
    return copy;
  }));
  select.value = source.value;
}

export function renderShareCard() {
  const card = el("share-card");
  if (!card) return;
  // Görünüm saf işlevden (js/share.js cardView): geçerli paylaşım kaydı yoksa kart GİZLİ ve düğme pasif.
  const view = cardView({
    pending: sharePending, seconds: sharePending && sharePending.seconds, offline: isOffline(),
    configured: isConfigured(settings()), busy: shareBusy,
  });
  card.hidden = view.hidden;
  el("share-name").textContent = view.name;
  el("share-meta").textContent = view.meta;
  const noteNode = el("share-note");
  noteNode.hidden = !view.note;
  noteNode.textContent = view.note;
  el("share-go").disabled = view.goDisabled;
  el("share-cancel").disabled = view.cancelDisabled;
  el("share-quality").disabled = view.qualityDisabled;
  el("share-go").textContent = view.goLabel;
  el("share-hint").textContent = view.hint;
}

// Süre: <audio> üst verisinden, en iyi çaba (okunamazsa kart süresiz kalır; sunucu 10 dk sınırını zaten uygular).
function probeDuration(file) {
  return new Promise((resolve) => {
    let url = "";
    const audio = new Audio();
    const done = (value) => {
      clearTimeout(timer);
      audio.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => done(null), 4000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(null);
    try {
      url = URL.createObjectURL(file);
      audio.src = url;
    } catch {
      done(null);
    }
  });
}

export async function showShareCard(pending, note) {
  sharePending = { file: pending.file, name: pending.name, size: pending.size, note, seconds: null };
  fillShareQuality();
  renderShareCard();
  const seconds = await probeDuration(pending.file);
  if (sharePending && sharePending.file === pending.file) {
    sharePending.seconds = seconds;
    renderShareCard();
  }
}

export async function dropShare() {
  sharePending = null;
  shareBusy = false;
  renderShareCard();
  try {
    await clearPending(window.caches);
  } catch {
    /* cache erişilemedi: kayıt 1 saat sonra zaten bayatlıyor */
  }
}

export async function confirmShare() {
  // Savunma: dosya yoksa (kart zaten gizli/pasif olmalı) hiçbir istek gitmesin.
  if (!sharePending || !sharePending.file || shareBusy) return;
  shareBusy = true;
  renderShareCard();
  // handleUpload kaliteyi #upload-quality'den ilk satırlarda (await'ten önce) okuyor: kartın seçimini oraya geçici yaz,
  // sonra eski değeri geri koy (kitaplıktaki seçim sessizce değişmesin).
  const select = el("upload-quality");
  const previous = select.value;
  select.value = el("share-quality").value;
  const run = handleUpload(sharePending.file);
  select.value = previous;
  const ok = await run;
  if (ok) {
    const wishId = sharePending && sharePending.wishId;
    if (wishId) {
      collection.setWishDone(wishId, lastUploadedId() || true);     // Eklenecekler'den başlatılan yükleme: istek "eklendi" olur
      refreshWishCard();
    }
    await dropShare();
  } else {
    shareBusy = false;
    renderShareCard();
  }
}

// Açılışta: ?paylasim=... varsa adresi temizle; bekleyen kayıt (varsa) kart ya da mesaj olur. Bekleyen kayıt parametresiz
// de bulunur (Android uygulamayı kart açıkken öldürebilir; kayıt 1 saat saklanır).
export async function handleShareLaunch() {
  const kind = launchKind(location.search);
  if (new URLSearchParams(location.search).has(SHARE_PARAM)) {
    history.replaceState(history.state, "", location.pathname + location.hash);
  }
  const library = el("library-message");
  const say = (text, tone = "warn") => {
    showMessage(isConfigured(settings()) ? library : el("settings()-message"), text, tone);
  };
  try {
    if (kind === "empty") say(SHARE_MESSAGES.empty);
    else if (kind === "error") say(SHARE_MESSAGES.error);
    const pending = await readPending(window.caches, location.href);
    if (!pending) {
      if (kind === "file") say(SHARE_MESSAGES.gone);
      return;
    }
    const verdict = classify(pending);
    if (verdict.action === "wish") {
      // YouTube Music vb. metin/bağlantı paylaşımı: Eklenecekler'e yazılır. Bağlantıya İSTEK ATILMAZ, hiçbir şey indirilmez.
      say(addSharedWish(verdict.entry), "ok");
      matchWishes(librarySongs());
      await clearPending(window.caches);
    } else if (verdict.action === "card") {
      await showShareCard(pending, verdict.note);
      if (!isConfigured(settings())) {
        say("Paylaşılan dosya bekliyor. API adresini ve token'ı girip kaydet, sonra kitaplıkta yükleyebilirsin.", "warn");
      }
    } else {
      if (kind === "file" || pending.state !== "stale") say(verdict.text);
      await clearPending(window.caches);
    }
  } catch (error) {
    console.warn("[share]", error);
    if (kind === "file") say(SHARE_MESSAGES.error);
  }
}

export function bind(deps) {
  ({ addSharedWish, collection, handleUpload, isOffline, matchWishes, refreshWishCard, showMessage, lastUploadedId, librarySongs, settings } = deps);
}
