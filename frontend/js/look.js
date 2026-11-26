// Görünüm tercihi: "yeni" (varsayılan) ya da "klasik". KLASİK BİR BETİK (modül değil): <head> içinde, sayfa boyanmadan ÖNCE çalışsın ki
// eski görünümden yeniye "yanıp sönme" olmasın. Aynı dosya node testinde de yüklenir (tests/look_test.mjs).
//
// Kurallar:
//   ?klasik=1  -> eski görünüm ve tercih "klasik" olarak KAYDEDİLİR (yeni görünüm bozulur da Ayarlar'a ulaşılamazsa kurtarma yolu).
//   ?klasik=0  -> yeni görünüm ve tercih "yeni" olarak kaydedilir.
//   parametre yoksa kayıtlı tercih; kayıt yoksa ya da okunamıyorsa YENİ.
// Tercih localStorage'da ayrı bir anahtarda (ayarlar JSON'una dokunulmaz); kayıt yazılamazsa o oturum yine de seçileni uygular.
(function (root) {
  "use strict";
  var KEY = "stem-mikser.look";
  var NEW = "new";
  var CLASSIC = "classic";

  function readStored(storage) {
    try {
      var value = storage && storage.getItem(KEY);
      return value === CLASSIC ? CLASSIC : NEW;
    } catch (error) {
      return NEW;
    }
  }

  function writeStored(storage, look) {
    try {
      if (storage) storage.setItem(KEY, look);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Adres çubuğundaki ?klasik= değeri: "1" -> klasik, "0" -> yeni, başka/yok -> null.
  function paramOf(search) {
    var match = /(?:^|[?&])klasik=([^&#]*)/.exec(String(search || ""));
    if (!match) return null;
    if (match[1] === "1") return CLASSIC;
    if (match[1] === "0") return NEW;
    return null;
  }

  // {look, persisted}: hangi görünüm uygulanacak. Parametre varsa tercihi de kaydeder.
  function resolve(search, storage) {
    var fromUrl = paramOf(search);
    if (fromUrl) {
      return { look: fromUrl, persisted: writeStored(storage, fromUrl), fromUrl: true };
    }
    return { look: readStored(storage), persisted: true, fromUrl: false };
  }

  function apply(look, doc) {
    var target = doc && doc.documentElement;
    if (!target) return;
    if (look === CLASSIC) target.classList.remove("ui-new");
    else target.classList.add("ui-new");
  }

  // Ayarlar anahtarı: kaydeder ve hemen uygular.
  function set(look, storage, doc) {
    var clean = look === CLASSIC ? CLASSIC : NEW;
    var ok = writeStored(storage, clean);
    apply(clean, doc);
    return ok;
  }

  function current(doc) {
    var target = doc && doc.documentElement;
    return target && target.classList.contains("ui-new") ? NEW : CLASSIC;
  }

  // Tema (yalnız yeni görünümde etkili): "dark" (varsayılan) | "black" (sahne siyahı, OLED) | "light" (aydınlık). Ayrı anahtar.
  var THEME_KEY = "stem-mikser.theme";
  var THEMES = ["dark", "black", "light"];
  var THEME_COLORS = { dark: "#07090d", black: "#000000", light: "#f4f6fa" };

  function readTheme(storage) {
    try {
      var value = storage && storage.getItem(THEME_KEY);
      return THEMES.indexOf(value) >= 0 ? value : "dark";
    } catch (error) {
      return "dark";
    }
  }

  function applyTheme(theme, doc) {
    var clean = THEMES.indexOf(theme) >= 0 ? theme : "dark";
    var target = doc && doc.documentElement;
    if (!target) return clean;
    target.setAttribute("data-theme", clean);
    var meta = doc.querySelector && doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLORS[clean]);
    return clean;
  }

  function setTheme(theme, storage, doc) {
    var clean = applyTheme(theme, doc);
    try {
      if (storage) storage.setItem(THEME_KEY, clean);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Açılış ekranı (logo + "Geliştiren"): yalnız sayfa İLK yüklenirken, ~2,2 sn. Zamanlama tamamen CSS'te (index.html #splash): ana betik
  // geç yüklense ya da hiç yüklenmese de ekran kendiliğinden kalkar. Burada yalnız: kapalıysa hiç gösterme (boyamadan önce), dokununca
  // hemen geç, bitince düğümü kaldır. Paylaş menüsünden gelinince gösterilmez (onay kartı beklemesin). Ayrı anahtar: "0" = kapalı.
  var SPLASH_KEY = "stem-mikser.splash";

  function readSplash(storage) {
    try {
      return (storage && storage.getItem(SPLASH_KEY)) !== "0";
    } catch (error) {
      return true;
    }
  }

  function setSplash(on, storage) {
    try {
      if (storage) storage.setItem(SPLASH_KEY, on ? "1" : "0");
      return true;
    } catch (error) {
      return false;
    }
  }

  function wantsSplash(search, storage) {
    if (/(?:^|[?&])paylasim(?:[=&#]|$)/.test(String(search || ""))) return false;
    return readSplash(storage);
  }

  function wireSplash(doc, win) {
    if (!doc || !doc.addEventListener) return;
    function done(node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    function setup() {
      var node = doc.getElementById("splash");
      if (!node) return;
      if (doc.documentElement.classList.contains("no-splash")) { done(node); return; }
      node.addEventListener("animationend", function (event) {
        if (event.target === node) done(node);              // çıkış animasyonu bitti
      });
      node.addEventListener("pointerdown", function () { node.classList.add("skip"); });
      // Güvence: animasyon olayı gelmese de (arka planda açılış vb.) kaldır.
      if (win && win.setTimeout) win.setTimeout(function () { done(node); }, 4000);
    }
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", setup);
    else setup();
  }

  var api = {
    KEY: KEY, NEW: NEW, CLASSIC: CLASSIC, paramOf: paramOf, resolve: resolve, apply: apply, set: set, current: current, readStored: readStored,
    THEME_KEY: THEME_KEY, THEMES: THEMES, readTheme: readTheme, applyTheme: applyTheme, setTheme: setTheme,
    SPLASH_KEY: SPLASH_KEY, readSplash: readSplash, setSplash: setSplash, wantsSplash: wantsSplash,
  };
  root.StemLook = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (typeof document !== "undefined" && typeof location !== "undefined") {
    var storage = null;
    try { storage = root.localStorage; } catch (error) { storage = null; }
    apply(resolve(location.search, storage).look, document);
    applyTheme(readTheme(storage), document);
    if (!wantsSplash(location.search, storage)) document.documentElement.classList.add("no-splash");
    wireSplash(document, root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
