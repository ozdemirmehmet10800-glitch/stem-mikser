// açılış hızı: bilgi önbelleği
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { dropKicks } from "../beatpulse.js";
import { dropCache as dropLyricsCache } from "../lyrics.js";

let lyricsStorage;   // app.js'ten (bind)

//
// ÖLÇÜM (masaüstü, 110 sn şarkı, Yüksek kip):
//   ilk açılış      2880 ms = bilgi 18 + indirme 253 + ÇÖZME 2593 + arayüz 16
//   aynı şarkı      2953 ms = bilgi 15 + önbellek 19 + ÇÖZME 2914 + arayüz 5
//   farklı şarkı    4145 ms = bilgi 18 + indirme 259 + ÇÖZME 3867 + arayüz 1
// Yani zamanın %90'ından fazlası decodeAudioData'da. İki sonuç çıkıyor:
//   1. Aynı şarkıya dönerken tamponlar ZATEN bellekte - yeniden çözmek saf
//      israf. Hızlı yol bunu tamamen siliyor.
//   2. Farklı şarkıda çözme kaçınılmaz; ikişerli çözmek (engine.loadStems)
//      indirmeyi de altına saklıyor.
// `bilgi` masaüstünde 18 ms ama telefonda Modal konteyneri soğuksa saniyeler
// sürebiliyor; o yüzden durum/akor cihazda saklanıyor ve açılış onu bekletmiyor.

const META_PREFIX = "stem-mikser.meta.";
const META_LIMIT = 40;          // şarkı başına ~12 KB; localStorage'a rahat sığar

function metaKey(id) {
  return META_PREFIX + id;
}

export function readMeta(id) {
  try {
    const raw = localStorage.getItem(metaKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeMeta(id, detail) {
  try {
    localStorage.setItem(metaKey(id), JSON.stringify({
      status: detail.status, chords: detail.chords, savedAt: Date.now(),
    }));
    pruneMeta();
  } catch {
    // Kota dolduysa önemli değil: açılış yavaşlar, bozulmaz.
  }
}

export function dropMeta(ids) {
  const lyricsKeep = lyricsStorage();
  if (lyricsKeep) {
    dropLyricsCache(lyricsKeep, ids);       // cihazdaki sözler de gitsin
    TR.dropCache(lyricsKeep, ids);          // ve çeviri önbelleği
    dropKicks(lyricsKeep, ids);             // ve kick vuruş listesi
  }
  for (const id of ids || []) {
    try {
      localStorage.removeItem(metaKey(id));
    } catch {
      /* yok say */
    }
  }
}

function pruneMeta() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(META_PREFIX)) keys.push(key);
    }
    if (keys.length <= META_LIMIT) return;
    const aged = keys.map((key) => {
      let savedAt = 0;
      try {
        savedAt = (JSON.parse(localStorage.getItem(key)) || {}).savedAt || 0;
      } catch {
        savedAt = 0;
      }
      return { key, savedAt };
    }).sort((a, b) => a.savedAt - b.savedAt);
    for (const item of aged.slice(0, aged.length - META_LIMIT)) {
      localStorage.removeItem(item.key);
    }
  } catch {
    /* yok say */
  }
}

export function bind(deps) {
  ({ lyricsStorage } = deps);
}
