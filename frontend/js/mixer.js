// Kanal şeridi: isim + ikon, fader (%0-150, dB göstergesi), Solo, Mute.
// Görsel referans: Moises mikser ekranı - ince fader çizgisi, duyulan kanal
// parlak, susturulmuş kanal soluk.

import { STEM_ORDER, STEM_LABELS, gainToDb } from "./engine.js";

const ICONS = {
  vocals: '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/>',
  drums: '<path d="M12 3C7 3 3 5 3 7.5v9C3 19 7 21 12 21s9-2 9-4.5v-9C21 5 17 3 12 3zm0 2c4.4 0 7 1.6 7 2.5S16.4 10 12 10 5 8.4 5 7.5 7.6 5 12 5z"/>',
  bass: '<path d="M18 3l3 3-2.3 2.3a3 3 0 0 1-1 .7l-2 .7-4.4 4.4a4 4 0 1 1-1.4-1.4l4.4-4.4.7-2a3 3 0 0 1 .7-1L18 3zM8 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  guitar: '<path d="M19 2l3 3-3.5 3.5-1-1-3 3 .6.6a4 4 0 1 1-1.4 1.4l-.6-.6-3 3 1 1L7.5 20 4.5 17 8 13.5l1 1 3-3-.6-.6a4 4 0 0 1 5.7-5.7l.6.6 3-3-1-1L19 2z"/>',
  piano: '<path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h2v-5h1V6H5zm5 0v7h1v5h2v-5h1V6h-4zm6 0v7h1v5h2V6h-3z"/>',
  other: '<path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6z"/>',
};

export class Mixer {
  constructor(container, engine, onChange) {
    this.container = container;
    this.engine = engine;
    this.onChange = onChange;
    this.rows = new Map();
  }

  render(stemNames) {
    this.container.innerHTML = "";
    this.rows.clear();

    const ordered = STEM_ORDER.filter((name) => stemNames.includes(name));
    for (const name of stemNames) {
      if (!ordered.includes(name)) ordered.push(name);
    }

    for (const name of ordered) {
      const row = document.createElement("div");
      row.className = "channel";

      const label = document.createElement("div");
      label.className = "channel-name";
      label.innerHTML =
        `<svg viewBox="0 0 24 24">${ICONS[name] || ICONS.other}</svg>` +
        `<span>${STEM_LABELS[name] || name}</span>`;

      const fader = document.createElement("input");
      fader.type = "range";
      fader.className = "fader";
      fader.min = "0";
      fader.max = "150";
      fader.step = "1";
      fader.value = "100";
      fader.setAttribute("aria-label", `${STEM_LABELS[name] || name} seviyesi`);

      const db = document.createElement("div");
      db.className = "channel-db";
      db.textContent = "0.0 dB";

      const solo = document.createElement("button");
      solo.className = "toggle";
      solo.textContent = "S";
      solo.title = "Solo";

      const mute = document.createElement("button");
      mute.className = "toggle";
      mute.textContent = "M";
      mute.title = "Sustur";

      fader.addEventListener("input", () => {
        const gain = Number(fader.value) / 100;
        this.engine.setFader(name, gain);
        db.textContent = `${gainToDb(gain)} dB`;
        this.refresh();
      });
      solo.addEventListener("click", () => {
        this.engine.toggleSolo(name);
        this.refresh();
      });
      mute.addEventListener("click", () => {
        this.engine.toggleMute(name);
        this.refresh();
      });

      row.append(label, fader, db, solo, mute);
      this.container.append(row);
      this.rows.set(name, { row, fader, db, solo, mute });
    }
    this.refresh();
  }

  refresh() {
    for (const [name, parts] of this.rows) {
      const channel = this.engine.channels.get(name);
      if (!channel) continue;
      parts.solo.classList.toggle("on-solo", channel.solo);
      parts.mute.classList.toggle("on-mute", channel.mute);
      parts.row.classList.toggle("audible", this.engine.isAudible(name));
    }
    if (this.onChange) this.onChange();
  }
}
