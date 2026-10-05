// Kanal şeridi: isim + ikon, fader (%0-150, dB göstergesi), Solo, Mute.
// Görsel referans: Moises mikser ekranı - ince fader çizgisi, duyulan kanal
// parlak, susturulmuş kanal soluk.

import { STEM_ORDER, STEM_LABELS, gainToDb } from "./engine.js";
import { Fader } from "./fader.js";
import { isNeutralFx } from "./fx.js";

const ICONS = {
  vocals: '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/>',
  drums: '<path d="M12 3C7 3 3 5 3 7.5v9C3 19 7 21 12 21s9-2 9-4.5v-9C21 5 17 3 12 3zm0 2c4.4 0 7 1.6 7 2.5S16.4 10 12 10 5 8.4 5 7.5 7.6 5 12 5z"/>',
  bass: '<path d="M18 3l3 3-2.3 2.3a3 3 0 0 1-1 .7l-2 .7-4.4 4.4a4 4 0 1 1-1.4-1.4l4.4-4.4.7-2a3 3 0 0 1 .7-1L18 3zM8 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  guitar: '<path d="M19 2l3 3-3.5 3.5-1-1-3 3 .6.6a4 4 0 1 1-1.4 1.4l-.6-.6-3 3 1 1L7.5 20 4.5 17 8 13.5l1 1 3-3-.6-.6a4 4 0 0 1 5.7-5.7l.6.6 3-3-1-1L19 2z"/>',
  piano: '<path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h2v-5h1V6H5zm5 0v7h1v5h2v-5h1V6h-4zm6 0v7h1v5h2V6h-3z"/>',
  other: '<path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6z"/>',
};
// Alt kanallar ana kanalın simgesini kullanıyor.
ICONS.lead = ICONS.vocals;
ICONS.backing = ICONS.vocals;
for (const name of ["kick", "snare", "toms", "hihat", "cymbals"]) ICONS[name] = ICONS.drums;

const DOWNLOAD_FORMATS = [
  ["m4a", "M4A", "oynatma kalitesi, küçük"],
  ["flac", "FLAC", "kayıpsız master"],
  ["wav", "WAV", "kayıpsız, düzenleme için"],
];

export class Mixer {
  constructor(container, engine, onChange, onDownload) {
    this.container = container;
    this.engine = engine;
    this.onChange = onChange;
    this.onDownload = onDownload;
    this.rows = new Map();
    this.groupSpecs = new Map();   // ana kanal -> alt parça denetimi (app.js verir)
    this.groupCtls = new Map();
    this.openMenu = null;
    // Menü açılıp kapandığında haber veriliyor: geri tuşu katman yığınını
    // buradan öğreniyor (app.js). Mikser history'yi BİLMİYOR.
    this.onMenuChange = null;
    // Kanal adına/simgesine dokunma: kanal ayarı sayfası (pan, EQ, yankı gönderimi; Aşama 15). app.js verir.
    this.onFx = null;
    // Menü dışına dokununca kapansın.
    document.addEventListener("pointerdown", (event) => {
      if (this.openMenu && !this.openMenu.contains(event.target)) this.closeMenu();
    });
  }

  closeMenu() {
    if (this.openMenu) {
      this.openMenu.hidden = true;
      this.openMenu = null;
      if (this.onMenuChange) this.onMenuChange(false);
    }
  }

  #buildDownload(name) {
    const wrap = document.createElement("div");
    wrap.className = "dl";

    const button = document.createElement("button");
    button.className = "toggle dl-btn";
    button.title = `${STEM_LABELS[name] || name} indir`;
    button.setAttribute("aria-label", `${STEM_LABELS[name] || name} indir`);
    button.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 3v10.2l3.6-3.6L17 11l-5 5-5-5 1.4-1.4L12 13.2V3zM5 19h14v2H5z"/></svg>';

