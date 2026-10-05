// Service worker.
//
// Tek işi ÖN YÜZ dosyalarını cache'lemek. Ses dosyaları ve API istekleri
// buraya hiç uğramaz:
//   - API başka bir origin'de (Modal), aşağıda origin kontrolü var
//   - stem'ler zaten API'den geliyor, ayrıca yol/destination kontrolü de var
//
// Sürüm numarası elle artırılıyor. Değişince eski cache'ler siliniyor ve
// yeni worker beklemeden devralıyor (skipWaiting + clients.claim), yoksa
// GitHub Pages'e atılan bir düzeltme kullanıcıya günlerce ulaşmayabiliyor.

const VERSION = "v53";
const CACHE = `stem-mikser-${VERSION}`;
// Kabuk cache'lerinin adı (stem-mikser-v<sayı>). Eski sürümler YALNIZ bu kalıpla silinir: uygulamanın kendi cache'leri
// (stemcache.js: stem-mikser-stems-v1 = çevrimdışı şarkılar; paylaşılan dosya: stem-mikser-share-v1) farklı adlı ve
// buradan silinmez.
const SHELL_CACHE_RE = /^stem-mikser-v\d+$/;

// Paylaş menüsünden şarkı ekleme (Web Share Target). manifest.json: share_target {action: "./share-target", POST,
// multipart}. GitHub Pages POST kabul etmez; bu worker isteği yakalar, İLK dosyayı geçici cache'e koyar ve 303 ile
// uygulamaya yollar (js/share.js dosyayı alıp onay kartı gösterir). Sabitler js/share.js ile AYNI olmalı
// (tests/sw_share_test.mjs ikisini karşılaştırır).
const SHARE_PATH = "share-target";
const SHARE_CACHE = "stem-mikser-share-v1";   // uygulamanın kendi cache'i: activate silmez (SHELL_CACHE_RE'ye uymaz)
const SHARE_KEY = "share-pending/current";    // tek bekleyen kayıt
const SHARE_PARAM = "paylasim";
const SHARE_MAX_BYTES = 30 * 1024 * 1024;     // sunucu sınırıyla aynı (MAX_UPLOAD_BYTES); üstü saklanmaz

