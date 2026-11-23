// Çalma sırası (js/queue.js) ve kilit ekranı önceki/sonraki (media.js keepSeek).   node tests\queue_test.mjs

import { readQueue, writeQueue, sanitize, addToQueue, removeFromQueue, takeNext, QUEUE_KEY, QUEUE_MAX } from "../frontend/js/queue.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const store = (seed = {}) => { const d = { ...seed }; return { d, getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } }; };

check("sanitize: geçersiz tür/kimlik, tekrar atılır; sıra korunur", JSON.stringify(sanitize(["a", "b", "a", 3, "../x", "", "c"])) === JSON.stringify(["a", "b", "c"]));
check(`sanitize: en çok ${QUEUE_MAX}`, sanitize(Array.from({ length: 500 }, (_, i) => `s${i}`)).length === QUEUE_MAX);
check("readQueue: bozuk/boş/dizi olmayan -> []", readQueue(store()).length === 0 && readQueue(store({ [QUEUE_KEY]: "{x" })).length === 0 && readQueue(store({ [QUEUE_KEY]: "{\"a\":1}" })).length === 0);
const s = store();
check("yaz/oku", writeQueue(s, ["a", "b"]) && JSON.stringify(readQueue(s)) === JSON.stringify(["a", "b"]));
check("yazma hatası false", writeQueue({ setItem() { throw new Error("kota"); } }, ["a"]) === false);
let r = addToQueue(["a"], ["b", "a", "c"]);
check("addToQueue: sona ekler, olan eklenmez, sayı doğru", JSON.stringify(r.ids) === JSON.stringify(["a", "b", "c"]) && r.added === 2);
check("removeFromQueue", JSON.stringify(removeFromQueue(["a", "b", "c"], "b")) === JSON.stringify(["a", "c"]));
let t = takeNext(["x", "y", "z"], (id) => id !== "x");
check("takeNext: çalınamayanı atlar, kalan sıra döner", t.id === "y" && JSON.stringify(t.rest) === JSON.stringify(["z"]) && t.dropped === 1);
t = takeNext(["x"], () => false);
check("takeNext: hiçbiri çalınamıyorsa id null, sıra boş", t.id === null && t.rest.length === 0 && t.dropped === 1);
check("takeNext: boş sıra", takeNext([], () => true).id === null);

// media.js: kütüphane kipinde önceki/sonraki VAR ama ±10 sn atlama işleyicileri KALIR
const handlers = {};
Object.defineProperty(globalThis, "navigator", { value: { mediaSession: { metadata: null, playbackState: "none", setActionHandler(a, h) { handlers[a] = h; } } }, configurable: true });
globalThis.window = { MediaMetadata: class { constructor(i) { Object.assign(this, i); } } };
const { MediaBridge } = await import("../frontend/js/media.js");
const seeks = [];
const bridge = new MediaBridge({ visualTime: 42, duration: 200, playing: true, rate: 1 }, { onSeek: (x) => seeks.push(x) });
let nexts = 0;
bridge.setTrackControls({ onPrevious: () => {}, onNext: () => { nexts += 1; }, keepSeek: true });
check("keepSeek: önceki/sonraki bağlı", typeof handlers.previoustrack === "function" && typeof handlers.nexttrack === "function");
handlers.nexttrack();
check("keepSeek: sonraki işleyicisi çalışır", nexts === 1);
check("keepSeek: ±10 sn atlama işleyicileri KALIR", typeof handlers.seekbackward === "function" && typeof handlers.seekforward === "function");
bridge.setTrackControls({ onPrevious: () => {}, onNext: () => {} });
check("liste modu (keepSeek yok): atlama işleyicileri kalkar (eski davranış)", handlers.seekbackward === null && handlers.seekforward === null);
bridge.setTrackControls(null);
check("null: sonraki yok, önceki = başa sar", handlers.nexttrack === null && (handlers.previoustrack(), seeks.includes(0)));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
