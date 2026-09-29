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

const VERSION = "v22";
const CACHE = `stem-mikser-${VERSION}`;

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
  "./js/fader.js",
  "./js/media.js",
  "./js/wakelock.js",
  "./js/stemcache.js",
  "./js/metronome.js",
  "./js/chords.js",
  "./js/settings.js",
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
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
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

  // Sadece GET. POST/DELETE'e karışmıyoruz.
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
