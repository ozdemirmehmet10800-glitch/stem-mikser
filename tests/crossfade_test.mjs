// Şarkılar arası yumuşak geçiş + kitaplıkta klip önizlemesi + Nightcore ön ayarı (saf mantık ve kaynak taraması).   node tests\crossfade_test.mjs

import { readFileSync } from "node:fs";
import {
  readCrossfade, crossfadeStep, fadeInSeconds, previewStart, pickPlaying, CROSSFADE_DEFAULT, CROSSFADE_KEY, PREVIEW_MAX_PLAYING,
} from "../frontend/js/crossfade.js";
import { PRESETS, applyPreset } from "../frontend/js/mixmemory.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").split(String.fromCharCode(13)).join("");

// ------------------------------------------------------------------ geçiş kararı
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null) };
  check("varsayılan geçiş 5 sn", readCrossfade(storage) === CROSSFADE_DEFAULT && CROSSFADE_DEFAULT === 5);
  mem.set(CROSSFADE_KEY, "0");
  check("'0' kapalı", readCrossfade(storage) === 0);
  mem.set(CROSSFADE_KEY, "7");
  check("geçersiz değer -> varsayılan", readCrossfade(storage) === 5 && readCrossfade(null) === 5);
}
{
  const base = { seconds: 5, playing: true, hasNext: true, rate: 1 };
  check("son 5 sn'ye girince kısmaya başlar (kalan süre kadar)", JSON.stringify(crossfadeStep({ ...base, remaining: 4.8 })) === JSON.stringify({ action: "start", seconds: 4.8 }));
  check("daha erken başlamaz", crossfadeStep({ ...base, remaining: 6 }) === null);
  check("sonraki şarkı yoksa kısmaz (şarkı normal biter)", crossfadeStep({ ...base, hasNext: false, remaining: 3 }) === null);
  check("döngü açıkken / durmuşken / kapalıyken kısmaz", crossfadeStep({ ...base, looping: true, remaining: 3 }) === null && crossfadeStep({ ...base, playing: false, remaining: 3 }) === null && crossfadeStep({ ...base, seconds: 0, remaining: 3 }) === null);
  check("hız hesaba katılır (0,5x'te kalan 2 sn şarkı = 4 sn gerçek)", JSON.stringify(crossfadeStep({ ...base, rate: 0.5, remaining: 2 })) === JSON.stringify({ action: "start", seconds: 4 }));
  check("kısarken geri sarılırsa ses geri açılır", JSON.stringify(crossfadeStep({ ...base, fading: true, remaining: 30 })) === JSON.stringify({ action: "cancel" }));
  check("kısarken döngü açılırsa ses geri açılır", crossfadeStep({ ...base, fading: true, looping: true, remaining: 2 }).action === "cancel");
  check("kısma sürerken bir şey yapılmaz", crossfadeStep({ ...base, fading: true, remaining: 2 }) === null);
  check("yükselme süresi 0,6-2,5 sn", fadeInSeconds(3) === 1.5 && fadeInSeconds(8) === 2.5 && fadeInSeconds(0.5) === 0.6);
}

// ------------------------------------------------------------------ klip önizlemesi
{
  check("önizleme sürenin %35'inden başlar", Math.abs(previewStart(200) - 70) < 1e-9);
  check("kısa klipte baştan, süresiz klipte 1. sn", previewStart(4) === 0 && previewStart(Infinity) === 1 && previewStart(NaN) === 1);
  check("son kısma taşmaz", previewStart(10) <= 10 - 4 - 0.5 + 1e-9);
  const visible = [{ id: "c", top: 300 }, { id: "a", top: 10 }, { id: "d", top: 500 }, { id: "b", top: 120 }];
  check(`aynı anda en çok ${PREVIEW_MAX_PLAYING} önizleme, üsttekiler önce`, pickPlaying(visible).join() === "a,b,c");
}

// ------------------------------------------------------------------ Nightcore ön ayarı
{
  const nightcore = PRESETS.find((p) => p.id === "nightcore");
  const slowed = PRESETS.find((p) => p.id === "slowed-reverb");
  check("Nightcore: plak gibi hızlandırma (hız ve ton birlikte yükselir)", nightcore && nightcore.tempo.vinyl === true && nightcore.tempo.rate > 1.15 && nightcore.tempo.rate <= 1.5);
  check("Slowed + reverb duruyor (yavaş + yankı)", slowed && slowed.tempo.rate < 1 && slowed.room);
  check("Nightcore karışımı değiştirmez (dışa aktarma etiketinde varsayılan karışımla eşleşmez)", applyPreset(nightcore, ["vocals", "drums"]) === null);
  check("yalnız hız ön ayarının düğmesi etkin kalır ve hızı uygular", /!\(preset\.tempo && names\.length\)/.test(read("../frontend/js/app.js")) && /\(states \|\| \(preset\.tempo && engine\.channels\.size\)\) && preset\.tempo/.test(read("../frontend/js/app.js")));
}

// ------------------------------------------------------------------ uygulama bağlantıları
{
  const app = read("../frontend/js/app.js");
  const engine = read("../frontend/js/engine.js");
  const html = read("../frontend/index.html");
  const sw = read("../frontend/sw.js");
  check("motor: ayrı geçiş kazancı (ana ses ve dikiş düğümünden sonra) + fadeOutput; düğüm sayan testler onu altyapı sayar", /this\.seamGain\.connect\(this\.transitionGain\)/.test(engine) && /fadeOutput\(value, seconds\)/.test(engine));
  check("geçiş mevcut döngüden (her kare) karar verir", /crossfadeTick\(time\);/.test(app));
  check("çalma başlarken kısılmış ses geri yükselir (çalma çekirdeğine dokunmadan, oynat simgesiyle)", /if \(playing\) crossfadeArrive\(\);/.test(app));
  check("tempo ön ayarına tekrar dokununca normale döner", /activeTempoPreset === preset\.id/.test(app));
  check("Ayarlar: geçiş süresi ve klip önizlemesi", /id="setting-crossfade"/.test(html) && /id="setting-clippreview"/.test(html));
  check("önizleme videoları sessiz ve satır içi, dokunma almaz", /preview\.muted = true/.test(app) && /preview\.playsInline = true/.test(app));
  check("önizleme yalnız ekrandaki satırlarda (IntersectionObserver)", /new IntersectionObserver\(/.test(app));
  check("crossfade.js çevrimdışı kabukta", sw.includes('"./js/crossfade.js"'));
  check("geçiş hatası çalma döngüsünü / çalmayı başlatmayı bozmaz (yakalanır)",
    /function crossfadeTick\(time\) \{\s*try \{\s*crossfadeTickInner\(time\);\s*\} catch/.test(app)
    && /function crossfadeArrive\(\) \{[\s\S]{0,120}try \{\s*engine\.fadeOutput\(0, 0\.02\)/.test(app));
}

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
