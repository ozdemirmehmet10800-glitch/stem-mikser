// Tam ekran sözler (Aşama 13). Satır bulma/kaydırma hedefi lyrics.js'ten, vuruş mantığı
// beatpulse.js'ten GELİR; burada yalnız ekranın DOM yaşam döngüsü var.
//
// PERFORMANS KURALLARI (ses motoru takılmasın):
//  - Hareket eden her şey yalnız transform + opacity (kompozitör). Satır değişimi: iz
//    (track) tek translate3d, satırlar yalnız opacity/transform geçişi. Hareketli öğede
//    blur, canvas piksel işleme, kare başı yeniden boyama YOK.
//  - DOM'a yalnız satır DEĞİŞİNCE dokunulur (kare başı tick: ikili arama + karşılaştırma).
//  - Ekran kapalı ya da uygulama arka plandayken hiçbir şey çalışmaz: tick erken döner,
//    CSS animasyonlar `paused` sınıfıyla durur, nabız animasyonları iptal, video durur.
//  - Dinleyiciler: kalıcı olanlar constructor'da BİR kez; document/window dinleyicileri
//    yalnız ekran açıkken (açılışta ekle, kapanışta kaldır), yani aç/kapa iz bırakmaz.
//
// DOM'a bağımlılık küçük bir yüzeyle sınırlı (ui düğümleri + createEl + doc/win verilir);
// node'da sahte DOM ile test ediliyor: node tests\lyricsscreen_test.mjs

import { findLine, highlightTime, scrollTarget } from "./lyrics.js";
import { BeatTracker, wantsFlow, wantsPulse } from "./beatpulse.js";

export const WINDOW = 2;                       // ortadaki satırın iki yanında görünen satır sayısı
const POSITION_CLASSES = ["cur", "next", "d1", "d2"];
const PULSE_MS = 420;