    const menu = document.createElement("div");
    menu.className = "dl-menu";
    menu.hidden = true;
    for (const [format, label, hint] of DOWNLOAD_FORMATS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "dl-item";
      item.innerHTML = `<b>${label}</b><span>${hint}</span>`;
      item.addEventListener("click", () => {
        this.closeMenu();
        if (this.onDownload) this.onDownload(name, format);
      });
      menu.append(item);
    }

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const acik = this.openMenu === menu;
      this.closeMenu();
      if (!acik) {
        menu.hidden = false;
        this.openMenu = menu;
        if (this.onMenuChange) this.onMenuChange(true);
      }
    });

    wrap.append(button, menu);
    return wrap;
  }

  /**
   * Alt parça denetimi (ana kanalın hemen altında): düğme / durum metni / açma
   * oku / rozet. spec = null ise kaldırılır. Biçim: sub.js::subView çıktısı +
   * `onButton`, `onToggle`. render() sonrasında da korunur.
   */
  setGroupControl(parentName, spec) {
    if (spec) this.groupSpecs.set(parentName, spec);
    else this.groupSpecs.delete(parentName);
    this.#renderGroupControl(parentName);
  }

  #renderGroupControl(parentName) {
    const old = this.groupCtls.get(parentName);
    const parts = this.rows.get(parentName);
    const spec = this.groupSpecs.get(parentName);
    if (old) {
      old.remove();
      this.groupCtls.delete(parentName);
    }
    if (!parts || !spec) return;

    const ctl = document.createElement("div");
    ctl.className = `sub-ctl ${spec.kind || ""}`;
    if (spec.arrow) {
      const arrow = document.createElement("button");
      arrow.type = "button";
      arrow.className = "sub-arrow";
      arrow.textContent = spec.arrow === "open" ? "▾" : "▸";
      arrow.disabled = Boolean(spec.disabled);
      arrow.setAttribute("aria-expanded", String(spec.arrow === "open"));
      arrow.setAttribute("aria-label", spec.arrow === "open"
        ? "Alt parçaları kapat" : "Alt parçaları aç");
      arrow.addEventListener("click", () => spec.onToggle && spec.onToggle());
      ctl.append(arrow);
    }
    if (spec.text) {
      const text = document.createElement("span");
      text.className = "sub-text";
      text.textContent = spec.text;
      ctl.append(text);
    }
    if (spec.badge) {
      const badge = document.createElement("span");
      badge.className = "sub-badge";
      badge.textContent = spec.badge;
      ctl.append(badge);
    }
    if (spec.button) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip sub-button";
      button.textContent = spec.button;
      button.disabled = Boolean(spec.disabled);
      button.addEventListener("click", () => spec.onButton && spec.onButton());
      ctl.append(button);
    }
    if (spec.hint) {
      const hint = document.createElement("span");
      hint.className = "sub-hint";
      hint.textContent = spec.hint;
      ctl.append(hint);
    }
    parts.row.after(ctl);
    this.groupCtls.set(parentName, ctl);
  }

  /**
   * stemNames: gösterilecek kanallar (ana kanal AÇIKKEN bile listede: grup
   * başlığı). groups: Map ana -> [alt adlar] (açık gruplar); alt satırlar ana
   * satırın altında girintili gelir.
   */
  render(stemNames, groups = new Map()) {
    this.container.innerHTML = "";
    this.rows.clear();
    this.groupCtls.clear();

    const childSet = new Set([...groups.values()].flat());
    const top = STEM_ORDER.filter((name) => stemNames.includes(name));
    for (const name of stemNames) {
      if (!top.includes(name) && !childSet.has(name)) top.push(name);
    }
    const ordered = [];
    for (const name of top) {
      ordered.push(name);
      for (const child of groups.get(name) || []) {
        if (stemNames.includes(child)) ordered.push(child);
      }
    }

    for (const name of ordered) {
      const isChild = childSet.has(name);
      const row = document.createElement("div");
      row.className = "channel" + (isChild ? " sub" : "")
        + (groups.has(name) ? " group" : "");

      const label = document.createElement("div");
      label.className = "channel-name";
      label.innerHTML =
        `<svg viewBox="0 0 24 24">${ICONS[name] || ICONS.other}</svg>` +
        `<span>${STEM_LABELS[name] || name}</span>`;
      label.setAttribute("role", "button");
      label.tabIndex = 0;
      label.title = "Kanal ayarı: pan, ekolayzer, yankı";
      label.addEventListener("click", () => { if (this.onFx) this.onFx(name); });
      label.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (this.onFx) this.onFx(name);
        }
      });

      const db = document.createElement("div");
      db.className = "channel-db";
      db.textContent = "0.0 dB";

      const fader = new Fader({
        min: 0, max: 150, value: 100, step: 1,
        label: `${STEM_LABELS[name] || name} seviyesi`,
        onInput: (percent) => {
          const gain = percent / 100;
          this.engine.setFader(name, gain);
          const text = `${gainToDb(gain)} dB`;
          db.textContent = text;
          fader.setValueText(`%${percent}, ${text}`);
          this.refresh();
        },
      });
      fader.setValueText("%100, 0.0 dB");

      const solo = document.createElement("button");
      solo.className = "toggle";
      solo.textContent = "S";
      solo.title = "Solo";

      const mute = document.createElement("button");
      mute.className = "toggle";
      mute.textContent = "M";
      mute.title = "Sustur";

      solo.addEventListener("click", () => {
        this.engine.toggleSolo(name);
        this.refresh();
      });
      mute.addEventListener("click", () => {
        this.engine.toggleMute(name);
        this.refresh();
      });

      // Alt kanalın indirme menüsü yok (indirme ana kanaldan).
      row.append(label, fader.element, db, solo, mute,
                 isChild ? document.createElement("span") : this.#buildDownload(name));
      this.container.append(row);
      this.rows.set(name, { row, fader, db, solo, mute });
      // Alt parça denetimi ana satırın hemen altına; alt satırlar ondan SONRA
      // eklendiği için sıra korunur.
    }
    for (const parentName of this.groupSpecs.keys()) this.#renderGroupControl(parentName);
    this.refresh();
  }

  // Motor durumunu (fader, solo, mute) arayüze yansıtır. Fader ve dB metni
  // yalnız kullanıcı sürüklerken yazılıyordu; kayıttan/ön ayardan gelen durum
  // için buradan. onChange'i ÇAĞIRMAZ (geri yükleme kayıt tetiklemesin).
  syncFromEngine() {
    for (const [name, parts] of this.rows) {
      const channel = this.engine.channels.get(name);
      if (!channel) continue;
      const percent = Math.round(channel.fader * 100);
      const text = `${gainToDb(channel.fader)} dB`;
      parts.fader.set(percent, false);
      parts.db.textContent = text;
      parts.fader.setValueText(`%${percent}, ${text}`);
    }
    this.refresh(false);
  }

  refresh(notify = true) {
    for (const [name, parts] of this.rows) {
      const channel = this.engine.channels.get(name);
      if (!channel) continue;
      parts.solo.classList.toggle("on-solo", channel.solo);
      parts.mute.classList.toggle("on-mute", channel.mute);
      // Açık grup başlığı: altındaki herhangi biri duyuluyorsa parlak.
      const members = channel.children && channel.children.length ? channel.children : null;
      const heard = members
        ? members.some((child) => this.engine.isAudible(child))
        : this.engine.isAudible(name);
      parts.row.classList.toggle("audible", heard);
      // Pan / EQ / yankı gönderimi nötr değilse isimde küçük nokta.
      parts.row.classList.toggle("has-fx", !isNeutralFx(channel));
    }
    if (notify && this.onChange) this.onChange();
  }
}
