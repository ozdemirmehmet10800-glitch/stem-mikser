// Karaoke tarzı kelime vurgusu: çalan satırda o an söylenen kelime parlar (söyleneni geçen kelimeler "done", sıradakiler sönük).
// SAF + küçük DOM yardımcısı (yalnız createEl/className/textContent; fakedom'la test edilir). node tests\karaoke_test.mjs
//
// Kelime zamanları sözlerin `w` alanında: [[başlangıç, bitiş, "kelime"], ...] (şarkı saniyesi). Parçalar satır metniyle uyuşmazsa
// (ör. elle düzenlenmiş satır) satır eskisi gibi düz kalır. Ayar: Ayarlar > Sözler > "Kelime kelime parlasın" (varsayılan AÇIK).

import { tokensOf } from "./chordsheet.js";

export const WORDGLOW_KEY = "stem-mikser.wordglow";

export function readWordGlow(storage) {
  try {
    return (storage && storage.getItem(WORDGLOW_KEY)) !== "0";
  } catch {
    return true;
  }
}

export function writeWordGlow(storage, on) {
  try {
    storage.setItem(WORDGLOW_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;                 // tercih bu oturumda kalır
  }
}

/** t anında söylenen (ya da en son başlamış) kelimenin sırası; ilk kelimeden önce -1. `t` zaten vurgu payıyla (highlightTime) verilir. */
export function sungIndex(words, t) {
  const list = Array.isArray(words) ? words : [];
  let found = -1;
  for (let k = 0; k < list.length; k += 1) {
    const start = Number(list[k] && list[k][0]);
    if (!(start <= t)) break;
    found = k;
  }
  return found;
}

/** Kelime k için sınıf: önceki kelimeler "kw done", şimdiki "kw now", sonrakiler "kw". */
export function wordClass(k, sung) {
  return k < sung ? "kw done" : k === sung ? "kw now" : "kw";
}

/**
 * Tek satırlık parlatıcı: `attach` satırın ana düğümünü kelime düğümlerine böler, `update(t)` yalnız şimdiki kelime değişince
 * sınıfları yazar (her karede DOM'a dokunmaz), `detach` düğümü düz metne geri çevirir.
 */
export class WordGlow {
  constructor(createEl) {
    this.createEl = createEl;
    this.main = null;
    this.line = null;
    this.nodes = [];
    this.sung = -2;
  }

  get active() {
    return this.nodes.length > 0;
  }

  /** Satırı kelimelere böler; kelime zamanı yoksa/uyuşmazsa false (düğüme dokunmaz). */
  attach(main, line, language) {
    this.detach();
    const parts = main && line ? tokensOf(line, language) : null;
    if (!parts || parts.tokens.length < 2) return false;
    main.textContent = "";
    parts.tokens.forEach((token, k) => {
      const node = this.createEl("span");
      node.className = "kw";
      node.textContent = token.trim() + (k < parts.tokens.length - 1 ? parts.joiner : "");
      main.append(node);
      this.nodes.push(node);
    });
    this.main = main;
    this.line = line;
    this.sung = -2;
    return true;
  }

  update(t) {
    if (!this.nodes.length) return;
    const sung = sungIndex(this.line.w, t);
    if (sung === this.sung) return;
    this.sung = sung;
    this.nodes.forEach((node, k) => {
      const name = wordClass(k, sung);
      if (node.className !== name) node.className = name;
    });
  }

  detach() {
    if (this.main && this.line && this.nodes.length) this.main.textContent = this.line.text;
    this.forget();
  }

  /** Düğüm başka biri tarafından yeniden çizildiyse (ör. liste baştan kuruldu): dokunmadan unut. */
  forget() {
    this.main = null;
    this.line = null;
    this.nodes = [];
    this.sung = -2;
  }
}