export class LyricsScreen {
  constructor({
    ui, createEl, doc = globalThis.document, win = globalThis.window,
    reducedMotion = () => false, wakeLock = null, keepAwake = () => false,
    onSeek = () => {}, onTogglePlay = () => {}, onRequestClose = () => {}, onClosed = () => {}, onSettings = () => {},
  }) {
    this.ui = ui;
    this.createEl = createEl || ((tag) => doc.createElement(tag));
    this.doc = doc;
    this.win = win;
    this.reducedMotion = reducedMotion;
    this.wakeLock = wakeLock;
    this.keepAwake = keepAwake;
    this.onSeek = onSeek;
    this.onTogglePlay = onTogglePlay;
    this.onRequestClose = onRequestClose;
    this.onClosed = onClosed;
    this.onSettings = onSettings;

    this.isOpen = false;
    this.paused = false;
    this.playing = false;
    this.lines = [];
    this.index = -2;
    this.center = -2;
    this.tracker = new BeatTracker([]);
    this.strong = null;
    this.flowOn = false;
    this.pulseOn = false;
    this.anims = new Set();
    this.mediaEl = null;
    this.mediaRevoke = null;
    this.instantFrame = 0;
    this.lastTime = 0;

    // Kalıcı dinleyiciler (ui düğümleri ömür boyu aynı): BİR kez.
    ui.track.addEventListener("click", this.#onTrackClick);
    ui.playBtn.addEventListener("click", this.#onPlay);
    ui.closeBtn.addEventListener("click", this.#onCloseClick);
    ui.settingsBtn.addEventListener("click", this.#onSettingsClick);
  }

  // ------------------------------------------------------------ yaşam döngüsü

  open({ lines, lang = null, title = "", mode = "plain", beats = null, media = null,
         playing = false, time = 0 }) {
    if (this.isOpen) this.close(true);
    this.lines = lines || [];
    this.isOpen = true;
    this.paused = this.doc.visibilityState === "hidden";
    this.index = -2;
    this.center = -2;
    this.lastTime = time;
    this.ui.title.textContent = title;
    this.#buildLines(lang);
    this.ui.root.hidden = false;
    this.#applyPaused();
    this.setMode(mode);
    this.setBeats(beats);
    this.setMedia(media);
    this.setPlaying(playing);
    this.doc.addEventListener("visibilitychange", this.#onVisibility);
    this.win.addEventListener("resize", this.#onResize);
    if (this.wakeLock) this.wakeLock.request();
    // İlk yerleşim anında (kayma yok), sonra geçişler açılır.
    this.ui.track.classList.add("instant");
    this.tick(time, true);
    this.instantFrame = this.win.requestAnimationFrame(() => {
      this.instantFrame = this.win.requestAnimationFrame(() => {
        this.instantFrame = 0;
        this.ui.track.classList.remove("instant");
      });
    });
  }

  /** quiet: yeniden açılış için iç çağrı (onClose çağrılmaz). */
  close(quiet = false) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.doc.removeEventListener("visibilitychange", this.#onVisibility);
    this.win.removeEventListener("resize", this.#onResize);
    if (this.instantFrame) {
      this.win.cancelAnimationFrame(this.instantFrame);
      this.instantFrame = 0;
    }
    this.#cancelAnims();
    this.#clearMedia();
    this.ui.track.textContent = "";
    this.ui.track.classList.remove("instant");
    this.ui.root.hidden = true;
    this.ui.root.classList.remove("paused", "playing", "has-media");
    this.ui.flow.hidden = true;
    this.ui.pulse.hidden = true;
    this.lines = [];
    this.flowOn = false;
    this.pulseOn = false;
    this.tracker.reset();
    // Ekran Wake Lock'ı yalnız çalma da bitmişse bırakılır (çalarken oynatıcı kendi kilidini tutuyor).
    if (this.wakeLock && !this.keepAwake()) this.wakeLock.release();
    if (!quiet) this.onClosed();
  }

  // -------------------------------------------------------------- ayarlar

  setMode(mode) {
    this.flowOn = wantsFlow(mode);
    this.pulseOn = wantsPulse(mode);
    this.ui.flow.hidden = !this.flowOn;
    this.ui.pulse.hidden = !this.pulseOn;
    if (!this.pulseOn) this.#cancelAnims();
    this.tracker.reset();
    this.ui.root.dataset.bg = mode;
  }

  setBeats(beats) {
    this.tracker.setTimes(beats && beats.times ? beats.times : []);
    this.strong = beats ? beats.strong : null;
  }

  setPlaying(playing) {
    this.playing = Boolean(playing);
    this.ui.root.classList.toggle("playing", this.playing);
    this.ui.playBtn.setAttribute("aria-label", this.playing ? "Duraklat" : "Oynat");
    if (!this.playing) this.#cancelAnims();
  }

  /** media: {kind: "image" | "video", url, revoke?} ya da null. */
  setMedia(media) {
    this.#clearMedia();
    if (!media || !media.url) {
      this.ui.root.classList.remove("has-media");
      return;
    }
    const node = this.createEl(media.kind === "video" ? "video" : "img");
    if (media.kind === "video") {
      node.muted = true;
      node.loop = true;
      node.playsInline = true;
      node.setAttribute("muted", "");
      node.setAttribute("playsinline", "");
      node.src = media.url;
    } else {
      node.src = media.url;
      node.alt = "";
    }
    this.ui.media.append(node);
    this.mediaEl = node;
    this.mediaRevoke = media.revoke || null;
    this.ui.root.classList.add("has-media");
    if (media.kind === "video" && !this.paused) this.#playVideo();
  }

  /** Satırlar değişti (yeniden hizalama bitti): ekran açıksa yeniden kur; boşsa kapat. */
  setLines(lines, lang = null) {
    if (!this.isOpen) return;
    if (!lines || !lines.length) {
      this.close();
      return;
    }
    this.lines = lines;
    this.index = -2;
    this.center = -2;
    this.#buildLines(lang);
    this.tick(this.lastTime, true);
  }

  // ----------------------------------------------------------- görünürlük

  /** Uygulama görünür/gizli: gizliyken her şey durur. */
  setVisible(visible) {
    if (!this.isOpen) return;
    this.paused = !visible;
    this.#applyPaused();
    if (visible) this.tick(this.lastTime, true);
  }

  #applyPaused() {
    this.ui.root.classList.toggle("paused", this.paused);
    if (this.paused) {
      this.#cancelAnims();
      this.#pauseVideo();
    } else {
      this.#playVideo();
    }
  }

  #onVisibility = () => {
    this.setVisible(this.doc.visibilityState !== "hidden");
  };

  #onResize = () => {
    if (this.isOpen) this.#position();
  };

  // -------------------------------------------------------------- her kare

  /** Şarkı zamanı (engine.visualTime). Satır değişmedikçe DOM'a dokunmaz. */
  tick(time, force = false) {
    if (!this.isOpen) return;
    this.lastTime = time;
    if (this.paused) return;
    const lines = this.lines;
    const probe = highlightTime(time);
    const index = findLine(lines, probe);
    const center = index >= 0 ? index : scrollTarget(lines, probe);
    if (force || index !== this.index || center !== this.center) this.#paint(index, center);
    if (this.pulseOn && this.playing) {
      const fired = this.tracker.poll(time);
      if (fired >= 0) this.#pulse(fired);
    }
  }

  #paint(index, center) {
    const items = this.ui.track.children;
    const previous = this.center;
    if (previous >= 0) {
      for (let k = previous - WINDOW; k <= previous + WINDOW; k += 1) {
        if (items[k]) items[k].classList.remove(...POSITION_CLASSES);
      }
    }
    if (center >= 0) {
      for (let k = center - WINDOW; k <= center + WINDOW; k += 1) {
        const item = items[k];
        if (!item) continue;
        item.classList.remove(...POSITION_CLASSES);
        const distance = Math.abs(k - center);
        item.classList.add(distance === 0 ? (index >= 0 ? "cur" : "next") : distance === 1 ? "d1" : "d2");
      }
    }
    this.index = index;
    this.center = center;
    this.#position();
  }

  #position() {
    const item = this.center >= 0 ? this.ui.track.children[this.center] : null;
    const stageHeight = this.ui.stage.clientHeight;
    if (!item || !(stageHeight > 0)) return;
    const y = item.offsetTop + item.offsetHeight / 2 - stageHeight / 2;
    this.ui.track.style.transform = `translate3d(0, ${(-y).toFixed(1)}px, 0)`;
  }

  #pulse(beatIndex) {
    if (this.reducedMotion() || !this.ui.pulse.animate) return;
    const strong = this.strong && this.strong[beatIndex] ? 1 : 0;
    const anim = this.ui.pulse.animate(
      [
        { opacity: strong ? 0.6 : 0.38, transform: "scale(0.9)" },
        { opacity: 0, transform: "scale(1.15)" },
      ],
      { duration: PULSE_MS, easing: "ease-out" },
    );
    this.anims.add(anim);
    const done = () => this.anims.delete(anim);
    anim.onfinish = done;
    anim.oncancel = done;
  }

  #cancelAnims() {
    for (const anim of this.anims) {
      try { anim.cancel(); } catch { /* zaten bitmiş */ }
    }
    this.anims.clear();
  }

