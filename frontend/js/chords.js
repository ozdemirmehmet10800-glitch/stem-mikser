// Akor şeridi.
//
// Canvas yerine DOM: metin, tıklama isabet testi ve erişilebilirlik bedava.
// Ölçüler downbeat'lerden çıkarılıyor; bir akor ölçü sınırını aşıyorsa her
// iki ölçüde de görünüyor (terminal çizelgesiyle aynı mantık).
//
// Izgara görünümü (ölçü başına 4 sabit vuruş hücresi) şimdilik kapsam dışı;
// PLAN.md'de "sonraki iyileştirmeler" altında.

import { transposeLabel, namesForKey, NO_CHORD } from "./tonality.js";

const TARGET_BAR_WIDTH = 168; // px; pxPerSec buradan türetiliyor
const PLAYHEAD_RATIO = 0.15;  // şeridin solundan oran

export class ChordStrip {
  constructor(root, trackEl, emptyEl, onSeek) {
    this.root = root;
    this.track = trackEl;
    this.empty = emptyEl;
    this.onSeek = onSeek;
    this.cells = [];
    this.pxPerSec = 0;
    this.activeIndex = -1;
    // Ton kaydırma durumu: etiketler bununla yeniden yazılıyor.
    this.semitones = 0;
    this.songKey = null;
  }

  clear() {
    this.track.innerHTML = "";
    this.cells = [];
    this.activeIndex = -1;
    this.track.style.transform = "translateX(0)";
    this.empty.hidden = false;
  }

  build(chordData, duration) {
    this.clear();
    if (!chordData || !chordData.chords || !chordData.chords.length) return;

    const downbeats = (chordData.downbeats || []).slice();
    const chords = chordData.chords;
    const endTime = Math.max(duration || 0, chords[chords.length - 1].end);

    // Ölçü sınırları: downbeat yoksa akorların kendisini ölçü say.
    let bounds;
    if (downbeats.length >= 2) {
      bounds = downbeats.slice();
      bounds.push(endTime);
    } else {
      bounds = chords.map((chord) => chord.start);
      bounds.push(endTime);
    }

    // Ölçü genişliği tutarlı olsun diye pxPerSec'i ölçü süresinin
    // MEDYANINDAN türetiyoruz (bpm'den değil).
    const spans = [];
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const span = bounds[i + 1] - bounds[i];
      if (span > 0.05) spans.push(span);
    }
    spans.sort((a, b) => a - b);
    const medianBar = spans.length ? spans[Math.floor(spans.length / 2)] : 2;
    this.pxPerSec = TARGET_BAR_WIDTH / medianBar;

    // İlk downbeat 0'da değilse baştaki boşluğu ayrı bir ölçü yapmıyoruz:
    // yarım ölçüden kısaysa ilk ölçüyü geriye uzatıyoruz, uzunsa kendi
    // ölçüsü oluyor. Aksi halde şeridin başında ince bir artık kalıyordu.
    if (bounds[0] > 0.05) {
      if (bounds[0] < medianBar * 0.6) bounds[0] = 0;
      else bounds.unshift(0);
    }

    this.empty.hidden = true;

    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const barStart = bounds[i];
      const barEnd = bounds[i + 1];
      if (barEnd <= barStart) continue;

      const bar = document.createElement("div");
      bar.className = "bar";
      bar.style.left = `${barStart * this.pxPerSec}px`;
      bar.style.width = `${(barEnd - barStart) * this.pxPerSec}px`;

      const inBar = chords.filter(
        (chord) => chord.end > barStart + 1e-6 && chord.start < barEnd - 1e-6
      );
      if (!inBar.length) {
        const blank = document.createElement("div");
        blank.className = "chord-cell none";
        blank.textContent = "·";
        bar.append(blank);
      }
      for (const chord of inBar) {
        const cellStart = Math.max(chord.start, barStart);
        const cellEnd = Math.min(chord.end, barEnd);
        const cell = document.createElement("div");
        cell.className = "chord-cell" + (chord.label === NO_CHORD ? " none" : "");
        cell.style.flexGrow = String(Math.max(cellEnd - cellStart, 0.01));
        cell.addEventListener("click", () => {
          if (this.onSeek) this.onSeek(chord.start);
        });
        bar.append(cell);
        // label ORİJİNAL etiket; ekrandaki metin #relabel'dan geliyor.
        this.cells.push({
          el: cell, start: cellStart, end: cellEnd,
          label: chord.label, labelStart: chord.start,
        });
      }
      this.track.append(bar);
    }

    this.track.style.width = `${endTime * this.pxPerSec}px`;
    this.#relabel();
    this.update(0);
  }

  /**
   * Ton değişince şerit yeniden KURULMUYOR: sadece etiket metinleri
   * yenileniyor, kaydırma konumu ve etkin hücre yerinde kalıyor.
   *
   * Yazım (bemol/diyez) YENİ tona göre seçiliyor - Fm'de "Ab" olan akor
   * +2 yarım sesle "Bb" olur, "A#" değil.
   */
  setTranspose(semitones, songKey) {
    this.semitones = Math.round(Number(semitones) || 0);
    this.songKey = songKey || null;
    this.#relabel();
  }

  #relabel() {
    if (!this.cells.length) return;
    const shift = this.semitones;
    const names = namesForKey(this.songKey, shift);
    for (const cell of this.cells) {
      const label = shift === 0 ? cell.label : transposeLabel(cell.label, shift, names);
      cell.el.textContent = label === NO_CHORD ? "·" : label;
      cell.el.title = `${label}  ${formatTime(cell.labelStart)}`;
    }
  }

  update(time) {
    if (!this.pxPerSec) return;
    const offset = this.root.clientWidth * PLAYHEAD_RATIO - time * this.pxPerSec;
    this.track.style.transform = `translateX(${offset}px)`;

    let next = -1;
    for (let i = 0; i < this.cells.length; i += 1) {
      const cell = this.cells[i];
      if (time >= cell.start - 1e-6 && time < cell.end) {
        next = i;
        break;
      }
    }
    if (next === this.activeIndex) return;
    if (this.activeIndex >= 0 && this.cells[this.activeIndex]) {
      this.cells[this.activeIndex].el.classList.remove("active");
    }
    if (next >= 0) this.cells[next].el.classList.add("active");
    this.activeIndex = next;
  }
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
