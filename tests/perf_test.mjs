// Performans korumaları: kare döngüsü yalnız DEĞİŞENİ yazar, duraklatılmışken boşta durur; akor şeridi her karede yerleşim ölçmez;
// sık kullanılan ayarlar her karede telefon hafızasından okunmaz.   node tests\perf_test.mjs
//
// Ölçüm (2026-11-26, 375x812, sahte sunucu): duraklatılmışken bile saniyede ~330 sayfa değişikliği vardı (zaman yazıları her karede).

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").split(String.fromCharCode(13)).join("");

// ------------------------------------------------------------------ akor şeridi (sahte DOM ile gerçek sınıf)
{
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
  };
  const { ChordStrip } = await import("../frontend/js/chords.js");
  let widthReads = 0;
  let transformWrites = 0;
  const root = { get clientWidth() { widthReads += 1; return 400; } };
  const style = {};
  Object.defineProperty(style, "transform", { set() { transformWrites += 1; }, get() { return ""; } });
  const track = { style, innerHTML: "" };
  const strip = new ChordStrip(root, track, { hidden: true }, () => {});
  transformWrites = 0;
  strip.pxPerSec = 20;
  for (let i = 0; i < 120; i += 1) strip.update(5);
  check("akor şeridi: aynı konumda 120 karede 1 yazım", transformWrites === 1, String(transformWrites));
  check("akor şeridi: genişlik 120 karede 1 kez ölçülür (yerleşim zorlanmaz)", widthReads === 1, String(widthReads));
  strip.update(5.5);
  check("akor şeridi: konum değişince yazılır", transformWrites === 2, String(transformWrites));
  observers[0].cb();
  strip.update(5.5);
  check("akor şeridi: boyut değişince genişlik yeniden ölçülür ve konum yeniden yazılır", widthReads === 2 && transformWrites === 3, `${widthReads}/${transformWrites}`);
  delete globalThis.ResizeObserver;
}

// ------------------------------------------------------------------ kare döngüsü (kaynak taraması)
{
  const app = read("../frontend/js/app.js");
  const loop = app.slice(app.indexOf("function startLoop() {"), app.indexOf("// Şarkı doğal olarak bitti"));
  check("zaman yazıları yalnız değişince yazılır", /setTextIfChanged\("now", "time-current"/.test(loop) && /setTextIfChanged\("left", "time-remaining"/.test(loop) && !/el\("time-current"\)\.textContent =/.test(loop));
  check("konum kaydırıcısı yalnız değişince yazılır", /if \(loopShown\.seek !== seekValue\)/.test(loop));
  check("duraklatılmışken ve konum değişmemişken kare işi atlanır (yalnız sonraki kare istenir)",
    /if \(!playing && !loopShown\.playing && !seeking && time === loopShown\.time\) \{\s*rafHandle = requestAnimationFrame\(tick\);[^\n]*\n\s*return;/.test(loop));
  check("şarkı açılınca ve ton değişince döngü yeniden değerlendirir", /cancelAnimationFrame\(rafHandle\);\s*invalidateLoop\(\);/.test(loop) && /strip\.setTranspose\(shown, originalKey\);\s*invalidateLoop\(\);/.test(app));
  check("boşta atlama güvenliği: dokunuş/boyut/geri dönüş ve akor şeridi kurulunca bir kare yeniden değerlendirilir",
    /\["pointerup", "keyup"\]\) document\.addEventListener\(type, \(\) => invalidateLoop\(\)/.test(app) && /addEventListener\("resize", \(\) => invalidateLoop\(\)\)/.test(app)
    && /strip\.build\(detail\.chords, duration\);\s*invalidateLoop\(\);/.test(app));
  check("geçiş ayarı her karede hafızadan okunmaz", /const seconds = crossfadeSeconds;/.test(app) && /crossfadeSeconds = readCrossfade\(safeStorage\(\)\.storage\);/.test(app));
  check("bitiş kontrolü ve kilit ekranı konumu boşta değilken sürer", /engine\.checkEnded\(\);/.test(loop) && /media\.updatePosition\(\);/.test(loop));
}

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