  // ------------------------------------------------------------ satırlar

  #buildLines(lang) {
    const track = this.ui.track;
    track.textContent = "";
    if (lang) track.lang = lang;
    else track.removeAttribute("lang");
    const fragment = this.doc.createDocumentFragment ? this.doc.createDocumentFragment() : track;
    this.lines.forEach((line, i) => {
      const item = this.createEl("li");
      item.className = "lf-line" + (line.c === 0 ? " low" : "");
      item.dataset.i = String(i);
      item.textContent = line.text;
      fragment.append(item);
    });
    if (fragment !== track) track.append(fragment);
  }

  #onTrackClick = (event) => {
    const item = event.target && event.target.closest ? event.target.closest(".lf-line") : null;
    if (!item) return;
    const index = Number(item.dataset.i);
    if (Number.isInteger(index) && this.lines[index]) this.onSeek(index);
  };

  #onPlay = () => this.onTogglePlay();
  #onCloseClick = () => this.onRequestClose();       // app geri-tuşu yolundan kapatır
  #onSettingsClick = () => this.onSettings();

  // --------------------------------------------------------------- medya

  #playVideo() {
    const node = this.mediaEl;
    if (!node || node.tagName !== "VIDEO" || !node.play) return;
    try {
      const result = node.play();
      if (result && result.catch) result.catch(() => {});
    } catch { /* otomatik oynatma reddedildi: resim gibi kalır */ }
  }

  #pauseVideo() {
    const node = this.mediaEl;
    if (node && node.tagName === "VIDEO" && node.pause) {
      try { node.pause(); } catch { /* yok say */ }
    }
  }

  #clearMedia() {
    const node = this.mediaEl;
    if (node) {
      if (node.tagName === "VIDEO") {
        try { node.pause(); } catch { /* yok say */ }
        node.removeAttribute("src");
        if (node.load) node.load();             // arabelleği bırak
      } else {
        node.removeAttribute("src");
      }
      node.remove();
    }
    this.mediaEl = null;
    if (this.mediaRevoke) {
      try { this.mediaRevoke(); } catch { /* yok say */ }
      this.mediaRevoke = null;
    }
  }
}