// Göreli yollar: site /stem-mikser/ alt yolunda yayınlanıyor, kökte değil.
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/app.js",
  "./js/api.js",
  "./js/engine.js",
  "./js/mixer.js",
  "./js/mixmemory.js",
  "./js/loop.js",
  "./js/sub.js",
  "./js/exportmix.js",
  "./js/lyrics.js",
  "./js/lyricsscreen.js",
  "./js/translation.js",
  "./js/vinyl.js",
  "./js/fx.js",
  "./js/beatpulse.js",
  "./js/bgstore.js",
  "./js/fader.js",
  "./js/media.js",
  "./js/wakelock.js",
  "./js/stemcache.js",
  "./js/share.js",
  "./js/collection.js",
  "./js/songfilter.js",
  "./js/playlist.js",
  "./js/metronome.js",
  "./js/chords.js",
  "./js/settings.js",
  "./js/diag.js",
  "./js/stretch.js",
  "./js/stretchers.js",
  "./js/tonality.js",
  "./js/aligncheck.js",
  "./js/tap-processor.js",
  // Esnetici (Aşama 8). soundtouch-processor.js AudioWorklet'e
  // addModule ile yükleniyor; fetch olayına destination "script" olarak
  // düşüyor, yani aşağıdaki "önce cache" dalından geçiyor. Çevrimdışıyken
  // hız/ton çalışsın diye kabuğa dahil.
  "./vendor/soundtouch-worklet/index.js",
  "./vendor/soundtouch-worklet/SoundTouchNode.js",
  "./vendor/soundtouch-worklet/constants.js",
  "./vendor/soundtouch-worklet/processOffline.js",
  "./vendor/soundtouch-worklet/soundtouch-processor.js",
  "./vendor/signalsmith-stretch/SignalsmithStretch.mjs",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Tek bir dosya 404 verirse addAll tümünü iptal eder; kurulum
      // sessizce yarım kalmasın diye tek tek ekliyoruz.
      .then((cache) =>
        Promise.all(
          SHELL.map((path) =>
            cache.add(new Request(path, { cache: "reload" })).catch((error) => {
              console.warn("[sw] cache'lenemedi:", path, error);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE && SHELL_CACHE_RE.test(key)).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Ayarlardaki "önbelleği temizle" düğmesi buraya mesaj atıyor.
self.addEventListener("message", (event) => {
  if (event.data === "temizle") {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .then(() => self.registration.unregister())
    );
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Paylaşım hedefi: YALNIZ aynı origin'de, kapsam içindeki /share-target POST'u. Başka hiçbir POST/DELETE'e karışmıyoruz.
  if (request.method === "POST") {
    const target = new URL(request.url);
    if (target.origin === self.location.origin && target.href === new URL(SHARE_PATH, self.location).href) {
      event.respondWith(handleShare(request));
    }
    return;
  }

  // Sadece GET.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // BAŞKA ORIGIN'E DOKUNMA. API buradan geçiyor; cache'lemek bir yana,
  // araya girmek bile CORS davranışını bozabilir.
  if (url.origin !== self.location.origin) return;

  // Ses asla cache'lenmez (kemer + askı: normalde aynı origin'de olmazlar).
  if (request.destination === "audio" || /\.(m4a|mp3|wav|flac|ogg|opus)$/i.test(url.pathname)) {
    return;
  }

  // Sayfa gezintisi: önce ağ, olmazsa cache. Böylece yeni sürüm iner ama
  // çevrimdışıyken uygulama yine açılır.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((hit) => hit || caches.match("./index.html"))
        )
    );
    return;
  }

  // manifest.json: önce AĞ. Chrome WebAPK güncelleme kontrolünde (share_target gibi alanlar) yeni manifesti ilk
  // kontrolde görsün diye; "önce cache" eski manifesti bir tur daha verirdi. Çevrimdışıyken cache'ten.
  if (url.pathname.endsWith("/manifest.json")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Diğer kendi dosyalarımız: önce cache, arkadan tazele.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});

// ------------------------------------------------------------ paylaşım hedefi

function shareRedirect(state) {
  return Response.redirect(new URL(`./?${SHARE_PARAM}=${state}`, self.location).href, 303);
}

/**
 * POST /share-target: multipart içindeki İLK dosyayı `stem-mikser-share-v1` cache'ine koyar, uygulamaya yönlendirir.
 * Dosya yoksa ?paylasim=bos, işlenemezse ?paylasim=hata. Tek bekleyen kayıt (yenisi eskinin yerine geçer).
 * 30 MB üstü saklanmaz: yalnız ad/boyut kaydedilir (bellek ve depolama boşa dolmasın), uygulama mesaj gösterir.
 */
async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = [];
    for (const [, value] of form.entries()) {
      if (typeof value !== "string") files.push(value);
    }
    if (!files.length) return shareRedirect("bos");
    const [file] = files;
    const cache = await caches.open(SHARE_CACHE);
    for (const old of await cache.keys()) await cache.delete(old);
    const large = file.size > SHARE_MAX_BYTES;
    await cache.put(
      new URL(SHARE_KEY, self.location).href,
      new Response(large ? null : file, {
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-share-state": large ? "large" : "ok",
          "x-share-name": encodeURIComponent(file.name || ""),
          "x-share-size": String(file.size),
          "x-share-skipped": String(files.length - 1),
          "x-share-time": String(Date.now()),
        },
      })
    );
    return shareRedirect("1");
  } catch (error) {
    console.warn("[sw] paylaşım alınamadı:", error);
    return shareRedirect("hata");
  }
}
