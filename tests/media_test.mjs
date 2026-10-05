// Kilit ekranı (Media Session) işleyicileri: çalma listesi modunda önceki/sonraki HER ZAMAN bağlı kalır
// (ilk şarkı, her otomatik geçiş, sıra ne olursa olsun), liste dışında eski davranış.
// Sahte navigator.mediaSession: son kurulan işleyici `handlers`ta.
//
//     node tests\media_test.mjs

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const handlers = {};
const session = {
  metadata: null,
  playbackState: "none",
  setActionHandler(action, handler) { handlers[action] = handler; },
};
Object.defineProperty(globalThis, "navigator", { value: { mediaSession: session }, configurable: true });
globalThis.window = { MediaMetadata: class { constructor(init) { Object.assign(this, init); } } };

const { MediaBridge } = await import("../frontend/js/media.js");

const seeks = [];
const engine = { visualTime: 42, duration: 200, playing: true, rate: 1 };
const calls = { prev: 0, next: 0, play: 0, pause: 0 };
const list = { onPrevious: () => { calls.prev += 1; }, onNext: () => { calls.next += 1; } };
const bridge = () => new MediaBridge(engine, { onSeek: (t) => seeks.push(t) });
const bind = (b) => b.bindHandlers({ onPlay: () => { calls.play += 1; }, onPause: () => { calls.pause += 1; } });
const reset = () => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  Object.assign(calls, { prev: 0, next: 0, play: 0, pause: 0 });
  seeks.length = 0;
};
const press = (action) => (typeof handlers[action] === "function" ? (handlers[action]({}), true) : false);

// --- 1) uygulamanın İLK şarkı sırası: updateListBar (liste) -> openSong: bindHandlers -> setMetadata -> updateListBar
reset();
let media = bridge();
media.setTrackControls(list);
bind(media);
media.setMetadata({ title: "A", artist: "x" });
media.setTrackControls(list);
check("ilk şarkı: önceki/sonraki bağlı ve liste işleyicisine gidiyor", press("previoustrack") && press("nexttrack") && calls.prev === 1 && calls.next === 1);
check("liste modunda ±10 sn işleyicileri YOK (ileri/geri = şarkı geçişi)", handlers.seekbackward === null && handlers.seekforward === null);
check("play/pause/seekto bağlı", press("play") && press("pause") && calls.play === 1 && calls.pause === 1 && typeof handlers.seekto === "function");

// --- 2) ESKİ HATA: bindHandlers liste önceki işleyicisinin üzerine yazıyordu (sıra: liste -> bind). Şimdi dokunmuyor.
reset();
media = bridge();
media.setTrackControls(list);
bind(media);
press("previoustrack");
check("setTrackControls bindHandlers'tan ÖNCE çağrılsa da önceki liste işleyicisinde kalır (başa sarma değil)", calls.prev === 1 && seeks.length === 0);

// --- 3) bindHandlers setTrackControls'tan ÖNCE: yine doğru
reset();
media = bridge();
bind(media);
media.setTrackControls(list);
press("nexttrack");
check("bind -> setTrackControls sırası da doğru", calls.next === 1 && typeof handlers.previoustrack === "function");

// --- 4) ardışık otomatik geçişler: her yeni şarkıda metadata + (updateListBar) tekrar; her seferinde bağlı
reset();
media = bridge();
bind(media);
let ok = true;
for (let song = 0; song < 6; song += 1) {
  media.setMetadata({ title: `Şarkı ${song}` });          // openSong tam yükleme yolu
  media.setTrackControls(list);                           // updateListBar
  ok = press("previoustrack") && press("nexttrack") && ok;
}
check("6 otomatik geçişten sonra da önceki/sonraki canlı", ok && calls.prev === 6 && calls.next === 6);

// --- 5) işleyici bir şekilde silinse bile yeni şarkının metadata'sı tekrar bağlar (tek kaynak = istenen durum)
reset();
media = bridge();
bind(media);
media.setTrackControls(list);
handlers.previoustrack = null;
handlers.nexttrack = null;
media.setMetadata({ title: "Y" });
check("setMetadata istenen önceki/sonraki durumunu yeniden uygular", press("previoustrack") && press("nexttrack"));

// --- 6) listeden çıkış: eski davranış
reset();
media = bridge();
bind(media);
media.setTrackControls(list);
media.setTrackControls(null);
press("previoustrack");
check("liste dışı: önceki = başa sar", seeks[0] === 0 && calls.prev === 0);
check("liste dışı: sonraki yok", handlers.nexttrack === null);
handlers.seekbackward({ seekOffset: 15 });
handlers.seekforward({});
check("liste dışı: ileri/geri = 10 sn (görünen konuma göre; seekOffset kullanılır)", seeks[1] === 42 - 15 && seeks[2] === 42 + 10);
media.setTrackControls(list);
check("tekrar liste modu: ±10 sn kalkar, önceki/sonraki döner", handlers.seekbackward === null && press("previoustrack") && press("nexttrack"));

// --- 7) desteklenmeyen tarayıcı: hiçbir şey patlamaz
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
reset();
media = bridge();
let threw = false;
try {
  media.setTrackControls(list);
  bind(media);
  media.setMetadata({ title: "Z" });
} catch {
  threw = true;
}
check("mediaSession yoksa sessizce atlanır", !threw && Object.keys(handlers).length === 0);

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
