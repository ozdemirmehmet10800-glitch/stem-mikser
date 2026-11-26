// çalma listeleri (prova modu)
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { el } from "../dom.js";
import { formatTime } from "../chords.js";
import { isOffline, isOfflineReady, readLibraryCache } from "../ui/offlineui.js";
import { totalDuration } from "../playlist.js";

let collection, hideMessage, openListDetail, pushLayer, refreshQueueUi, refreshWishCard, showMessage, showView, stemCache, librarySongs;   // app.js'ten (bind)

//
// Listeler ekranı (kitaplık üst çubuğundaki "Listeler"), liste ayrıntısı (sıra, Düzenle: ↑ ↓ ✕, ad, sil) ve seçim
// modundan "Listeye ekle". Veri js/collection.js (lists), çalma kuralları js/playlist.js. Sıra değiştirme ↑/↓ düğmeleri
// ("Düzenle" modunda): telefonda sürüklemeye göre çok daha sağlam (kaydırma ve uzun basmayla çakışmıyor).

export const listView = { lid: null, edit: false, renaming: false };

export function librarySongMap() {
  const source = librarySongs().length ? librarySongs() : (readLibraryCache() || []);
  return new Map(source.map((song) => [song.id, song]));
}

export function listContext(map = librarySongMap()) {
  const offline = isOffline();
  const index = offline ? stemCache.indexSnapshot() : null;
  return {
    songById: (id) => map.get(id) || null,
    offline,
    offlineReady: (song) => isOfflineReady(song, index),
  };
}

export function itemTitle(item, map) {
  const song = map.get(item.song);
  return song ? (song.title || song.id.slice(0, 12)) : "Şarkı bulunamadı";
}

export function listMessage(id, text, tone = "warn") {
  if (text) showMessage(el(id), text, tone);
  else hideMessage(el(id));
}

export function openListsScreen() {
  listMessage("lists-message", "");
  el("lists-create").hidden = true;
  renderListsScreen();
  showView("lists");
  pushLayer("lists");
}

export function renderListsScreen() {
  refreshWishCard();
  refreshQueueUi();
  const box = el("lists-list");
  const map = librarySongMap();
  const lists = collection.listSummaries();
  box.replaceChildren();
  if (!lists.length) {
    const none = document.createElement("li");
    none.className = "list-row";
    none.style.cursor = "default";
    none.textContent = "Henüz liste yok. Yukarıdan oluştur ya da kitaplıkta şarkılara uzun basıp \"Listeye ekle\" de.";
    box.append(none);
    return;
  }
  for (const entry of lists) {
    const list = collection.getList(entry.id);
    const total = totalDuration(list.items, (item) => (map.get(item.song) || {}).duration);
    const row = document.createElement("li");
    row.className = "list-row";
    const info = document.createElement("div");
    info.className = "list-info";
    const name = document.createElement("div");
    name.className = "list-name";
    name.textContent = list.name;
    const sub = document.createElement("div");
    sub.className = "list-sub";
    sub.textContent = `${list.items.length} şarkı${total ? ` · ${formatTime(total)}` : ""}`;
    info.append(name, sub);
    const chevron = document.createElement("span");
    chevron.className = "list-chevron";
    chevron.textContent = "›";
    row.append(info, chevron);
    row.addEventListener("click", () => openListDetail(entry.id));
    box.append(row);
  }
}

export function bind(deps) {
  ({ collection, hideMessage, openListDetail, pushLayer, refreshQueueUi, refreshWishCard, showMessage, showView, stemCache, librarySongs } = deps);
}
