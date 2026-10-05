// Çalma listesi (prova modu): SAF çalma mantığı (DOM, depolama, ses yok). node tests\playlist_test.mjs
//
// Veri js/collection.js'te: lists[lid] = {name, cur?, items: [{iid, song, miss?}]}. Burası "sıradaki ne?" kuralları:
//  - bir öğe ÇALINABİLİR mi: şarkı kitaplıkta var ve hazır ("done"), "kayıp" damgalı değil, çevrimdışıysa cihazda kopyası var
//  - sıradaki / önceki: çalınamayanlar ATLANIR (atlananlar kullanıcıya söylenir)
//  - önceki: konum 3 sn'den büyükse AYNI şarkıyı başa sar, değilse bir önceki şarkı
//  - liste bitince DURUR (liste döngüsü yok)
// Aynı şarkı bir listede birden çok kez olabildiği için konum ÖĞE kimliğiyle (iid) tutulur, şarkı kimliğiyle değil.

export const PREVIOUS_RESTART_SECONDS = 3;

/**
 * ctx: {songById(id) -> şarkı | null, offline: boolean, offlineReady(song) -> boolean}.
 * Dönen: "ok" | "missing" (kayıp damgalı ya da kitaplıkta yok) | "notready" (işleniyor/hata) | "offline" (çevrimdışı, kopya yok).
 */
export function itemState(item, ctx) {
  if (!item || item.miss) return "missing";
  const song = ctx.songById(item.song);
  if (!song) return "missing";
  if (song.state !== "done") return "notready";
  if (ctx.offline && !ctx.offlineReady(song)) return "offline";
  return "ok";
}

export const isPlayable = (item, ctx) => itemState(item, ctx) === "ok";

/**
 * `from`dan SONRAKİ ilk çalınabilir öğe. Dönen: {index, skipped: [öğe...]}; index -1 = liste bitti.
 * skipped: arada atlanan (çalınamayan) öğeler.
 */
export function nextPlayable(items, from, ctx) {
  const skipped = [];
  for (let i = from + 1; i < items.length; i += 1) {
    if (isPlayable(items[i], ctx)) return { index: i, skipped };
    skipped.push(items[i]);
  }
  return { index: -1, skipped };
}

/** `from`dan ÖNCEKİ ilk çalınabilir öğe (yukarı doğru). */
export function previousPlayable(items, from, ctx) {
  const skipped = [];
  for (let i = from - 1; i >= 0; i -= 1) {
    if (isPlayable(items[i], ctx)) return { index: i, skipped };
    skipped.push(items[i]);
  }
  return { index: -1, skipped };
}

/** Öğe kimliğinin indeksi; yoksa -1. */
export function indexOfItem(items, iid) {
  return items.findIndex((item) => item.iid === iid);
}

/**
 * "Baştan çal" = ilk çalınabilir; "Devam" = `cur` öğesi (çalınabilirse), değilse ondan sonraki ilk çalınabilir.
 * Dönen: {index, skipped}; index -1 = çalınabilir öğe yok.
 */
export function startIndex(items, cur, ctx) {
  if (cur) {
    const at = indexOfItem(items, cur);
    if (at >= 0) {
      if (isPlayable(items[at], ctx)) return { index: at, skipped: [] };
      const after = nextPlayable(items, at, ctx);
      return { index: after.index, skipped: [items[at], ...after.skipped] };
    }
  }
  return nextPlayable(items, -1, ctx);
}

/** "Önceki" düğmesi/kilit ekranı: {action: "restart"} (aynı şarkıyı başa sar) ya da {action: "previous", index, skipped} ya da {action: "restart"} (öncesi yoksa). */
export function previousAction(items, index, position, ctx) {
  if (Number(position) > PREVIOUS_RESTART_SECONDS) return { action: "restart" };
  const found = previousPlayable(items, index, ctx);
  if (found.index < 0) return { action: "restart" };
  return { action: "previous", index: found.index, skipped: found.skipped };
}

/** Çalınabilir öğe var mı ("Çal" düğmesi)? */
export function anyPlayable(items, ctx) {
  return items.some((item) => isPlayable(item, ctx));
}

/** Atlananları kullanıcıya söyleyen tek cümle; hiç atlanan yoksa "". titleOf(item) -> görünen ad. */
export function skipNote(skipped, titleOf, ctx) {
  if (!skipped.length) return "";
  const first = titleOf(skipped[0]);
  const reason = itemState(skipped[0], ctx);
  const why = reason === "offline" ? "telefonda kayıtlı değil"
    : reason === "notready" ? "henüz hazır değil" : "bulunamadı";
  return skipped.length === 1 ? `${first} atlandı: ${why}.` : `${skipped.length} şarkı atlandı (${first}: ${why}, ...).`;
}

/** Liste toplam süresi (sn): durationOf(item) -> sn ya da 0. */
export function totalDuration(items, durationOf) {
  return items.reduce((sum, item) => sum + (Number(durationOf(item)) || 0), 0);
}

/** Oynatıcıdaki durum satırı: "Cuma provası · 2/4". index 0 tabanlı. */
export function positionLabel(listName, index, count) {
  return `${listName} · ${index + 1}/${count}`;
}

/** Listeye ekleme: seçilenlerden listede ZATEN olanlar (onay sorusu için). */
export function alreadyInList(items, songIds) {
  const present = new Set(items.map((item) => item.song));
  return [...new Set(songIds)].filter((id) => present.has(id));
}
