// Tam ekran sözler (Aşama 13). Satır bulma/kaydırma hedefi lyrics.js'ten, vuruş mantığı
// beatpulse.js'ten GELİR; burada yalnız ekranın DOM yaşam döngüsü var.
//
// PERFORMANS KURALLARI (ses motoru takılmasın):
//  - Hareket eden her şey yalnız transform + opacity (kompozitör). Sahne TARAYICININ KENDİ
//    kaydırması (overflow-y + scrollTo): kare başı konum hesabı YOK, yalnız satır değişince
//    tek scrollTo. Satırlar yalnız opacity/transform geçişi. Hareketli öğede blur, canvas
//    piksel işleme, kare başı yeniden boyama YOK.
//  - Kullanıcı kaydırması touch/wheel olaylarından anlaşılır (scroll olayından DEĞİL; otomatik
//    takibin kendi scrollTo'su kullanıcı sanılmasın). Kaydırınca takip durur, "Şimdiye dön"
//    çıkar; dokunup atlayınca ya da düğmeyle takip yeniden başlar. Parmak kaydıysa tarayıcı
//    click üretmez, yani kaydırma "dokun → atla" sayılmaz.
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

// Ortadaki satırın üstünde ve altında görünen satır sayısı (1-5, ayar: settings.lyricsRows).
// CSS opaklık/ölçek kademesi bu sayıya göre hesaplanır (--lf-span). Ekran kısaysa sığmayanlar
// zaten kesilir.
export const ROWS_MIN = 1;
export const ROWS_MAX = 5;
export const ROWS_DEFAULT = 3;

export function normalizeRows(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= ROWS_MIN && n <= ROWS_MAX ? n : ROWS_DEFAULT;
}
const POSITION_CLASSES = ["cur", "next", "dist"];
const PULSE_MS = 420;

