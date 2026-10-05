// Kitaplıkta arama / süzme / sıralama: SAF mantık (DOM, depolama yok). node tests\songfilter_test.mjs
//
// Arama iki tarafı da AYNI biçime getirir (fold):
//   1. İ, I, ı -> i        (Türkçe: "ISPARTA", "İsparta", "ısparta", "isparta" aynı)
//   2. NFKC                 (Japonca tam genişlik "ＡＤＯ" -> "ADO", yarım genişlik katakana -> normal)
//   3. NFD + aksan silme    (ş ç ğ ö ü â -> s c g o u a; "sarki" -> "Şarkı"yı bulur)
//   4. küçük harf
//   5. katakana -> hiragana ("アド" yazan "あど"u da bulur)
// Japonca kanji/kana başlıklar aynen alt dizgi olarak bulunur. (Dakuten/handakuten birleşik işaretleri SİLİNMEZ: yalnız
// U+0300-036F aralığı atılıyor, yani "か" ile "が" karışmaz.)

export function fold(text) {
  let s = String(text ?? "");
  s = s.replace(/[İIı]/g, "i");
  s = s.normalize("NFKC");
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return s;
}

/** Sorgu -> katlanmış sözcükler (boşlukla ayrılır; hepsi bulunmalı = AND). */
export function queryTokens(query) {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Şarkının aranan metni: görünen ad + etiket adları. */
export function songText(song, tagNames = []) {
  return fold([song.title || String(song.id || "").slice(0, 12), ...tagNames].join(" "));
}

export function matchesTokens(text, tokens) {
  return tokens.every((token) => text.includes(token));
}

/**
 * Kitaplığı süzer. state: {query, fav, tag}; ctx: {isFav(id), tagIdsOf(id), tagName(tid)}.
 *   query: ad + etiket adlarında (AND), fav: yalnız favoriler, tag: yalnız bu etiketli şarkılar.
 * Sıra korunur (sunucu sırası: yeniden eskiye). Favoriler ÜSTE alınır (kendi aralarında aynı sıra); `pinFavorites: false`
 * ile kapatılabilir.
 */
export function filterSongs(songs, state = {}, ctx = {}, { pinFavorites = true } = {}) {
  const tokens = queryTokens(state.query || "");
  const isFav = ctx.isFav || (() => false);
  const tagIdsOf = ctx.tagIdsOf || (() => []);
  const tagName = ctx.tagName || (() => "");
  const kept = songs.filter((song) => {
    if (state.fav && !isFav(song.id)) return false;
    const tagIds = tagIdsOf(song.id);
    if (state.tag && !tagIds.includes(state.tag)) return false;
    if (!tokens.length) return true;
    return matchesTokens(songText(song, tagIds.map(tagName)), tokens);
  });
  if (!pinFavorites) return kept;
  const favs = kept.filter((song) => isFav(song.id));
  if (!favs.length || favs.length === kept.length) return kept;
  return [...favs, ...kept.filter((song) => !isFav(song.id))];
}

/** Süzme açık mı? (boş durum mesajı ve "Süzmeyi temizle" için) */
export function isFiltering(state = {}) {
  return Boolean(queryTokens(state.query || "").length || state.fav || state.tag);
}

/** Bir sonuç listesinde favoriden sonra gelen ilk satırın indeksi (ince ayraç için); ayraç gerekmiyorsa -1. */
export function separatorIndex(list, isFav) {
  const first = list.findIndex((song) => !isFav(song.id));
  if (first <= 0) return -1;
  return list.slice(first).some((song) => isFav(song.id)) ? -1 : first;
}
