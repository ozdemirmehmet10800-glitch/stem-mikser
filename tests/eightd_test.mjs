// 8D ses (js/eightd.js) + ses motoru bağlantısı (engine.js setAutoPan, kaynak taraması) + uygulama düğmesi.   node tests\eightd_test.mjs

import { readFileSync } from "node:fs";
import {
  eightDPlan, panAt, nextEightDMode, readEightD, storeEightD, EIGHTD_SPEEDS, EIGHTD_WIDTH, EIGHTD_TEXT, EIGHTD_KEY,
} from "../frontend/js/eightd.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ------------------------------------------------------------------ plan
check("kapalı: plan yok (motor 8D'yi kaldırır)", eightDPlan({ mode: "off" }) === null && eightDPlan({}) === null && eightDPlan({ mode: "x" }) === null);
{
  const plan = eightDPlan({ mode: "all", speed: "medium" });
  const names = ["vocals", "drums", "bass", "guitar", "piano", "other"];
  const entries = names.map((n) => plan(n));
  check("klasik 8D: bütün kanallar AYNI hız, genişlik ve evrede (şarkı birlikte döner)",
    entries.every((e) => e.rate === EIGHTD_SPEEDS.medium && e.depth === EIGHTD_WIDTH && e.phase === 0));
  check("klasik 8D: vokal de döner", plan("vocals") !== null);
  check("klasik 8D planı 'tek zincir' işaretli (motor karışıma tek zincir kurar)", plan.uniform === true && eightDPlan({ mode: "stems" }).uniform !== true);
}
{
  const plan = eightDPlan({ mode: "stems", speed: "slow" });
  check("kanal kanal: vokal ORTADA sabit", plan("vocals") === null);
  const bass = plan("bass");
  check("kanal kanal: bas ortaya yakın (dar)", bass.depth < 0.3 && bass.rate < EIGHTD_SPEEDS.slow);
  const g = plan("guitar");
  const d = plan("drums");
  const p = plan("piano");
  check("kanal kanal: enstrümanlar farklı hız ve evrede", new Set([g.rate, d.rate, p.rate]).size === 3 && new Set([g.phase, d.phase, p.phase]).size === 3);
  check("kanal kanal: alt parça ana kanalı izler (davulun alt kanalı = davul)", JSON.stringify(plan("drums_kick", "drums")) === JSON.stringify(d));
  check("kanal kanal: bilinmeyen kanal da döner (sabit, ada göre evre)", plan("synth") !== null && JSON.stringify(plan("synth")) === JSON.stringify(plan("synth")));
}
{
  const fast = eightDPlan({ mode: "all", speed: "fast" })("x");
  const slow = eightDPlan({ mode: "all", speed: "slow" })("x");
  check("hız: hızlı > orta > yavaş (tam tur 4,5 / 8 / 12 sn)", fast.rate > EIGHTD_SPEEDS.medium && EIGHTD_SPEEDS.medium > slow.rate && near(1 / slow.rate, 12));
  check("bilinmeyen hız -> orta", eightDPlan({ mode: "all", speed: "zzz" })("x").rate === EIGHTD_SPEEDS.medium);
}
{
  const e = eightDPlan({ mode: "all", speed: "medium" })("x");
  check("pan dalgası: başta orta, çeyrek turda sağ uç, yarımda orta, 3/4'te sol uç",
    near(panAt(e, 0), 0) && near(panAt(e, 2), EIGHTD_WIDTH) && near(panAt(e, 4), 0, 1e-9) && near(panAt(e, 6), -EIGHTD_WIDTH));
  check("pan hiçbir zaman -1..1 dışına çıkmaz", Array.from({ length: 200 }, (_, i) => panAt(e, i * 0.37)).every((v) => v >= -1 && v <= 1));
  check("plan yoksa pan 0", panAt(null, 3) === 0);
}

// ------------------------------------------------------------------ düğme + saklama
check("8D düğmesi: kapalı -> klasik -> kanal kanal -> kapalı", nextEightDMode("off") === "all" && nextEightDMode("all") === "stems" && nextEightDMode("stems") === "off" && nextEightDMode("?") === "off");
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  check("varsayılan: kapalı, orta hız, 3D açık", JSON.stringify(readEightD(storage)) === JSON.stringify({ mode: "off", speed: "medium", space: true }));
  storeEightD(storage, { mode: "stems", speed: "fast", space: false });
  check("seçim saklanır ve geri okunur (3D kapalı dahil)", JSON.stringify(readEightD(storage)) === JSON.stringify({ mode: "stems", speed: "fast", space: false }) && mem.has(EIGHTD_KEY));
  mem.set(EIGHTD_KEY, JSON.stringify({ mode: "all", speed: "slow" }));
  check("eski kayıt (3D alanı yok): 3D açık sayılır", readEightD(storage).space === true);
  mem.set(EIGHTD_KEY, "{bozuk");
  check("bozuk kayıt: kapalı (çökmez)", readEightD(storage).mode === "off" && readEightD(null).mode === "off");
  check("depolama yazılamazsa false (çökmez)", storeEightD({ setItem() { throw new Error("x"); } }, { mode: "all", speed: "slow" }) === false);
  check("her kipin kullanıcı metni var; açık kiplerde kulaklık önerilir", ["off", "all", "stems"].every((m) => EIGHTD_TEXT[m]) && /Kulaklık/i.test(EIGHTD_TEXT.all + EIGHTD_TEXT.stems));
}