export class LyricsScreen {
  constructor({
    ui, createEl, doc = globalThis.document, win = globalThis.window,
    rows = ROWS_DEFAULT, reducedMotion = () => false, wakeLock = null, keepAwake = () => false,
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
    this.instant = false;
    this.following = true;
    this.padded = 0;
    this.lastTime = 0;

    this.rows = normalizeRows(rows);
    ui.root.style.setProperty("--lf-span", String(Math.max(this.rows - 1, 1)));
    // Kalıcı dinleyiciler (ui düğümleri ömür boyu aynı): BİR kez.
    ui.track.addEventListener("click", this.#onTrackClick);
    ui.playBtn.addEventListener("click", this.#onPlay);
    ui.closeBtn.addEventListener("click", this.#onCloseClick);
    ui.settingsBtn.addEventListener("click", this.#onSettingsClick);
    ui.stage.addEventListener("wheel", this.#onUserScroll, { passive: true });
    ui.stage.addEventListener("touchmove", this.#onUserScroll, { passive: true });
    if (ui.followBtn) ui.followBtn.addEventListener("click", this.#onFollowClick);
  }

  // ------------------------------------------------------------ yaşam döngüsü

  open({ lines, lang = null, title = "", mode = "plain", beats = null, media = null,
         playing = false, time = 0, subs = null }) {
    if (this.isOpen) this.close(true);
    this.lines = lines || [];
    this.isOpen = true;
    this.paused = this.doc.visibilityState === "hidden";
    this.index = -2;
    this.center = -2;
    this.lastTime = time;
    this.following = true;
    this.padded = 0;
    this.#showFollowing();
    this.ui.title.textContent = title;
    this.ui.root.classList.remove("empty");
    this.#buildLines(lang);
    this.#fillSubs(subs);
    this.ui.root.hidden = false;
    this.#applyPaused();
    this.setMode(mode);
    this.setBeats(beats);
    this.setMedia(media);
    this.setPlaying(playing);
    this.doc.addEventListener("visibilitychange", this.#onVisibility);
    this.win.addEventListener("resize", this.#onResize);
    if (this.wakeLock) this.wakeLock.request();
    // İlk yerleşim anında (kayma yok), sonra yumuşak kaydırma açılır.
    this.instant = true;
    this.tick(time, true);
    this.instantFrame = this.win.requestAnimationFrame(() => {
      this.instantFrame = this.win.requestAnimationFrame(() => {
        this.instantFrame = 0;
        this.instant = false;
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
    this.instant = false;
    this.ui.root.hidden = true;
    this.ui.root.classList.remove("paused", "playing", "has-media", "browsing", "empty");
    if (this.ui.followBtn) this.ui.followBtn.hidden = true;
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

  /** Görünen satır sayısı (1-5): ekran açıkken de hemen uygulanır. */
  setRows(value) {
    const next = normalizeRows(value);
    if (next === this.rows) return;
    if (this.isOpen && this.center >= 0) {
      const items = this.ui.track.children;
      for (let k = this.center - this.rows; k <= this.center + this.rows; k += 1) {
        if (items[k]) items[k].classList.remove(...POSITION_CLASSES);
      }
    }
    this.rows = next;
    this.ui.root.style.setProperty("--lf-span", String(Math.max(next - 1, 1)));
    if (this.isOpen && !this.paused) this.tick(this.lastTime, true);
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

  /**
   * Alt yazılar (okunuş, çeviri): subs[i] = {ro, tr} (boş string = gizli). Satırlar yeniden KURULMAZ, yalnız
   * alt satırlar güncellenir; yükseklik değişeceği için takip açıksa o anki satır yeniden ortalanır.
   */
  setSubs(subs) {
    if (!this.isOpen) return;
    this.#fillSubs(subs);
    if (this.following) {
      const was = this.instant;
      this.instant = true;               // yükseklik değişimi kaymayla değil, anında oturur
      this.#position();
      this.instant = was;
    }
  }

  #fillSubs(subs) {
    const items = this.ui.track.children;
    for (let i = 0; i < items.length; i += 1) {
      const sub = subs && subs[i] ? subs[i] : null;
      const nodes = items[i].children;
      if (!nodes || nodes.length < 3) continue;
      for (const [slot, text] of [[1, sub ? sub.ro : ""], [2, sub ? sub.tr : ""]]) {
        const node = nodes[slot];
        const value = text || "";
        if (node.textContent !== value) node.textContent = value;
        node.hidden = !value;
      }
    }
  }

  /** Başlık (liste modunda yeni şarkıya geçilince ekran açık kalır, başlık güncellenir). */
  setTitle(title) {
    this.ui.title.textContent = title || "";
  }

  /**
   * Satırlar değişti (yeniden hizalama bitti / liste modunda yeni şarkı): ekran açıksa yeniden kur. Boşsa: emptyText verilmişse
   * ekran AÇIK kalır ve sade bir metin gösterir ("Bu şarkıda söz yok"); verilmemişse kapanır.
   */
  setLines(lines, lang = null, subs = null, emptyText = null) {
    if (!this.isOpen) return;
    if (!lines || !lines.length) {
      if (emptyText) this.#showEmpty(emptyText);
      else this.close();
      return;
    }
    this.ui.root.classList.remove("empty");
    this.padded = 0;
    this.lines = lines;
    this.index = -2;
    this.center = -2;
    this.following = true;
    this.#showFollowing();
    this.#buildLines(lang);
    this.#fillSubs(subs);
    this.instant = true;
    this.tick(this.lastTime, true);
    this.instant = false;
  }

  #showEmpty(text) {
    this.lines = [];
    this.index = -2;
    this.center = -2;
    this.padded = 0;
    this.following = true;
    this.#showFollowing();
    const track = this.ui.track;
    track.textContent = "";
    track.removeAttribute("lang");
    track.style.paddingTop = "";
    track.style.paddingBottom = "";
    const item = this.createEl("li");
    item.className = "lf-empty";
    item.textContent = text;
    track.append(item);
    this.ui.root.classList.add("empty");
  }

  /** "Şimdiye dön" / satıra dokunma: takip yeniden başlar ve o anki satıra kayar. */
  resumeFollow() {
    this.following = true;
    this.#showFollowing();
    if (this.isOpen) this.#position();
  }

  #showFollowing() {
    this.ui.root.classList.toggle("browsing", !this.following);
    if (this.ui.followBtn) this.ui.followBtn.hidden = this.following;
  }

  #onUserScroll = () => {
    if (!this.following) return;
    this.following = false;
    this.#showFollowing();
  };

  #onFollowClick = () => this.resumeFollow();

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
    this.padded = 0;
    if (this.isOpen) this.#position();
  };

  // -------------------------------------------------------------- her kare

  /** Şarkı zamanı (engine.visualTime). Satır değişmedikçe DOM'a dokunmaz. */
  tick(time, force = false) {
    if (!this.isOpen) return;
    this.lastTime = time;
    if (this.paused) return;
    const lines = this.lines;
    if (!lines.length) return;                // "söz yok" görünümü: boyanacak satır yok
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
      for (let k = previous - this.rows; k <= previous + this.rows; k += 1) {
        if (items[k]) items[k].classList.remove(...POSITION_CLASSES);
      }
    }
    if (center >= 0) {
      for (let k = center - this.rows; k <= center + this.rows; k += 1) {
        const item = items[k];
        if (!item) continue;
        item.classList.remove(...POSITION_CLASSES);
        const distance = Math.abs(k - center);
        if (distance === 0) {
          item.classList.add(index >= 0 ? "cur" : "next");
        } else {
          item.classList.add("dist");
          item.style.setProperty("--k", String(distance));     // 1..rows: uzaklaştıkça solar
        }
      }
    }
    this.index = index;
    this.center = center;
    if (this.following) this.#position();
  }

  // Tarayıcının kendi kaydırması: satır değişince TEK scrollTo (kare başı hesap yok).
  #position() {
    const item = this.center >= 0 ? this.ui.track.children[this.center] : null;
    const stageHeight = this.ui.stage.clientHeight;
    if (!item || !(stageHeight > 0)) return;
    if (this.padded !== stageHeight) {
      // ilk ve son satır da ortalanabilsin
      this.ui.track.style.paddingTop = `${Math.round(stageHeight / 2)}px`;
      this.ui.track.style.paddingBottom = `${Math.round(stageHeight / 2)}px`;
      this.padded = stageHeight;
    }
    const top = Math.max(0, item.offsetTop + item.offsetHeight / 2 - stageHeight / 2);
    if (Math.abs(this.ui.stage.scrollTop - top) < 2) return;
    const smooth = !this.instant && !this.reducedMotion();
    this.ui.stage.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
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
      // [0] satır, [1] okunuş, [2] çeviri (alt yazılar başta gizli; setSubs doldurur)
      const main = this.createEl("span");
      main.className = "lf-main";
      main.textContent = line.text;
      const ro = this.createEl("span");
      ro.className = "lf-sub lf-ro";
      ro.hidden = true;
      const tr = this.createEl("span");
      tr.className = "lf-sub lf-tr";
      tr.hidden = true;
      item.append(main, ro, tr);
      fragment.append(item);
    });
    if (fragment !== track) track.append(fragment);
  }

  #onTrackClick = (event) => {
    const item = event.target && event.target.closest ? event.target.closest(".lf-line") : null;
    if (!item) return;
    const index = Number(item.dataset.i);
    if (Number.isInteger(index) && this.lines[index]) {
      this.following = true;                 // atlayınca takip yeniden başlar
      this.#showFollowing();
      this.onSeek(index);
    }
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
