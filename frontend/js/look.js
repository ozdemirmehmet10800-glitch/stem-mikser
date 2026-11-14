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

  var api = { KEY: KEY, NEW: NEW, CLASSIC: CLASSIC, paramOf: paramOf, resolve: resolve, apply: apply, set: set, current: current, readStored: readStored };
  root.StemLook = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (typeof document !== "undefined" && typeof location !== "undefined") {
    var storage = null;
    try { storage = root.localStorage; } catch (error) { storage = null; }
    apply(resolve(location.search, storage).look, document);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