// ------------------------------------------------------------------ motor (kaynak taraması)
{
  const engine = read("../frontend/js/engine.js");
  const body = (name) => {
    const start = engine.indexOf(`  ${name}(`);
    const next = engine.indexOf("\n  }\n", start);
    return start < 0 ? "" : engine.slice(start, next);
  };
  check("motor: setAutoPan var; kapanınca bütün LFO'lar bırakılır", /setAutoPan\(planFn, \{ space = false \} = \{\}\)/.test(engine) && /for \(const channel of this\.channels\.values\(\)\) this\.#dropLfo\(channel\)/.test(body("setAutoPan")));
  check("motor: 8D açıkken kanal şeridi devrede (pan nötr olsa da)", /const active = this\.#needsStrip\(name, channel\);/.test(engine) && /#autoPanEntry\(name, channel\) !== null/.test(body("#needsStrip")));
  check("motor: nötre dönen şerit kontrolü 8D'yi hesaba katar (açıkken şerit sökülmez)", (engine.match(/!this\.#needsStrip\(name, channel\)/g) || []).length === 2);
  check("motor: dönüş ses kartında (osilatör -> derinlik -> StereoPanner.pan), kare döngüsü yok",
    /drive\(side, d, pan.pan\)/.test(body("#motion")) && /createOscillator\(\)/.test(body("#motion")) && !/requestAnimationFrame|setInterval/.test(body("#motion")));
  check("motor: ortak döneme göre evre (sonradan açılan kanal aynı turda)", /entry\.rate \* \(startAt - this\.autoPanEpoch\)/.test(body("#motion")) && /setPeriodicWave/.test(body("#motion")));
  check("motor: yumuşak giriş/çıkış (tık yok)", /setTargetAtTime\(amount/.test(body("#motion")) && /setTargetAtTime\(0, now/.test(body("#dropMotion")));
  check("motor 3D: tarayıcının HRTF düğümü KULLANILMAZ (hareketli kaynakta cızırtı yapıyor, ölçüldü)", !/createPanner\(|panningModel/.test(engine));
  check("motor 3D: kulak başına gecikme (zaman farkı) ve arka gölgesi süzgeci",
    /createDelay\(0\.01\)/.test(body("#makeSpace")) && /type = "lowpass"/.test(body("#makeSpace")) && /SPACE_ITD_SWING = 0\.0006/.test(engine));
  check("motor 3D: değerler LFO'larla pürüzsüz sürülür (gecikmeler zıt yönde, süzgeç ön-arka ile)",
    /drive\(side, SPACE_ITD_SWING \* d, space.left\.delayTime\)/.test(body("#motion")) && /drive\(side, -SPACE_ITD_SWING \* d, space.right\.delayTime\)/.test(body("#motion"))
    && /drive\(front, SPACE_SHADE_SWING \* d, space.shade\.frequency\)/.test(body("#motion")) && /wave\(Math\.PI \/ 2\)/.test(body("#motion")));
  check("motor 3D: 2D <-> 3D geçişinde açık şeritler yeniden bağlanır", /was3d !== this\.autoPan3d/.test(body("setAutoPan")) && /Boolean\(strip\.spatial\) === spatial/.test(engine));
  check("Ayarlar: '3D' anahtarı", /id="setting-eightd-3d"/.test(read("../frontend/index.html")) && /on\("setting-eightd-3d", "change"/.test(read("../frontend/js/app.js")));
  check("hafif: 8D parametreleri k-rate (128 örnekte bir; her örnekte güncellemek yükü ~7 kat artırıyordu)",
    /param\.automationRate = "k-rate"/.test(body("#makeSpace")) && /pan\.pan\.automationRate = "k-rate"/.test(body("#motion")));
  check("hafif: klasik 8D karışıma TEK zincir (kanal başına değil)", /this\.master\.connect\(pan\)/.test(body("#syncMasterMotion"))
    && /this\.autoPanUniform\) return null;/.test(body("#autoPanEntry")) && /this\.#syncMasterMotion\(\);/.test(body("setAutoPan")));
  check("hafif: 8D kapanınca karışım doğrudan bağlanır (master -> seamGain)", /if \(!entry\) \{\s*try \{ this\.master\.disconnect\(this\.seamGain\); \}[\s\S]{0,80}this\.master\.connect\(this\.seamGain\);/.test(body("#syncMasterMotion")));
  check("motor: şerit atılınca LFO da atılır", /#disposeStrip\(channel\) \{\n    this\.#dropLfo\(channel\);/.test(engine));
}

// ------------------------------------------------------------------ uygulama
{
  const app = read("../frontend/js/app.js");
  const html = read("../frontend/index.html");
  const sw = read("../frontend/sw.js");
  check("mikserde 8D düğmesi", /id="eightd-toggle"[^>]*aria-pressed="false"/.test(html));
  check("düğme kipi döndürür, saklar ve uygular", /storeEightD\(storage, \{ \.\.\.state, mode: nextEightDMode\(state\.mode\) \}\);\n\s*applyEightD\(true\);/.test(app));
  check("açılışta saklı 8D seçimi uygulanır (her şarkıda geçerli)", /\napplyEightD\(\);\n/.test(app) && /engine\.setAutoPan\(eightDPlan\(state\), \{ space: state\.space \}\)/.test(app));
  check("Ayarlar: dönüş hızı seçimi", /id="setting-eightd-speed"/.test(html) && /on\("setting-eightd-speed", "change"/.test(app));
  check("8D modülü çevrimdışı kabukta", sw.includes('"./js/eightd.js"'));
  check("eightd.js ağa bağlanmaz", !/\bfetch\(|XMLHttpRequest/.test(read("../frontend/js/eightd.js")));
}

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
