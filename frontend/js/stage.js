// Sahne modu mantığı: SAF (DOM, ses, depolama YOK). node tests\stage_test.mjs
//
// Sahnede ekran: büyük akor (+ sıradaki akor), büyük söz satırı (+ sıradaki), ilerleme, sıradaki şarkı. Burada yalnız "şu an ne gösterilecek"
// hesabı var; çizimi app.js yapar. Akor ve sözler yoksa ilgili alan boş döner (ekran yine çalışır).

import { soundingAt } from "./chordsheet.js";
import { findLine, highlightTime } from "./lyrics.js";
import { NO_CHORD } from "./tonality.js";

export const LOCK_HOLD_MS = 700;           // kilidi açmak için kilit simgesine basılı tutma süresi

/**
 * chords: chordsheet.prepareChords çıktısı [{i, start, end, label}]; lines: söz satırları [{t, text}] ya da boş.
 * Dönen {ci, next, li, nextLi}: ci = çalan akor indeksi (yoksa -1), next = ondan SONRAKİ farklı akor (yoksa -1; "N" atlanır),
 * li = o anki söz satırı (yoksa -1), nextLi = bir sonraki satır (yoksa -1).
 */
export function stageState({ chords = [], lines = [], time = 0 } = {}) {
  let ci = -1;
  let next = -1;
  if (chords.length) {
    ci = soundingAt(chords, time);
    const current = ci >= 0 ? chords[ci].label : null;
    const from = ci >= 0 ? ci + 1 : chords.findIndex((chord) => chord.start > time);
    if (from >= 0) {
      for (let i = from; i < chords.length; i += 1) {
        if (chords[i].label !== NO_CHORD && chords[i].label !== current) {
          next = i;
          break;
        }
      }
    }
  }
  let li = -1;
  let nextLi = -1;
  if (lines.length) {
    li = findLine(lines, highlightTime(time));
    const candidate = li + 1;
    nextLi = candidate < lines.length ? candidate : -1;
  }
  return { ci, next, li, nextLi };
}

/** İlerleme çizgisi için 0..1. */
export function stageProgress(time, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.max(Number(time) / total, 0), 1);
}

/** Sahne kilidi: kilitliyken dokunuşlar yutulur; açmak için kilit simgesine LOCK_HOLD_MS basılı tutulur. Dönen: kilit açıldı mı. */
export function holdUnlocks(heldMs) {
  return Number(heldMs) >= LOCK_HOLD_MS;
}
