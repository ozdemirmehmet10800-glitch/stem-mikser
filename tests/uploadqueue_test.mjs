// Yükleme sırası (js/uploadqueue.js): telefonda saklama, eski kayıt temizliği, kalıcı/yeniden denenebilir hata ayrımı + app.js bağlantısı.
// Küçük sahte IndexedDB ile.   node tests\uploadqueue_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

// ---- sahte IndexedDB (keyPath "id" + getAll)
function fakeIdb() {
  const dbs = new Map();
  return {
    open(name) {
      const request = {};
      setTimeout(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          createObjectStore(store) { stores.set(store, new Map()); },
          transaction(store) {
            const data = stores.get(store);
            const tx = {};
            tx.objectStore = () => ({
              put(value) { data.set(value.id, value); return { result: value.id }; },
              delete(key) { data.delete(key); return { result: undefined }; },
              getAll() { return { result: [...data.values()] }; },
            });
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
            return tx;
          },
          close() {},
        };
        request.result = db;
        if (fresh && request.onupgradeneeded) request.onupgradeneeded();
        request.onsuccess && request.onsuccess();
      }, 0);
      return request;
    },
  };
}

const { enqueue, pending, remove, isRetryable, QUEUE_MAX_AGE_MS } = await import("../frontend/js/uploadqueue.js");
const idb = fakeIdb();
const file = (name) => ({ name, size: 100, type: "audio/mpeg" });

const now = 1_000_000_000_000;
const items = await enqueue([file("a.mp3"), file("b.mp3"), file("c.mp3")], "hifi", { idb, now });
check("sıraya yazılır, her birinin kimliği var, kalite saklanır", items.length === 3 && items.every((i) => i.id && i.quality === "hifi"));
let left = await pending({ idb, now: now + 1000 });
check("bekleyenler eklenme sırasında", left.map((i) => i.name).join() === "a.mp3,b.mp3,c.mp3");
await remove([items[0].id], { idb });
left = await pending({ idb, now: now + 2000 });
check("yüklenen sıradan çıkar, kalanlar durur (uygulama kapanınca sürecek olanlar)", left.map((i) => i.name).join() === "b.mp3,c.mp3");
left = await pending({ idb, now: now + QUEUE_MAX_AGE_MS + 5000 });
check("24 saatten eski sıra kendiliğinden silinir (unutulmuş sıra GPU açmasın)", left.length === 0);
check("silinmiş olarak kalır", (await pending({ idb, now: now + 3000 })).length === 0);
check("boş/kimliksiz silme sorun değil", (await remove([null, undefined], { idb })) === true);

// IndexedDB yoksa: sıra yalnız bellekte yürür
const memoryOnly = await enqueue([file("x.mp3")], null, { idb: null, now });
check("IndexedDB yoksa çökmez: kimlik null (yalnız bellekte)", memoryOnly.length === 1 && memoryOnly[0].id === null);
check("IndexedDB yoksa bekleyen yok", (await pending({ idb: null })).length === 0);

check("yeniden denenebilir: internet/ağ/sunucu", isRetryable("offline") && isRetryable("network") && isRetryable("server"));
check("kalıcı: çok büyük / ses değil / iptal / yetki", !isRetryable("final") && !isRetryable("") && !isRetryable(undefined));

// ---- app.js bağlantısı (kaynak)
const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8");
const sw = readFileSync(new URL("../frontend/sw.js", import.meta.url), "utf8");
const many = app.slice(app.indexOf("function uploadMany("), app.indexOf("async function resumeUploads("));
check("yükleme sürerken AYRI ekran kilidi (çalmanınkine dokunmaz), bitince bırakılır",
  /const uploadWake = new WakeLock\(\);/.test(app) && /uploadWake\.request\(\)/.test(many) && /if \(!uploadRunning\) uploadWake\.release\(\);/.test(many));
check("yeni seçim önce telefona yazılır, yüklenen ve kalıcı hata veren silinir",
  /await enqueueUploads\(/.test(many) && (many.match(/await removeUploads\(\[item\.id\]\)/g) || []).length === 2);
check("internet/sunucu hatasında sıra durur, kalanlar saklı kalır", /else if \(isRetryable\(lastUploadFailure\)\) \{[\s\S]{0,200}break;/.test(many));
check("hata türü handleUpload'ta ayrılır (çevrimdışı / ağ / sunucu 5xx / kalıcı)",
  /lastUploadFailure = "offline";/.test(app) && /lastUploadFailure = kind === "offline" \? "offline" : kind === "network" \? "network" : code >= 500 \? "server" : "final";/.test(app));
check("açılışta ve internet gelince yarım kalan sıra sürer", /setTimeout\(resumeUploads, 2500\);/.test(app) && /addEventListener\("online", \(\) => setTimeout\(resumeUploads/.test(app));
check("sürdürme: başka yükleme sürerken, çevrimdışıyken ya da ayarlar yokken başlamaz",
  /async function resumeUploads\(\) \{\s*if \(uploadRunning \|\| isOffline\(\) \|\| !isConfigured\(settings\)\) return;/.test(app));
check("modül çevrimdışı kabukta", sw.includes('"./js/uploadqueue.js"'));

console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nhepsi geçti");
process.exit(failed ? 1 : 0);
